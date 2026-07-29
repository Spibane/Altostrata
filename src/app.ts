import { AbortedError, fetchBlob, getPosts, resolveHandle, type PostView } from "./atproto.ts";
import { escapeHtml, renderRichText } from "./richtext.ts";
import { crawl, type CrawlProgress } from "./crawl.ts";
import {
  authedTransport,
  bookmark,
  currentAccount,
  initAuth,
  isSignedIn,
  like,
  listBookmarks,
  PopupBlockedError,
  repost,
  signIn,
  signInRedirect,
  signOut,
  unbookmark,
  unlike,
  unrepost,
} from "./session.ts";
import {
  downloadAllOriginals,
  downloadOriginal,
  extractImages,
  extractVideo,
  originalRefs,
  type DownloadTarget,
  type VideoRef,
  type ViewImage,
} from "./media.ts";
import {
  deletePosts,
  estimateUsage,
  exportIndex,
  getMeta,
  importIndex,
  insertExclusions,
  markShown,
  removeExclusion,
  requestPersistence,
  resetAll,
  resetSeen,
  shuffle,
  shuffleByAuthor,
  stats,
  type IndexFile,
  type ShuffleRow,
  type Stats,
} from "./store.ts";

/** Pages the shallow pass covers before the deep pass takes over. */
const SHALLOW_DEPTH = 1;
const DEEP_DEPTH = 50;
const PAGE_SIZE = 12;

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing element #${id}`);
  return node as T;
}

const ui = {
  toTop: el<HTMLButtonElement>("to-top"),
  pinnedRow: el("pinned-row"),
  controlsRow1: el("controls-row-1"),
  controlsRow2: el("controls-row-2"),
  tagline: el("tagline"),
  age: el<HTMLSelectElement>("age"),
  seen: el<HTMLInputElement>("seen"),
  liked: el<HTMLInputElement>("liked"),
  dig: el<HTMLButtonElement>("dig"),
  digBottom: el<HTMLButtonElement>("dig-bottom"),
  diggingAs: el("digging-as"),
  diggingHandle: el("digging-handle"),
  clearDigFilter: el<HTMLButtonElement>("clear-dig-filter"),
  openSettings: el<HTMLButtonElement>("open-settings"),
  progress: el("progress"),
  track: el("track"),
  fill: el("fill"),
  progressLabel: el("progress-label"),
  stop: el<HTMLButtonElement>("stop"),
  setup: el("setup"),
  setupForm: el<HTMLFormElement>("setup-form"),
  handle: el<HTMLInputElement>("handle"),
  start: el<HTMLButtonElement>("start"),
  setupError: el("setup-error"),
  importFirst: el<HTMLButtonElement>("import-first"),
  results: el("results"),
  note: el("note"),
  settings: el<HTMLDialogElement>("settings"),
  statsList: el("stats"),
  deepen: el<HTMLButtonElement>("deepen"),
  refresh: el<HTMLButtonElement>("refresh"),
  depthNote: el("depth-note"),
  resetSeen: el<HTMLButtonElement>("reset-seen"),
  exportBtn: el<HTMLButtonElement>("export"),
  importBtn: el<HTMLButtonElement>("import"),
  resetAll: el<HTMLButtonElement>("reset-all"),
  closeSettings: el<HTMLButtonElement>("close-settings"),
  file: el<HTMLInputElement>("file"),
  lightbox: el<HTMLDialogElement>("lightbox"),
  lbImg: el<HTMLImageElement>("lb-img"),
  lbPrev: el<HTMLButtonElement>("lb-prev"),
  lbNext: el<HTMLButtonElement>("lb-next"),
  lbClose: el<HTMLButtonElement>("lb-close"),
  lbCaption: el("lb-caption"),
  lbCount: el("lb-count"),
  lbDownload: el<HTMLButtonElement>("lb-download"),
  signin: el<HTMLButtonElement>("signin"),
  who: el("who"),
  whoHandle: el("who-handle"),
  signout: el<HTMLButtonElement>("signout"),
  auth: el<HTMLDialogElement>("auth"),
  authForm: el<HTMLFormElement>("auth-form"),
  authHandle: el<HTMLInputElement>("auth-handle"),
  authGo: el<HTMLButtonElement>("auth-go"),
  authError: el("auth-error"),
  authFallback: el("auth-fallback"),
  authRedirect: el<HTMLButtonElement>("auth-redirect"),
  authClose: el<HTMLButtonElement>("auth-close"),
};

let crawlController: AbortController | undefined;
/** Download targets for what is currently on screen, keyed by post URI. */
const targets = new Map<string, DownloadTarget>();

interface ActionState {
  cid: string;
  likeUri: string | null;
  repostUri: string | null;
  bookmarked: boolean;
}

/** Like/repost/bookmark state for what is on screen, keyed by post URI. */
const actions = new Map<string, ActionState>();

/** Playable video details for what is on screen, keyed by post URI. */
const videos = new Map<string, VideoRef>();

/** Every image of each post on screen, so the viewer can page through them. */
const galleries = new Map<string, ViewImage[]>();

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/** `escapeHtml` and rich-text rendering both live in `richtext.ts`. */

