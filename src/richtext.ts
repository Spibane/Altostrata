export function escapeHtml(value: unknown): string {
  return String(value).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c,
  );
}

interface FacetFeature {
  $type?: string;
  did?: string;
  uri?: string;
  tag?: string;
}

export interface Facet {
  index?: { byteStart?: number; byteEnd?: number };
  features?: FacetFeature[];
}

// Facet offsets are indices into the UTF-8 encoding of the text, not into the
// JavaScript string. Slicing by character index silently corrupts any post
// containing an emoji or a non-Latin script, which on an art feed is most of them.
const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Anything other than http(s) is rendered as plain text. A facet's `uri` comes
 * from a stranger's post and lands in an href, so `javascript:` and `data:` are
 * live XSS vectors on a page that anyone can visit.
 *
 * Exported so `app.ts` can apply the same check to image/avatar URLs, which
 * currently reach the DOM only `escapeHtml`'d — not scheme-checked. Not
 * exploitable today, since those URLs come from the AppView's hydrated view
 * objects rather than a stranger's raw record, but the invariant this file
 * documents ("a uri goes into an href, so its scheme must be checked") should
 * hold everywhere a uri goes into an href, not just here.
 */
export function safeHref(uri: string): string | null {
  try {
    const parsed = new URL(uri);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? uri : null;
  } catch {
    return null;
  }
}

function linkFor(feature: FacetFeature): string | null {
  const type = feature.$type ?? "";

  if (type.endsWith("#mention") && feature.did) {
    return `https://bsky.app/profile/${feature.did}`;
  }
  if (type.endsWith("#link") && feature.uri) {
    return safeHref(feature.uri);
  }
  if (type.endsWith("#tag") && feature.tag) {
    return `https://bsky.app/hashtag/${encodeURIComponent(feature.tag)}`;
  }
  return null;
}

/**
 * Post text as HTML, with mentions, links and hashtags turned into anchors.
 *
 * Only facets are honoured; bare text that looks like a URL is left alone,
 * matching how Bluesky itself renders posts. A link facet's display text is
 * frequently a truncated form of its target, so the visible text always comes
 * from the byte range while the href comes from the feature.
 */
export function renderRichText(text: string, facets?: Facet[]): string {
  if (!text) return "";
  if (!facets || facets.length === 0) return escapeHtml(text);

  const bytes = encoder.encode(text);

  const usable = facets
    .flatMap((facet) => {
      const start = facet.index?.byteStart;
      const end = facet.index?.byteEnd;
      if (typeof start !== "number" || typeof end !== "number") return [];
      if (!(start >= 0 && end > start && end <= bytes.length)) return [];
      const href = (facet.features ?? []).reduce<string | null>(
        (found, feature) => found ?? linkFor(feature),
        null,
      );
      return href ? [{ start, end, href }] : [];
    })
    .sort((a, b) => a.start - b.start);

  let out = "";
  let cursor = 0;

  for (const { start, end, href } of usable) {
    // Overlapping facets would produce nested or duplicated text; first wins.
    if (start < cursor) continue;
    if (start > cursor) out += escapeHtml(decoder.decode(bytes.subarray(cursor, start)));
    const label = escapeHtml(decoder.decode(bytes.subarray(start, end)));
    out += `<a href="${escapeHtml(href)}" target="_blank" rel="noreferrer">${label}</a>`;
    cursor = end;
  }

  if (cursor < bytes.length) out += escapeHtml(decoder.decode(bytes.subarray(cursor)));
  return out;
}
