<h1 align="center">&#128187; Strata</h1>

<h2 align="center"><strong>Rediscover old media posts from the people you follow on Bluesky</strong></h2>

<div align="center">

[![Version](https://img.shields.io/badge/version-1.0.0-black)]()
[![Status](https://img.shields.io/badge/status-Beta-yellow)]()
[![Changelog](https://img.shields.io/badge/changelog-blue)](./CHANGELOG.md)

[![Node](https://img.shields.io/badge/Node-22.x-339933?logo=nodedotjs&logoColor=white)]()
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript&logoColor=white)]()
[![SQLite](https://img.shields.io/badge/SQLite-3.x-003B57?logo=sqlite&logoColor=white)]()

</div>

## Architecture

Two independent halves that share a SQLite file. The indexer is slow and runs
occasionally; the viewer is fast and reads only local data.

```
  INDEXER  (npm run index)                          VIEWER  (npm run serve)
  ─────────────────────────                         ────────────────────────
                                                    
  resolveHandle ──► your DID                        browser
        │                                              │  GET /api/shuffle
        ├──► plc.directory ──► your PDS host           ▼
        │                                          localhost:4173
        ├──► getFollows ─────────► authors table       │
        │                                              ├─► SELECT ... ORDER BY RANDOM()
        ├──► listRecords ────────► excluded table      │      minus excluded, minus seen
        │    app.bsky.feed.like                        │
        │    app.bsky.feed.repost                      ├─► getPosts (hydrate 25 at a time)
        │                                              │
        └──► getAuthorFeed ──────► posts table         └─► JSON ──► age stamp + depth gauge
             filter=posts_with_media
             paged backwards per account
                        │
                        ▼
                 data/strata.db
```

Everything upstream is read through the public AppView at
`public.api.bsky.app` plus `plc.directory` for PDS discovery. **No
authentication anywhere** — follows, author feeds, likes, and reposts are all
public records on the AT Protocol, so there is no app password to store.

Two design consequences worth knowing:

- **The backfill is the expensive part.** The firehose only carries new posts,
  so reaching 2022 means paging `getAuthorFeed` backwards through each account
  one page at a time. Progress is checkpointed per account, so the crawl is
  resumable and interruptible.
- **The viewer stores no content.** `posts` holds only URIs and timestamps.
  Images, text, and counts are hydrated from Bluesky at display time, which
  keeps the database small and means deleted posts disappear on their own.

## Features

- **Random selection across all of time**, not a reverse-chronological window.
  Post age is irrelevant to selection except for the minimum-age floor.
- **Excludes anything you liked or reposted**, read from your own repo. Repeat
  runs only scan back to the highest record key already seen, so syncing
  30,000 likes is expensive once and cheap thereafter.
- **Per-author caps** so one prolific account can't fill a page.
- **Repeat suppression** via a `shown_at` stamp, with an override in the UI.
- **Depth gauge** on each card showing where the post sits within that
  account's *indexed* history — a post near the bottom of the rail is close to
  the oldest thing Strata has found for that person.
- **Resumable crawl.** Each run explores `--depth` more pages per account.
  Run it repeatedly to reach further back without one long session.
- **Self-healing index.** Posts the AppView no longer returns are deleted
  locally on the next shuffle that touches them.
- **Throttled and retried.** Requests are serialised with a minimum interval,
  with exponential backoff on 429 and 5xx.

### Known limitations

- **Bookmarks cannot be excluded.** Bluesky's Saved Posts are stored
  off-protocol precisely so they stay private, so they are invisible here.
- **Unlikes are not detected.** Removing a like leaves a stale exclusion.
  Run with `--full-likes` to rebuild the exclusion table from scratch.
- **Your blocks and mutes are not applied.** Unauthenticated reads don't carry
  viewer state. This only matters for accounts you follow and have muted.
- **`posts_with_media` means images.** Pass `--include-video` to crawl with the
  `posts_with_video` filter instead; run it as a second pass to get both.
- **The depth gauge reflects what's indexed, not what exists.** Until an
  account reports `done`, its true oldest post is probably older.

## Environment Variables

All optional — every value has a working default. A `.env` file in the project
root is loaded automatically by every `npm run` script and is gitignored, so
personal values never reach the repo. Copy `.env.example` to start.

```env
# ======= Identity =======
BSKY_HANDLE=<str>                 # Default account to index; --handle overrides

# ======= Storage =======
STRATA_DB=<str>                   # SQLite path, default ./data/strata.db

# ======= Server =======
PORT=<int>                        # Viewer port, default 4173

# ======= Upstream =======
BSKY_APPVIEW=<str>                # Default https://public.api.bsky.app
PLC_DIRECTORY=<str>               # Default https://plc.directory
MIN_REQUEST_INTERVAL_MS=<int>     # Gap between API calls, default 120
```

## Configuration

### Indexer flags

| Flag | Default | Effect |
|---|---|---|
| `--handle <h>` | `$BSKY_HANDLE` | Whose follows to index |
| `--depth <n>` | `5` | Pages of history per account per run |
| `--concurrency <n>` | `4` | Accounts crawled in parallel |
| `--include-video` | off | Use the `posts_with_video` filter |
| `--full-likes` | off | Rebuild exclusions instead of syncing incrementally |
| `--no-refresh` | off | Skip the top-up pass over finished accounts |
| `--reset` | off | Clear crawl cursors, keeping indexed posts |
| `--stats-only` | off | Print index statistics and exit |

### First run

```bash
npm install
cp .env.example .env                        # then set BSKY_HANDLE
npm run index                               # breadth first: 5 pages each
npm run serve                               # http://localhost:4173
```

Or skip the `.env` and pass the handle explicitly:

```bash
npm run index -- --handle you.bsky.social
```

Re-run the indexer to go deeper. Once it reports every account as fully
indexed, later runs only pick up new posts.

```bash
npm run index -- --depth 50    # dig much further back
npm run stats                  # how far back have we got?
```

### Viewer controls

`Older than` sets the minimum age floor — the point of the tool is to skip
recent posts, so the default is three months. `Allow repeats` ignores the
`shown_at` stamp when the unseen pool runs dry.

## Package Structure

```
strata/
├── src/
│   ├── atproto.ts        # XRPC client: throttling, retries, DID/PDS resolution
│   ├── db.ts             # SQLite schema, upserts, random selection
│   ├── index-crawl.ts    # Indexer CLI
│   └── serve.ts          # Local HTTP server + hydration
├── public/
│   └── index.html        # Viewer (single file, no build step)
└── data/
    └── strata.db         # Created on first run
```

## Testing

There is no unit-test suite yet. The type checker covers the API response
shapes, which is where most breakage would come from:

```bash
npx tsc --noEmit              # Typecheck all sources
npm run stats                 # Verify the index looks sane
```