/** "3 years, 7 months" — the coarse unit is what matters here, not precision. */
function formatAge(iso: string): string {
  const then = new Date(iso);
  const now = new Date();
  let months = (now.getFullYear() - then.getFullYear()) * 12 + (now.getMonth() - then.getMonth());
  if (now.getDate() < then.getDate()) months -= 1;
  if (months < 1) {
    const days = Math.max(1, Math.round((now.getTime() - then.getTime()) / 86_400_000));
    return days === 1 ? "Yesterday" : `${days} days ago`;
  }
  const years = Math.floor(months / 12);
  const rest = months % 12;
  const parts: string[] = [];
  if (years) parts.push(`${years} year${years === 1 ? "" : "s"}`);
  if (rest) parts.push(`${rest} month${rest === 1 ? "" : "s"}`);
  return `${parts.join(", ")} ago`;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

/** 1200 -> "1.2K", matching how Bluesky abbreviates counts. */
function formatCount(value: number): string {
  if (value < 1000) return String(value);
  if (value < 1_000_000) {
    const thousands = value / 1000;
    return `${thousands < 10 ? thousands.toFixed(1).replace(/\.0$/, "") : Math.round(thousands)}K`;
  }
  return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

// ---------------------------------------------------------------------------
// Icons
//
// Inline so the page stays self-contained and the glyphs inherit `currentColor`.
// `.fillable` is filled by CSS once a gesture is active, the way a liked heart
// goes solid on Bluesky.
// ---------------------------------------------------------------------------

function icon(paths: string, fillable = false): string {
  return (
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" ` +
    `stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">` +
    `<path${fillable ? ' class="fillable"' : ""} d="${paths}"/></svg>`
  );
}

const ICONS = {
  like: icon("M12 20.8s-8-4.9-8-10.2A4.8 4.8 0 0 1 12 7.5a4.8 4.8 0 0 1 8 3.1c0 5.3-8 10.2-8 10.2z", true),
  mark: icon("M6.5 3.5h11a1 1 0 0 1 1 1v16L12 16.2 5.5 20.5v-16a1 1 0 0 1 1-1z", true),
  repost:
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" ` +
    `stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">` +
    `<path d="M17.5 3.5 21 7l-3.5 3.5"/><path d="M21 7H8.5A4.5 4.5 0 0 0 4 11.5V13"/>` +
    `<path d="M6.5 20.5 3 17l3.5-3.5"/><path d="M3 17h12.5A4.5 4.5 0 0 0 20 12.5V11"/></svg>`,
  download:
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" ` +
    `stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">` +
    `<path d="M12 3.5v11"/><path d="M7.5 10.5 12 15l4.5-4.5"/><path d="M4.5 20.5h15"/></svg>`,
  open:
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" ` +
    `stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">` +
    `<path d="M14 3.5h6.5V10"/><path d="M20.5 3.5 12 12"/>` +
    `<path d="M18 14.5v4a2 2 0 0 1-2 2H5.5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4"/></svg>`,
  play:
    `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">` +
    `<path d="M8 5.2v13.6a1 1 0 0 0 1.5.87l11.2-6.8a1 1 0 0 0 0-1.74L9.5 4.33A1 1 0 0 0 8 5.2z"/></svg>`,
  close: icon("M6.5 6.5l11 11M17.5 6.5l-11 11"),
  prev: icon("M14.5 5.5 8 12l6.5 6.5"),
  next: icon("M9.5 5.5 16 12l-6.5 6.5"),
} as const;

/**
 * Buttons carry an SVG beside their text, so transient labels are written into a
 * dedicated span. Assigning textContent on the button itself would drop the icon.
 */
function labelOf(button: HTMLElement): string {
  return button.querySelector(".label")?.textContent ?? "";
}

function setLabel(button: HTMLElement, text: string): void {
  const label = button.querySelector(".label");
  if (label) label.textContent = text;
}

// ---------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------

interface Card {
  uri: string;
  webUrl: string;
  /** Already-escaped HTML, with mentions, links and hashtags as anchors. */
  textHtml: string;
  createdAt: string;
  authorDid: string;
  handle: string;
  displayName: string;
  avatar: string | null;
  images: ViewImage[];
  isVideo: boolean;
  likeCount: number;
  repostCount: number;
  depth: number | null;
  authorOldest: string | null;
  authorNewest: string | null;
  originals: number;
}

/** Position of this post within the author's indexed history, 0 = oldest. */
function depthOf(row: ShuffleRow): number | null {
  if (!row.authorOldest || !row.authorNewest) return null;
  const oldest = Date.parse(row.authorOldest);
  const newest = Date.parse(row.authorNewest);
  const span = newest - oldest;
  if (!Number.isFinite(span) || span <= 0) return null;
  return Math.min(1, Math.max(0, (Date.parse(row.createdAt) - oldest) / span));
}

function toCard(post: PostView, row: ShuffleRow): Card {
  // Refs are zipped into the images by record position, so each image carries
  // its own. `targets.refs` is then rebuilt from the *rendered* images, keeping
  // DOM indices and blob refs aligned even when an entry was unusable.
  const { images, isVideo } = extractImages(post.embed, originalRefs(post));
  const refs = images.map((image) => image.original);
  const handle = post.author.handle;

  targets.set(post.uri, { uri: post.uri, authorDid: post.author.did, handle, refs });
  const video = extractVideo(post.embed);
  if (video) videos.set(post.uri, video);
  if (images.length > 0 && !video) galleries.set(post.uri, images);
  actions.set(post.uri, {
    cid: post.cid,
    likeUri: post.viewer?.like ?? null,
    repostUri: post.viewer?.repost ?? null,
    bookmarked: post.viewer?.bookmarked ?? false,
  });

  return {
    uri: post.uri,
    webUrl: `https://bsky.app/profile/${handle}/post/${post.uri.split("/").pop() ?? ""}`,
    textHtml: renderRichText(post.record?.text ?? "", post.record?.facets),
    createdAt: post.record?.createdAt ?? row.createdAt,
    authorDid: post.author.did,
    handle,
    displayName: post.author.displayName ?? handle,
    avatar: post.author.avatar ?? null,
    images,
    isVideo,
    likeCount: post.likeCount ?? 0,
    repostCount: post.repostCount ?? 0,
    depth: depthOf(row),
    authorOldest: row.authorOldest,
    authorNewest: row.authorNewest,
    originals: refs.filter((ref) => ref !== null).length,
  };
}

interface Notch {
  pct: number;
  label: string | null;
}

const THREE_YEARS_MS = 3 * 365 * 86_400_000;

/**
 * Real month/year boundaries within an author's indexed range, positioned the
 * same way as the "you are here" tick (`depthOf`) — newest at 0%, oldest at
 * 100%. Endpoints are skipped since `gaugeHtml`'s "now"/oldest-year caps
 * already label them. Month ticks are dropped for authors indexed across more
 * than ~3 years, where they would otherwise be too dense to read.
 */
function gaugeNotches(oldestIso: string, newestIso: string): Notch[] {
  const oldest = Date.parse(oldestIso);
  const newest = Date.parse(newestIso);
  const span = newest - oldest;
  if (!Number.isFinite(span) || span <= 0) return [];

  const pctOf = (ms: number): number => (1 - (ms - oldest) / span) * 100;
  const oldestDate = new Date(oldest);
  const newestDate = new Date(newest);
  const notches: Notch[] = [];
  const yearBoundaries = new Set<number>();

  for (let year = oldestDate.getUTCFullYear() + 1; year <= newestDate.getUTCFullYear(); year++) {
    const ms = Date.UTC(year, 0, 1);
    if (ms <= oldest || ms >= newest) continue;
    yearBoundaries.add(ms);
    notches.push({ pct: pctOf(ms), label: String(year) });
  }

  if (span <= THREE_YEARS_MS) {
    let cursor = Date.UTC(oldestDate.getUTCFullYear(), oldestDate.getUTCMonth() + 1, 1);
    while (cursor < newest) {
      if (cursor > oldest && !yearBoundaries.has(cursor)) {
        notches.push({ pct: pctOf(cursor), label: null });
      }
      const d = new Date(cursor);
      cursor = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
    }
  }

  return notches;
}

function gaugeHtml(card: Card): string {
  if (card.depth === null) return '<div class="gauge"></div>';
  const fromTop = (1 - card.depth) * 100;
  // UTC, to match the notch boundaries below. Reading this one in local time put
  // the cap a year off from the notch sitting on top of it for anyone west of
  // Greenwich whose oldest post landed in the first hours of January.
  const oldestYear = card.authorOldest ? new Date(card.authorOldest).getUTCFullYear() : "";
  const notches =
    card.authorOldest && card.authorNewest
      ? gaugeNotches(card.authorOldest, card.authorNewest)
      : [];
  const notchesHtml = notches
    .map((notch) =>
      notch.label !== null
        ? `<span class="notch-year" style="top:${notch.pct.toFixed(2)}%">${notch.label}</span>`
        : `<span class="notch-month" style="top:${notch.pct.toFixed(2)}%"></span>`,
    )
    .join("");
  return `<div class="gauge" title="Position within this account's indexed history">
    <span class="cap top">now</span>
    ${notchesHtml}
    <span class="tick" style="top:${fromTop.toFixed(1)}%"></span>
    <span class="cap bottom">${oldestYear}</span>
  </div>`;
}

function mediaHtml(card: Card): string {
  const shown = card.images.slice(0, 4);
  const playable = videos.get(card.uri);

  const items = shown
    .map((image, i) => {
      // Keyed off this image's own ref rather than `i < card.originals`, which
      // assumed every downloadable original sat in an unbroken prefix.
      const grab =
        image.original !== null
          ? `<button class="grab" data-uri="${escapeHtml(card.uri)}" data-index="${i}"
             title="Download the original file">${ICONS.download}<span class="label">${
               card.isVideo ? "Video" : "Original"
             }</span></button>`
          : "";

      // A video poster is a server-chosen frame and frequently misleading, so the
      // thumbnail is only ever a placeholder for the real player.
      if (playable && i === 0) {
        const ratio = playable.aspectRatio
          ? ` style="aspect-ratio:${playable.aspectRatio.toFixed(4)}"`
          : "";
        return `<figure class="video"${ratio}>
          <img src="${escapeHtml(image.thumb)}" alt="${escapeHtml(image.alt || "Video")}" loading="lazy">
          <button class="play" data-play="${escapeHtml(card.uri)}" title="Play video"
            aria-label="Play video">${ICONS.play}</button>${grab}
        </figure>`;
      }

      // Still a real link: a plain click opens the viewer, but Cmd or middle click
      // keeps working as a link to the original.
      return `<figure>
        <a href="${escapeHtml(image.full)}" target="_blank" rel="noreferrer"
           data-zoom="${escapeHtml(card.uri)}" data-index="${i}">
          <img src="${escapeHtml(image.thumb)}" alt="${escapeHtml(image.alt || "Untitled image")}" loading="lazy">
        </a>${grab}
      </figure>`;
    })
    .join("");
  return `<div class="media n${shown.length}">${items}</div>`;
}

/**
 * Rendered whether or not anyone is signed in: clicking while signed out opens
 * the sign-in dialog, which is more discoverable than hiding the controls.
 */
function actionsHtml(card: Card): string {
  const state = actions.get(card.uri);
  const uri = escapeHtml(card.uri);
  // Muted rather than hidden or disabled while signed out: the click still opens
  // the sign-in dialog (see applyAction), which stays discoverable this way.
  const signedOut = !isSignedIn();

  const act = (
    kind: string,
    action: string,
    glyph: string,
    on: boolean,
    title: string,
    count?: number,
  ): string =>
    `<button class="act ${kind}" data-act="${action}" data-uri="${uri}" ` +
    `${signedOut ? 'data-signed-out="1" ' : ""}aria-pressed="${on}" title="${
      signedOut ? "Sign in to " + title.toLowerCase() : title
    }">${glyph}` +
    `${count ? `<span class="count">${formatCount(count)}</span>` : ""}</button>`;

  // Always offered when there is anything to fetch. The count only appears when
  // there is more than one file, but the label span is always present so status
  // text has somewhere to go; CSS hides it while empty.
  const downloadAll =
    card.originals > 0
      ? `<button class="act" data-all="${uri}" title="${
          card.originals > 1
            ? `Download all ${card.originals} originals`
            : "Download the original file"
        }">${ICONS.download}<span class="label">${
          card.originals > 1 ? card.originals : ""
        }</span></button>`
      : "";

  return `<div class="acts">
    ${act("like", "like", ICONS.like, state?.likeUri != null, "Like", card.likeCount)}
    ${act("repost", "repost", ICONS.repost, state?.repostUri != null, "Repost", card.repostCount)}
    ${act("mark", "bookmark", ICONS.mark, state?.bookmarked === true, "Bookmark")}
    ${downloadAll}
    <a class="act open" href="${escapeHtml(card.webUrl)}" target="_blank" rel="noreferrer"
       title="Open on Bluesky">${ICONS.open}</a>
  </div>`;
}

function cardHtml(card: Card): string {
  const extra = card.images.length > 4 ? `+${card.images.length - 4} more` : "";
  return `<article class="find">
    ${gaugeHtml(card)}
    <div>
      <div class="age">${escapeHtml(formatAge(card.createdAt))}</div>
      <div class="byline">
        ${
          card.avatar
            ? `<img class="avatar" src="${escapeHtml(card.avatar)}" alt="" loading="lazy">`
            : ""
        }
        <span>
          <a href="https://bsky.app/profile/${escapeHtml(card.handle)}" target="_blank" rel="noreferrer">${escapeHtml(card.displayName)}</a>
          &nbsp;<a class="handle" href="#" data-dig-author="${escapeHtml(card.authorDid)}"
             data-dig-handle="${escapeHtml(card.handle)}" title="Dig only @${escapeHtml(card.handle)}">@${escapeHtml(card.handle)}</a>
        </span>
      </div>
      ${card.textHtml ? `<p class="text">${card.textHtml}</p>` : ""}
      ${mediaHtml(card)}
      <div class="stamp">
        <span>${escapeHtml(formatDate(card.createdAt))}</span>
        ${card.isVideo ? '<span class="badge">video</span>' : ""}
        ${extra ? `<span>${escapeHtml(extra)}</span>` : ""}
      </div>
      ${actionsHtml(card)}
    </div>
  </article>`;
}

// ---------------------------------------------------------------------------
// Digging
// ---------------------------------------------------------------------------

/**
 * Digs are numbered so a slower one cannot finish on top of a faster one. Six
 * different controls call this, and the shared card state is keyed by URI: an
 * older dig clearing `targets` after a newer one filled it leaves cards on screen
 * whose Play and Download buttons quietly do nothing.
 */
/**
 * Deferred a frame (twice, to be safe across engines) rather than called
 * immediately after swapping in new cards: on mobile Safari, starting a smooth
 * scroll before the browser has laid out and painted the new content races the
 * dynamic toolbar's own resize, and the animation can stop short or no-op
 * entirely. Letting one paint happen first gives the scroll a settled layout
 * to animate against.
 */
function scrollToTop(): void {
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      window.scrollTo({ top: 0, behavior: "smooth" });
    });
  });
}

