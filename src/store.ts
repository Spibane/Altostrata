const DB_NAME = "strata";
const DB_VERSION = 1;

export interface AuthorRow {
  did: string;
  handle: string;
  displayName: string | null;
  cursor: string | null;
  complete: number;
  lastCrawled: string | null;
  oldest: string | null;
  newest: string | null;
}

export interface PostRow {
  uri: string;
  cid: string;
  authorDid: string;
  createdAt: string;
  embedType: string;
  mediaCount: number;
  /** Fixed random sort key. Makes "random sample" an index range scan. */
  rnd: number;
}

export interface Stats {
  authors: number;
  authorsComplete: number;
  posts: number;
  excluded: number;
  seen: number;
  unseen: number;
  oldest: string | null;
}

let dbPromise: Promise<IDBDatabase> | undefined;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = () => reject(request.error ?? new Error("Could not open IndexedDB"));
    request.onsuccess = () => resolve(request.result);
    request.onupgradeneeded = () => {
      const db = request.result;

      if (!db.objectStoreNames.contains("meta")) {
        db.createObjectStore("meta");
      }
      if (!db.objectStoreNames.contains("authors")) {
        const authors = db.createObjectStore("authors", { keyPath: "did" });
        authors.createIndex("by_complete", "complete");
      }
      if (!db.objectStoreNames.contains("posts")) {
        const posts = db.createObjectStore("posts", { keyPath: "uri" });
        posts.createIndex("by_author", "authorDid");
        posts.createIndex("by_created", "createdAt");
        posts.createIndex("by_rnd", "rnd");
      }
      if (!db.objectStoreNames.contains("excluded")) {
        db.createObjectStore("excluded", { keyPath: "uri" });
      }
      // Kept out of `posts` so clearing seen state is a single store wipe.
      if (!db.objectStoreNames.contains("seen")) {
        db.createObjectStore("seen", { keyPath: "uri" });
      }
    };
  });
  return dbPromise;
}

function tx(
  db: IDBDatabase,
  names: string[],
  mode: IDBTransactionMode,
): { transaction: IDBTransaction; done: Promise<void> } {
  const transaction = db.transaction(names, mode);
  const done = new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error("Transaction aborted"));
    transaction.onerror = () => reject(transaction.error ?? new Error("Transaction failed"));
  });
  // Read-only callers ignore `done`; attaching a handler here keeps a failed
  // transaction from surfacing as an unhandled rejection while still letting
  // anyone who does await it see the error.
  done.catch(() => {});
  return { transaction, done };
}

function wrap<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Request failed"));
  });
}

// ---------------------------------------------------------------------------
// In-memory mirrors
//
// Exclusions and seen state are needed on every candidate during a shuffle.
// Holding them as Sets keeps selection to one index scan instead of two lookups
// per row. Both are string-only and small next to the post index itself.
// ---------------------------------------------------------------------------

let excludedSet: Set<string> | undefined;
let seenSet: Set<string> | undefined;

async function loadSets(): Promise<{ excluded: Set<string>; seen: Set<string> }> {
  if (excludedSet && seenSet) return { excluded: excludedSet, seen: seenSet };
  const db = await openDb();
  const { transaction } = tx(db, ["excluded", "seen"], "readonly");
  const [excludedKeys, seenKeys] = await Promise.all([
    wrap(transaction.objectStore("excluded").getAllKeys()),
    wrap(transaction.objectStore("seen").getAllKeys()),
  ]);
  excludedSet = new Set(excludedKeys as string[]);
  seenSet = new Set(seenKeys as string[]);
  return { excluded: excludedSet, seen: seenSet };
}

// ---------------------------------------------------------------------------
// Meta
// ---------------------------------------------------------------------------

export async function setMeta(key: string, value: string): Promise<void> {
  const db = await openDb();
  const { transaction, done } = tx(db, ["meta"], "readwrite");
  transaction.objectStore("meta").put(value, key);
  await done;
}

export async function getMeta(key: string): Promise<string | undefined> {
  const db = await openDb();
  const { transaction } = tx(db, ["meta"], "readonly");
  const value = await wrap(transaction.objectStore("meta").get(key));
  return typeof value === "string" ? value : undefined;
}

// ---------------------------------------------------------------------------
// Authors
// ---------------------------------------------------------------------------

