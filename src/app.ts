import { AbortedError, getPosts, type PostView } from "./atproto.ts";
import { crawl, type CrawlProgress } from "./crawl.ts";
import {
  downloadAllOriginals,
  downloadOriginal,
  extractImages,
  originalRefs,
  type DownloadTarget,
  type ViewImage,
} from "./media.ts";
import {
  deletePosts,
  estimateUsage,
  exportIndex,
  getMeta,
  importIndex,
  markShown,
  requestPersistence,
  resetAll,
  resetSeen,
  shuffle,
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
  controls: el("controls"),
  age: el<HTMLSelectElement>("age"),
  seen: el<HTMLInputElement>("seen"),
  dig: el<HTMLButtonElement>("dig"),
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
};

let crawlController: AbortController | undefined;
/** Download targets for what is currently on screen, keyed by post URI. */
const targets = new Map<string, DownloadTarget>();

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function escapeHtml(value: unknown): string {
  return String(value).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c,
  );
}

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

// ---------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------

interface Card {
  uri: string;
  webUrl: string;
  text: string;
  createdAt: string;
  handle: string;
  displayName: string;
  images: ViewImage[];
  isVideo: boolean;
  likeCount: number;
  depth: number | null;
  authorOldest: string | null;
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
  const { images, isVideo } = extractImages(post.embed);
  const refs = originalRefs(post);
  const handle = post.author.handle;

  targets.set(post.uri, { uri: post.uri, authorDid: post.author.did, handle, refs });

  return {
    uri: post.uri,
    webUrl: `https://bsky.app/profile/${handle}/post/${post.uri.split("/").pop() ?? ""}`,
    text: post.record?.text ?? "",
    createdAt: post.record?.createdAt ?? row.createdAt,
    handle,
    displayName: post.author.displayName ?? handle,
    images,
    isVideo,
    likeCount: post.likeCount ?? 0,
    depth: depthOf(row),
    authorOldest: row.authorOldest,
    originals: refs.length,
  };
}

function gaugeHtml(card: Card): string {
  if (card.depth === null) return '<div class="gauge"></div>';
  const fromTop = (1 - card.depth) * 100;
  const oldestYear = card.authorOldest ? new Date(card.authorOldest).getFullYear() : "";
  return `<div class="gauge" title="Position within this account's indexed history">
    <span class="cap top">now</span>
    <span class="tick" style="top:${fromTop.toFixed(1)}%"></span>
    <span class="cap bottom">${oldestYear}</span>
  </div>`;
}

function mediaHtml(card: Card): string {
  const shown = card.images.slice(0, 4);
  const items = shown
    .map((image, i) => {
      const grab =
        i < card.originals
          ? `<button class="grab" data-uri="${escapeHtml(card.uri)}" data-index="${i}"
             title="Download the original file">${card.isVideo ? "Save video" : "Save"}</button>`
          : "";
      return `<figure>
        <a href="${escapeHtml(image.full)}" target="_blank" rel="noreferrer">
          <img src="${escapeHtml(image.thumb)}" alt="${escapeHtml(image.alt || "Untitled image")}" loading="lazy">
        </a>${grab}
      </figure>`;
    })
    .join("");
  return `<div class="media n${shown.length}">${items}</div>`;
}

function cardHtml(card: Card): string {
  const extra = card.images.length > 4 ? `+${card.images.length - 4} more` : "";
  const saveAll =
    card.originals > 1
      ? `<button data-all="${escapeHtml(card.uri)}">Save all ${card.originals} originals</button>`
      : "";
  return `<article class="find">
    ${gaugeHtml(card)}
    <div>
      <div class="age">${escapeHtml(formatAge(card.createdAt))}</div>
      <div class="byline">
        <a href="https://bsky.app/profile/${escapeHtml(card.handle)}" target="_blank" rel="noreferrer">${escapeHtml(card.displayName)}</a>
        &nbsp;@${escapeHtml(card.handle)}
      </div>
      ${card.text ? `<p class="text">${escapeHtml(card.text)}</p>` : ""}
      ${mediaHtml(card)}
      <footer class="meta">
        <span>${escapeHtml(formatDate(card.createdAt))}</span>
        <span>${card.likeCount} likes</span>
        ${card.isVideo ? '<span class="badge">video</span>' : ""}
        ${extra ? `<span>${escapeHtml(extra)}</span>` : ""}
        ${saveAll}
        <a href="${escapeHtml(card.webUrl)}" target="_blank" rel="noreferrer">Open on Bluesky &rarr;</a>
      </footer>
    </div>
  </article>`;
}

// ---------------------------------------------------------------------------
// Digging
// ---------------------------------------------------------------------------

/**
 * `afterMessage` is shown once the page has rendered. Callers cannot set the note
 * themselves beforehand — digging clears it — so they hand it over instead.
 */
