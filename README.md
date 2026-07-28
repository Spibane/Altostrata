<h1 align="center">&#128187; Strata</h1>

<h2 align="center"><strong>Rediscover old media posts from the people you follow on Bluesky</strong></h2>

<div align="center">

[![Version](https://img.shields.io/badge/version-2.0.0-black)]()
[![Status](https://img.shields.io/badge/status-Beta-yellow)]()
[![Changelog](https://img.shields.io/badge/changelog-blue)](./CHANGELOG.md)

[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript&logoColor=white)]()
[![esbuild](https://img.shields.io/badge/esbuild-0.28-FFCF00?logo=esbuild&logoColor=black)]()
[![IndexedDB](https://img.shields.io/badge/IndexedDB-local-4A5568)]()
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

Everything upstream is read through the public AppView at
`public.api.bsky.app` plus `plc.directory` for PDS discovery. **No
authentication anywhere** — follows, author feeds, likes, and reposts are all
public records on the AT Protocol, so there is no app password to store.

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
  30,000 likes is expensive once and cheap thereafter.
- **Original-quality downloads.** The Save button pulls the actual file the
  artist uploaded via `com.atproto.sync.getBlob` — not the CDN's re-encoded
  JPEG. Transparent PNGs stay transparent and video comes down as the source
  MP4 rather than an HLS playlist.
- **Progressive first run.** A shallow pass surfaces artwork within a couple of
  minutes, then the crawl keeps digging deeper in the background while you browse.
- **Resettable seen state.** Kept in its own store, so forgetting everything you
  have been shown is instant and leaves the index and exclusions intact.
- **Per-author caps** so one prolific account can't fill a page.
- **Depth gauge** on each card showing where the post sits within that
  account's *indexed* history — a post near the bottom of the rail is close to
  the oldest thing Strata has found for that person.
- **Export and import.** The whole index round-trips through a JSON file, for
  moving between browsers or surviving storage eviction.
- **Self-healing index.** Posts the AppView no longer returns are deleted
  locally on the next dig that touches them.
- **Throttled and retried.** Requests are serialised with a minimum interval,
  with exponential backoff on 429 and 5xx.

### Known limitations

- **Storage can be evicted.** Safari clears IndexedDB for sites not visited for
  roughly a week. Strata calls `navigator.storage.persist()`, which Chrome
  generally grants and Safari generally does not — export if you care about the
  index.
- **Every visitor crawls from scratch.** With no server there is no shared index,
  so nobody benefits from anyone else's crawl.
- **The tab must stay open while crawling.** Progress is saved continuously, so
  closing it loses only the page in flight.
- **Bookmarks cannot be excluded.** Bluesky's Saved Posts are stored
  off-protocol precisely so they stay private, so they are invisible here.
- **Unlikes are not detected.** Removing a like leaves a stale exclusion until
  the exclusion table is rebuilt.
- **Your blocks and mutes are not applied.** Unauthenticated reads don't carry
  viewer state. This only matters for accounts you follow and have muted.
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
| **Older than** | Minimum age floor; `any age` disables it |
| **Allow repeats** | Include posts already surfaced |
| **Save** | Download the original file for that image or video |
| **Index** | Stats, dig deeper, reset seen posts, export/import, start over |

## Deploying

The build output is committed, so GitHub Pages needs no CI:

```bash
npm install
npm run build
```

Point Pages at the `public/` directory on `main`, or run the included workflow in
`.github/workflows/pages.yml`, which builds and deploys on every push.

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
| `src/app.ts` | UI: setup, digging, cards, settings |
| `public/index.html` | Page shell and all styling |
| `public/app.js` | Built bundle, committed for static hosting |
