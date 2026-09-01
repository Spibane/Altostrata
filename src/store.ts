/**
 * Deliberately still "strata" after the rename to Altostrata. This name is
 * invisible to users, and changing it would orphan every index already built —
 * the app would open empty while the old database sat there consuming quota.
 * IndexedDB is scoped per origin rather than per path, so on GitHub Pages this
 * is shared with any other project on the same subdomain; it needs to stay
 * distinctive, not current.
 */
const DB_NAME = "strata";
const DB_VERSION = 3;

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
  kept: number;
  oldest: string | null;
}

let dbPromise: Promise<IDBDatabase> | undefined;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  const attempt = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = () => reject(request.error ?? new Error("Could not open IndexedDB"));
    /**
     * A blocked open never fires `success` *or* `error` — it simply hangs. Without
     * this the whole app waits on a promise that can never settle, and because
     * every section starts out `hidden`, the page renders as a bare header with
     * no error and no way to tell why. Blocking happens whenever another tab
     * still holds a connection at the older version, i.e. on every schema bump.
     */
    request.onblocked = () =>
      reject(
        new Error(
          "Another tab has an older version of Altostrata open. Close or reload it, then reload this page.",
        ),
      );
    request.onsuccess = () => {
      const db = request.result;
      // The other half of the same problem: when *this* tab is the old one, it
      // has to step aside so the new tab's upgrade can start, rather than
      // blocking it forever.
      db.onversionchange = () => {
        db.close();
        dbPromise = undefined;
      };
      resolve(db);
    };
    request.onupgradeneeded = (event) => {
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
      // Kept out of `posts` so clearing seen state is a single store wipe.
      if (!db.objectStoreNames.contains("seen")) {
        db.createObjectStore("seen", { keyPath: "uri" });
      }
      // A purely local "hang onto this" shelf, independent of Bluesky auth — the
      // like/repost/bookmark exclusions above all require signing in, but
      // CLAUDE.md requires the app stay fully usable signed out.
      if (!db.objectStoreNames.contains("kept")) {
        db.createObjectStore("kept", { keyPath: "uri" });
      }

      if (db.objectStoreNames.contains("excluded")) {
        // v1 kept one row per uri, so a post could carry only one exclusion
        // reason — "Include Liked" could wrongly re-admit a post that was
        // excluded for a like but was *also* bookmarked or reposted. Migrate
        // to a compound [uri, reason] key so every reason a post is excluded
        // for survives independently of the others.
        if (event.oldVersion < 2) {
          const transaction = request.transaction;
          if (!transaction) throw new Error("Missing upgrade transaction");
          const oldStore = transaction.objectStore("excluded");
          const getAllRequest = oldStore.getAll();
          // Without this the read failing would leave the version at 2 while the
          // store kept its v1 keyPath and gained no `by_uri` index — every later
          // unlike would throw and multi-reason rows would silently collapse.
          // Aborting instead rolls the whole upgrade back to v1, data intact.
          getAllRequest.onerror = () => transaction.abort();
          getAllRequest.onsuccess = () => {
            const rows = getAllRequest.result as Array<{ uri: string; reason: string }>;
            db.deleteObjectStore("excluded");
            const store = db.createObjectStore("excluded", { keyPath: ["uri", "reason"] });
            store.createIndex("by_uri", "uri");
            for (const row of rows) store.put(row);
          };
        }
      } else {
        const store = db.createObjectStore("excluded", { keyPath: ["uri", "reason"] });
        store.createIndex("by_uri", "uri");
      }
    };
  });
  // Deliberately not caching a rejection: a blocked open resolves itself the
  // moment the other tab goes away, so a caller that retries should get a fresh
  // attempt rather than the first failure forever.
  attempt.catch(() => {
    dbPromise = undefined;
  });
  dbPromise = attempt;
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
/** `uri reason` pairs, so a second reason for an already-excluded uri still gets inserted. */
let excludedPairSet: Set<string> | undefined;
/** Subset of `excludedSet` excluded because of a like, so likes alone can be re-admitted. */
let likedSet: Set<string> | undefined;
/** Subset of `excludedSet` excluded for a reason other than a like, so it can never be waived. */
let nonWaivableSet: Set<string> | undefined;
let seenSet: Set<string> | undefined;
/** Locally kept posts. Never resurfaces regardless of "Allow repeats" or "Include liked". */
let keptSet: Set<string> | undefined;