/**
 * Upserts follow-graph data without clobbering crawl progress. Unfollowed
 * accounts keep their indexed posts but stop being crawled.
 */
export async function upsertAuthors(
  authors: Array<{ did: string; handle: string; displayName?: string }>,
): Promise<void> {
  const db = await openDb();
  const { transaction, done } = tx(db, ["authors"], "readwrite");
  const store = transaction.objectStore("authors");
  for (const author of authors) {
    const existing = (await wrap(store.get(author.did))) as AuthorRow | undefined;
    store.put({
      did: author.did,
      handle: author.handle,
      displayName: author.displayName ?? null,
      cursor: existing?.cursor ?? null,
      complete: existing?.complete ?? 0,
      lastCrawled: existing?.lastCrawled ?? null,
      oldest: existing?.oldest ?? null,
      newest: existing?.newest ?? null,
    } satisfies AuthorRow);
  }
  await done;
}

async function authorsWhere(complete: 0 | 1): Promise<AuthorRow[]> {
  const db = await openDb();
  const { transaction } = tx(db, ["authors"], "readonly");
  const rows = (await wrap(
    transaction.objectStore("authors").index("by_complete").getAll(complete),
  )) as AuthorRow[];
  return rows;
}

export function pendingAuthors(): Promise<AuthorRow[]> {
  return authorsWhere(0);
}

export function completeAuthors(): Promise<AuthorRow[]> {
  return authorsWhere(1);
}

export async function allAuthors(): Promise<AuthorRow[]> {
  const db = await openDb();
  const { transaction } = tx(db, ["authors"], "readonly");
  return (await wrap(transaction.objectStore("authors").getAll())) as AuthorRow[];
}

export async function updateAuthorProgress(
  did: string,
  cursor: string | null,
  complete: boolean,
): Promise<void> {
  const db = await openDb();
  const { transaction, done } = tx(db, ["authors"], "readwrite");
  const store = transaction.objectStore("authors");
  const row = (await wrap(store.get(did))) as AuthorRow | undefined;
  if (row) {
    row.cursor = cursor;
    row.complete = complete ? 1 : 0;
    row.lastCrawled = new Date().toISOString();
    store.put(row);
  }
  await done;
}

/** Recomputes an author's indexed date range, which drives the depth gauge. */
export async function refreshAuthorRange(did: string): Promise<void> {
  const db = await openDb();
  const { transaction, done } = tx(db, ["authors", "posts"], "readwrite");
  const posts = transaction.objectStore("posts").index("by_author");

  let oldest: string | null = null;
  let newest: string | null = null;
  const rows = (await wrap(posts.getAll(did))) as PostRow[];
  for (const row of rows) {
    if (oldest === null || row.createdAt < oldest) oldest = row.createdAt;
    if (newest === null || row.createdAt > newest) newest = row.createdAt;
  }

  const store = transaction.objectStore("authors");
  const author = (await wrap(store.get(did))) as AuthorRow | undefined;
  if (author) {
    author.oldest = oldest;
    author.newest = newest;
    store.put(author);
  }
  await done;
}

// ---------------------------------------------------------------------------
// Posts
// ---------------------------------------------------------------------------

export type PostInsert = Omit<PostRow, "rnd">;

/** Inserts only URIs we do not already have. Returns how many were new. */
export async function insertPosts(rows: PostInsert[]): Promise<number> {
  if (rows.length === 0) return 0;
  const db = await openDb();
  const { transaction, done } = tx(db, ["posts"], "readwrite");
  const store = transaction.objectStore("posts");

  let inserted = 0;
  await Promise.all(
    rows.map(async (row) => {
      const existing = await wrap(store.count(row.uri));
      if (existing > 0) return;
      store.put({ ...row, rnd: Math.random() } satisfies PostRow);
      inserted += 1;
    }),
  );
  await done;
  return inserted;
}

export async function deletePosts(uris: string[]): Promise<void> {
  if (uris.length === 0) return;
  const db = await openDb();
  const { transaction, done } = tx(db, ["posts"], "readwrite");
  const store = transaction.objectStore("posts");
  for (const uri of uris) store.delete(uri);
  await done;
}

// ---------------------------------------------------------------------------
// Exclusions
// ---------------------------------------------------------------------------

