import type { Facet } from "./richtext.ts";

const APPVIEW = "https://public.api.bsky.app";
const PLC = "https://plc.directory";

let minIntervalMs = 120;
let requestCount = 0;
let chain: Promise<void> = Promise.resolve();

export function requestsMade(): number {
  return requestCount;
}

/**
 * Raising this is the first thing to try if retry warnings pile up. Each visitor
 * crawls from their own IP, so the budget is per-browser rather than shared.
 */
export function setMinInterval(ms: number): void {
  minIntervalMs = Math.max(0, ms);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A sleep that gives up early when the signal fires. The retry backoff reaches
 * 8s, so waiting it out blind made Stop look like it had done nothing — the
 * abort was only noticed on the next attempt.
 */
function sleepUnlessAborted(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return sleep(ms);
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

/**
 * Lets the authenticated transport in `session.ts` share this module's queue.
 * Signing in must not create a second, unmetered request path.
 */
export function runThrottled<T>(fn: () => Promise<T>): Promise<T> {
  requestCount += 1;
  return throttle(fn);
}

/**
 * Serialises every outbound call through a single queue with a minimum gap
 * between requests. Concurrency in the crawler is over accounts, not over raw
 * HTTP — this queue is the only place requests actually leave.
 */
function throttle<T>(fn: () => Promise<T>): Promise<T> {
  const result = chain.then(fn);
  chain = result.then(
    () => sleep(minIntervalMs),
    () => sleep(minIntervalMs),
  );
  return result;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    body: string,
    url: string,
    /** Seconds the server asked us to wait, when it said so. */
    readonly retryAfterSeconds: number | null = null,
  ) {
    super(`HTTP ${status} for ${url}: ${body.slice(0, 200)}`);
  }
}

/** `Retry-After` is the one wait a rate limiter explicitly asks for; guessing shorter earns another 429. */
function retryAfterMs(err: unknown): number | null {
  if (!(err instanceof HttpError) || err.retryAfterSeconds === null) return null;
  return Math.min(60_000, Math.max(0, err.retryAfterSeconds) * 1000);
}

export class AbortedError extends Error {
  constructor() {
    super("Crawl stopped");
  }
}

async function rawRequest(url: string, signal?: AbortSignal): Promise<Response> {
  const res = await fetch(url, { headers: { accept: "*/*" }, signal });
  if (!res.ok) {
    const header = res.headers.get("retry-after");
    const seconds = header === null ? null : Number(header);
    throw new HttpError(
      res.status,
      await res.text().catch(() => ""),
      url,
      seconds !== null && Number.isFinite(seconds) ? seconds : null,
    );
  }
  return res;
}

/** Throttled GET with retry on 429/5xx. Aborts are never retried. */
async function request(url: string, signal?: AbortSignal, attempt = 0): Promise<Response> {
  if (signal?.aborted) throw new AbortedError();
  requestCount += 1;
  try {
    return await throttle(() => rawRequest(url, signal));
  } catch (err) {
    if (signal?.aborted || (err instanceof DOMException && err.name === "AbortError")) {
      throw new AbortedError();
    }
    const retriable =
      err instanceof HttpError
        ? err.status === 429 || err.status >= 500
        : true; // network errors are worth retrying too
    if (!retriable || attempt >= 4) throw err;

    // Honours `Retry-After` when the server sends one — on a 429 that is the
    // wait the server is actually asking for, and guessing shorter just earns
    // another 429.
    const backoff = retryAfterMs(err) ?? Math.min(30_000, 1000 * 2 ** attempt);
    console.warn(`retrying in ${Math.round(backoff / 1000)}s (${String(err).slice(0, 120)})`);
    await sleepUnlessAborted(backoff, signal);
    if (signal?.aborted) throw new AbortedError();
    return request(url, signal, attempt + 1);
  }
}

async function getJson(url: string, signal?: AbortSignal): Promise<unknown> {
  return (await request(url, signal)).json();
}

function query(
  base: string,
  nsid: string,
  params: Record<string, string | number | undefined>,
): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) search.set(key, String(value));
  }
  return `${base}/xrpc/${nsid}?${search.toString()}`;
}

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

export async function resolveHandle(handle: string, signal?: AbortSignal): Promise<string> {
  if (handle.startsWith("did:")) return handle;
  const clean = handle.trim().replace(/^@/, "").toLowerCase();
  if (!clean) throw new Error("Enter a handle first");
  // Signal threaded through so Stop works during the identity phase too, which
  // was previously the one stretch of a crawl the button could not interrupt.
  const data = (await getJson(
    query(APPVIEW, "com.atproto.identity.resolveHandle", { handle: clean }),
    signal,
  )) as { did?: string };
  if (!data.did) throw new Error(`No such handle: ${handle}`);
  return data.did;
}

interface DidDocument {
  service?: Array<{ id?: string; type?: string; serviceEndpoint?: string }>;
}

const pdsCache = new Map<string, string>();

/**
 * Finds the PDS that hosts a repo. Needed twice: like and repost records live
 * in the user's own repo, and original media blobs live in the author's.
 */
export async function resolvePds(did: string, signal?: AbortSignal): Promise<string> {
  const cached = pdsCache.get(did);
  if (cached) return cached;

  let doc: DidDocument;
  if (did.startsWith("did:web:")) {
    const domain = decodeURIComponent(did.slice("did:web:".length)).replace(/:/g, "/");
    doc = (await getJson(`https://${domain}/.well-known/did.json`, signal)) as DidDocument;
  } else {
    doc = (await getJson(`${PLC}/${encodeURIComponent(did)}`, signal)) as DidDocument;
  }
  const service = doc.service?.find(
    (s) => s.id === "#atproto_pds" || s.type === "AtprotoPersonalDataServer",
  );
  if (!service?.serviceEndpoint) {
    throw new Error(`No PDS endpoint in DID document for ${did}`);
  }
  const endpoint = service.serviceEndpoint.replace(/\/$/, "");
  pdsCache.set(did, endpoint);
  return endpoint;
}