let digGeneration = 0;

/** When set, `dig()` scopes selection to one author instead of the whole index. */
let digFilter: { did: string; handle: string } | undefined;

function setDigFilter(filter: { did: string; handle: string } | undefined): void {
  digFilter = filter;
  ui.diggingAs.hidden = !filter;
  ui.diggingHandle.textContent = filter ? `@${filter.handle}` : "";
}

/**
 * `afterMessage` is shown once the page has rendered. Callers cannot set the note
 * themselves beforehand — digging clears it — so they hand it over instead.
 */
async function dig(afterMessage?: string): Promise<void> {
  const generation = ++digGeneration;
  const superseded = (): boolean => generation !== digGeneration;

  // Three characters, exactly as wide as "Dig" in a monospace face. "Digging" was
  // 34px wider, and with the mark now in the header there is not enough slack for
  // that — every dig bumped the row onto two lines and back. Both buttons move in
  // lockstep, so the trailing button can't be tapped again while the header one shows busy.
  for (const button of [ui.dig, ui.digBottom]) {
    button.disabled = true;
    button.textContent = "···";
  }
  ui.note.textContent = "";

  try {
    const options = {
      limit: PAGE_SIZE,
      minAgeDays: Number(ui.age.value),
      includeSeen: ui.seen.checked,
      includeLiked: ui.liked.checked,
    };
    const rows = digFilter
      ? await shuffleByAuthor(digFilter.did, options)
      : await shuffle({ ...options, maxPerAuthor: 2 });

    if (superseded()) return;

    if (rows.length === 0) {
      await showEmptyNote(superseded);
      return;
    }

    const byUri = new Map(rows.map((row) => [row.uri, row]));
    // Signed in, hydration goes through the authenticated AppView so each card
    // knows whether this reader has already liked, reposted or bookmarked it.
    const hydrated = await getPosts(
      rows.map((row) => row.uri),
      isSignedIn() ? authedTransport : undefined,
    );

    // Anything the AppView no longer knows about has been deleted upstream.
    const returned = new Set(hydrated.map((post) => post.uri));
    const missing = rows.map((row) => row.uri).filter((uri) => !returned.has(uri));
    if (missing.length > 0) await deletePosts(missing);

    // Last point of no return: everything below mutates shared state and the DOM.
    if (superseded()) return;

    targets.clear();
    actions.clear();
    videos.clear();
    galleries.clear();
    releaseObjectUrls();
    const cards: Card[] = [];
    // Hydrated but unrenderable — the AppView still knows the post, so it is not
    // "missing" and never gets deleted, but nothing can be drawn for it either.
    // Marking these seen alongside the rendered ones stops each from silently
    // consuming a slot in every future page forever.
    const unrenderable: string[] = [];
    for (const post of hydrated) {
      const row = byUri.get(post.uri);
      if (!row) continue;
      const card = toCard(post, row);
      if (card.images.length > 0) cards.push(card);
      else unrenderable.push(post.uri);
    }

    if (cards.length === 0) {
      if (unrenderable.length > 0) {
        markShown(unrenderable).catch((err: unknown) => {
          console.warn("Could not record seen state", err);
        });
      }
      await showEmptyNote(superseded);
      return;
    }

    ui.results.innerHTML = cards.map(cardHtml).join("");
    // Not awaited into the catch below: the cards are already on screen, so a
    // failure here (a full quota, say) is a seen-state problem, not a load
    // failure, and painting "Could not load posts" over a rendered page would
    // be actively wrong.
    markShown([...cards.map((card) => card.uri), ...unrenderable]).catch((err: unknown) => {
      console.warn("Could not record seen state", err);
    });
    if (afterMessage) ui.note.innerHTML = afterMessage;
    scrollToTop();
  } catch (err) {
    if (superseded()) return;
    ui.note.innerHTML = `<strong>Could not load posts.</strong> ${escapeHtml(
      err instanceof Error ? err.message : err,
    )}`;
  } finally {
    // A superseded dig must not re-enable the buttons while the newer one runs.
    if (!superseded()) {
      for (const button of [ui.dig, ui.digBottom]) {
        button.disabled = false;
        button.textContent = "Dig";
      }
    }
  }
}

