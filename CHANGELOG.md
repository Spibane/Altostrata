# Changelog

### v2.6.1 - 2026-07-29

- Added the author's avatar to each card, beside the name and handle. It comes
  from the hydrated post view, which already carried it, so this costs no extra
  requests. Posts by accounts with no avatar render without one

### v2.6.0 - 2026-07-29

- **Clicking a handle now digs only that account.** A "Digging @handle" chip
  appears with a Clear control, and every Dig click stays scoped to that
  author until you clear it or start a new/reset index. Uses the `by_author`
  index that already existed on `posts` but had no query behind it
- **Bookmarking now excludes a post from future digs**, the same as liking or
  reposting. This needed a schema fix: the exclusion store used to key rows by
  URI alone, so a post could carry only one reason — a post that was both
  liked and bookmarked would lose its bookmark exclusion the moment "Include
  liked" re-admitted the like. Exclusions are now keyed by `[uri, reason]`,
  migrated automatically from the old shape on first load. Bookmarks made
  before this release, or from another client, are backfilled once on sign-in
- **Like, repost and bookmark buttons are visibly muted while signed out.**
  Previously they looked identical whether or not you could act on them;
  clicking still opens the sign-in dialog either way
- **The depth gauge marks real month and year boundaries** instead of even
  quarter-marks. Year boundaries are labelled; month ticks appear too for any
  account indexed across less than three years, past which they'd just be
  noise
- **Reworked the mobile header.** Only the wordmark and Dig button (plus the
  author filter chip, when active) stay pinned to the top; the age filter,
  toggles and account controls scroll away underneath like ordinary content,
  rather than eating a quarter of the screen permanently. Index/Sign in/Sign
  out collapse to icons at this width
- **Swipe left or right in the image viewer** to move between a post's
  images, alongside the existing arrow keys and on-screen chevrons
- **Tapping anywhere outside the image now closes the viewer.** It previously
  required an exact click on the dialog's own backdrop, so most of what
  visually read as blank space around the caption bar did nothing
- Fixed Dig's scroll-to-top not completing on mobile: it now waits a frame
  for the new cards to lay out before starting the scroll, rather than racing
  the browser's own reflow
- Fixed a second, unrelated block of dead space at the bottom of the page: an
  empty status-message slot below the results still reserved 80px of padding
  with nothing in it

### v2.5.1 - 2026-07-28

- Restored the full four-bar logo in the header, matching the original mockup:
  bar widths 62/48/62/40 at descending opacity with the amber dot on the third.
  The favicon keeps its three-bar simplification, which is only needed at 16px
- Sized the mark to the logotype's ascender rather than its cap height, so its top
  meets the top of the name. "Altostrata" carries an l and two t's, which set the
  line the eye reads at 19.3px against an 18.6px cap — the mark now stands 20.5px
  with its top within 0.05px of the letters and its foot still on the baseline
- Fixed the header bouncing between one and two rows on every dig. With the mark
  now occupying header space, the button's "Digging" label — 34px wider than
  "Dig" — no longer fit, so the row wrapped and unwrapped each time. The busy
  label is three characters instead, exactly as wide as "Dig" in a monospace face

### v2.5.0 - 2026-07-28

- Clicking an image now opens it in an overlay instead of a new tab. Multi-image
  posts are cropped to square tiles so a page of finds stays on a grid, which
  means the thumbnail frequently is not the whole picture — one measured case
  showed a 1000x568 image inside a 369x369 tile, with nearly half of it cut away.
  The only way to see the rest was a new tab, which threw you out of the app and
  cost you the page you were part-way through
- The overlay shows the full image with its aspect ratio intact, the author's alt
  text as a caption, a position counter, and a download for the original
- Arrow keys and on-screen chevrons page through a post's images; Escape, the
  close button, or a click on the surround dismisses it
- The thumbnail is still a real link, so Cmd, Ctrl or middle click continues to
  open the original in a new tab. Only an unmodified left click is intercepted
- Closing releases the decoded full-size image, which is the largest thing the
  page holds outside the index itself

### v2.4.0 - 2026-07-28

- Added a logo: three stacked bars of decreasing weight with an amber dot resting
  on the middle one, taken from the depth rail already on every card, so the mark
  means the same thing the interface does — layers of history, and one find
- Used it as the favicon, as an inline SVG data URI, so there is no binary to
  fetch and nothing that can fall out of sync with the page
- Added a 180px `apple-touch-icon.png`, because iOS ignores SVG there. This is
  worth more than decoration: an installed site gets far gentler storage eviction
  than a bookmarked one, and rebuilding a 116,000-post index is expensive
- Added `npm run icon` and `tools/make-icon.mjs`, which paints the mark pixel by
  pixel and writes the PNG chunks directly, so the icon is reproducible without an
  image library
- Placed the mark beside the wordmark, sized to the logotype's cap height: 19px
  tall against a measured 18.6px cap, with its foot on the text baseline plus a
  0.045em optical overshoot. The wordmark itself is unchanged at 27px
