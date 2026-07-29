import {
  AbortedError,
  cachePds,
  getAuthorMediaPage,
  getFollows,
  listRecordsDescending,
  requestsMade,
  resolveHandle,
  resolvePds,
  type FeedViewPost,
  type MediaFilter,
} from "./atproto.ts";
import {
  clearExclusions,
  completeAuthors,
  getMeta,
  insertExclusions,
  insertPosts,
  pendingAuthors,
  refreshAuthorRange,
  setMeta,
  updateAuthorProgress,
  upsertAuthors,
  type AuthorRow,
  type PostInsert,
} from "./store.ts";

export type CrawlPhase =
  | "identity"
  | "follows"
  | "exclusions"
  | "history"
  | "topup"
  | "done"
  | "stopped";

export interface CrawlProgress {
  phase: CrawlPhase;
  message: string;
  /** Fraction of the current phase, or null when the phase has no known total. */
  fraction: number | null;
  postsAdded: number;
  requests: number;
}

export interface CrawlOptions {
  depth: number;
  concurrency?: number;
  includeVideo?: boolean;
  fullExclusions?: boolean;
  /** Skips the re-read of page 1 for finished accounts. */
  refresh?: boolean;
  signal?: AbortSignal;
  onProgress?: (progress: CrawlProgress) => void;
  /** Fired the first time posts land, so the UI can show art mid-crawl. */
  onFirstPosts?: () => void;
}

export interface CrawlResult {
  did: string;
  handle: string;
  postsAdded: number;
  requests: number;
  pendingAccounts: number;
  stopped: boolean;
}

/**
 * Keeps only original media posts by the target author. getAuthorFeed mixes in
 * the author's reposts of other people, which carry a `reason` field, and
 * `posts_with_media` also lets through link-preview cards on some accounts.
 *
 * Embed shapes are nested: images may sit on the embed directly or under
 * `media` for recordWithMedia, and `$type` carries a `#view` suffix.
 */
export function extractMediaPosts(feed: FeedViewPost[], authorDid: string): PostInsert[] {
  const out: PostInsert[] = [];
  for (const item of feed) {
    if (item.reason) continue;
    const post = item.post;
    if (post.author.did !== authorDid) continue;

    const embedType = post.embed?.$type ?? "";
    const nested = post.embed?.media?.$type ?? "";
    const isImages =
      embedType.startsWith("app.bsky.embed.images") || nested.startsWith("app.bsky.embed.images");
    const isVideo =
      embedType.startsWith("app.bsky.embed.video") || nested.startsWith("app.bsky.embed.video");
    if (!isImages && !isVideo) continue;

    const images = post.embed?.images ?? post.embed?.media?.images;
    out.push({
      uri: post.uri,
      cid: post.cid,
      authorDid,
      createdAt: post.record?.createdAt ?? post.indexedAt ?? new Date().toISOString(),
      embedType: isVideo ? "video" : "images",
      mediaCount: Array.isArray(images) ? images.length : 1,
    });
  }
  return out;
}

/** Runs an async worker over a list with bounded concurrency. */
async function pool<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      const item = items[index];
      if (item !== undefined) await worker(item);
    }
  });
  await Promise.all(runners);
}

/** Crawls up to `depth` pages further back through one author's media history. */
async function crawlAuthor(
  author: AuthorRow,
  depth: number,
  filter: MediaFilter,
  signal: AbortSignal | undefined,
): Promise<number> {
  let cursor = author.cursor ?? undefined;
  let inserted = 0;
  let complete = false;

  for (let page = 0; page < depth; page += 1) {
    let result;
    try {
      result = await getAuthorMediaPage(author.did, cursor, filter, signal);
    } catch (err) {
      if (err instanceof AbortedError) throw err;
      console.warn(`${author.handle}: ${String(err).slice(0, 140)}`);
      break;
    }

    inserted += await insertPosts(extractMediaPosts(result.feed, author.did));

    // No cursor, or an empty page, means we have reached the end of the repo.
    if (!result.cursor || result.feed.length === 0) {
      complete = true;
      cursor = undefined;
      break;
    }
    cursor = result.cursor;
  }

  await updateAuthorProgress(author.did, cursor ?? null, complete);
  if (inserted > 0) await refreshAuthorRange(author.did);
  return inserted;
}

/**
 * Re-reads the newest page for an already-finished account so freshly posted art
 * gets picked up. Deliberately does not touch the stored cursor, which points at
 * the far end of the backfill, nor the `complete` flag.
 */
