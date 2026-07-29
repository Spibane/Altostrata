import { BrowserOAuthClient } from "@atproto/oauth-client-browser";
import type { OAuthSession } from "@atproto/oauth-client";
import { runThrottled, type Transport } from "./atproto.ts";

/**
 * `transition:generic` is what currently grants repo writes. The finer-grained
 * scope system is still landing; when it does, this should narrow to just the
 * collections Altostrata writes.
 */
const SCOPE = "atproto transition:generic";

/** Authenticated app.bsky.* calls go through the PDS, which proxies to the AppView. */
const APPVIEW_PROXY = "did:web:api.bsky.app#bsky_appview";

const HANDLE_RESOLVER = "https://public.api.bsky.app";

export interface Account {
  did: string;
  handle: string;
  displayName: string | null;
  avatar: string | null;
}

let clientPromise: Promise<BrowserOAuthClient> | undefined;
let session: OAuthSession | undefined;
let account: Account | undefined;

function isLoopback(): boolean {
  return ["localhost", "127.0.0.1", "[::1]", "::1"].includes(location.hostname);
}

/**
 * A loopback client needs no published document — the client_id *is* the
 * metadata, encoded as query parameters. The library's own builder omits `scope`,
 * which makes the server reject `transition:generic`, so the id is built here
 * instead. Redirects must use 127.0.0.1 rather than the `localhost` alias.
 */
function loopbackClientMetadata(): ConstructorParameters<
  typeof BrowserOAuthClient
>[0]["clientMetadata"] {
  const host = location.hostname === "localhost" ? "127.0.0.1" : location.hostname;
  const redirectUri = `http://${host}${location.port ? `:${location.port}` : ""}${location.pathname}`;
  const clientId =
    `http://localhost${location.pathname === "/" ? "" : location.pathname}` +
    `?redirect_uri=${encodeURIComponent(redirectUri)}&scope=${encodeURIComponent(SCOPE)}`;

  return {
    client_id: clientId,
    scope: SCOPE,
    redirect_uris: [redirectUri],
    response_types: ["code"],
    grant_types: ["authorization_code", "refresh_token"],
    token_endpoint_auth_method: "none",
    application_type: "native",
    dpop_bound_access_tokens: true,
  } as ConstructorParameters<typeof BrowserOAuthClient>[0]["clientMetadata"];
}

/**
 * Anywhere other than loopback, `client_id` must be the URL that actually serves
 * client-metadata.json, and the scopes there must match what is requested here.
 */
function getClient(): Promise<BrowserOAuthClient> {
  clientPromise ??= (async () => {
    if (isLoopback()) {
      return new BrowserOAuthClient({
        clientMetadata: loopbackClientMetadata(),
        handleResolver: HANDLE_RESOLVER,
      });
    }
    return BrowserOAuthClient.load({
      clientId: new URL("client-metadata.json", location.href).href,
      handleResolver: HANDLE_RESOLVER,
    });
  })();
  return clientPromise;
}

export function currentAccount(): Account | undefined {
  return account;
}

export function isSignedIn(): boolean {
  return session !== undefined;
}

async function describe(did: string): Promise<Account> {
  // Read through the public AppView: a profile is public and this keeps the
  // authenticated transport for writes only.
  try {
    const res = await runThrottled(() =>
      fetch(
        `${HANDLE_RESOLVER}/xrpc/app.bsky.actor.getProfile?actor=${encodeURIComponent(did)}`,
        { headers: { accept: "application/json" } },
      ),
    );
    const data = (await res.json()) as {
      handle?: string;
      displayName?: string;
      avatar?: string;
    };
    return {
      did,
      handle: data.handle ?? did,
      displayName: data.displayName ?? null,
      avatar: data.avatar ?? null,
    };
  } catch {
    return { did, handle: did, displayName: null, avatar: null };
  }
}

/** Restores a stored session, or completes a redirect callback if one is in the URL. */
export async function initAuth(): Promise<Account | undefined> {
  try {
    const client = await getClient();
    const result = await client.init();
    if (!result?.session) return undefined;
    session = result.session;
    account = await describe(session.did);
    return account;
  } catch (err) {
    console.warn("Could not restore session", err);
    return undefined;
  }
}

export class PopupBlockedError extends Error {
  constructor() {
    super("The sign-in window could not open");
  }
}

/**
 * A popup keeps the current page of finds on screen. If it cannot open, the
 * caller is expected to offer `signInRedirect` rather than navigating unasked.
 */
export async function signIn(input: string): Promise<Account> {
  const client = await getClient();
  try {
    session = await client.signInPopup(input, { scope: SCOPE });
  } catch (err) {
    throw err instanceof Error && /popup|window|blocked/i.test(err.message)
      ? new PopupBlockedError()
      : err;
  }
  account = await describe(session.did);
  return account;
}

export async function signInRedirect(input: string): Promise<never> {
  const client = await getClient();
  return client.signInRedirect(input, { scope: SCOPE });
}

export async function signOut(): Promise<void> {
  await session?.signOut().catch((err) => console.warn("Sign out failed", err));
  session = undefined;
  account = undefined;
}