- The header mark is cropped to the artwork while the favicon keeps a padded tile.
  Reusing the padded viewBox inline looked shrunken, because the glyph filled only
  about half the box it was given. Crop for inline use, pad for tiles
- The favicon's tile is dark, so its pale bars stay visible on a light browser tab

### v2.3.1 - 2026-07-28

Findings from a full pass over the codebase for bugs and weaknesses.

- **Fixed data loss on a failed import.** Importing validated only the file
  version, wiped the index, and then read fields that a malformed file does not
  have — so picking the wrong file destroyed the index and reported
  "Cannot read properties of undefined". Reproduced at 967 posts to zero. The
  whole payload is now checked before anything is written, and a bad file leaves
  the index untouched with a message that says what was wrong
- Hardened import against prototype pollution: field names come from the file, so
  rows are assembled on a null-prototype object and `__proto__`, `constructor`
  and `prototype` are rejected as field names
- **Fixed cards whose Play and Download buttons did nothing.** Six controls
  trigger a dig, but only the Dig button guarded against overlap. Two digs racing
  meant the slower one cleared the card state the faster one had just written.
  Digs are now numbered, and a superseded one abandons without touching shared
  state, the page or the button
- Added a Content-Security-Policy. Cards are assembled as HTML strings from other
  people's posts, so `script-src 'self'` keeps an escaping slip from becoming
  script execution. `connect-src`, `img-src` and `media-src` stay open to https
  because a PDS can be on any host
- Added a `no-referrer` policy
- Reported running out of storage mid-crawl as itself, noting the partial index is
  kept, rather than surfacing an opaque DOM error
- Fixed a malformed `complete` value importing as `NaN`, which dropped an author
  out of the index that drives crawling — leaving an account that was never
  crawled and never reported done
- Released video object URLs and cleared card state when a dig comes back empty,
  rather than only when it comes back full

### v2.3.0 - 2026-07-28

- Mentions, links and hashtags in post text are now clickable, rendered from the
  post's own facets. A link facet's display text is often a shortened form of its
  target, so the visible text comes from the text and the href from the facet —
  `www.cpsc.gov/Recalls/2026...` links to the full URL
- Facet ranges are resolved in UTF-8 byte space rather than by string index.
  Character indexing corrupts every facet following an emoji or non-Latin
  character, which on an art feed is most posts
- Facet URIs are restricted to `http` and `https`. Post text comes from strangers
  and is rendered into an `href` on a public page, so `javascript:` and `data:`
  links would otherwise execute
- Moved `escapeHtml` into the new `richtext.ts` alongside the facet renderer

### v2.2.1 - 2026-07-28

- Video posts can now be played. Previously they showed only a thumbnail — a
  server-chosen frame that frequently misrepresented the clip — with no way to
  watch it
- Playback fetches the original file and plays it from an object URL rather than
  streaming from the PDS. Streaming starts faster, but `getBlob` ignores Range
  requests, so any seek made the browser re-request from byte zero and threw
  playback back to the start. Measured: seeking to 30s landed at 3.8s. With the
  file loaded locally, seeks land exactly
- Video posters now use the author's own alt text instead of the placeholder
  "Video thumbnail", and the player inherits the post's aspect ratio so swapping
  the poster for the video does not shift the page
- The HLS manifest is kept as a fallback for when a blob cannot be fetched; it
  would need a player library to work outside Safari

### v2.2.0 - 2026-07-28

- Renamed the project from Strata to **Altostrata**. "Strata" collided with an
  entire category of condo-management software, which would have buried the app
  in search forever. Altostrata keeps the layers metaphor — the depth rail and
  age stamps are unchanged — while borrowing from *altostratus*, the layered
  cloud deck, so it sits in Bluesky's ATmosphere rather than underground
- **Breaking for deployment:** `client_id` in `public/client-metadata.json` now
  points at the new Pages URL. OAuth fails until the deployed URL and that file
  agree, and anyone who signed in against the old URL has to sign in again
- Kept the IndexedDB database name as `strata`. It is invisible to users, and
  renaming it would orphan every index already built

### v2.1.2 - 2026-07-28

- Added an "Include liked" toggle that re-admits posts excluded because you liked
  them, for revisiting favourites. Reposts stay excluded either way, which meant
  teaching the exclusion store to remember *why* each post was excluded rather
  than only that it was
- Stacked the two filter checkboxes into a column sharing the header row, which
  is narrower than laying them side by side and left the labels spelled out

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
- Fixed clicks landing on a button's icon doing nothing. The delegated handler
  narrowed the event target to `HTMLElement`, which an inline SVG is not, so only
  the padding around each glyph responded. This affected the like, repost and
  bookmark buttons as well as the per-image download overlays
- The card's download button now appears on every post with an original file,
  not only on posts with more than one image
- Confirmed bookmarks take the same `{uri, cid}` subject shape as likes and
  reposts, and removed the notes calling that shape unverified

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