interface Sets {
  excluded: Set<string>;
  pairs: Set<string>;
  liked: Set<string>;
  nonWaivable: Set<string>;
  seen: Set<string>;
  kept: Set<string>;
}

function pairKey(uri: string, reason: string): string {
  return `${uri} ${reason}`;
}

/**
 * Memoises the *promise*, not just the result. Two concurrent first-callers
 * would otherwise each build their own Set objects and each assign the
 * module-level vars — the loser then holds references the module no longer
 * uses, so an exclusion it inserts is written to the database but invisible to
 * `shuffle` until reload. `boot()` fires `syncBookmarks()` alongside `stats()`
 * and the first `dig()`, which is exactly that shape.
 */
let setsPromise: Promise<Sets> | undefined;

/**
 * Bumped by every wipe (`resetAll`, `clearExclusions`, `resetSeen`, `importIndex`).
 * A read that started before a wipe must not assign its now-stale Sets over the
 * empty ones the wipe installed — clearing `setsPromise` alone cannot stop an
 * already-running read from finishing.
 */
let setsEpoch = 0;

function invalidateSets(): void {
  setsEpoch += 1;
  setsPromise = undefined;
}

async function loadSets(): Promise<Sets> {
  if (excludedSet && excludedPairSet && likedSet && nonWaivableSet && seenSet && keptSet) {
    return {
      excluded: excludedSet,
      pairs: excludedPairSet,
      liked: likedSet,
      nonWaivable: nonWaivableSet,
      seen: seenSet,
      kept: keptSet,
    };
  }
  setsPromise ??= readSets().finally(() => {
    setsPromise = undefined;
  });
  return setsPromise;
}

async function readSets(): Promise<Sets> {
  const epoch = setsEpoch;
  const db = await openDb();
  const { transaction } = tx(db, ["excluded", "seen", "kept"], "readonly");
  const [excluded, seenKeys, keptKeys] = await Promise.all([
    wrap(transaction.objectStore("excluded").getAll()) as Promise<
      Array<{ uri: string; reason: string }>
    >,
    wrap(transaction.objectStore("seen").getAllKeys()),
    wrap(transaction.objectStore("kept").getAllKeys()),
  ]);
  const sets: Sets = {
    excluded: new Set(excluded.map((row) => row.uri)),
    pairs: new Set(excluded.map((row) => pairKey(row.uri, row.reason))),
    liked: new Set(excluded.filter((row) => row.reason === "like").map((row) => row.uri)),
    nonWaivable: new Set(excluded.filter((row) => row.reason !== "like").map((row) => row.uri)),
    seen: new Set(seenKeys as string[]),
    kept: new Set(keptKeys as string[]),
  };
  // A wipe landed while this read was in flight, so its result describes a
  // database state that no longer exists. Hand it back to this caller but leave
  // the module's Sets — which the wipe just emptied — alone.
  if (epoch !== setsEpoch) return sets;
  excludedSet = sets.excluded;
  excludedPairSet = sets.pairs;
  likedSet = sets.liked;
  nonWaivableSet = sets.nonWaivable;
  seenSet = sets.seen;
  keptSet = sets.kept;
  return sets;
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
  const { seen, kept } = await loadSets();
  const db = await openDb();
  // Seen and kept rows go with the posts. Leaving them behind inflated `seen`
  // against a shrinking `posts`, so the "still unseen" figure drifted further
  // from the truth every time a deleted post was cleaned up, and an orphaned
  // kept row pointed at a post that no longer exists to hydrate.
  const { transaction, done } = tx(db, ["posts", "seen", "kept"], "readwrite");
  const store = transaction.objectStore("posts");
  const seenStore = transaction.objectStore("seen");
  const keptStore = transaction.objectStore("kept");
  for (const uri of uris) {
    store.delete(uri);
    seenStore.delete(uri);
    keptStore.delete(uri);
  }
  await done;
  for (const uri of uris) {
    seen.delete(uri);
    kept.delete(uri);
  }
}

