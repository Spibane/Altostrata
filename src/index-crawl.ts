import {
  getAuthorMediaPage,
  getFollows,
  listRecordsDescending,
  requestsMade,
  resolveHandle,
  resolvePds,
  type FeedViewPost,
} from "./atproto.ts";
import {
  clearExclusions,
  completeAuthors,
  getMeta,
  insertExclusions,
  insertPosts,
  pendingAuthors,
  refreshAuthorRange,
  resetCrawl,
  setMeta,
  stats,
  updateAuthorProgress,
  upsertAuthors,
  type PostInsert,
} from "./db.ts";

interface Args {
  handle?: string;
  depth: number;
  concurrency: number;
  statsOnly: boolean;
  fullLikes: boolean;
  reset: boolean;
  includeVideo: boolean;
  refresh: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    handle: process.env.BSKY_HANDLE,
    depth: 5,
    concurrency: 4,
    statsOnly: false,
    fullLikes: false,
    reset: false,
    includeVideo: false,
    refresh: true,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    switch (arg) {
      case "--handle":
        args.handle = next;
        i += 1;
        break;
      case "--depth":
        args.depth = Number(next);
        i += 1;
        break;
      case "--concurrency":
        args.concurrency = Number(next);
        i += 1;
        break;
      case "--stats-only":
        args.statsOnly = true;
        break;
      case "--full-likes":
        args.fullLikes = true;
        break;
      case "--reset":
        args.reset = true;
        break;
      case "--include-video":
        args.includeVideo = true;
        break;
      case "--no-refresh":
        args.refresh = false;
        break;
      default:
        if (arg && !arg.startsWith("--") && !args.handle) args.handle = arg;
    }
  }
  return args;
}

function printStats(): void {
  const s = stats();
  console.log(
    [
      "",
      `  Accounts followed      ${s.authors}`,
      `  Fully crawled          ${s.authorsComplete}`,
      `  Media posts indexed    ${s.posts}`,
      `  Liked or reposted      ${s.excluded}`,
      `  Never surfaced         ${s.unseen}`,
      `  Oldest indexed post    ${s.oldest ? s.oldest.slice(0, 10) : "none yet"}`,
      "",
    ].join("\n"),
  );
}

/**
 * Keeps only original media posts by the target author. getAuthorFeed mixes in
 * the author's reposts of other people, which carry a `reason` field, and
 * `posts_with_media` also lets through link-preview cards on some accounts.
 */
