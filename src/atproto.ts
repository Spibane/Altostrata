const APPVIEW = process.env.BSKY_APPVIEW ?? "https://public.api.bsky.app";
const PLC = process.env.PLC_DIRECTORY ?? "https://plc.directory";

const MIN_INTERVAL_MS = Number(process.env.MIN_REQUEST_INTERVAL_MS ?? 120);

let requestCount = 0;
let chain: Promise<void> = Promise.resolve();

export function requestsMade(): number {
  return requestCount;
}

/**
 * Serialises every outbound call through a single queue with a minimum gap
 * between requests. Bluesky's public AppView allows a few thousand requests
 * per five minutes per IP; 120ms between calls keeps us comfortably under it
 * even with concurrent crawlers upstream.
 */
function throttle<T>(fn: () => Promise<T>): Promise<T> {
  const result = chain.then(fn);
  chain = result.then(
    () => sleep(MIN_INTERVAL_MS),
    () => sleep(MIN_INTERVAL_MS),
  );
  return result;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    url: string,
  ) {
    super(`HTTP ${status} for ${url}: ${body.slice(0, 200)}`);
  }
}

async function rawGet(url: string): Promise<unknown> {
  const res = await fetch(url, {
    headers: { accept: "application/json", "user-agent": "strata/1.0" },
  });
  if (!res.ok) {
    throw new HttpError(res.status, await res.text().catch(() => ""), url);
  }
  return res.json();
}

/** GET with throttling, retry on 429/5xx, and Retry-After support. */
async function get(url: string, attempt = 0): Promise<unknown> {
  requestCount += 1;
  try {
    return await throttle(() => rawGet(url));
  } catch (err) {
    const retriable =
      err instanceof HttpError
        ? err.status === 429 || err.status >= 500
        : true; // network errors are worth retrying too
    if (!retriable || attempt >= 4) throw err;

    const backoff = Math.min(30_000, 1000 * 2 ** attempt);
    console.warn(`  retrying in ${Math.round(backoff / 1000)}s (${String(err).slice(0, 120)})`);
    await sleep(backoff);
    return get(url, attempt + 1);
  }
}

function query(base: string, nsid: string, params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) search.set(key, String(value));
  }
  return `${base}/xrpc/${nsid}?${search.toString()}`;
}

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

export async function resolveHandle(handle: string): Promise<string> {
  if (handle.startsWith("did:")) return handle;
  const clean = handle.replace(/^@/, "");
  const data = (await get(
    query(APPVIEW, "com.atproto.identity.resolveHandle", { handle: clean }),
  )) as { did?: string };
  if (!data.did) throw new Error(`Could not resolve handle: ${handle}`);
  return data.did;
}

interface DidDocument {
  service?: Array<{ id?: string; type?: string; serviceEndpoint?: string }>;
}

/**
 * Finds the PDS that hosts a repo. Needed because like and repost records live
 * in the user's own repo, which the AppView does not expose via listRecords.
 */
export async function resolvePds(did: string): Promise<string> {
  let doc: DidDocument;
  if (did.startsWith("did:web:")) {
    const domain = decodeURIComponent(did.slice("did:web:".length)).replace(/:/g, "/");
    doc = (await get(`https://${domain}/.well-known/did.json`)) as DidDocument;
  } else {
    doc = (await get(`${PLC}/${encodeURIComponent(did)}`)) as DidDocument;
  }
  const service = doc.service?.find(
    (s) => s.id === "#atproto_pds" || s.type === "AtprotoPersonalDataServer",
  );
  if (!service?.serviceEndpoint) {
    throw new Error(`No PDS endpoint in DID document for ${did}`);
  }
  return service.serviceEndpoint.replace(/\/$/, "");
}

// ---------------------------------------------------------------------------
// Graph
// ---------------------------------------------------------------------------

export interface ActorRef {
  did: string;
  handle: string;
  displayName?: string;
}

