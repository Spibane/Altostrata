# Changelog

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
