# Changelog

### v2.1.1 - 2026-07-28

- Replaced the muddy brass and cream palette with true-neutral darks, crisp white
  text and a brighter amber, which is now reserved for the excavation motif: age
  stamps, the depth rail and the Dig button
- Turned the card footer links into real buttons — pill-shaped, with inline
  Bluesky-style glyphs, abbreviated counts, and rose/green/blue active states for
  liked, reposted and bookmarked
- Reordered the top bar into a single row: Dig and its filters on the left, index
  and account controls on the right
- Hid the tagline while browsing and shortened the displayed handle by dropping a
  `.bsky.social` suffix, which together took the gap between the top-bar groups
  from 26px to 113px
- Renamed the widest "older than" option to `now` and moved it to the top of the
  list, so the scale reads shortest to longest
- Declared `color-scheme: dark`, so browsers do not apply automatic dark mode on
  top of an already dark page
- Fixed the download-all button being swallowed by the like/repost handler, as it
  carried both selectors
- Made the wordmark a button that returns to the top of the page
- Brought the dialogs into the same visual language as the cards: pill buttons
  with raised fills, recessed input fields, and the oldest-post date in amber.
  Their colours were already current; the button shapes were not
- Added quarter marks to the depth rail, so a post's dot reads as a fraction of
  that account's indexed history rather than a bare position on a line

### v2.1.0 - 2026-07-28

- Added optional sign-in with AT Protocol OAuth, so posts can be liked, reposted
  and bookmarked from inside Strata. Reading, digging and downloading still need
  no account
- Added `@atproto/oauth-client-browser` as the project's first runtime
  dependency, which handles DPoP proofs, PAR, PKCE and token refresh. The bundle
  grows from about 8 KB to 69 KB gzipped
- Chose OAuth over app passwords deliberately: no password is ever entered into
  the page, tokens are DPoP-bound to a non-extractable key, and access is
  revocable from Bluesky settings — which matters because this is hosted publicly
- Liking or reposting from Strata writes the post into the exclusion store
  immediately, so it stops resurfacing without waiting for the next like sync;
  undoing either removes the exclusion again
- Hydration switches to the authenticated AppView when signed in, so each card
  shows whether the reader has already liked, reposted or bookmarked it
- Routed authenticated requests through the same throttle as anonymous ones, so
  signing in does not open a second, unmetered request path
- Added `public/client-metadata.json` for the OAuth client identity, and built
  loopback client metadata at runtime so local development needs no published
  client document
- Renamed the media Save button to Download, to distinguish it from Bookmark
- Stopped emitting a production sourcemap; it had grown to 1.1 MB of bundled
  library sources and churned on every build

### v2.0.0 - 2026-07-28

Rebuilt as a static browser application. There is no longer a server or a
database to host, and the Node CLI is gone.

- **Breaking:** removed the Node indexer, the local server, and the SQLite
  database. `npm run index`, `npm run serve` and `npm run stats` no longer exist
- **Breaking:** dropped the `better-sqlite3` dependency and the `.env` file; the
  app has no runtime dependencies and nothing to configure
- **Breaking:** added a build step. `npm run build` bundles TypeScript into
  `public/app.js` with esbuild, replacing the previous no-build convention
- Added a setup page that takes any handle and builds the index in the browser,
  so the app can be hosted publicly for anyone to use
- Moved the entire index into IndexedDB, scoped per browser, so each visitor has
  their own index and nothing about anyone's likes ever leaves their machine
- Added original-quality downloads via `com.atproto.sync.getBlob`, giving the
  file the artist uploaded rather than a re-encoded CDN derivative — including
  the source MP4 for video posts
- Added a reset for seen posts, kept in its own store so clearing it leaves the
  index and like exclusions intact
- Added a progressive first run: a shallow pass surfaces artwork within a couple
  of minutes while the deeper crawl continues in the background
- Added JSON export and import for the whole index, for moving between browsers
  or surviving storage eviction
- Added a stop control and crawl resumption, so closing the tab loses only the
  page in flight
- Fixed video posts never rendering: embed source selection tested for the shape
  of a `recordWithMedia` embed, which a bare video view does not have, so every
  video post was silently dropped from results
- Fixed random selection returning short pages once the wrap-around scan was
  reached, caused by reusing an IndexedDB transaction that had already committed
- Added a GitHub Pages workflow that typechecks, builds and deploys on push

### v1.0.0 - 2026-07-28
- Initial release
- Resumable media-post backfill across all followed accounts via `getAuthorFeed` with the `posts_with_media` filter
- Exclusion of liked and reposted posts, read from the user's own repo with incremental record-key checkpointing
- Random selection with a minimum-age floor, per-author caps, and repeat suppression
- Local viewer with post age stamp and per-account depth gauge
- Fully unauthenticated: no app password or session token required
- Configuration read from a gitignored `.env`, loaded natively by every `npm run` script with no added dependency