function extractMediaPosts(feed: FeedViewPost[], authorDid: string): PostInsert[] {
  const out: PostInsert[] = [];
  for (const item of feed) {
    if (item.reason) continue;
    const post = item.post;
    if (post.author.did !== authorDid) continue;

    const embedType = post.embed?.$type ?? "";
    const nested = post.embed?.media?.$type ?? "";
    const isImages = embedType.startsWith("app.bsky.embed.images") || nested.startsWith("app.bsky.embed.images");
    const isVideo = embedType.startsWith("app.bsky.embed.video") || nested.startsWith("app.bsky.embed.video");
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

/** Crawls up to `depth` pages further back through one author's media history. */
async function crawlAuthor(
  author: { did: string; handle: string; cursor: string | null },
  depth: number,
  filter: "posts_with_media" | "posts_with_video",
): Promise<{ inserted: number; complete: boolean }> {
  let cursor = author.cursor ?? undefined;
  let inserted = 0;
  let complete = false;

  for (let page = 0; page < depth; page += 1) {
    let result;
    try {
      result = await getAuthorMediaPage(author.did, cursor, filter);
    } catch (err) {
      console.warn(`  ! ${author.handle}: ${String(err).slice(0, 140)}`);
      break;
    }

    inserted += insertPosts(extractMediaPosts(result.feed, author.did));

    // No cursor, or an empty page, means we have reached the end of the repo.
    if (!result.cursor || result.feed.length === 0) {
      complete = true;
      cursor = undefined;
      break;
    }
    cursor = result.cursor;
  }

  updateAuthorProgress(author.did, cursor ?? null, complete);
  refreshAuthorRange(author.did);
  return { inserted, complete };
}

/**
 * Re-reads the newest page for an already-finished account so freshly posted
 * art gets picked up. Deliberately does not touch the stored cursor, which
 * points at the far end of the backfill.
 */
async function topUpAuthor(
  author: { did: string; handle: string },
  filter: "posts_with_media" | "posts_with_video",
): Promise<number> {
  try {
    const result = await getAuthorMediaPage(author.did, undefined, filter);
    const inserted = insertPosts(extractMediaPosts(result.feed, author.did));
    if (inserted > 0) refreshAuthorRange(author.did);
    return inserted;
  } catch (err) {
    console.warn(`  ! ${author.handle}: ${String(err).slice(0, 140)}`);
    return 0;
  }
}

/** Runs an async worker over a list with bounded concurrency. */
async function pool<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
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

async function syncExclusions(pds: string, did: string, full: boolean): Promise<void> {
  for (const [collection, reason] of [
    ["app.bsky.feed.like", "like"],
    ["app.bsky.feed.repost", "repost"],
  ] as const) {
    const metaKey = `${reason}_high_rkey`;
    if (full) {
      clearExclusions(reason);
      setMeta(metaKey, "");
    }
    const stopAt = full ? undefined : getMeta(metaKey) || undefined;

    const { records, highestRkey } = await listRecordsDescending(pds, did, collection, stopAt);
    const rows = records
      .map((record) => record.value.subject?.uri)
      .filter((uri): uri is string => typeof uri === "string")
      .map((uri) => ({ uri, reason }));

    const added = insertExclusions(rows);
    if (highestRkey && (!stopAt || highestRkey > stopAt)) setMeta(metaKey, highestRkey);
    console.log(`  ${reason}s: ${added} new (${records.length} records scanned)`);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.statsOnly) {
    printStats();
    return;
  }

  if (!args.handle) {
    console.error(
      "Which account's follows should I index?\n" +
        "  npm run index -- --handle you.bsky.social\n" +
        "Or set BSKY_HANDLE in your environment.",
    );
    process.exit(1);
  }

  const started = Date.now();

  console.log(`Resolving ${args.handle}...`);
  const did = await resolveHandle(args.handle);
  const pds = await resolvePds(did);
  setMeta("owner_did", did);
  setMeta("owner_handle", args.handle);
  console.log(`  ${did}\n  repo hosted at ${pds}`);

  if (args.reset) {
    console.log("\nResetting crawl cursors (indexed posts are kept).");
    resetCrawl();
  }

  console.log("\nSyncing follows...");
  const follows = await getFollows(did);
  upsertAuthors(follows);
  console.log(`  ${follows.length} accounts`);

  console.log("\nSyncing your likes and reposts...");
  await syncExclusions(pds, did, args.fullLikes);

  const pending = pendingAuthors();
  console.log(
    `\nCrawling media history: ${pending.length} accounts still have unexplored pages,` +
      ` up to ${args.depth} page${args.depth === 1 ? "" : "s"} each.`,
  );

  const filter = args.includeVideo ? "posts_with_video" : "posts_with_media";
  let done = 0;
  let totalInserted = 0;

  await pool(pending, args.concurrency, async (author) => {
    const { inserted, complete } = await crawlAuthor(author, args.depth, filter);
    totalInserted += inserted;
    done += 1;
    const flag = complete ? "done" : "more";
    console.log(
      `  [${String(done).padStart(3)}/${pending.length}] ${author.handle} ` +
        `+${inserted} (${flag})`,
    );
  });

  if (args.refresh) {
    const finished = completeAuthors();
    if (finished.length > 0) {
      console.log(`\nChecking ${finished.length} finished accounts for new posts...`);
      let found = 0;
      await pool(finished, args.concurrency, async (author) => {
        found += await topUpAuthor(author, filter);
      });
      totalInserted += found;
      console.log(`  ${found} new`);
    }
  }

  const elapsed = Math.round((Date.now() - started) / 1000);
  console.log(
    `\nAdded ${totalInserted} media posts in ${elapsed}s using ${requestsMade()} API requests.`,
  );
  printStats();

  const remaining = pendingAuthors().length;
  if (remaining > 0) {
    console.log(
      `${remaining} accounts have more history to explore. Run the same command again to dig deeper,\n` +
        `or pass --depth 50 to go much further back in one pass.\n`,
    );
  } else {
    console.log("Every followed account is fully indexed. Re-run any time to pick up new posts.\n");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