// ---------------------------------------------------------------------------
// Exclusions
// ---------------------------------------------------------------------------

export async function insertExclusions(
  rows: Array<{ uri: string; reason: string }>,
): Promise<number> {
  if (rows.length === 0) return 0;
  const { excluded, pairs, liked, nonWaivable } = await loadSets();
  const db = await openDb();
  const { transaction, done } = tx(db, ["excluded"], "readwrite");
  const store = transaction.objectStore("excluded");

  let added = 0;
  for (const row of rows) {
    const key = pairKey(row.uri, row.reason);
    if (pairs.has(key)) continue;
    store.put(row);
    pairs.add(key);
    excluded.add(row.uri);
    if (row.reason === "like") liked.add(row.uri);
    else nonWaivable.add(row.uri);
    added += 1;
  }
  await done;
  return added;
}

/** Used when a like/repost/bookmark is undone from inside Altostrata, so the post becomes findable again — unless another reason still excludes it. */
export async function removeExclusion(uri: string, reason: string): Promise<void> {
  const { excluded, pairs, liked, nonWaivable } = await loadSets();
  const db = await openDb();
  const { transaction, done } = tx(db, ["excluded"], "readwrite");
  const store = transaction.objectStore("excluded");
  store.delete([uri, reason]);
  const remainingRequest = wrap(store.index("by_uri").getAll(uri)) as Promise<
    Array<{ uri: string; reason: string }>
  >;
  // Both requests are issued before this await, so the transaction stays active
  // for both. Attaching a catch keeps a failed transaction from surfacing as an
  // unhandled rejection on this promise, which `await done` would beat to it.
  remainingRequest.catch(() => {});
  await done;
  const remaining = await remainingRequest;

  pairs.delete(pairKey(uri, reason));
  if (remaining.length === 0) {
    excluded.delete(uri);
    liked.delete(uri);
    nonWaivable.delete(uri);
  } else {
    if (!remaining.some((row) => row.reason === "like")) liked.delete(uri);
    if (!remaining.some((row) => row.reason !== "like")) nonWaivable.delete(uri);
  }
}

export async function clearExclusions(): Promise<void> {
  const db = await openDb();
  const { transaction, done } = tx(db, ["excluded"], "readwrite");
  transaction.objectStore("excluded").clear();
  await done;
  excludedSet = new Set();
  excludedPairSet = new Set();
  likedSet = new Set();
  nonWaivableSet = new Set();
  invalidateSets();
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
  invalidateSets();
  return count;
}

// ---------------------------------------------------------------------------
// Kept posts
//
// A purely local "hang onto this" shelf. Unlike likes/reposts/bookmarks it
// needs no Bluesky account, which is the only way a signed-out visitor can
// hold onto a find instead of losing it the moment `markShown` fires.
// ---------------------------------------------------------------------------

export async function keepPost(uri: string): Promise<void> {
  const { kept } = await loadSets();
  const db = await openDb();
  const { transaction, done } = tx(db, ["kept"], "readwrite");
  transaction.objectStore("kept").put({ uri, keptAt: new Date().toISOString() });
  await done;
  kept.add(uri);
}

export async function unkeepPost(uri: string): Promise<void> {
  const { kept } = await loadSets();
  const db = await openDb();
  const { transaction, done } = tx(db, ["kept"], "readwrite");
  transaction.objectStore("kept").delete(uri);
  await done;
  kept.delete(uri);
}