/**
 * `superseded` is threaded in rather than checked against `digGeneration`
 * directly so this shares one notion of staleness with its caller. Without it,
 * a slow dig that found nothing could resume after `await stats()` and wipe a
 * *newer* dig's rendered cards — replacing real results with "nothing left to
 * surface", and revoking the object URL of a video the newer page had started
 * playing.
 */
async function showEmptyNote(superseded: () => boolean): Promise<void> {
  const s = await stats();
  if (superseded()) return;
  // Cards are going away, so their state and any object URLs go with them.
  targets.clear();
  actions.clear();
  videos.clear();
  galleries.clear();
  releaseObjectUrls();
  ui.results.innerHTML = "";
  if (s.posts === 0) {
    ui.note.innerHTML = `<strong>Nothing indexed yet.</strong> The crawl has not found any media posts.`;
    return;
  }
  const filterHint = digFilter
    ? `, or <a href="#" id="empty-clear-filter">clear the @${escapeHtml(digFilter.handle)} filter</a>`
    : "";
  ui.note.innerHTML =
    `<strong>Nothing left to surface at this depth.</strong> Loosen the age filter, allow repeats, ` +
    `dig deeper from the Index panel${filterHint}. ${s.unseen.toLocaleString()} of ` +
    `${s.posts.toLocaleString()} indexed posts are still unseen.`;
  if (digFilter) {
    document.getElementById("empty-clear-filter")?.addEventListener("click", (event) => {
      event.preventDefault();
      setDigFilter(undefined);
      void dig();
    });
  }
}

// ---------------------------------------------------------------------------
// Downloads
// ---------------------------------------------------------------------------

async function handleGrab(button: HTMLButtonElement): Promise<void> {
  const uri = button.dataset.uri;
  const index = Number(button.dataset.index ?? 0);
  if (!uri) return;
  const target = targets.get(uri);
  if (!target) return;

  const original = labelOf(button);
  button.disabled = true;
  button.dataset.state = "working";
  setLabel(button, "Saving");
  try {
    await downloadOriginal(target, index);
    button.dataset.state = "done";
    setLabel(button, "Saved");
  } catch (err) {
    button.dataset.state = "failed";
    setLabel(button, "Failed");
    console.warn(err);
  } finally {
    button.disabled = false;
    setTimeout(() => {
      delete button.dataset.state;
      setLabel(button, original);
    }, 2400);
  }
}

async function handleGrabAll(button: HTMLButtonElement): Promise<void> {
  const uri = button.dataset.all;
  if (!uri) return;
  const target = targets.get(uri);
  if (!target) return;

  const original = labelOf(button);
  button.disabled = true;
  button.dataset.busy = "1";
  try {
    const saved = await downloadAllOriginals(target);
    setLabel(button, `${saved} saved`);
  } catch (err) {
    button.dataset.failed = "1";
    setLabel(button, "Failed");
    console.warn(err);
  } finally {
    button.disabled = false;
    delete button.dataset.busy;
    setTimeout(() => {
      delete button.dataset.failed;
      setLabel(button, original);
    }, 2400);
  }
}

// ---------------------------------------------------------------------------
// Interactions
// ---------------------------------------------------------------------------

/**
 * Liking from inside Altostrata writes the post into the exclusion store too, so it
 * stops resurfacing immediately rather than waiting for the next like sync.
 * Undoing the like removes the exclusion again.
 */
