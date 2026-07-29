// Rasterises the Altostrata mark to a PNG. No image library available, so this
// paints pixels directly and writes the PNG chunks by hand with zlib.
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";

const SIZE = Number(process.argv[2] ?? 180);
const OUT = process.argv[3] ?? "public/apple-touch-icon.png";

// Artwork is authored in a 64-unit square, matching the inline SVG favicon.
const UNITS = 64;
const SS = 4; // supersampling factor per axis, for smooth curves

const BG = [0x0a, 0x0a, 0x0b];
const BONE = [0xf7, 0xf7, 0xf8];
const AMBER = [0xff, 0xb2, 0x24];

// Stadium-shaped bars: x0..x1 with fully rounded caps, like rx = height / 2.
const bars = [
  { x0: 12, x1: 52, y0: 17, y1: 24, alpha: 0.92 },
  { x0: 12, x1: 40, y0: 30, y1: 37, alpha: 0.5 },
  { x0: 12, x1: 52, y0: 43, y1: 50, alpha: 0.28 },
];
const dot = { cx: 44, cy: 33.5, r: 8 };

function inBar(u, v, bar) {
  const r = (bar.y1 - bar.y0) / 2;
  const cy = bar.y0 + r;
  if (v < bar.y0 || v > bar.y1) return false;
  if (u >= bar.x0 + r && u <= bar.x1 - r) return true;
  const capX = u < bar.x0 + r ? bar.x0 + r : bar.x1 - r;
  return (u - capX) ** 2 + (v - cy) ** 2 <= r * r;
}

function inDot(u, v) {
  return (u - dot.cx) ** 2 + (v - dot.cy) ** 2 <= dot.r * dot.r;
}

/** Blends a colour over another at the given alpha. */
function over(dst, src, alpha) {
  return [
    Math.round(dst[0] * (1 - alpha) + src[0] * alpha),
    Math.round(dst[1] * (1 - alpha) + src[1] * alpha),
    Math.round(dst[2] * (1 - alpha) + src[2] * alpha),
  ];
}

// One filter byte per row, then RGB triples.
const raw = Buffer.alloc(SIZE * (1 + SIZE * 3));

for (let py = 0; py < SIZE; py += 1) {
  const rowStart = py * (1 + SIZE * 3);
  raw[rowStart] = 0; // filter: none
  for (let px = 0; px < SIZE; px += 1) {
    // Accumulate coverage over the subsample grid so edges land between colours.
    let acc = [0, 0, 0];
    for (let sy = 0; sy < SS; sy += 1) {
      for (let sx = 0; sx < SS; sx += 1) {
        const u = ((px + (sx + 0.5) / SS) / SIZE) * UNITS;
        const v = ((py + (sy + 0.5) / SS) / SIZE) * UNITS;
        let c = BG;
        for (const bar of bars) if (inBar(u, v, bar)) c = over(c, BONE, bar.alpha);
        if (inDot(u, v)) c = AMBER; // the dot sits on top of the bars
        acc = [acc[0] + c[0], acc[1] + c[1], acc[2] + c[2]];
      }
    }
    const n = SS * SS;
    const o = rowStart + 1 + px * 3;
    raw[o] = Math.round(acc[0] / n);
    raw[o + 1] = Math.round(acc[1] / n);
    raw[o + 2] = Math.round(acc[2] / n);
  }
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 2; // colour type: truecolour RGB
ihdr[10] = 0;
ihdr[11] = 0;
ihdr[12] = 0;

writeFileSync(
  OUT,
  Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]),
);

console.log(`wrote ${OUT} at ${SIZE}x${SIZE}`);