async function topUpAuthor(
  author: AuthorRow,
  filter: MediaFilter,
  signal: AbortSignal | undefined,
): Promise<number> {
  try {
    const result = await getAuthorMediaPage(author.did, undefined, filter, signal);
    const inserted = await insertPosts(extractMediaPosts(result.feed, author.did));
    if (inserted > 0) await refreshAuthorRange(author.did);
    return inserted;
  } catch (err) {
    if (err instanceof AbortedError) throw err;
    console.warn(`${author.handle}: ${String(err).slice(0, 140)}`);
    return 0;
  }
}

async function syncExclusions(
  pds: string,
  did: string,
  full: boolean,
  report: (message: string, fraction: number | null) => void,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (full) await clearExclusions();

  for (const [collection, reason] of [
    ["app.bsky.feed.like", "like"],
    ["app.bsky.feed.repost", "repost"],
  ] as const) {
    const metaKey = `${reason}_high_rkey`;
    if (full) await setMeta(metaKey, "");
    const stopAt = full ? undefined : (await getMeta(metaKey)) || undefined;

    const { records, highestRkey } = await listRecordsDescending(
      pds,
      did,
      collection,
      stopAt,
      (total) => report(`Reading your ${reason}s (${total})`, null),
      signal,
    );

    const rows = records
      .map((record) => record.value.subject?.uri)
      .filter((uri): uri is string => typeof uri === "string")
      .map((uri) => ({ uri, reason }));

    await insertExclusions(rows);
    if (highestRkey && (!stopAt || highestRkey > stopAt)) await setMeta(metaKey, highestRkey);
  }
}

/**
 * Full crawl for one account. Safe to call repeatedly: per-author cursors mean a
 * second run picks up exactly where the last one stopped, so a shallow pass can
 * be followed by a deeper one without redoing work.
 */
export async function crawl(handle: string, options: CrawlOptions): Promise<CrawlResult> {
  const {
    depth,
    concurrency = 4,
    includeVideo = false,
    fullExclusions = false,
    refresh = true,
    signal,
    onProgress,
    onFirstPosts,
  } = options;

  let postsAdded = 0;
  let announcedPosts = false;

  const report = (phase: CrawlPhase, message: string, fraction: number | null): void => {
    onProgress?.({ phase, message, fraction, postsAdded, requests: requestsMade() });
  };

  const countPosts = (added: number): void => {
    postsAdded += added;
    if (added > 0 && !announcedPosts) {
      announcedPosts = true;
      onFirstPosts?.();
    }
  };

  try {
    report("identity", `Looking up ${handle}`, null);
    const did = await resolveHandle(handle, signal);
    const pds = await resolvePds(did, signal);
    cachePds(did, pds);
    await setMeta("owner_did", did);
    await setMeta("owner_handle", handle.trim().replace(/^@/, "").toLowerCase());
    await setMeta("owner_pds", pds);

    report("follows", "Reading who you follow", null);
    const follows = await getFollows(
      did,
      (total) => report("follows", `Reading who you follow (${total})`, null),
      signal,
    );
    await upsertAuthors(follows);
    report("follows", `${follows.length} accounts followed`, 1);

    report("exclusions", "Reading your likes and reposts", null);
    await syncExclusions(
      pds,
      did,
      fullExclusions,
      (message, fraction) => report("exclusions", message, fraction),
      signal,
    );

    const filter: MediaFilter = includeVideo ? "posts_with_video" : "posts_with_media";
    const pending = await pendingAuthors();
    let done = 0;

    report("history", `Digging through ${pending.length} accounts`, pending.length ? 0 : 1);
    await pool(pending, concurrency, async (author) => {
      countPosts(await crawlAuthor(author, depth, filter, signal));
      done += 1;
      report(
        "history",
        `${done} of ${pending.length} accounts · ${postsAdded} posts found`,
        done / pending.length,
      );
    });

    if (refresh) {
      const finished = await completeAuthors();
      if (finished.length > 0) {
        let checked = 0;
        report("topup", `Checking ${finished.length} accounts for new posts`, 0);
        await pool(finished, concurrency, async (author) => {
          countPosts(await topUpAuthor(author, filter, signal));
          checked += 1;
          report(
            "topup",
            `Checked ${checked} of ${finished.length} for new posts`,
            checked / finished.length,
          );
        });
      }
    }

    const stillPending = (await pendingAuthors()).length;
    report("done", `${postsAdded} posts added`, 1);

    return {
      did,
      handle,
      postsAdded,
      requests: requestsMade(),
      pendingAccounts: stillPending,
      stopped: false,
    };
  } catch (err) {
    if (err instanceof AbortedError) {
      report("stopped", "Stopped. Progress is saved.", null);
      return {
        did: (await getMeta("owner_did")) ?? "",
        handle,
        postsAdded,
        requests: requestsMade(),
        pendingAccounts: (await pendingAuthors()).length,
        stopped: true,
      };
    }
    throw err;
  }
}