async function dig(afterMessage?: string): Promise<void> {
  ui.dig.disabled = true;
  ui.dig.textContent = "Digging";
  ui.note.textContent = "";

  try {
    const rows = await shuffle({
      limit: PAGE_SIZE,
      minAgeDays: Number(ui.age.value),
      includeSeen: ui.seen.checked,
      maxPerAuthor: 2,
    });

    if (rows.length === 0) {
      await showEmptyNote();
      return;
    }

    const byUri = new Map(rows.map((row) => [row.uri, row]));
    const hydrated = await getPosts(rows.map((row) => row.uri));

    // Anything the AppView no longer knows about has been deleted upstream.
    const returned = new Set(hydrated.map((post) => post.uri));
    const missing = rows.map((row) => row.uri).filter((uri) => !returned.has(uri));
    if (missing.length > 0) await deletePosts(missing);

    targets.clear();
    const cards = hydrated.flatMap((post) => {
      const row = byUri.get(post.uri);
      if (!row) return [];
      const card = toCard(post, row);
      return card.images.length > 0 ? [card] : [];
    });

    if (cards.length === 0) {
      await showEmptyNote();
      return;
    }

    ui.results.innerHTML = cards.map(cardHtml).join("");
    await markShown(cards.map((card) => card.uri));
    if (afterMessage) ui.note.innerHTML = afterMessage;
    window.scrollTo({ top: 0, behavior: "smooth" });
  } catch (err) {
    ui.note.innerHTML = `<strong>Could not load posts.</strong> ${escapeHtml(
      err instanceof Error ? err.message : err,
    )}`;
  } finally {
    ui.dig.disabled = false;
    ui.dig.textContent = "Dig";
  }
}

async function showEmptyNote(): Promise<void> {
  const s = await stats();
  ui.results.innerHTML = "";
  if (s.posts === 0) {
    ui.note.innerHTML = `<strong>Nothing indexed yet.</strong> The crawl has not found any media posts.`;
    return;
  }
  ui.note.innerHTML =
    `<strong>Nothing left to surface at this depth.</strong> Loosen the age filter, allow repeats, ` +
    `or dig deeper from the Index panel. ${s.unseen.toLocaleString()} of ${s.posts.toLocaleString()} ` +
    `indexed posts are still unseen.`;
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

  const original = button.textContent ?? "Save";
  button.disabled = true;
  button.dataset.state = "working";
  button.textContent = "Saving";
  try {
    await downloadOriginal(target, index);
    button.dataset.state = "done";
    button.textContent = "Saved";
  } catch (err) {
    button.dataset.state = "failed";
    button.textContent = "Failed";
    console.warn(err);
  } finally {
    button.disabled = false;
    setTimeout(() => {
      delete button.dataset.state;
      button.textContent = original;
    }, 2400);
  }
}

async function handleGrabAll(button: HTMLButtonElement): Promise<void> {
  const uri = button.dataset.all;
  if (!uri) return;
  const target = targets.get(uri);
  if (!target) return;

  const original = button.textContent ?? "Save all";
  button.disabled = true;
  button.textContent = "Saving originals";
  try {
    const saved = await downloadAllOriginals(target);
    button.textContent = `Saved ${saved}`;
  } catch (err) {
    button.textContent = "Failed";
    console.warn(err);
  } finally {
    button.disabled = false;
    setTimeout(() => {
      button.textContent = original;
    }, 2400);
  }
}

ui.results.addEventListener("click", (event) => {
  const node = event.target;
  if (!(node instanceof HTMLElement)) return;
  const grab = node.closest<HTMLButtonElement>("button.grab");
  if (grab) {
    void handleGrab(grab);
    return;
  }
  const all = node.closest<HTMLButtonElement>("button[data-all]");
  if (all) void handleGrabAll(all);
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
    if (shallow.stopped) return;

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
      if (deep.stopped) return;
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
    const message = err instanceof Error ? err.message : String(err);
    if (ui.setup.hidden) {
      ui.note.innerHTML = `<strong>The crawl stopped early.</strong> ${escapeHtml(message)}`;
      hideProgress();
    } else {
      ui.setupError.hidden = false;
      ui.setupError.textContent = message;
      hideProgress();
    }
    throw err;
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
    const ok = window.confirm(
      `This browser holds an index for @${owner}. Building one for @${normalised} will erase it. Continue?`,
    );
    if (!ok) return;
    await resetAll();
  }
  await runCrawl(normalised, { deep: true });
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

async function refreshStats(): Promise<void> {
  const s = await stats();
  const usage = await estimateUsage();
  const rows: Array<[string, string]> = [
    ["Account", (await getMeta("owner_handle")) ?? "none"],
    ["Accounts followed", s.authors.toLocaleString()],
    ["Fully indexed", `${s.authorsComplete.toLocaleString()} of ${s.authors.toLocaleString()}`],
    ["Media posts", s.posts.toLocaleString()],
    // The raw count of exclusion records, not how many indexed posts they hide.
    ["Likes and reposts", s.excluded.toLocaleString()],
    ["Already surfaced", s.seen.toLocaleString()],
    ["Still unseen", s.unseen.toLocaleString()],
    ["Oldest post", s.oldest ? s.oldest.slice(0, 10) : "none yet"],
  ];
  if (usage) rows.push(["Browser storage", formatBytes(usage.usage)]);

  ui.statsList.innerHTML = rows
    .map(([term, value]) => `<dt>${escapeHtml(term)}</dt><dd>${escapeHtml(value)}</dd>`)
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
    anchor.download = `strata-index-${(file.owner.handle ?? "export").replace(/[^a-z0-9.-]/gi, "_")}.json`;
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
  ui.controls.hidden = true;
}

function showBrowsing(): void {
  ui.setup.hidden = true;
  ui.controls.hidden = false;
}

ui.dig.addEventListener("click", () => void dig());
ui.age.addEventListener("change", () => void dig());

async function boot(): Promise<void> {
  void requestPersistence();

  let s: Stats;
  try {
    s = await stats();
  } catch (err) {
    ui.note.innerHTML =
      `<strong>This browser will not let Strata store an index.</strong> ` +
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
