import { fetchBlob, type BlobRef, type PostView, type RecordEmbed } from "./atproto.ts";

export interface ViewImage {
  thumb: string;
  full: string;
  alt: string;
  aspectRatio: number | null;
}

interface EmbedViewImage {
  thumb?: string;
  fullsize?: string;
  alt?: string;
  aspectRatio?: { width?: number; height?: number };
}

interface EmbedView {
  $type?: string;
  images?: EmbedViewImage[];
  thumbnail?: string;
  playlist?: string;
  media?: EmbedView;
}

/**
 * Media can sit directly on the embed or nested under `media` for
 * recordWithMedia. `$type` carries a `#view` suffix, so every check is by prefix.
 *
 * Selecting the source by shape rather than by type is what broke video: a bare
 * video view has no `images` and no `media`, so a shape test lands on undefined
 * and silently drops the post.
 */
export function extractImages(embed: unknown): { images: ViewImage[]; isVideo: boolean } {
  const node = embed as EmbedView | undefined;
  if (!node) return { images: [], isVideo: false };

  const outerType = node.$type ?? "";
  const source = outerType.startsWith("app.bsky.embed.recordWithMedia")
    ? (node.media ?? node)
    : node;
  const type = source.$type ?? "";

  if (type.startsWith("app.bsky.embed.video")) {
    const thumb = source.thumbnail;
    return {
      images: thumb ? [{ thumb, full: thumb, alt: "Video thumbnail", aspectRatio: null }] : [],
      isVideo: true,
    };
  }

  const images = (source.images ?? []).flatMap((image): ViewImage[] => {
    const thumb = image.thumb ?? image.fullsize;
    if (!thumb) return [];
    const width = image.aspectRatio?.width;
    const height = image.aspectRatio?.height;
    return [
      {
        thumb,
        full: image.fullsize ?? thumb,
        alt: image.alt ?? "",
        aspectRatio: width && height ? width / height : null,
      },
    ];
  });

  return { images, isVideo: false };
}

// ---------------------------------------------------------------------------
// Original files
// ---------------------------------------------------------------------------

export interface OriginalRef {
  cid: string;
  mimeType: string;
  size: number | null;
}

function refToCid(ref: BlobRef["ref"]): string | null {
  if (typeof ref === "string") return ref;
  if (ref && typeof ref === "object" && typeof ref.$link === "string") return ref.$link;
  return null;
}

function blobToOriginal(blob: BlobRef | undefined, fallbackMime: string): OriginalRef | null {
  if (!blob) return null;
  const cid = refToCid(blob.ref);
  if (!cid) return null;
  return { cid, mimeType: blob.mimeType ?? fallbackMime, size: blob.size ?? null };
}

/**
 * Blob references live on the raw record, not the hydrated view. The view only
 * ever points at CDN derivatives, so this is what makes original-quality
 * downloads possible.
 */
export function originalRefs(post: PostView): OriginalRef[] {
  const embed: RecordEmbed | undefined = post.record?.embed;
  if (!embed) return [];

  const source: RecordEmbed = embed.images || embed.video ? embed : (embed.media ?? embed);

  if (source.video) {
    const video = blobToOriginal(source.video, "video/mp4");
    return video ? [video] : [];
  }

  return (source.images ?? []).flatMap((entry) => {
    const original = blobToOriginal(entry.image, "image/jpeg");
    return original ? [original] : [];
  });
}

const EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/avif": "avif",
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "video/webm": "webm",
};

function extensionFor(mimeType: string): string {
  return EXTENSIONS[mimeType.toLowerCase()] ?? mimeType.split("/")[1]?.replace(/[^a-z0-9]/gi, "") ?? "bin";
}

export function rkeyOf(uri: string): string {
  return uri.split("/").pop() ?? "post";
}

/** `handle_rkey_2.png` — sorts sensibly and keeps the source traceable. */
export function filenameFor(
  handle: string,
  uri: string,
  index: number,
  total: number,
  mimeType: string,
): string {
  const safeHandle = handle.replace(/[^a-z0-9.-]/gi, "_");
  const suffix = total > 1 ? `_${index + 1}` : "";
  return `${safeHandle}_${rkeyOf(uri)}${suffix}.${extensionFor(mimeType)}`;
}

function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  // Revoked on a delay so the download has certainly started.
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

export interface DownloadTarget {
  uri: string;
  authorDid: string;
  handle: string;
  refs: OriginalRef[];
}

/**
 * Downloads one original file. A same-origin `download` attribute cannot be used
 * against the PDS, so the bytes are fetched and handed to the browser as a blob
 * URL — which is also what lets the filename be set.
 */
export async function downloadOriginal(
  target: DownloadTarget,
  index: number,
  signal?: AbortSignal,
): Promise<void> {
  const ref = target.refs[index];
  if (!ref) throw new Error("That image has no original on record");

  const blob = await fetchBlob(target.authorDid, ref.cid, signal);
  const mimeType = blob.type || ref.mimeType;
  saveBlob(blob, filenameFor(target.handle, target.uri, index, target.refs.length, mimeType));
}

/** Downloads every original attached to a post, one at a time. */
export async function downloadAllOriginals(
  target: DownloadTarget,
  signal?: AbortSignal,
): Promise<number> {
  let saved = 0;
  for (let i = 0; i < target.refs.length; i += 1) {
    await downloadOriginal(target, i, signal);
    saved += 1;
  }
  return saved;
}
