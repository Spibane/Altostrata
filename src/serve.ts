import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { getPosts, type PostView } from "./atproto.ts";
import { deletePosts, getMeta, markShown, shuffle, stats, type ShuffleRow } from "./db.ts";

const PORT = Number(process.env.PORT ?? 4173);
const VIEWER = resolve(import.meta.dirname, "../public/index.html");

interface ImageOut {
  thumb: string;
  full: string;
  alt: string;
  aspectRatio: number | null;
}

interface CardOut {
  uri: string;
  webUrl: string;
  text: string;
  createdAt: string;
  handle: string;
  displayName: string;
  avatar: string | null;
  images: ImageOut[];
  isVideo: boolean;
  likeCount: number;
  depth: number | null;
  authorOldest: string | null;
  authorComplete: boolean;
}

/** Turns an at:// URI into the bsky.app permalink for that post. */
function webUrl(uri: string, handle: string): string {
  const rkey = uri.split("/").pop() ?? "";
  return `https://bsky.app/profile/${handle}/post/${rkey}`;
}

interface EmbedImage {
  thumb?: string;
  fullsize?: string;
  alt?: string;
  aspectRatio?: { width?: number; height?: number };
}

interface Embed {
  $type?: string;
  images?: EmbedImage[];
  thumbnail?: string;
  media?: Embed;
}

/** Images can sit directly on the embed or nested under recordWithMedia. */
function extractImages(embed: unknown): { images: ImageOut[]; isVideo: boolean } {
  const node = embed as Embed | undefined;
  if (!node) return { images: [], isVideo: false };

  const source = node.images ? node : node.media;
  const type = source?.$type ?? "";

  if (type.startsWith("app.bsky.embed.video")) {
    const thumb = source?.thumbnail;
    return {
      images: thumb ? [{ thumb, full: thumb, alt: "Video thumbnail", aspectRatio: null }] : [],
      isVideo: true,
    };
  }

  const images = (source?.images ?? []).flatMap((image): ImageOut[] => {
    const thumb = image.thumb ?? image.fullsize;
    if (!thumb) return [];
    const width = image.aspectRatio?.width;
    const height = image.aspectRatio?.height;
    return [
      {
        thumb,
        full: image.fullsize ?? thumb,
        alt: image.alt ?? "",
        aspectRatio: width && height ? width / height : null,
      },
    ];
  });

  return { images, isVideo: false };
}

/** Position of this post within the author's indexed history, 0 = oldest. */
function depthOf(row: ShuffleRow): number | null {
  if (!row.oldest || !row.newest) return null;
  const oldest = Date.parse(row.oldest);
  const newest = Date.parse(row.newest);
  const span = newest - oldest;
  if (!Number.isFinite(span) || span <= 0) return null;
  return Math.min(1, Math.max(0, (Date.parse(row.created_at) - oldest) / span));
}

function toCard(post: PostView, row: ShuffleRow): CardOut {
  const { images, isVideo } = extractImages(post.embed);
  return {
    uri: post.uri,
    webUrl: webUrl(post.uri, post.author.handle),
    text: post.record?.text ?? "",
    createdAt: post.record?.createdAt ?? row.created_at,
    handle: post.author.handle,
    displayName: post.author.displayName ?? post.author.handle,
    avatar: post.author.avatar ?? null,
    images,
    isVideo,
    likeCount: post.likeCount ?? 0,
    depth: depthOf(row),
    authorOldest: row.oldest,
    authorComplete: row.author_complete === 1,
  };
}

async function handleShuffle(url: URL): Promise<CardOut[]> {
  const limit = Math.min(48, Math.max(1, Number(url.searchParams.get("n") ?? 12)));
  const rows = shuffle({
    limit,
    minAgeDays: Math.max(0, Number(url.searchParams.get("minAgeDays") ?? 90)),
    includeSeen: url.searchParams.get("includeSeen") === "1",
    maxPerAuthor: Math.max(1, Number(url.searchParams.get("maxPerAuthor") ?? 2)),
  });
  if (rows.length === 0) return [];

  const byUri = new Map(rows.map((row) => [row.uri, row]));
  const hydrated = await getPosts(rows.map((row) => row.uri));

  // Anything the AppView no longer knows about has been deleted upstream.
  const returned = new Set(hydrated.map((post) => post.uri));
  const missing = rows.map((row) => row.uri).filter((uri) => !returned.has(uri));
  if (missing.length > 0) deletePosts(missing);

  const cards = hydrated.flatMap((post) => {
    const row = byUri.get(post.uri);
    if (!row) return [];
    const card = toCard(post, row);
    return card.images.length > 0 ? [card] : [];
  });

  markShown(cards.map((card) => card.uri));
  return cards;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);

  try {
    if (url.pathname === "/api/shuffle") {
      const cards = await handleShuffle(url);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(cards));
      return;
    }

    if (url.pathname === "/api/stats") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ...stats(), owner: getMeta("owner_handle") ?? null }));
      return;
    }

    if (url.pathname === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(await readFile(VIEWER));
      return;
    }

    res.writeHead(404, { "content-type": "text/plain" });
    res.end("Not found");
  } catch (err) {
    console.error(err);
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: String(err) }));
  }
});

server.listen(PORT, () => {
  const s = stats();
  if (s.posts === 0) {
    console.log("No posts indexed yet. Run `npm run index -- --handle you.bsky.social` first.\n");
  }
  console.log(`Strata is running at http://localhost:${PORT}`);
  console.log(`${s.posts} media posts indexed across ${s.authors} accounts.`);
});