async function applyAction(button: HTMLButtonElement): Promise<void> {
  const act = button.dataset.act;
  const uri = button.dataset.uri;
  if (!act || !uri) return;

  if (!isSignedIn()) {
    openAuth();
    return;
  }

  const state = actions.get(uri);
  if (!state) return;

  button.dataset.busy = "1";
  button.disabled = true;
  delete button.dataset.failed;

  try {
    if (act === "like") {
      if (state.likeUri) {
        await unlike(state.likeUri);
        state.likeUri = null;
        await removeExclusion(uri, "like");
      } else {
        state.likeUri = await like({ uri, cid: state.cid });
        await insertExclusions([{ uri, reason: "like" }]);
      }
      button.setAttribute("aria-pressed", String(state.likeUri !== null));
    } else if (act === "repost") {
      if (state.repostUri) {
        await unrepost(state.repostUri);
        state.repostUri = null;
        await removeExclusion(uri, "repost");
      } else {
        state.repostUri = await repost({ uri, cid: state.cid });
        await insertExclusions([{ uri, reason: "repost" }]);
      }
      button.setAttribute("aria-pressed", String(state.repostUri !== null));
    } else if (act === "bookmark") {
      if (state.bookmarked) {
        await unbookmark(uri);
        state.bookmarked = false;
        await removeExclusion(uri, "bookmark");
      } else {
        await bookmark({ uri, cid: state.cid });
        state.bookmarked = true;
        await insertExclusions([{ uri, reason: "bookmark" }]);
      }
      button.setAttribute("aria-pressed", String(state.bookmarked));
    }
  } catch (err) {
    // The glyph and count stay put; failure shows as the red state plus a note.
    button.dataset.failed = "1";
    const message = err instanceof Error ? err.message : String(err);
    ui.note.innerHTML = `<strong>That didn't go through.</strong> ${escapeHtml(message)}`;
    setTimeout(() => delete button.dataset.failed, 3000);
  } finally {
    delete button.dataset.busy;
    button.disabled = false;
  }
}

/** Object URLs for players on screen, revoked when the page of finds is replaced. */
const objectUrls: string[] = [];

function releaseObjectUrls(): void {
  for (const url of objectUrls) URL.revokeObjectURL(url);
  objectUrls.length = 0;
}

/**
 * Swaps the poster for a real player, because a video thumbnail is a
 * server-chosen frame and often says nothing about the clip.
 *
 * The whole file is fetched before playback rather than streamed from the PDS.
 * Streaming the blob URL directly does start faster, but `getBlob` ignores Range
 * requests: seeking makes the browser re-request from byte zero, so scrubbing
 * throws playback back to the start. Handing the player a complete local blob
 * costs a short wait and makes seeking work properly. Bluesky caps video length,
 * so these are megabytes, not gigabytes.
 *
 * The HLS manifest would stream and seek correctly, but needs a player library
 * outside Safari, so it stays a fallback.
 *
 * The download button is left in place — only the poster and the play control go.
 */
async function playVideo(button: HTMLButtonElement): Promise<void> {
  const uri = button.dataset.play;
  if (!uri) return;
  const info = videos.get(uri);
  const target = targets.get(uri);
  const figure = button.closest("figure");
  if (!info || !target || !figure) return;

  button.disabled = true;
  button.dataset.state = "loading";
  button.setAttribute("aria-label", "Loading video");

  const mount = (src: string): void => {
    const ratio = info.aspectRatio ? ` style="aspect-ratio:${info.aspectRatio.toFixed(4)}"` : "";
    figure.querySelector("img")?.remove();
    figure.insertAdjacentHTML(
      "afterbegin",
      `<video controls autoplay playsinline${ratio}` +
        `${info.alt ? ` aria-label="${escapeHtml(info.alt)}"` : ""}` +
        ` src="${escapeHtml(src)}"></video>`,
    );
    button.remove();
  };

  try {
    const blob = await fetchBlob(target.authorDid, info.cid);
    const src = URL.createObjectURL(blob);
    objectUrls.push(src);
    mount(src);
  } catch (err) {
    if (info.playlist) {
      mount(info.playlist);
      return;
    }
    button.disabled = false;
    delete button.dataset.state;
    button.setAttribute("aria-label", "Play video");
    ui.note.innerHTML =
      `<strong>That video could not be loaded.</strong> ` +
      escapeHtml(err instanceof Error ? err.message : err);
  }
}

// ---------------------------------------------------------------------------
// Image viewer
//
// Multi-image posts are cropped to square tiles so a page of finds stays on a
// grid, which means the thumbnail is often not the whole picture. Opening the
// original in a new tab answered that but threw you out of the app, losing the
// page of finds you were part-way through.
// ---------------------------------------------------------------------------

let viewing: { uri: string; index: number; images: ViewImage[] } | undefined;

function renderViewer(): void {
  if (!viewing) return;
  const image = viewing.images[viewing.index];
  if (!image) return;

  ui.lbImg.src = image.full;
  ui.lbImg.alt = image.alt || "";
  ui.lbCaption.textContent = image.alt || "";

  const total = viewing.images.length;
  ui.lbCount.textContent = total > 1 ? `${viewing.index + 1} / ${total}` : "";
  ui.lbPrev.hidden = total < 2;
  ui.lbNext.hidden = total < 2;

  // Only offer the download when *this* image has an original on record — an
  // index comparison assumed the downloadable ones formed an unbroken prefix.
  ui.lbDownload.hidden = !targets.get(viewing.uri)?.refs[viewing.index];
}

function openViewer(uri: string, index: number): void {
  const images = galleries.get(uri);
  if (!images || images.length === 0) return;
  viewing = { uri, index: Math.min(Math.max(index, 0), images.length - 1), images };
  renderViewer();
  if (!ui.lightbox.open) ui.lightbox.showModal();
}

function stepViewer(delta: number): void {
  if (!viewing || viewing.images.length < 2) return;
  const total = viewing.images.length;
  viewing.index = (viewing.index + delta + total) % total;
  renderViewer();
}

ui.lbPrev.innerHTML = ICONS.prev;
ui.lbNext.innerHTML = ICONS.next;
ui.lbClose.innerHTML = ICONS.close;
ui.lbDownload.innerHTML = `${ICONS.download}<span class="label">Original</span>`;

/**
 * Dropping the src releases the decoded full-size bitmap, the largest thing this
 * page holds outside the index. Done here rather than only in a `close` handler so
 * it does not hinge on one event: Escape closes the dialog without running any of
 * our code, which is what the `close` listener below is for.
 */
function closeViewer(): void {
  viewing = undefined;
  ui.lbImg.removeAttribute("src");
  if (ui.lightbox.open) ui.lightbox.close();
}

ui.lbPrev.addEventListener("click", () => stepViewer(-1));
ui.lbNext.addEventListener("click", () => stepViewer(1));
ui.lbClose.addEventListener("click", closeViewer);