export async function insertExclusions(
  rows: Array<{ uri: string; reason: string }>,
): Promise<number> {
  if (rows.length === 0) return 0;
  const { excluded } = await loadSets();
  const db = await openDb();
  const { transaction, done } = tx(db, ["excluded"], "readwrite");
  const store = transaction.objectStore("excluded");

  let added = 0;
  for (const row of rows) {
    if (excluded.has(row.uri)) continue;
    store.put(row);
    excluded.add(row.uri);
    added += 1;
  }
  await done;
  return added;
}

/** Used when a like is undone from inside Strata, so the post becomes findable again. */
export async function removeExclusion(uri: string): Promise<void> {
  const { excluded } = await loadSets();
  const db = await openDb();
  const { transaction, done } = tx(db, ["excluded"], "readwrite");
  transaction.objectStore("excluded").delete(uri);
  await done;
  excluded.delete(uri);
}

export async function clearExclusions(): Promise<void> {
  const db = await openDb();
  const { transaction, done } = tx(db, ["excluded"], "readwrite");
  transaction.objectStore("excluded").clear();
  await done;
  excludedSet = new Set();
}

// ---------------------------------------------------------------------------
// Seen state
// ---------------------------------------------------------------------------

export async function markShown(uris: string[]): Promise<void> {
  if (uris.length === 0) return;
  const { seen } = await loadSets();
  const db = await openDb();
  const { transaction, done } = tx(db, ["seen"], "readwrite");
  const store = transaction.objectStore("seen");
  const shownAt = new Date().toISOString();
  for (const uri of uris) {
    store.put({ uri, shownAt });
    seen.add(uri);
  }
  await done;
}