// ---------------------------------------------------------------------------
// Authenticated XRPC
// ---------------------------------------------------------------------------

function requireSession(): OAuthSession {
  if (!session) throw new Error("Sign in first");
  return session;
}

interface XrpcOptions {
  method?: "GET" | "POST";
  body?: unknown;
  search?: URLSearchParams;
  /** Adds the proxy header so the PDS forwards to the AppView. */
  proxy?: boolean;
}

/**
 * Every authenticated call still goes through the shared throttle in
 * `atproto.ts`, so signing in does not open a second, unmetered request path.
 */
async function xrpc(nsid: string, options: XrpcOptions = {}): Promise<unknown> {
  const active = requireSession();
  const { method = "GET", body, search, proxy = false } = options;

  const headers: Record<string, string> = { accept: "application/json" };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (proxy) headers["atproto-proxy"] = APPVIEW_PROXY;

  const path = `/xrpc/${nsid}${search && [...search].length > 0 ? `?${search}` : ""}`;

  const res = await runThrottled(() =>
    active.fetchHandler(path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );

  const text = await res.text();
  const parsed: unknown = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const error = parsed as { error?: string; message?: string };
    throw new Error(error.message ?? error.error ?? `HTTP ${res.status} from ${nsid}`);
  }
  return parsed;
}

/** Transport that hydrates through the authenticated AppView, so viewer state comes back. */
export const authedTransport: Transport = {
  get: (nsid, search) => xrpc(nsid, { search, proxy: true }),
};

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

export interface Subject {
  uri: string;
  cid: string;
}

function rkeyOf(uri: string): string {
  return uri.split("/").pop() ?? "";
}

async function createRecord(collection: string, record: object): Promise<string> {
  const data = (await xrpc("com.atproto.repo.createRecord", {
    method: "POST",
    body: { repo: requireSession().did, collection, record },
  })) as { uri?: string };
  if (!data.uri) throw new Error("The server did not return a record URI");
  return data.uri;
}

async function deleteRecord(collection: string, recordUri: string): Promise<void> {
  await xrpc("com.atproto.repo.deleteRecord", {
    method: "POST",
    body: { repo: requireSession().did, collection, rkey: rkeyOf(recordUri) },
  });
}

const LIKE = "app.bsky.feed.like";
const REPOST = "app.bsky.feed.repost";

/** Returns the URI of the new like record, which is what unliking needs. */
export function like(subject: Subject): Promise<string> {
  return createRecord(LIKE, {
    $type: LIKE,
    subject,
    createdAt: new Date().toISOString(),
  });
}

export function unlike(recordUri: string): Promise<void> {
  return deleteRecord(LIKE, recordUri);
}

export function repost(subject: Subject): Promise<string> {
  return createRecord(REPOST, {
    $type: REPOST,
    subject,
    createdAt: new Date().toISOString(),
  });
}

export function unrepost(recordUri: string): Promise<void> {
  return deleteRecord(REPOST, recordUri);
}

// ---------------------------------------------------------------------------
// Bookmarks
//
// Bookmarks are not repo records — they live on the AppView so they stay private,
// which is why they cannot be excluded without signing in. The request shape here
// is inferred from the lexicon name; the endpoint refuses unauthenticated probes,
// so it is confirmed to exist but its body has not been verified.
// ---------------------------------------------------------------------------

export async function bookmark(subject: Subject): Promise<void> {
  await xrpc("app.bsky.bookmark.createBookmark", {
    method: "POST",
    body: subject,
    proxy: true,
  });
}

export async function unbookmark(uri: string): Promise<void> {
  await xrpc("app.bsky.bookmark.deleteBookmark", {
    method: "POST",
    body: { uri },
    proxy: true,
  });
}

export interface BookmarkedSubject {
  uri: string;
  cid: string;
}

/**
 * Pages through the signed-in account's existing bookmarks, so ones made
 * before Altostrata could track them (or from another client) can be
 * backfilled into the exclusion store. The response shape is inferred from
 * the lexicon name — like `createBookmark`/`deleteBookmark`, it has not been
 * exercised against the live API, so both `subject` and `item` are accepted
 * as the record's field name until this runs against a real account.
 */
export async function listBookmarks(): Promise<BookmarkedSubject[]> {
  const out: BookmarkedSubject[] = [];
  let cursor: string | undefined;
  for (;;) {
    const search = new URLSearchParams({ limit: "100" });
    if (cursor) search.set("cursor", cursor);
    const data = (await xrpc("app.bsky.bookmark.getBookmarks", {
      search,
      proxy: true,
    })) as {
      bookmarks?: Array<{
        subject?: { uri?: string; cid?: string };
        item?: { uri?: string; cid?: string };
      }>;
      cursor?: string;
    };
    const rows = data.bookmarks ?? [];
    if (rows.length === 0) break;
    for (const row of rows) {
      const subject = row.subject ?? row.item;
      if (subject?.uri && subject.cid) out.push({ uri: subject.uri, cid: subject.cid });
    }
    if (!data.cursor) break;
    cursor = data.cursor;
  }
  return out;
}