// Closes on any click that isn't the image or a control — not just a click that
// lands exactly on the dialog element. `.lb-bar` is a full-width fixed strip, so
// most of what reads as "blank space" around the caption is actually inside it.
ui.lightbox.addEventListener("click", (event) => {
  if (suppressNextLightboxClick) {
    suppressNextLightboxClick = false;
    return;
  }
  if (!(event.target instanceof Element)) return;
  if (event.target.closest("img, button, a")) return;
  closeViewer();
});

// ---------------------------------------------------------------------------
// Lightbox swipe
//
// Pointer Events rather than separate touch/mouse listeners, since they unify
// touch, pen and mouse. Tracked on the image only, so a drag starting on the
// nav buttons or the bottom bar can't be misread as a swipe.
// ---------------------------------------------------------------------------

const SWIPE_THRESHOLD = 50;
let swipeStart: { x: number; y: number } | undefined;
/** A swipe's pointerup can synthesize a click; that click must not also close the viewer. */
let suppressNextLightboxClick = false;

ui.lbImg.addEventListener("pointerdown", (event) => {
  swipeStart = { x: event.clientX, y: event.clientY };
  // Cleared here as well as in the click handler: a touch swipe exceeds the tap
  // slop, so the browser synthesizes no click at all and the flag would
  // otherwise stay set and eat the *next* legitimate tap-to-close — including
  // one in a later viewer session entirely.
  suppressNextLightboxClick = false;
  // Routes every later event for this pointer here even once it leaves the
  // image's box, which a fast flick or a portrait image on a wide screen does
  // easily. Without it the pointerup lands on the bar or backdrop instead, so
  // the swipe silently does nothing and its click closes the viewer.
  if (event.pointerId !== undefined) {
    try {
      ui.lbImg.setPointerCapture(event.pointerId);
    } catch {
      // A pointer that has already ended cannot be captured; the swipe just
      // falls back to the uncaptured path.
    }
  }
});

ui.lbImg.addEventListener("pointerup", (event) => {
  if (!swipeStart) return;
  const dx = event.clientX - swipeStart.x;
  const dy = event.clientY - swipeStart.y;
  swipeStart = undefined;
  if (Math.abs(dx) < SWIPE_THRESHOLD || Math.abs(dx) <= Math.abs(dy)) return;
  suppressNextLightboxClick = true;
  stepViewer(dx > 0 ? -1 : 1);
});

ui.lbImg.addEventListener("pointercancel", () => {
  swipeStart = undefined;
});

ui.lightbox.addEventListener("keydown", (event) => {
  if (event.key === "ArrowLeft") {
    event.preventDefault();
    stepViewer(-1);
  } else if (event.key === "ArrowRight") {
    event.preventDefault();
    stepViewer(1);
  }
});

// Covers the paths that bypass our buttons entirely — Escape, and the browser
// closing the dialog itself.
ui.lightbox.addEventListener("close", () => {
  viewing = undefined;
  ui.lbImg.removeAttribute("src");
  swipeStart = undefined;
  suppressNextLightboxClick = false;
});

ui.lbDownload.addEventListener("click", async () => {
  if (!viewing) return;
  const target = targets.get(viewing.uri);
  if (!target) return;
  const original = labelOf(ui.lbDownload);
  ui.lbDownload.disabled = true;
  ui.lbDownload.dataset.busy = "1";
  try {
    await downloadOriginal(target, viewing.index);
    setLabel(ui.lbDownload, "Saved");
  } catch (err) {
    ui.lbDownload.dataset.failed = "1";
    setLabel(ui.lbDownload, "Failed");
    console.warn(err);
  } finally {
    ui.lbDownload.disabled = false;
    delete ui.lbDownload.dataset.busy;
    setTimeout(() => {
      delete ui.lbDownload.dataset.failed;
      setLabel(ui.lbDownload, original);
    }, 2400);
  }
});

ui.results.addEventListener("click", (event) => {
  const node = event.target;
  // Element, not HTMLElement: every button in here contains an inline SVG, and a
  // click landing on the glyph makes the target an SVGPathElement. Narrowing to
  // HTMLElement silently swallowed those clicks, so only the padding worked.
  if (!(node instanceof Element)) return;
  // Modifier and non-primary clicks fall through to the anchor, so opening the
  // original in a new tab still works for anyone who wants it.
  const zoom = node.closest<HTMLAnchorElement>("a[data-zoom]");
  if (zoom && event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) {
    event.preventDefault();
    openViewer(zoom.dataset.zoom ?? "", Number(zoom.dataset.index ?? 0));
    return;
  }
  const handle = node.closest<HTMLAnchorElement>("a[data-dig-author]");
  if (handle) {
    event.preventDefault();
    const did = handle.dataset.digAuthor;
    const digHandle = handle.dataset.digHandle;
    if (did && digHandle) {
      setDigFilter({ did, handle: digHandle });
      void dig();
    }
    return;
  }
  const play = node.closest<HTMLButtonElement>("button.play");
  if (play) {
    void playVideo(play);
    return;
  }
  const grab = node.closest<HTMLButtonElement>("button.grab");
  if (grab) {
    void handleGrab(grab);
    return;
  }
  // Checked before `.act`: the download-all button carries both, and routing it
  // to applyAction would silently do nothing.
  const all = node.closest<HTMLButtonElement>("button[data-all]");
  if (all) {
    void handleGrabAll(all);
    return;
  }
  const act = node.closest<HTMLButtonElement>("button.act");
  if (act) void applyAction(act);
});

ui.clearDigFilter.addEventListener("click", () => {
  setDigFilter(undefined);
  void dig();
});

// ---------------------------------------------------------------------------
// Auth UI
// ---------------------------------------------------------------------------

/** `@you.bsky.social` costs ~140px in the top bar; the default suffix is noise. */
function shortHandle(handle: string): string {
  return handle.replace(/\.bsky\.social$/i, "");
}

function reflectAccount(): void {
  const account = currentAccount();
  if (account) {
    ui.signin.hidden = true;
    ui.who.hidden = false;
    ui.whoHandle.textContent = `@${shortHandle(account.handle)}`;
    ui.whoHandle.title = `@${account.handle}`;
  } else {
    ui.signin.hidden = false;
    ui.who.hidden = true;
    ui.whoHandle.textContent = "";
  }
}

/**
 * Backfills exclusions for bookmarks made before Altostrata could track them,
 * or from another client. Safe to call on every sign-in: insertExclusions
 * dedupes on (uri, reason), so nothing double-inserts on a later call.
 */
async function syncBookmarks(): Promise<void> {
  try {
    const bookmarks = await listBookmarks();
    if (bookmarks.length === 0) return;
    await insertExclusions(bookmarks.map((b) => ({ uri: b.uri, reason: "bookmark" })));
  } catch (err) {
    console.warn("Could not sync bookmarks", err);
  }
}

function openAuth(): void {
  ui.authError.hidden = true;
  ui.authFallback.hidden = true;
  void getMeta("owner_handle").then((owner) => {
    if (owner && !ui.authHandle.value) ui.authHandle.value = owner;
  });
  ui.auth.showModal();
}

ui.signin.addEventListener("click", openAuth);
ui.authClose.addEventListener("click", () => ui.auth.close());