/** Forgets every post that has been surfaced, without touching the index. */
export async function resetSeen(): Promise<number> {
  const { seen } = await loadSets();
  const count = seen.size;
  const db = await openDb();
  const { transaction, done } = tx(db, ["seen"], "readwrite");
  transaction.objectStore("seen").clear();
  await done;
  seenSet = new Set();
  return count;
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

export interface ShuffleOptions {
  limit: number;
  minAgeDays: number;
  includeSeen: boolean;
  maxPerAuthor: number;
}

export interface ShuffleRow extends PostRow {
  handle: string;
  displayName: string | null;
  authorOldest: string | null;
  authorNewest: string | null;
  authorComplete: number;
}

/** Bounds the work a single shuffle will do when almost everything is filtered out. */
const SCAN_LIMIT = 40_000;

/**
 * Samples the index by walking the random sort key from a random offset and
 * wrapping once. Age floor, exclusions, seen state and the per-author cap are
 * all applied during the scan, so a page never costs more than SCAN_LIMIT rows
 * however picked-over the index gets.
 */
export async function shuffle(options: ShuffleOptions): Promise<ShuffleRow[]> {
  const { excluded, seen } = await loadSets();
  const cutoff = new Date(Date.now() - options.minAgeDays * 86_400_000).toISOString();

  const db = await openDb();

  const picked: PostRow[] = [];
  const perAuthor = new Map<string, number>();
  let scanned = 0;

  // A fresh transaction per pass: the first scan's transaction commits as soon as
  // its last cursor request settles, so the wrap-around cannot borrow it.
  const collect = (from: number, upTo: number): Promise<void> =>
    new Promise((resolve, reject) => {
      const index = tx(db, ["posts"], "readonly").transaction
        .objectStore("posts")
        .index("by_rnd");
      const range = IDBKeyRange.bound(from, upTo);
      const cursorRequest = index.openCursor(range);
      cursorRequest.onerror = () => reject(cursorRequest.error);
      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
        if (!cursor || picked.length >= options.limit || scanned >= SCAN_LIMIT) {
          resolve();
          return;
        }
        scanned += 1;
        const row = cursor.value as PostRow;

        const ok =
          row.createdAt < cutoff &&
          !excluded.has(row.uri) &&
          (options.includeSeen || !seen.has(row.uri)) &&
          (perAuthor.get(row.authorDid) ?? 0) < options.maxPerAuthor;

        if (ok) {
          perAuthor.set(row.authorDid, (perAuthor.get(row.authorDid) ?? 0) + 1);
          picked.push(row);
        }
        cursor.continue();
      };
    });

  const start = Math.random();
  await collect(start, 1);
  if (picked.length < options.limit && scanned < SCAN_LIMIT) {
    await collect(0, start); // wrap around once
  }

  // Deliberately a second transaction: the scan above may have auto-committed
  // once its last cursor request settled, so author lookups get a fresh one.
  const authorTx = tx(db, ["authors"], "readonly");
  const authorStore = authorTx.transaction.objectStore("authors");
  return Promise.all(
    picked.map(async (row): Promise<ShuffleRow> => {
      const author = (await wrap(authorStore.get(row.authorDid))) as AuthorRow | undefined;
      return {
        ...row,
        handle: author?.handle ?? "unknown",
        displayName: author?.displayName ?? null,
        authorOldest: author?.oldest ?? null,
        authorNewest: author?.newest ?? null,
        authorComplete: author?.complete ?? 0,
      };
    }),
  );
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

export async function stats(): Promise<Stats> {
  const { excluded, seen } = await loadSets();
  const db = await openDb();
  const { transaction } = tx(db, ["authors", "posts"], "readonly");
  const authorStore = transaction.objectStore("authors");
  const postStore = transaction.objectStore("posts");

  // Every request is issued before the first await, so the transaction cannot
  // commit out from under a later one.
  const authorsRequest = wrap(authorStore.count());
  const completeRequest = wrap(authorStore.index("by_complete").count(1));
  const postsRequest = wrap(postStore.count());
  const oldestRequest = new Promise<string | null>((resolve, reject) => {
    const request = postStore.index("by_created").openKeyCursor(null, "next");
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve((request.result?.key as string | undefined) ?? null);
  });

  const [authors, authorsComplete, posts, oldestKey] = await Promise.all([
    authorsRequest,
    completeRequest,
    postsRequest,
    oldestRequest,
  ]);

  return {
    authors,
    authorsComplete,
    posts,
    excluded: excluded.size,
    seen: seen.size,
    unseen: Math.max(0, posts - seen.size),
    oldest: oldestKey,
  };
}

// ---------------------------------------------------------------------------
// Whole-index operations
// ---------------------------------------------------------------------------

export async function resetAll(): Promise<void> {
  const db = await openDb();
  const names = ["meta", "authors", "posts", "excluded", "seen"];
  const { transaction, done } = tx(db, names, "readwrite");
  for (const name of names) transaction.objectStore(name).clear();
  await done;
  excludedSet = new Set();
  seenSet = new Set();
}

/** Best-effort request that the browser stop evicting this index. */
export async function requestPersistence(): Promise<boolean> {
  if (!navigator.storage?.persist) return false;
  if (await navigator.storage.persisted()) return true;
  return navigator.storage.persist();
}

export async function estimateUsage(): Promise<{ usage: number; quota: number } | null> {
  if (!navigator.storage?.estimate) return null;
  const { usage = 0, quota = 0 } = await navigator.storage.estimate();
  return { usage, quota };
}

// ---------------------------------------------------------------------------
// Export / import
//
// Tuple rows rather than objects: the payload is a third of the size, which
// matters when the whole index has to fit through a file download.
// ---------------------------------------------------------------------------

const AUTHOR_FIELDS = [
  "did",
  "handle",
  "displayName",
  "cursor",
  "complete",
  "lastCrawled",
  "oldest",
  "newest",
] as const;
const POST_FIELDS = ["uri", "cid", "authorDid", "createdAt", "embedType", "mediaCount"] as const;

export interface IndexFile {
  version: number;
  exportedAt: string;
  owner: { did: string | null; handle: string | null };
  checkpoints: { likeHighRkey: string | null; repostHighRkey: string | null };
  authorFields?: readonly string[];
  authors: unknown[][];
  postFields?: readonly string[];
  posts: unknown[][];
  excludedFields?: readonly string[];
  excluded: unknown[][];
}

export async function exportIndex(): Promise<IndexFile> {
  const db = await openDb();
  const { transaction } = tx(db, ["authors", "posts", "excluded"], "readonly");
  const [authors, posts, excluded] = await Promise.all([
    wrap(transaction.objectStore("authors").getAll()) as Promise<AuthorRow[]>,
    wrap(transaction.objectStore("posts").getAll()) as Promise<PostRow[]>,
    wrap(transaction.objectStore("excluded").getAll()) as Promise<
      Array<{ uri: string; reason: string }>
    >,
  ]);

  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    owner: {
      did: (await getMeta("owner_did")) ?? null,
      handle: (await getMeta("owner_handle")) ?? null,
    },
    checkpoints: {
      likeHighRkey: (await getMeta("like_high_rkey")) ?? null,
      repostHighRkey: (await getMeta("repost_high_rkey")) ?? null,
    },
    authorFields: AUTHOR_FIELDS,
    authors: authors.map((a) => AUTHOR_FIELDS.map((f) => a[f])),
    postFields: POST_FIELDS,
    posts: posts.map((p) => POST_FIELDS.map((f) => p[f])),
    excludedFields: ["uri", "reason"],
    excluded: excluded.map((e) => [e.uri, e.reason]),
  };
}

