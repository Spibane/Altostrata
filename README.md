<h1 align="center">&#128187; Altostrata</h1>

<h2 align="center"><strong>Rediscover old media posts from the people you follow on Bluesky</strong></h2>

<div align="center">

[![Version](https://img.shields.io/badge/version-2.2.0-black)]()
[![Status](https://img.shields.io/badge/status-Beta-yellow)]()
[![Changelog](https://img.shields.io/badge/changelog-blue)](./CHANGELOG.md)

[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript&logoColor=white)]()
[![esbuild](https://img.shields.io/badge/esbuild-0.28-FFCF00?logo=esbuild&logoColor=black)]()
[![IndexedDB](https://img.shields.io/badge/IndexedDB-local-4A5568)]()
[![OAuth](https://img.shields.io/badge/OAuth-DPoP-6E56CF)]()
[![No backend](https://img.shields.io/badge/backend-none-success)]()

</div>

## Architecture

One static page. There is no server, no database to host, and no account — the
whole application is a browser tab that talks directly to the public AT Protocol
APIs and keeps its index in IndexedDB.

```
                        BROWSER TAB  (there is nothing else)
  ──────────────────────────────────────────────────────────────────────────
   your handle
       │
       ├──► resolveHandle ──────────────► your DID
       │
       ├──► plc.directory ──────────────► your PDS host
       │
       ├──► getFollows ─────────────────► authors    ┐
       │                                             │
       ├──► listRecords ────────────────► excluded   │  IndexedDB
       │      app.bsky.feed.like                     │  (this browser only)
       │      app.bsky.feed.repost                   │
       │                                             │
       └──► getAuthorFeed ──────────────► posts      ┘
              filter=posts_with_media
              paged backwards per account
                          │
                          ▼
              DIG ──► random sample over a fixed sort key
                      minus excluded, minus seen, capped per author
                          │
                          ├──► getPosts ──► hydrate 25 at a time
                          │
                          └──► card ──► SAVE ──► com.atproto.sync.getBlob
                                                 the artist's original upload
```

Reading needs no account at all: follows, author feeds, likes and reposts are
public AT Protocol records, read through `public.api.bsky.app` plus
`plc.directory` for PDS discovery.

**Liking, reposting and bookmarking are opt-in and use OAuth.** No password is
ever typed into Altostrata — you are sent to Bluesky to approve access, and tokens
come back DPoP-bound to a non-extractable key held in this browser:

```
   Sign in ──► bsky.social /oauth/par ──► /oauth/authorize
                                              │  you approve, on Bluesky
                                              ▼
                             DPoP-bound tokens ──► IndexedDB
                                              │
   Like / Repost ──► your PDS  com.atproto.repo.createRecord
   Bookmark ──────► your PDS ──proxy──► AppView  app.bsky.bookmark.*
```

Four design consequences worth knowing:

- **Nothing about you ever leaves your machine.** The index, your like
  exclusions, and which posts you have already seen exist only in this browser.
  Because there is no backend, there is no place for that data to be collected.
- **Each visitor crawls from their own IP**, so rate-limit budget is per-person
  rather than shared, and hosting costs nothing beyond static files.
- **The backfill is the expensive part.** The firehose only carries new posts, so
  reaching 2022 means paging `getAuthorFeed` backwards through each account one
  page at a time. Progress is checkpointed per account, so a crawl is resumable
  and interruptible — close the tab and the next visit picks up where it left off.
- **The index stores no content.** `posts` holds only URIs and timestamps. Images,
  text, and counts are hydrated from Bluesky at display time, which keeps the
  index small and means deleted posts disappear on their own.

## Features

- **Random selection across all of time**, not a reverse-chronological window.
  Post age is irrelevant to selection except for the minimum-age floor.
- **Excludes anything you liked or reposted**, read from your own repo. Repeat
  runs only scan back to the highest record key already seen, so syncing
  30,000 likes is expensive once and cheap thereafter. Likes can be re-admitted
  with a toggle when you want to revisit favourites; reposts stay hidden.
- **Original-quality downloads.** The Download button pulls the actual file the
  artist uploaded via `com.atproto.sync.getBlob` — not the CDN's re-encoded
  JPEG. Transparent PNGs stay transparent and video comes down as the source
  MP4 rather than an HLS playlist.
- **Like, repost and bookmark in place**, via OAuth. Liking from Altostrata also adds
  the post to your exclusions immediately, so it stops resurfacing without
  waiting for the next like sync — and unliking makes it findable again.
- **Progressive first run.** A shallow pass surfaces artwork within a couple of
  minutes, then the crawl keeps digging deeper in the background while you browse.
- **Resettable seen state.** Kept in its own store, so forgetting everything you
  have been shown is instant and leaves the index and exclusions intact.
- **Per-author caps** so one prolific account can't fill a page.
- **Depth gauge** on each card showing where the post sits within that
  account's *indexed* history — a post near the bottom of the rail is close to
  the oldest thing Altostrata has found for that person.
- **Export and import.** The whole index round-trips through a JSON file, for
  moving between browsers or surviving storage eviction.
- **Self-healing index.** Posts the AppView no longer returns are deleted
  locally on the next dig that touches them.
- **Throttled and retried.** Requests are serialised with a minimum interval,
  with exponential backoff on 429 and 5xx.

### Known limitations

- **Storage can be evicted.** Safari clears IndexedDB for sites not visited for
  roughly a week. Altostrata calls `navigator.storage.persist()`, which Chrome
  generally grants and Safari generally does not — export if you care about the
  index.
- **Every visitor crawls from scratch.** With no server there is no shared index,
  so nobody benefits from anyone else's crawl.
- **The tab must stay open while crawling.** Progress is saved continuously, so
  closing it loses only the page in flight.
- **Bookmarked posts are not excluded yet.** Saved Posts live on the AppView
  rather than in your repo, so the anonymous crawl cannot see them. Signing in
  makes them readable, so this is unbuilt rather than impossible.
- **Unlikes are not detected.** Removing a like leaves a stale exclusion until
  the exclusion table is rebuilt.
- **Your blocks and mutes are not applied to the crawl.** The backfill reads
  anonymously, so it doesn't carry viewer state. This only matters for accounts
  you follow and have muted.
- **`posts_with_media` means images.** Video needs the `posts_with_video` filter
  as a separate pass.
- **The depth gauge reflects what's indexed, not what exists.** Until an
  account is fully read, its true oldest post is probably older.

## Using it

Type a handle, press **Start digging**, and wait for the first artwork to appear
— about two minutes for a 600-account follow list. The crawl keeps going in the
background while you browse.

| Control | Effect |
|---|---|
| **Dig** | Draw a fresh random page |
| **Older than** | Minimum age floor; `now` disables it |
| **Allow repeats** | Include posts already surfaced |
| **Include liked** | Re-admit posts you liked; reposts stay hidden either way |
| **Download** | Save the original file for that image or video |
| **Like / Repost / Bookmark** | Acts on your account; prompts sign-in if needed |
| **Sign in** | OAuth via Bluesky; nothing is required to browse or download |
| **Index** | Stats, dig deeper, reset seen posts, export/import, start over |

## Deploying

`.github/workflows/pages.yml` typechecks, builds and deploys on every push to
`main`. Enable it with **Settings → Pages → Source: GitHub Actions**.

**One thing must be edited before OAuth works:**
[`public/client-metadata.json`](./public/client-metadata.json) hard-codes the
deployed URL, and the AT Protocol requires `client_id` to be the exact URL that
serves that file. If your Pages URL is not
`https://spibane.github.io/Altostrata/`, update all three fields:

```json
{
  "client_id":     "https://YOUR.github.io/REPO/client-metadata.json",
  "client_uri":    "https://YOUR.github.io/REPO/",
  "redirect_uris": ["https://YOUR.github.io/REPO/"]
}
```

The `scope` there must also match the scope requested in `src/session.ts`, or the
authorization server rejects the request with `invalid_scope`. Local development
needs none of this — a loopback origin builds its own client identity, so
`npm run dev` on `127.0.0.1` can sign in as-is.

## Development

```bash
npm install
npm run dev          # esbuild watch + static server on http://127.0.0.1:8000
npm run typecheck    # must pass; no test suite yet
npm run build        # minified bundle into public/app.js
```

There is no `.env` and nothing to configure — the app has no secrets and no
server-side settings.

## Package Structure

| Path | Role |
|---|---|
| `src/atproto.ts` | All outbound HTTP. Throttling, retries, DID/PDS resolution, blob fetches |
| `src/store.ts` | IndexedDB schema and every query, including random selection |
| `src/crawl.ts` | Crawl orchestration, progress reporting, abort handling |
| `src/media.ts` | Embed parsing and original-file downloads |
| `src/session.ts` | OAuth sign-in, authenticated XRPC, likes/reposts/bookmarks |
| `src/app.ts` | UI: setup, digging, cards, settings |
| `public/index.html` | Page shell and all styling |
| `public/client-metadata.json` | OAuth client identity; must match the deployed URL |
| `public/app.js` | Built bundle, committed for static hosting |