/** Snapshot of currently-kept URIs, so cards can render their star as already-lit. */
export async function keptUris(): Promise<Set<string>> {
  const { kept } = await loadSets();
  return kept;
}

/**
 * Enough of a row to draw a card. Kept posts are not always indexed ones: the
 * likes browser surfaces posts by accounts you don't follow, and starring one
 * of those used to drop it from this list entirely — the join against `posts`
 * found nothing and filtered it out, so the star silently did nothing.
 */
export interface KeptRow {
  uri: string;
  createdAt: string;
  authorOldest: string | null;
  authorNewest: string | null;
}

/**
 * Newest-kept first. Indexed posts are hydrated exactly the way `shuffle`
 * hydrates its picks, so they keep their depth gauge; the rest fall back to the
 * date they were kept, which the hydrated post's own `createdAt` then replaces.
 */
export async function keptRows(): Promise<KeptRow[]> {
  const db = await openDb();
  const keptTx = tx(db, ["kept"], "readonly");
  const keptEntries = (await wrap(keptTx.transaction.objectStore("kept").getAll())) as Array<{
    uri: string;
    keptAt: string;
  }>;
  keptEntries.sort((a, b) => (a.keptAt < b.keptAt ? 1 : -1));

  const postTx = tx(db, ["posts"], "readonly");
  const postStore = postTx.transaction.objectStore("posts");
  // Every request issued before the first await, so this second transaction
  // cannot auto-commit out from under a later lookup.
  const found = (await Promise.all(keptEntries.map((entry) => wrap(postStore.get(entry.uri))))).filter(
    (row): row is PostRow => row !== undefined,
  );
  const hydrated = new Map((await hydrateRows(db, found)).map((row) => [row.uri, row]));

  return keptEntries.map(
    (entry): KeptRow =>
      hydrated.get(entry.uri) ?? {
        uri: entry.uri,
        createdAt: entry.keptAt,
        authorOldest: null,
        authorNewest: null,
      },
  );
}

/**
 * Rows for whichever of `uris` the index already holds, keyed by URI. Used by
 * the likes browser, where the subjects come from someone else's repo rather
 * than from a scan of the index: the ones that are indexed get a real depth
 * gauge, the rest render without one instead of being dropped.
 */
export async function rowsForUris(uris: string[]): Promise<Map<string, ShuffleRow>> {
  if (uris.length === 0) return new Map();
  const db = await openDb();
  const postTx = tx(db, ["posts"], "readonly");
  const postStore = postTx.transaction.objectStore("posts");
  // Every request issued before the first await, as in `keptRows`, so the
  // transaction cannot auto-commit part-way through the lookups.
  const rows = (await Promise.all(uris.map((uri) => wrap(postStore.get(uri))))).filter(
    (row): row is PostRow => row !== undefined,
  );
  const hydrated = await hydrateRows(db, rows);
  return new Map(hydrated.map((row) => [row.uri, row]));
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

export interface ShuffleOptions {
  limit: number;
  minAgeDays: number;
  includeSeen: boolean;
  /** Re-admits posts excluded for a like. Reposts stay excluded regardless. */
  includeLiked: boolean;
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
 * A like exclusion can be waived by "Include Liked"; a repost or bookmark
 * exclusion cannot, even on a post that's also liked. A kept post is never
 * waivable either — it's a deliberate hold, not incidental exclusion state.
 * Shared between `shuffle` and `shuffleByAuthor` so the two selection paths
 * can't diverge.
 */
function isBlocked(
  uri: string,
  includeLiked: boolean,
  excluded: Set<string>,
  liked: Set<string>,
  nonWaivable: Set<string>,
  kept: Set<string>,
): boolean {
  if (kept.has(uri)) return true;
  return excluded.has(uri) && !(includeLiked && liked.has(uri) && !nonWaivable.has(uri));
}

/**
 * Samples the index by walking the random sort key from a random offset and
 * wrapping once. Age floor, exclusions, seen state and the per-author cap are
 * all applied during the scan, so a page never costs more than SCAN_LIMIT rows
 * however picked-over the index gets.
 */
export async function shuffle(options: ShuffleOptions): Promise<ShuffleRow[]> {
  const { excluded, liked, nonWaivable, seen, kept } = await loadSets();
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

        const blocked = isBlocked(row.uri, options.includeLiked, excluded, liked, nonWaivable, kept);

        const ok =
          row.createdAt < cutoff &&
          !blocked &&
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

  return hydrateRows(db, picked);
}

/** Fisher-Yates, so `shuffleByAuthor`'s full scan of one author doesn't return posts in URI order. */
function shuffleInPlace<T>(items: T[]): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [items[i], items[j]] = [items[j] as T, items[i] as T];
  }
  return items;
}