function rowToObject(fields: readonly string[], row: unknown[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  fields.forEach((field, i) => {
    out[field] = row[i] ?? null;
  });
  return out;
}

export interface ImportResult {
  authors: number;
  posts: number;
  excluded: number;
}

/**
 * Replaces the whole index with the contents of an export. Field names travel
 * with the file so an older export still lands in the right columns.
 */
export async function importIndex(
  file: IndexFile,
  onProgress?: (message: string) => void,
): Promise<ImportResult> {
  if (file.version !== 1) throw new Error(`Unsupported index version ${file.version}`);

  await resetAll();

  const authorFields = file.authorFields ?? AUTHOR_FIELDS;
  const postFields = file.postFields ?? POST_FIELDS;
  const db = await openDb();

  onProgress?.(`Importing ${file.authors.length} accounts`);
  {
    const { transaction, done } = tx(db, ["authors"], "readwrite");
    const store = transaction.objectStore("authors");
    for (const row of file.authors) {
      const o = rowToObject(authorFields, row);
      store.put({
        did: String(o.did),
        handle: String(o.handle ?? "unknown"),
        displayName: o.displayName === null ? null : String(o.displayName),
        cursor: o.cursor === null ? null : String(o.cursor),
        complete: Number(o.complete ?? 0),
        lastCrawled: o.lastCrawled === null ? null : String(o.lastCrawled),
        oldest: o.oldest === null ? null : String(o.oldest),
        newest: o.newest === null ? null : String(o.newest),
      } satisfies AuthorRow);
    }
    await done;
  }

  // Chunked so a large import reports progress and never builds one huge txn.
  const CHUNK = 5000;
  for (let i = 0; i < file.posts.length; i += CHUNK) {
    const chunk = file.posts.slice(i, i + CHUNK);
    const { transaction, done } = tx(db, ["posts"], "readwrite");
    const store = transaction.objectStore("posts");
    for (const row of chunk) {
      const o = rowToObject(postFields, row);
      store.put({
        uri: String(o.uri),
        cid: String(o.cid),
        authorDid: String(o.authorDid),
        createdAt: String(o.createdAt),
        embedType: String(o.embedType ?? "images"),
        mediaCount: Number(o.mediaCount ?? 1),
        rnd: Math.random(),
      } satisfies PostRow);
    }
    await done;
    onProgress?.(`Imported ${Math.min(i + CHUNK, file.posts.length)} of ${file.posts.length} posts`);
  }

  {
    const { transaction, done } = tx(db, ["excluded"], "readwrite");
    const store = transaction.objectStore("excluded");
    for (const row of file.excluded) {
      const o = rowToObject(file.excludedFields ?? ["uri", "reason"], row);
      store.put({ uri: String(o.uri), reason: String(o.reason ?? "like") });
    }
    await done;
  }

  excludedSet = undefined;
  seenSet = undefined;

  if (file.owner.did) await setMeta("owner_did", file.owner.did);
  if (file.owner.handle) await setMeta("owner_handle", file.owner.handle);
  if (file.checkpoints.likeHighRkey) await setMeta("like_high_rkey", file.checkpoints.likeHighRkey);
  if (file.checkpoints.repostHighRkey) {
    await setMeta("repost_high_rkey", file.checkpoints.repostHighRkey);
  }

  return {
    authors: file.authors.length,
    posts: file.posts.length,
    excluded: file.excluded.length,
  };
}