ui.authForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const input = ui.authHandle.value.trim();
  if (!input) return;

  ui.authError.hidden = true;
  ui.authFallback.hidden = true;
  ui.authGo.disabled = true;
  ui.authGo.textContent = "Waiting for Bluesky";

  try {
    await signIn(input);
    ui.auth.close();
    reflectAccount();
    await syncBookmarks();
    // Re-hydrate so the buttons reflect real viewer state rather than blanks.
    await dig("<strong>Signed in.</strong> Likes, reposts and bookmarks are live.");
  } catch (err) {
    ui.authError.hidden = false;
    ui.authError.textContent =
      err instanceof PopupBlockedError
        ? "The sign-in window was blocked or closed."
        : err instanceof Error
          ? err.message
          : String(err);
    ui.authFallback.hidden = false;
  } finally {
    ui.authGo.disabled = false;
    ui.authGo.textContent = "Continue";
  }
});

ui.authRedirect.addEventListener("click", () => {
  const input = ui.authHandle.value.trim();
  if (input) void signInRedirect(input);
});

ui.signout.addEventListener("click", async () => {
  await signOut();
  reflectAccount();
  await dig("<strong>Signed out.</strong> Reading and downloads still work.");
});

// ---------------------------------------------------------------------------
// Crawling
// ---------------------------------------------------------------------------

function showProgress(progress: CrawlProgress): void {
  ui.progress.hidden = false;
  ui.progressLabel.textContent = progress.message;
  if (progress.fraction === null) {
    ui.track.classList.add("indeterminate");
    ui.fill.style.width = "";
  } else {
    ui.track.classList.remove("indeterminate");
    ui.fill.style.width = `${Math.round(progress.fraction * 100)}%`;
  }
}

function hideProgress(): void {
  ui.progress.hidden = true;
  ui.track.classList.remove("indeterminate");
}

function warnBeforeLeaving(event: BeforeUnloadEvent): void {
  event.preventDefault();
}

/**
 * Shallow pass first so there is something to look at within a couple of minutes,
 * then keep going deeper in the background. Per-author cursors make the second
 * pass resume rather than repeat.
 */
async function runCrawl(handle: string, options: { deep: boolean }): Promise<void> {
  crawlController = new AbortController();
  const signal = crawlController.signal;
  window.addEventListener("beforeunload", warnBeforeLeaving);
  ui.stop.disabled = false;
  setCrawlButtonsDisabled(true);

  try {
    let started = false;
    const onFirstPosts = (): void => {
      if (started) return;
      started = true;
      showBrowsing();
      void dig();
    };

    const shallow = await crawl(handle, {
      depth: SHALLOW_DEPTH,
      signal,
      onProgress: showProgress,
      onFirstPosts,
    });
    // Stopping used to leave the strip on screen forever: the click handler hid
    // it, then the aborting crawl's own "Stopped" progress report showed it
    // again, and returning here skipped every later `hideProgress`.
    if (shallow.stopped) {
      hideProgress();
      return;
    }

    onFirstPosts();
    await refreshStats();

    if (options.deep && shallow.pendingAccounts > 0) {
      const deep = await crawl(handle, {
        depth: DEEP_DEPTH,
        signal,
        refresh: false,
        onProgress: showProgress,
        onFirstPosts,
      });
      if (deep.stopped) {
        hideProgress();
        return;
      }
    }

    showProgress({
      phase: "done",
      message: "Index complete",
      fraction: 1,
      postsAdded: 0,
      requests: 0,
    });
    setTimeout(hideProgress, 2500);
  } catch (err) {
    if (err instanceof AbortedError) return;
    // Running out of quota mid-crawl otherwise reads as an opaque DOM error, when
    // the useful thing to say is that the index so far is intact and usable.
    const quota = err instanceof DOMException && err.name === "QuotaExceededError";
    const message = quota
      ? "This browser is out of storage for the index. What has been found so far is kept — export it, or free space and dig again."
      : err instanceof Error
        ? err.message
        : String(err);
    if (ui.setup.hidden) {
      ui.note.innerHTML = `<strong>The crawl stopped early.</strong> ${escapeHtml(message)}`;
      hideProgress();
    } else {
      ui.setupError.hidden = false;
      ui.setupError.textContent = message;
      hideProgress();
    }
    // Deliberately not rethrown. The failure is already reported above, and none
    // of the three callers (`startFresh`, Dig deeper, Check for new posts) catch
    // — so rethrowing only produced an unhandledrejection alongside the message,
    // including on the quota path this block goes out of its way to explain.
  } finally {
    window.removeEventListener("beforeunload", warnBeforeLeaving);
    crawlController = undefined;
    setCrawlButtonsDisabled(false);
    await refreshStats();
  }
}

function setCrawlButtonsDisabled(disabled: boolean): void {
  ui.start.disabled = disabled;
  ui.deepen.disabled = disabled;
  ui.refresh.disabled = disabled;
  ui.resetAll.disabled = disabled;
  ui.importBtn.disabled = disabled;
  ui.importFirst.disabled = disabled;
}

ui.stop.addEventListener("click", () => {
  crawlController?.abort();
  ui.stop.disabled = true;
  hideProgress();
});

ui.setupForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const handle = ui.handle.value.trim();
  if (!handle) return;
  ui.setupError.hidden = true;
  void startFresh(handle);
});

