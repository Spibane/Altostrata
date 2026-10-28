<h1 align="center">&#128187; Altostrata</h1>

<h2 align="center"><strong>Rediscover old media posts from the people you follow on Bluesky</strong></h2>

<div align="center">

[![Version](https://img.shields.io/badge/version-2.9.1-black)]()
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
                          └──► card ──► PLAY / DOWNLOAD ──► com.atproto.sync.getBlob
                                                            the original upload
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
- **Excludes anything you liked, reposted or bookmarked**, read from your own
  repo for likes and reposts, and backfilled from the AppView for bookmarks
  once you sign in. Repeat runs only scan back to the highest record key
  already seen, so syncing 30,000 likes is expensive once and cheap
  thereafter. Likes can be re-admitted with a toggle when you want to revisit
  favourites; reposts and bookmarks stay hidden either way.
- **Dig within one account.** Clicking a handle scopes every subsequent Dig to
  just that person until you clear the filter or start a new index. The same
  filter can be reached from the Index panel by searching for an account you
  haven't stumbled onto yet — it shows each account's post count and indexed
  date range, and survives a reload instead of reverting to global digging.
- **Browse what an account has liked.** While digging one account, **Their
  likes** walks that person's own `app.bsky.feed.like` records straight from
  their PDS and renders the media posts among them as ordinary cards — a public
  read that needs no account of your own, and a way into artwork by people you
  don't follow yet. **More** keeps walking back through their likes.
- **A local "kept" shelf.** Every find gets a star, alongside like/repost/
  bookmark, that holds it on this device and stops it from resurfacing — no
  sign-in required, so a signed-out visitor still has a way to hang onto
  something instead of losing it the moment it scrolls past. Viewable as its
  own full page from the Index panel.
- **Moderation labels blur in place**, with the label's own name on the cover
  and a tap to reveal — configurable in the Index panel to always show or hide
  labelled posts entirely instead. The crawl is anonymous, so this can't see
  your own mutes and blocks.
- **Replies and quote posts are marked**, rather than rendering identically to
  a standalone post — which on an art feed can otherwise be genuinely
  misleading (a reply pulled out of its thread, or a quote missing what it's
  quoting).
- **Original-quality downloads.** The Download button pulls the actual file the
  artist uploaded via `com.atproto.sync.getBlob` — not the CDN's re-encoded
  JPEG. Transparent PNGs stay transparent and video comes down as the source
  MP4 rather than an HLS playlist.
- **Mentions, links and hashtags are clickable**, rendered from the post's own
  facets so a shortened link still points at its real target. Only `http` and
  `https` are honoured, since post text comes from strangers.
- **Images open in an overlay, not a new tab.** Posts with several images are
  cropped to square tiles to keep a page on a grid, so a thumbnail is often not
  the whole picture. Clicking one opens it uncropped in place, with arrow keys to
  page through the post — without losing the page of finds you were reading.
  Cmd or middle click still opens the original in a tab.
- **Video plays inline.** A thumbnail is a server-chosen frame and often says
  nothing about the clip, so video posts get a play button that loads the original
  file. Seeking works, which it does not when streaming from a PDS.
- **Like, repost and bookmark in place**, via OAuth. Liking from Altostrata also adds
  the post to your exclusions immediately, so it stops resurfacing without
  waiting for the next like sync — and unliking makes it findable again.
- **Progressive first run.** A shallow pass surfaces artwork within a couple of
  minutes, then the crawl keeps digging deeper in the background while you browse.
- **Resettable seen state.** Kept in its own store, so forgetting everything you
  have been shown is instant and leaves the index and exclusions intact.
- **Per-author caps** so one prolific account can't fill a page.
- **Depth gauge** on each card showing where the post sits within that
  account's *indexed* history, marked at real month and year boundaries — a
  post near the bottom of the rail is close to the oldest thing Altostrata has
  found for that person.
- **Export and import.** The whole index round-trips through a JSON file, for
  moving between browsers or surviving storage eviction.
- **Self-healing index.** Posts the AppView no longer returns are deleted
  locally on the next dig that touches them.
- **Throttled and retried.** Requests are serialised with a minimum interval,
  with exponential backoff on 429 and 5xx.

### Known limitations

- **Storage can be evicted.** Safari clears IndexedDB for sites not visited for
  roughly a week. Altostrata calls `navigator.storage.persist()`, which Chrome
  generally grants and Safari generally does not — the Index panel shows
  whether protection was granted, and export if you care about the index.
- **Every visitor crawls from scratch.** With no server there is no shared index,
  so nobody benefits from anyone else's crawl.
- **The tab must stay open while crawling.** Progress is saved continuously, so
  closing it loses only the page in flight.
- **Unlikes are not detected.** Removing a like leaves a stale exclusion until
  the exclusion table is rebuilt.
- **Your blocks and mutes are not applied to the crawl.** The backfill reads
  anonymously, so it doesn't carry viewer state. This only matters for accounts
  you follow and have muted.
- **`posts_with_media` means images.** Video needs the `posts_with_video` filter
  as a separate pass.
- **Video downloads fully before it plays.** A PDS ignores Range requests, so
  streaming it directly makes any seek restart from the beginning. Loading the
  whole file first costs a short wait and makes the scrubber work. Bluesky caps
  video length, so these are megabytes.
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
| **Click a handle** | Dig only that account until you Clear the filter |
| **Their likes** | Browse the media posts the account you're digging has liked; **More** pages further back |
| **Click an image** | Open it uncropped in an overlay; arrows or swipe page through the post |
| **Play** | Load and play a video post's original file |
| **Download** | Save the original file for that image or video |
| **Like / Repost / Bookmark** | Acts on your account; prompts sign-in if needed |
| **Star** | Keeps a find on this device so it stops resurfacing; no sign-in needed |
| **Sign in** | OAuth via Bluesky; nothing is required to browse or download |
| **Index** | Stats, dig deeper, reset seen posts, search an account to dig, view kept posts, export/import, start over |

## Deploying

`.github/workflows/pages.yml` typechecks, builds and deploys on every push to
`main`. Enable it with **Settings → Pages → Source: GitHub Actions**.

This deployment serves from the custom domain
[`altostrata.spibane.com`](https://altostrata.spibane.com/), recorded in
[`public/CNAME`](./public/CNAME) and set under **Settings → Pages → Custom
domain**, with **Enforce HTTPS** on. The DNS side is one `CNAME` record for the
`altostrata` label pointing at `spibane.github.io`. Nothing else in the build
knows the URL: every path in the page is relative, so the same artifact serves
correctly from a domain root or a `/REPO/` subpath.

**One thing must be edited before OAuth works:**
[`public/client-metadata.json`](./public/client-metadata.json) hard-codes the
deployed URL, and the AT Protocol requires `client_id` to be the exact URL that
serves that file. If you are serving from anywhere other than
`https://altostrata.spibane.com/`, update all three fields:

```json
{
  "client_id":     "https://YOUR.DOMAIN/client-metadata.json",
  "client_uri":    "https://YOUR.DOMAIN/",
  "redirect_uris": ["https://YOUR.DOMAIN/"]
}
```

`client_id` *is* the client's identity to every authorization server, so
changing the domain makes this a different OAuth client: existing sessions stop
being honoured and everyone signs in again. The `scope` there must also match
the scope requested in `src/session.ts`, or the authorization server rejects the
request with `invalid_scope`. Local development needs none of this — a loopback
origin builds its own client identity, so `npm run dev` on `127.0.0.1` can sign
in as-is.

**Moving domains takes the index with nothing.** IndexedDB is scoped to an
origin, so a visitor arriving at the new domain finds an empty index, an empty
kept shelf and no seen state, even though the old URL redirects here. The Index
panel's **Export** on the old origin and **Import** on the new one is the only
route across.

## Development

```bash
npm install
npm run dev          # esbuild watch + static server on http://127.0.0.1:8000
npm run typecheck    # must pass; no test suite yet
npm run build        # minified bundle into public/app.js
npm run icon         # regenerate the iOS icon after changing the mark
```

There is no `.env` and nothing to configure — the app has no secrets and no
server-side settings.

## Package Structure

| Path | Role |
|---|---|
| `src/atproto.ts` | All outbound HTTP. Throttling, retries, DID/PDS resolution, blob fetches |
| `src/store.ts` | IndexedDB schema and every query, including random selection |
| `src/crawl.ts` | Crawl orchestration, progress reporting, abort handling |
| `src/media.ts` | Embed parsing, video playback, original-file downloads |
| `src/richtext.ts` | Facet rendering and HTML escaping |
| `src/session.ts` | OAuth sign-in, authenticated XRPC, likes/reposts/bookmarks |
| `src/app.ts` | UI: setup, digging, cards, settings |
| `public/index.html` | Page shell and all styling |
| `public/client-metadata.json` | OAuth client identity; must match the deployed URL |
| `public/apple-touch-icon.png` | 180px icon for iOS; `npm run icon` regenerates it |
| `tools/make-icon.mjs` | Rasterises the mark to PNG, with no image library |
| `public/app.js` | Built bundle, committed for static hosting |