/**
 * Attaches author.handle/displayName/date-range info to a page of picked
 * posts. Deliberately a second transaction: the scan that produced `picked`
 * may have auto-committed once its last cursor request settled, so author
 * lookups get a fresh one.
 */
function hydrateRows(db: IDBDatabase, picked: PostRow[]): Promise<ShuffleRow[]> {
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

/**
 * Same filters as `shuffle`, scoped to one author via the `by_author` index
 * instead of sampling `by_rnd`. A single author's post count is small enough
 * to scan in full and shuffle in memory, rather than needing the
 * random-offset-with-wraparound trick `shuffle` uses over the whole index.
 */
export async function shuffleByAuthor(
  authorDid: string,
  options: Omit<ShuffleOptions, "maxPerAuthor">,
): Promise<ShuffleRow[]> {
  const { excluded, liked, nonWaivable, seen, kept } = await loadSets();
  const cutoff = new Date(Date.now() - options.minAgeDays * 86_400_000).toISOString();
  const db = await openDb();

  const matches: PostRow[] = [];
  // Bounds rows *scanned*, not rows kept, matching `shuffle`. Counting only
  // matches meant that an author whose posts were all filtered out — the normal
  // end state, once everything has been seen — walked their entire history on
  // every dig without the cap ever coming close.
  let scanned = 0;
  await new Promise<void>((resolve, reject) => {
    const index = tx(db, ["posts"], "readonly").transaction.objectStore("posts").index("by_author");
    const cursorRequest = index.openCursor(IDBKeyRange.only(authorDid));
    cursorRequest.onerror = () => reject(cursorRequest.error);
    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result;
      if (!cursor || scanned >= SCAN_LIMIT) {
        resolve();
        return;
      }
      scanned += 1;
      const row = cursor.value as PostRow;
      const blocked = isBlocked(row.uri, options.includeLiked, excluded, liked, nonWaivable, kept);
      const ok = row.createdAt < cutoff && !blocked && (options.includeSeen || !seen.has(row.uri));
      if (ok) matches.push(row);
      cursor.continue();
    };
  });

  const picked = shuffleInPlace(matches).slice(0, options.limit);
  return hydrateRows(db, picked);
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

export async function stats(): Promise<Stats> {
  const { excluded, seen, kept } = await loadSets();
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
    kept: kept.size,
    oldest: oldestKey,
  };
}

/** Post counts per author, for the account picker in the Index panel. */
export async function authorPostCounts(): Promise<Map<string, number>> {
  const db = await openDb();
  const { transaction } = tx(db, ["authors", "posts"], "readonly");
  const authors = (await wrap(transaction.objectStore("authors").getAll())) as AuthorRow[];
  const index = transaction.objectStore("posts").index("by_author");
  const counts = new Map<string, number>();
  await Promise.all(
    authors.map(async (author) => {
      counts.set(author.did, await wrap(index.count(author.did)));
    }),
  );
  return counts;
}

// ---------------------------------------------------------------------------
// Whole-index operations
// ---------------------------------------------------------------------------