async function startFresh(handle: string): Promise<void> {
  const owner = await getMeta("owner_handle");
  const normalised = handle.replace(/^@/, "").toLowerCase();
  if (owner && owner !== normalised) {
    // Resolve first, wipe second. The other order erased a finished index —
    // twelve minutes of crawling — before discovering the new handle was a typo
    // or a deleted account, since resolution did not happen until inside the
    // crawl. The confirm below is the point of no return, so nothing that can
    // fail on bad input may come after it.
    ui.setupError.hidden = true;
    try {
      await resolveHandle(normalised);
    } catch (err) {
      ui.setupError.hidden = false;
      ui.setupError.textContent = `Could not find @${normalised}. Your existing index is untouched.`;
      console.warn("Handle resolution failed", err);
      return;
    }

    const s = await stats();
    const ok = window.confirm(
      `This browser holds an index for @${owner}: ${s.posts.toLocaleString()} posts across ` +
        `${s.authors.toLocaleString()} accounts.\n\n` +
        `Building one for @${normalised} will erase it, and rebuilding takes many minutes. ` +
        `Export it first from the Index panel if you want to keep it.\n\nErase and rebuild?`,
    );
    if (!ok) return;
    await resetAll();
    setDigFilter(undefined);
  }
  await runCrawl(normalised, { deep: true });
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

async function refreshStats(): Promise<void> {
  const s = await stats();
  const usage = await estimateUsage();
  const rows: Array<[string, string, boolean?]> = [
    ["Account", (await getMeta("owner_handle")) ?? "none"],
    ["Accounts followed", s.authors.toLocaleString()],
    ["Fully indexed", `${s.authorsComplete.toLocaleString()} of ${s.authors.toLocaleString()}`],
    ["Media posts", s.posts.toLocaleString()],
    // Distinct posts excluded, not a count of exclusion records — one post can
    // now carry several reasons at once, so those two numbers differ.
    ["Excluded posts", s.excluded.toLocaleString()],
    ["Already surfaced", s.seen.toLocaleString()],
    ["Still unseen", s.unseen.toLocaleString()],
    ["Oldest post", s.oldest ? s.oldest.slice(0, 10) : "none yet", true],
  ];
  if (usage) rows.push(["Browser storage", formatBytes(usage.usage)]);

  ui.statsList.innerHTML = rows
    .map(
      ([term, value, highlight]) =>
        `<dt>${escapeHtml(term)}</dt>` +
        `<dd${highlight ? ' class="hi"' : ""}>${escapeHtml(value)}</dd>`,
    )
    .join("");

  const pending = s.authors - s.authorsComplete;
  ui.depthNote.textContent =
    pending > 0
      ? `${pending.toLocaleString()} accounts still have older posts that have not been read yet.`
      : "Every followed account has been read all the way back.";
  ui.deepen.disabled = pending === 0 || crawlController !== undefined;
}

ui.openSettings.addEventListener("click", () => {
  void refreshStats().then(() => ui.settings.showModal());
});

ui.closeSettings.addEventListener("click", () => ui.settings.close());

ui.deepen.addEventListener("click", async () => {
  const handle = await getMeta("owner_handle");
  if (!handle) return;
  ui.settings.close();
  await runCrawl(handle, { deep: true });
});

ui.refresh.addEventListener("click", async () => {
  const handle = await getMeta("owner_handle");
  if (!handle) return;
  ui.settings.close();
  await runCrawl(handle, { deep: false });
});

ui.resetSeen.addEventListener("click", async () => {
  const cleared = await resetSeen();
  await refreshStats();
  ui.settings.close();
  void dig(
    `<strong>Reset ${cleared.toLocaleString()} seen posts.</strong> Everything is findable again.`,
  );
});

ui.resetAll.addEventListener("click", async () => {
  const ok = window.confirm("Erase the whole local index? This cannot be undone.");
  if (!ok) return;
  await resetAll();
  setDigFilter(undefined);
  ui.settings.close();
  ui.results.innerHTML = "";
  ui.note.textContent = "";
  showSetup();
  await refreshStats();
});

ui.exportBtn.addEventListener("click", async () => {
  ui.exportBtn.disabled = true;
  ui.exportBtn.textContent = "Preparing";
  try {
    const file = await exportIndex();
    const blob = new Blob([JSON.stringify(file)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    const label = (file.owner?.handle ?? "export").replace(/[^a-z0-9.-]/gi, "_");
    anchor.download = `altostrata-index-${label}.json`;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  } finally {
    ui.exportBtn.disabled = false;
    ui.exportBtn.textContent = "Export index";
  }
});

function pickFile(): void {
  ui.file.value = "";
  ui.file.click();
}

ui.importBtn.addEventListener("click", pickFile);
ui.importFirst.addEventListener("click", pickFile);

ui.file.addEventListener("change", async () => {
  const file = ui.file.files?.[0];
  if (!file) return;

  ui.settings.close();
  showProgress({
    phase: "identity",
    message: `Reading ${file.name}`,
    fraction: null,
    postsAdded: 0,
    requests: 0,
  });

  try {
    const parsed = JSON.parse(await file.text()) as IndexFile;
    const result = await importIndex(parsed, (message) =>
      showProgress({ phase: "history", message, fraction: null, postsAdded: 0, requests: 0 }),
    );
    hideProgress();
    showBrowsing();
    await refreshStats();
    await dig(
      `<strong>Imported ${result.posts.toLocaleString()} posts</strong> across ` +
        `${result.authors.toLocaleString()} accounts.`,
    );
  } catch (err) {
    hideProgress();
    const message = err instanceof Error ? err.message : String(err);
    if (ui.setup.hidden) {
      ui.note.innerHTML = `<strong>Could not import that file.</strong> ${escapeHtml(message)}`;
    } else {
      ui.setupError.hidden = false;
      ui.setupError.textContent = `Could not import that file. ${message}`;
    }
  }
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

function showSetup(): void {
  ui.setup.hidden = false;
  ui.controlsRow1.hidden = true;
  ui.controlsRow2.hidden = true;
  ui.tagline.hidden = false;
  ui.digBottom.hidden = true;
}

/**
 * The tagline gives way to the controls: it is redundant once there is a page of
 * finds on screen, and keeping it would squeeze the whole row onto two lines.
 */
function showBrowsing(): void {
  ui.setup.hidden = true;
  ui.controlsRow1.hidden = false;
  ui.controlsRow2.hidden = false;
  ui.tagline.hidden = true;
  ui.digBottom.hidden = false;
}

ui.dig.addEventListener("click", () => void dig());
ui.digBottom.addEventListener("click", () => void dig());
ui.age.addEventListener("change", () => void dig());
ui.liked.addEventListener("change", () => void dig());
// "Allow repeats" sat here with no listener while its two neighbours in the same
// cluster re-dug instantly, so it read as a broken checkbox.
ui.seen.addEventListener("change", () => void dig());
ui.toTop.addEventListener("click", () => window.scrollTo({ top: 0, behavior: "smooth" }));

/**
 * On mobile, `#pinned-row` is `position: fixed` (see the 700px query) so it can
 * stay put while `.controls-row-2` scrolls away underneath it — but a fixed
 * element reserves no space of its own, so `header` needs an explicit
 * padding-top standing in for it. That height isn't constant: it grows by a
 * line whenever the "Digging @handle" chip wraps `.controls-row-1` onto two
 * rows. Mirroring the live height into a CSS variable, rather than hard-coding
 * one, keeps the reserved space correct in both states without duplicating the
 * chip's wrapping logic in CSS.
 */
new ResizeObserver(([entry]) => {
  if (!entry) return;
  document.documentElement.style.setProperty(
    "--pinned-row-height",
    `${entry.borderBoxSize[0]?.blockSize ?? entry.contentRect.height}px`,
  );
}).observe(ui.pinnedRow);

async function boot(): Promise<void> {
  void requestPersistence();

  // Runs before the first dig so hydration can carry viewer state, and because a
  // redirect callback has to be consumed out of the URL early.
  await initAuth();
  reflectAccount();
  // Fire-and-forget: a restored session shouldn't delay the first dig on this.
  if (isSignedIn()) void syncBookmarks();

  let s: Stats;
  try {
    s = await stats();
  } catch (err) {
    ui.note.innerHTML =
      `<strong>This browser will not let Altostrata store an index.</strong> ` +
      `Private windows and blocked site data prevent IndexedDB from opening. ` +
      escapeHtml(err instanceof Error ? err.message : err);
    return;
  }

  await refreshStats();

  if (s.posts === 0) {
    const owner = await getMeta("owner_handle");
    if (owner) ui.handle.value = owner;
    showSetup();
    return;
  }

  showBrowsing();
  await dig();
}

void boot();