export function cachePds(did: string, pds: string): void {
  pdsCache.set(did, pds);
}

// ---------------------------------------------------------------------------
// Graph
// ---------------------------------------------------------------------------

export interface ActorRef {
  did: string;
  handle: string;
  displayName?: string;
}

export async function getFollows(
  actor: string,
  onPage?: (total: number) => void,
  signal?: AbortSignal,
): Promise<ActorRef[]> {
  const out: ActorRef[] = [];
  let cursor: string | undefined;
  do {
    const data = (await getJson(
      query(APPVIEW, "app.bsky.graph.getFollows", { actor, limit: 100, cursor }),
      signal,
    )) as { follows?: ActorRef[]; cursor?: string };
    out.push(...(data.follows ?? []));
    onPage?.(out.length);
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
 *
 * Unlikes are not detected: an incremental pass only walks back to the highest
 * record key already seen. A full resync rebuilds.
 */
export async function listRecordsDescending(
  pds: string,
  repo: string,
  collection: string,
  stopAtRkey?: string,
  onPage?: (total: number) => void,
  signal?: AbortSignal,
): Promise<{ records: RepoRecord[]; highestRkey?: string }> {
  const records: RepoRecord[] = [];
  let cursor: string | undefined;
  let highestRkey: string | undefined;
  let done = false;

  do {
    const data = (await getJson(
      query(pds, "com.atproto.repo.listRecords", {
        repo,
        collection,
        limit: 100,
        reverse: "false",
        cursor,
      }),
      signal,
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
    onPage?.(records.length);
    cursor = data.cursor;
  } while (cursor && !done);

  return { records, highestRkey };
}

// ---------------------------------------------------------------------------
// Author feeds
// ---------------------------------------------------------------------------

export type MediaFilter = "posts_with_media" | "posts_with_video";

export interface FeedViewPost {
  post: {
    uri: string;
    cid: string;
    author: { did: string; handle: string; displayName?: string };
    record?: { createdAt?: string };
    indexedAt?: string;
    embed?: {
      $type?: string;
      images?: unknown[];
      media?: { $type?: string; images?: unknown[] };
    };
  };
  reason?: { $type?: string };
}

/** One page of an actor's media posts. `filter` is applied server-side. */
export async function getAuthorMediaPage(
  actor: string,
  cursor: string | undefined,
  filter: MediaFilter,
  signal?: AbortSignal,
): Promise<{ feed: FeedViewPost[]; cursor?: string }> {
  const data = (await getJson(
    query(APPVIEW, "app.bsky.feed.getAuthorFeed", {
      actor,
      limit: 100,
      filter,
      includePins: "false",
      cursor,
    }),
    signal,
  )) as { feed?: FeedViewPost[]; cursor?: string };
  return { feed: data.feed ?? [], cursor: data.cursor };
}

// ---------------------------------------------------------------------------
// Hydration
// ---------------------------------------------------------------------------

/** A blob reference as it appears inside a raw record. */
export interface BlobRef {
  $type?: "blob";
  ref?: { $link?: string } | string;
  mimeType?: string;
  size?: number;
}

export interface RecordEmbed {
  $type?: string;
  images?: Array<{ image?: BlobRef; alt?: string }>;
  video?: BlobRef;
  media?: RecordEmbed;
}

export interface PostView {
  uri: string;
  cid: string;
  author: { did: string; handle: string; displayName?: string; avatar?: string };
  record?: {
    createdAt?: string;
    text?: string;
    embed?: RecordEmbed;
    /** Byte-indexed mention/link/tag ranges. See `richtext.ts`. */
    facets?: Facet[];
  };
  embed?: unknown;
  likeCount?: number;
  repostCount?: number;
  replyCount?: number;
  /** Only populated when hydrated through an authenticated transport. */
  viewer?: { like?: string; repost?: string; bookmarked?: boolean };
}

/**
 * How an XRPC query reaches the AppView. The default is unauthenticated; signing
 * in swaps in a transport that carries viewer state (whether the reader has
 * already liked, reposted or bookmarked each post).
 */
export interface Transport {
  get(nsid: string, search: URLSearchParams): Promise<unknown>;
}

const publicTransport: Transport = {
  get: (nsid, search) => getJson(`${APPVIEW}/xrpc/${nsid}?${search.toString()}`),
};

/** getPosts accepts at most 25 URIs per call. Missing URIs mean deleted posts. */
export async function getPosts(
  uris: string[],
  transport: Transport = publicTransport,
): Promise<PostView[]> {
  const out: PostView[] = [];
  for (let i = 0; i < uris.length; i += 25) {
    const chunk = uris.slice(i, i + 25);
    const search = new URLSearchParams();
    for (const uri of chunk) search.append("uris", uri);
    const data = (await transport.get("app.bsky.feed.getPosts", search)) as {
      posts?: PostView[];
    };
    out.push(...(data.posts ?? []));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Blobs
// ---------------------------------------------------------------------------

/**
 * Fetches an original upload. The CDN only serves re-encoded derivatives, so
 * this is the only route to the file the artist actually posted — including the
 * source MP4 for video, which the view exposes only as an HLS playlist.
 */
export async function fetchBlob(did: string, cid: string, signal?: AbortSignal): Promise<Blob> {
  const pds = await resolvePds(did, signal);
  const res = await request(
    query(pds, "com.atproto.sync.getBlob", { did, cid }),
    signal,
  );
  return res.blob();
}