export async function resetAll(): Promise<void> {
  const db = await openDb();
  const names = ["meta", "authors", "posts", "excluded", "seen", "kept"];
  const { transaction, done } = tx(db, names, "readwrite");
  for (const name of names) transaction.objectStore(name).clear();
  await done;
  excludedSet = new Set();
  excludedPairSet = new Set();
  likedSet = new Set();
  nonWaivableSet = new Set();
  seenSet = new Set();
  keptSet = new Set();
  invalidateSets();
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
  // Optional on the way in: this type also describes files handed to us by a
  // user, which may be older exports or edited by hand.
  owner?: { did: string | null; handle: string | null };
  checkpoints?: { likeHighRkey: string | null; repostHighRkey: string | null };
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

/**
 * Field names come from the imported file, so `__proto__` and friends must not be
 * able to reach an object's prototype. A null-prototype object has none to reach.
 */
function rowToObject(fields: readonly string[], row: unknown[]): Record<string, unknown> {
  const out = Object.create(null) as Record<string, unknown>;
  fields.forEach((field, i) => {
    if (field === "__proto__" || field === "constructor" || field === "prototype") return;
    out[field] = row[i] ?? null;
  });
  return out;
}

function asRows(value: unknown, label: string): unknown[][] {
  if (!Array.isArray(value)) throw new Error(`Missing or malformed "${label}" list`);
  const bad = value.findIndex((row) => !Array.isArray(row));
  if (bad !== -1) throw new Error(`Entry ${bad + 1} of "${label}" is not a row`);
  return value as unknown[][];
}

/**
 * Checked in full *before* anything is written, because importing replaces the
 * whole index. Validating as we went would leave a half-wiped index behind on a
 * malformed file — and an export is exactly what someone reaches for after losing
 * data, so destroying it on a wrong pick is the worst possible failure.
 */
function validateIndexFile(file: IndexFile): void {
  if (!file || typeof file !== "object") throw new Error("That file is not an index export");
  if (file.version !== 1) {
    throw new Error(`Unsupported index version ${String(file.version)} — expected 1`);
  }
  asRows(file.authors, "authors");
  asRows(file.posts, "posts");
  asRows(file.excluded, "excluded");

  for (const [key, value] of [
    ["authorFields", file.authorFields],
    ["postFields", file.postFields],
    ["excludedFields", file.excludedFields],
  ] as const) {
    if (value !== undefined && !Array.isArray(value)) {
      throw new Error(`Malformed "${key}" in that file`);
    }
  }

  // A row with no URI would import as the string "undefined" and poison selection.
  const postFields = file.postFields ?? POST_FIELDS;
  const uriAt = postFields.indexOf("uri");
  if (file.posts.length > 0 && uriAt === -1) throw new Error(`"postFields" does not include a uri`);
}

function toWholeNumber(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
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
  validateIndexFile(file);

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
        // A NaN here would silently drop the row out of the by_complete index,
        // leaving an author that never gets crawled and never reports done.
        complete: toWholeNumber(o.complete, 0),
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
        mediaCount: toWholeNumber(o.mediaCount, 1),
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

  // All six, so a future change to loadSets that refreshes them independently
  // cannot leave a stale subset behind. `setsPromise` too, or an in-flight read
  // started before the import would resolve into the post-import world.
  excludedSet = undefined;
  excludedPairSet = undefined;
  likedSet = undefined;
  nonWaivableSet = undefined;
  seenSet = undefined;
  keptSet = undefined;
  invalidateSets();

  // Optional: an export from an older build, or a hand-trimmed one, may omit these.
  if (file.owner?.did) await setMeta("owner_did", String(file.owner.did));
  if (file.owner?.handle) await setMeta("owner_handle", String(file.owner.handle));
  if (file.checkpoints?.likeHighRkey) {
    await setMeta("like_high_rkey", String(file.checkpoints.likeHighRkey));
  }
  if (file.checkpoints?.repostHighRkey) {
    await setMeta("repost_high_rkey", String(file.checkpoints.repostHighRkey));
  }

  return {
    authors: file.authors.length,
    posts: file.posts.length,
    excluded: file.excluded.length,
  };
}
