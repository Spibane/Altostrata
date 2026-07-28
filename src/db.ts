import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const DB_PATH = resolve(process.env.STRATA_DB ?? "./data/strata.db");

mkdirSync(dirname(DB_PATH), { recursive: true });

export const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS authors (
  did          TEXT PRIMARY KEY,
  handle       TEXT NOT NULL,
  display_name TEXT,
  cursor       TEXT,
  complete     INTEGER NOT NULL DEFAULT 0,
  last_crawled TEXT,
  oldest       TEXT,
  newest       TEXT
);

CREATE TABLE IF NOT EXISTS posts (
  uri         TEXT PRIMARY KEY,
  cid         TEXT NOT NULL,
  author_did  TEXT NOT NULL REFERENCES authors(did),
  created_at  TEXT NOT NULL,
  embed_type  TEXT,
  media_count INTEGER NOT NULL DEFAULT 0,
  shown_at    TEXT
);

CREATE TABLE IF NOT EXISTS excluded (
  uri    TEXT PRIMARY KEY,
  reason TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_posts_author  ON posts(author_did);
CREATE INDEX IF NOT EXISTS idx_posts_created ON posts(created_at);
CREATE INDEX IF NOT EXISTS idx_posts_shown   ON posts(shown_at);
`);

// ---------------------------------------------------------------------------
// Meta
// ---------------------------------------------------------------------------

const setMetaStmt = db.prepare(
  "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
);
const getMetaStmt = db.prepare("SELECT value FROM meta WHERE key = ?");

export function setMeta(key: string, value: string): void {
  setMetaStmt.run(key, value);
}

export function getMeta(key: string): string | undefined {
  const row = getMetaStmt.get(key) as { value: string } | undefined;
  return row?.value;
}

// ---------------------------------------------------------------------------
// Authors
// ---------------------------------------------------------------------------

export interface AuthorRow {
  did: string;
  handle: string;
  display_name: string | null;
  cursor: string | null;
  complete: number;
  last_crawled: string | null;
  oldest: string | null;
  newest: string | null;
}

/**
 * Upserts follow-graph data without clobbering crawl progress. Unfollowed
 * accounts keep their indexed posts but stop being crawled.
 */
const upsertAuthorStmt = db.prepare(`
INSERT INTO authors (did, handle, display_name) VALUES (?, ?, ?)
ON CONFLICT(did) DO UPDATE SET handle = excluded.handle, display_name = excluded.display_name
`);

export const upsertAuthors = db.transaction(
  (authors: Array<{ did: string; handle: string; displayName?: string }>) => {
    for (const author of authors) {
      upsertAuthorStmt.run(author.did, author.handle, author.displayName ?? null);
    }
  },
);

export function pendingAuthors(): AuthorRow[] {
  return db
    .prepare("SELECT * FROM authors WHERE complete = 0 ORDER BY last_crawled IS NOT NULL, last_crawled")
    .all() as AuthorRow[];
}

export function completeAuthors(): AuthorRow[] {
  return db.prepare("SELECT * FROM authors WHERE complete = 1 ORDER BY handle").all() as AuthorRow[];
}

export function allAuthors(): AuthorRow[] {
  return db.prepare("SELECT * FROM authors ORDER BY handle").all() as AuthorRow[];
}

const updateProgressStmt = db.prepare(`
UPDATE authors
   SET cursor = ?, complete = ?, last_crawled = ?
 WHERE did = ?
`);

export function updateAuthorProgress(
  did: string,
  cursor: string | null,
  complete: boolean,
): void {
  updateProgressStmt.run(cursor, complete ? 1 : 0, new Date().toISOString(), did);
}

/** Recomputes the indexed date range, which drives the depth gauge in the UI. */
export function refreshAuthorRange(did: string): void {
  db.prepare(
    `UPDATE authors SET oldest = (SELECT MIN(created_at) FROM posts WHERE author_did = ?),
                        newest = (SELECT MAX(created_at) FROM posts WHERE author_did = ?)
      WHERE did = ?`,
  ).run(did, did, did);
}

export function resetCrawl(): void {
  db.prepare("UPDATE authors SET cursor = NULL, complete = 0").run();
}

// ---------------------------------------------------------------------------
// Posts
// ---------------------------------------------------------------------------

const insertPostStmt = db.prepare(`
INSERT INTO posts (uri, cid, author_did, created_at, embed_type, media_count)
VALUES (?, ?, ?, ?, ?, ?)
ON CONFLICT(uri) DO NOTHING
`);

export interface PostInsert {
  uri: string;
  cid: string;
  authorDid: string;
  createdAt: string;
  embedType: string | null;
  mediaCount: number;
}

export const insertPosts = db.transaction((rows: PostInsert[]): number => {
  let inserted = 0;
  for (const row of rows) {
    const result = insertPostStmt.run(
      row.uri,
      row.cid,
      row.authorDid,
      row.createdAt,
      row.embedType,
      row.mediaCount,
    );
    inserted += result.changes;
  }
  return inserted;
});

export const deletePosts = db.transaction((uris: string[]) => {
  const stmt = db.prepare("DELETE FROM posts WHERE uri = ?");
  for (const uri of uris) stmt.run(uri);
});

export const markShown = db.transaction((uris: string[]) => {
  const stmt = db.prepare("UPDATE posts SET shown_at = ? WHERE uri = ?");
  const now = new Date().toISOString();
  for (const uri of uris) stmt.run(now, uri);
});

// ---------------------------------------------------------------------------
// Exclusions
// ---------------------------------------------------------------------------

const insertExclusionStmt = db.prepare(
  "INSERT INTO excluded (uri, reason) VALUES (?, ?) ON CONFLICT(uri) DO NOTHING",
);

export const insertExclusions = db.transaction(
  (rows: Array<{ uri: string; reason: string }>): number => {
    let inserted = 0;
    for (const row of rows) {
      inserted += insertExclusionStmt.run(row.uri, row.reason).changes;
    }
    return inserted;
  },
);

export function clearExclusions(reason: string): void {
  db.prepare("DELETE FROM excluded WHERE reason = ?").run(reason);
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

export interface ShuffleRow {
  uri: string;
  created_at: string;
  handle: string;
  display_name: string | null;
  oldest: string | null;
  newest: string | null;
  author_complete: number;
}

export interface ShuffleOptions {
  limit: number;
  minAgeDays: number;
  includeSeen: boolean;
  maxPerAuthor: number;
}

/**
 * Random selection excluding anything liked or reposted. Overselects, then
 * caps per author in JS so one prolific account can't fill the whole page.
 */
export function shuffle(options: ShuffleOptions): ShuffleRow[] {
  const cutoff = new Date(Date.now() - options.minAgeDays * 86_400_000).toISOString();

  const rows = db
    .prepare(
      `SELECT p.uri, p.created_at, a.handle, a.display_name, a.oldest, a.newest,
              a.complete AS author_complete
         FROM posts p
         JOIN authors a ON a.did = p.author_did
        WHERE p.created_at < @cutoff
          AND NOT EXISTS (SELECT 1 FROM excluded e WHERE e.uri = p.uri)
          AND (@includeSeen = 1 OR p.shown_at IS NULL)
        ORDER BY RANDOM()
        LIMIT @overselect`,
    )
    .all({
      cutoff,
      includeSeen: options.includeSeen ? 1 : 0,
      overselect: options.limit * 8,
    }) as ShuffleRow[];

  const perAuthor = new Map<string, number>();
  const picked: ShuffleRow[] = [];
  for (const row of rows) {
    const seen = perAuthor.get(row.handle) ?? 0;
    if (seen >= options.maxPerAuthor) continue;
    perAuthor.set(row.handle, seen + 1);
    picked.push(row);
    if (picked.length >= options.limit) break;
  }
  return picked;
}

export interface Stats {
  authors: number;
  authorsComplete: number;
  posts: number;
  excluded: number;
  unseen: number;
  oldest: string | null;
}

export function stats(): Stats {
  const one = <T>(sql: string): T => db.prepare(sql).get() as T;
  return {
    authors: one<{ n: number }>("SELECT COUNT(*) AS n FROM authors").n,
    authorsComplete: one<{ n: number }>("SELECT COUNT(*) AS n FROM authors WHERE complete = 1").n,
    posts: one<{ n: number }>("SELECT COUNT(*) AS n FROM posts").n,
    excluded: one<{ n: number }>(
      "SELECT COUNT(*) AS n FROM posts p WHERE EXISTS (SELECT 1 FROM excluded e WHERE e.uri = p.uri)",
    ).n,
    unseen: one<{ n: number }>("SELECT COUNT(*) AS n FROM posts WHERE shown_at IS NULL").n,
    oldest: one<{ d: string | null }>("SELECT MIN(created_at) AS d FROM posts").d,
  };
}