export async function getFollows(actor: string): Promise<ActorRef[]> {
  const out: ActorRef[] = [];
  let cursor: string | undefined;
  do {
    const data = (await get(
      query(APPVIEW, "app.bsky.graph.getFollows", { actor, limit: 100, cursor }),
    )) as { follows?: ActorRef[]; cursor?: string };
    out.push(...(data.follows ?? []));
    cursor = data.cursor;
  } while (cursor);
  return out;
}

// ---------------------------------------------------------------------------
// Repo records (likes, reposts)
// ---------------------------------------------------------------------------

export interface RepoRecord {
  uri: string;
  value: { subject?: { uri?: string } };
}

/**
 * Pages a collection newest-first. `stopAtRkey` short-circuits once we reach a
 * record we already have, which makes repeat runs cheap. Record keys are TIDs,
 * so descending rkey order is descending chronological order.
 */
export async function listRecordsDescending(
  pds: string,
  repo: string,
  collection: string,
  stopAtRkey?: string,
): Promise<{ records: RepoRecord[]; highestRkey?: string }> {
  const records: RepoRecord[] = [];
  let cursor: string | undefined;
  let highestRkey: string | undefined;
  let done = false;

  do {
    const data = (await get(
      query(pds, "com.atproto.repo.listRecords", {
        repo,
        collection,
        limit: 100,
        reverse: "false",
        cursor,
      }),
    )) as { records?: RepoRecord[]; cursor?: string };

    for (const record of data.records ?? []) {
      const rkey = record.uri.split("/").pop() ?? "";
      if (highestRkey === undefined || rkey > highestRkey) highestRkey = rkey;
      if (stopAtRkey && rkey <= stopAtRkey) {
        done = true;
        break;
      }
      records.push(record);
    }
    cursor = data.cursor;
  } while (cursor && !done);

  return { records, highestRkey };
}

// ---------------------------------------------------------------------------
// Author feeds
// ---------------------------------------------------------------------------

export interface FeedViewPost {
  post: {
    uri: string;
    cid: string;
    author: { did: string; handle: string; displayName?: string };
    record?: { createdAt?: string };
    indexedAt?: string;
    embed?: { $type?: string; images?: unknown[]; media?: { $type?: string; images?: unknown[] } };
  };
  reason?: { $type?: string };
}

/** One page of an actor's media posts. `filter` is applied server-side. */
export async function getAuthorMediaPage(
  actor: string,
  cursor: string | undefined,
  filter: "posts_with_media" | "posts_with_video",
): Promise<{ feed: FeedViewPost[]; cursor?: string }> {
  const data = (await get(
    query(APPVIEW, "app.bsky.feed.getAuthorFeed", {
      actor,
      limit: 100,
      filter,
      includePins: "false",
      cursor,
    }),
  )) as { feed?: FeedViewPost[]; cursor?: string };
  return { feed: data.feed ?? [], cursor: data.cursor };
}

// ---------------------------------------------------------------------------
// Hydration
// ---------------------------------------------------------------------------

export interface PostView {
  uri: string;
  cid: string;
  author: { did: string; handle: string; displayName?: string; avatar?: string };
  record?: { createdAt?: string; text?: string };
  embed?: unknown;
  likeCount?: number;
  repostCount?: number;
  replyCount?: number;
}

/** getPosts accepts at most 25 URIs per call. Missing URIs mean deleted posts. */
export async function getPosts(uris: string[]): Promise<PostView[]> {
  const out: PostView[] = [];
  for (let i = 0; i < uris.length; i += 25) {
    const chunk = uris.slice(i, i + 25);
    const search = new URLSearchParams();
    for (const uri of chunk) search.append("uris", uri);
    const data = (await get(
      `${APPVIEW}/xrpc/app.bsky.feed.getPosts?${search.toString()}`,
    )) as { posts?: PostView[] };
    out.push(...(data.posts ?? []));
  }
  return out;
}
