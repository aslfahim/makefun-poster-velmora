// VELMORA — a travel poster for a city that floats above a sea of clouds.
// Self-contained raster painter: no dependencies, no network, writes one PNG.
import { writeFileSync, mkdirSync } from "node:fs";
import { deflateSync } from "node:zlib";

const W = 768;
const H = 1024;
const px = new Uint8Array(W * H * 3);

// Deterministic scatter so every run paints the identical poster.
let seed = 987123541;
function rnd() {
  seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

function hex(h) {
  return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
}
function mix(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}
function put(x, y, c, a) {
  x = Math.round(x); y = Math.round(y);
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const i = (y * W + x) * 3;
  px[i] = px[i] * (1 - a) + c[0] * a;
  px[i + 1] = px[i + 1] * (1 - a) + c[1] * a;
  px[i + 2] = px[i + 2] * (1 - a) + c[2] * a;
}

// Vertical sky built from colour stops: [y, colour] pairs lerped per row.
function sky(stops) {
  for (let y = 0; y < H; y++) {
    let s = 0;
    while (s < stops.length - 2 && y > stops[s + 1][0]) s++;
    const [y0, c0] = stops[s];
    const [y1, c1] = stops[s + 1];
    const c = mix(c0, c1, Math.min(1, Math.max(0, (y - y0) / (y1 - y0))));
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 3;
      px[i] = c[0]; px[i + 1] = c[1]; px[i + 2] = c[2];
    }
  }
}

function disc(cx, cy, r, c, a) {
  for (let y = Math.floor(cy - r); y <= cy + r; y++) {
    const dy = y - cy;
    const half = Math.sqrt(Math.max(0, r * r - dy * dy));
    for (let x = Math.floor(cx - half); x <= cx + half; x++) put(x, y, c, a);
  }
}
function ellipse(cx, cy, rx, ry, c, a) {
  for (let y = Math.floor(cy - ry); y <= cy + ry; y++) {
    const t = (y - cy) / ry;
    const half = rx * Math.sqrt(Math.max(0, 1 - t * t));
    for (let x = Math.floor(cx - half); x <= cx + half; x++) put(x, y, c, a);
  }
}
// Soft-edged ellipse: stacked shrinking passes of low alpha.
function glowEllipse(cx, cy, rx, ry, c, a) {
  for (let k = 5; k >= 1; k--) {
    const f = k / 5;
    ellipse(cx, cy, rx * f, ry * f, c, a / 3);
  }
}
function poly(pts, c, a) {
  let minY = Infinity, maxY = -Infinity;
  for (const p of pts) { minY = Math.min(minY, p[1]); maxY = Math.max(maxY, p[1]); }
  for (let y = Math.floor(minY); y <= maxY; y++) {
    const xs = [];
    for (let i = 0; i < pts.length; i++) {
      const [x0, y0] = pts[i];
      const [x1, y1] = pts[(i + 1) % pts.length];
      if ((y0 <= y && y1 > y) || (y1 <= y && y0 > y)) xs.push(x0 + ((y - y0) / (y1 - y0)) * (x1 - x0));
    }
    xs.sort((p, q) => p - q);
    for (let i = 0; i + 1 < xs.length; i += 2)
      for (let x = Math.floor(xs[i]); x <= xs[i + 1]; x++) put(x, y, c, a);
  }
}
function seg(x0, y0, x1, y1, w, c, a) {
  const d = Math.hypot(x1 - x0, y1 - y0);
  const steps = Math.max(1, Math.ceil(d / (w * 0.3)));
  for (let i = 0; i <= steps; i++)
    disc(x0 + ((x1 - x0) * i) / steps, y0 + ((y1 - y0) * i) / steps, w / 2, c, a);
}
function rect(x, y, w, h, c, a) {
  for (let j = Math.floor(y); j < y + h; j++)
    for (let i = Math.floor(x); i < x + w; i++) put(i, j, c, a);
}

// Stroke letterforms on a 4-wide, 6-tall grid — drawn thick so the name
// reads like hand-set poster type, not a font file.
const FONT = {
  A: [[[0, 6], [2, 0], [4, 6]], [[1.1, 4.1], [2.9, 4.1]]],
  B: [[[0, 0], [0, 6]], [[0, 0], [2.6, 0], [3.7, 1], [2.6, 2.1], [0, 2.1]], [[0, 2.1], [2.9, 2.1], [3.9, 3.6], [2.9, 6], [0, 6]]],
  C: [[[4, 1.4], [2.7, 0.1], [0.9, 0.7], [0, 3], [0.9, 5.3], [2.7, 5.9], [4, 4.6]]],
  D: [[[0, 0], [0, 6]], [[0, 0], [2.4, 0], [4, 1.9], [4, 4.1], [2.4, 6], [0, 6]]],
  E: [[[4, 0], [0, 0], [0, 6], [4, 6]], [[0, 3], [3.1, 3]]],
  F: [[[4, 0], [0, 0], [0, 6]], [[0, 3], [3.1, 3]]],
  G: [[[4, 1.4], [2.7, 0.1], [0.9, 0.7], [0, 3], [0.9, 5.3], [2.7, 5.9], [4, 5.9], [4, 3.7], [2.5, 3.7]]],
  H: [[[0, 0], [0, 6]], [[4, 0], [4, 6]], [[0, 3], [4, 3]]],
  I: [[[2, 0], [2, 6]], [[0.6, 0], [3.4, 0]], [[0.6, 6], [3.4, 6]]],
  J: [[[4, 0], [4, 4.5], [3.1, 5.8], [1.3, 6], [0.3, 4.9]]],
  K: [[[0, 0], [0, 6]], [[4, 0], [0.7, 3.1]], [[1.3, 2.5], [4, 6]]],
  L: [[[0, 0], [0, 6], [4, 6]]],
  M: [[[0, 6], [0, 0], [2, 3.4], [4, 0], [4, 6]]],
  N: [[[0, 6], [0, 0], [4, 6], [4, 0]]],
  O: [[[2, 0], [3.6, 0.7], [4, 3], [3.6, 5.3], [2, 6], [0.4, 5.3], [0, 3], [0.4, 0.7], [2, 0]]],
  P: [[[0, 6], [0, 0], [3, 0], [4, 1.1], [3, 2.5], [0, 2.5]]],
  Q: [[[2, 0], [3.6, 0.7], [4, 3], [3.6, 5.3], [2, 6], [0.4, 5.3], [0, 3], [0.4, 0.7], [2, 0]], [[2.7, 4.3], [4.3, 6.3]]],
  R: [[[0, 6], [0, 0], [3, 0], [4, 1.1], [3, 2.5], [0, 2.5]], [[2.1, 2.5], [4, 6]]],
  S: [[[4, 0.9], [2.7, 0], [0.9, 0.6], [0.5, 1.9], [2, 2.9], [3.4, 3.7], [3.6, 5], [2.4, 6], [0.3, 5.3]]],
  T: [[[0, 0], [4, 0]], [[2, 0], [2, 6]]],
  U: [[[0, 0], [0, 4.3], [0.8, 5.6], [2, 6], [3.2, 5.6], [4, 4.3], [4, 0]]],
  V: [[[0, 0], [2, 6], [4, 0]]],
  W: [[[0, 0], [0.8, 6], [2, 2.7], [3.2, 6], [4, 0]]],
  X: [[[0, 0], [4, 6]], [[4, 0], [0, 6]]],
  Y: [[[0, 0], [2, 2.8], [4, 0]], [[2, 2.8], [2, 6]]],
  Z: [[[0, 0], [4, 0], [0, 6], [4, 6]]],
  " ": [],
};
function textWidth(text, size, track) {
  const s = size / 6;
  return text.length * 5 * s + (text.length - 1) * track * s;
}
function drawText(text, cx, y, size, c, a, track) {
  const s = size / 6;
  const w = Math.max(2.4, size * 0.17);
  let x = cx - textWidth(text, size, track) / 2;
  for (const ch of text.toUpperCase()) {
    const glyph = FONT[ch] || [];
    for (const stroke of glyph)
      for (let i = 0; i + 1 < stroke.length; i++)
        seg(x + stroke[i][0] * s, y + stroke[i][1] * s, x + stroke[i + 1][0] * s, y + stroke[i + 1][1] * s, w, c, a);
    x += 5 * s + track * s;
  }
}

// ---- The scene: sunset over the cloud sea, three floating isles ----
const INK = hex("#2b1e3f");
sky([
  [0, hex("#1d2a52")],
  [300, hex("#5d3360")],
  [560, hex("#c65b4e")],
  [700, hex("#f08a3c")],
  [790, hex("#f7b267")],
  [1024, hex("#f3cf9a")],
]);

// Low sun with a warm halo, sinking toward the cloud line.
glowEllipse(528, 668, 210, 210, hex("#ffb35c"), 0.35);
disc(528, 668, 92, hex("#ffd98a"), 1);
disc(528, 668, 92, hex("#ffe9b8"), 0.35);

// High cloud bands, thin and violet, catching the last light.
for (let i = 0; i < 9; i++) {
  const y = 120 + rnd() * 420;
  const x = rnd() * W;
  const len = 130 + rnd() * 260;
  glowEllipse(x, y, len, 7 + rnd() * 9, hex("#8a5a8e"), 0.16);
  glowEllipse(x, y + 10, len * 0.7, 5, hex("#f7b267"), 0.10);
}

// One floating isle: meadow cap, tapering rock underside, houses, a fall.
function isle(cx, cy, r, fallLen) {
  // Rock underside: a jagged cone hanging below the meadow line.
  const rock = [];
  const steps = 9;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    rock.push([cx - r + 2 * r * t, cy + Math.sin(t * Math.PI) * r * 0.16]);
  }
  for (let i = steps; i >= 0; i--) {
    const t = i / steps;
    const pinch = Math.sin(t * Math.PI);
    rock.push([cx - r * 0.92 + 1.84 * r * t * pinch * 0.9 + r * 0.02, cy + r * 1.25 * (1 - pinch) + r * 0.15]);
  }
  poly(rock, hex("#6e4636"), 1);
  poly(rock.map(([x, y]) => [x, y + 4]), hex("#59382c"), 0.35);
  // Strata scratches on the rock.
  for (let i = 0; i < 5; i++) {
    const yy = cy + r * 0.25 + i * r * 0.17;
    seg(cx - r * 0.45, yy, cx + r * 0.4, yy + 3, 2, hex("#4c2d24"), 0.5);
  }
  // Meadow cap.
  ellipse(cx, cy, r, r * 0.22, hex("#7fae4c"), 1);
  ellipse(cx, cy - 2, r * 0.96, r * 0.19, hex("#93c05a"), 1);
  // Houses with lamplit windows along the rim.
  const homes = Math.max(2, Math.round(r / 42));
  for (let i = 0; i < homes; i++) {
    const hx = cx - r * 0.62 + (i + 0.5) * ((r * 1.24) / homes);
    const hy = cy - r * 0.16 - Math.cos((hx - cx) / r * 1.2) * 2;
    const s = r * 0.16;
    rect(hx - s / 2, hy - s, s, s, hex("#f3e3c2"), 1);
    poly([[hx - s * 0.7, hy - s], [hx + s * 0.7, hy - s], [hx, hy - s * 1.7]], hex("#a83e32"), 1);
    rect(hx - s * 0.16, hy - s * 0.55, s * 0.32, s * 0.32, hex("#ffca66"), 1);
  }
  // A lone pine.
  const tx = cx + r * 0.55;
  seg(tx, cy - r * 0.18, tx, cy - r * 0.52, 3, hex("#4c2d24"), 1);
  poly([[tx - r * 0.16, cy - r * 0.34], [tx + r * 0.16, cy - r * 0.34], [tx, cy - r * 0.78]], hex("#3d6b35"), 1);
  // The waterfall: bright threads spilling off the rim into the clouds.
  if (fallLen > 0) {
    const fx = cx - r * 0.3;
    for (let i = 0; i < 7; i++) {
      const xx = fx + i * 3.2;
      const fade = 1 - i / 9;
      seg(xx, cy + 2, xx + Math.sin(i) * 2, cy + fallLen, 2.2, hex("#dff3ff"), 0.5 * fade);
    }
    glowEllipse(fx + 9, cy + fallLen + 8, 30, 9, hex("#ffffff"), 0.35);
  }
}
isle(178, 452, 104, 190);
isle(486, 330, 138, 260);
isle(636, 540, 76, 120);

// A small airship drifting between the isles, gondola slung below.
ellipse(206, 268, 58, 19, hex("#8a4438"), 1);
ellipse(206, 262, 58, 17, hex("#b85c46"), 0.8);
poly([[252, 255], [272, 242], [272, 272], [252, 274]], hex("#6e352a"), 1);
rect(188, 282, 38, 11, hex("#5d4030"), 1);
seg(176, 278, 188, 284, 2, INK, 0.7);
seg(236, 278, 224, 284, 2, INK, 0.7);
rect(198, 285, 6, 5, hex("#ffca66"), 1);
rect(211, 285, 6, 5, hex("#ffca66"), 1);

// Birds, far off: two-stroke wings.
for (let i = 0; i < 7; i++) {
  const bx = 90 + rnd() * 580;
  const by = 130 + rnd() * 260;
  const s = 5 + rnd() * 5;
  seg(bx - s, by, bx, by - s * 0.5, 2, INK, 0.75);
  seg(bx, by - s * 0.5, bx + s, by, 2, INK, 0.75);
}

// The cloud sea itself: banked, overlapping billows along the bottom.
for (let row = 0; row < 4; row++) {
  const baseY = 792 + row * 62;
  for (let i = 0; i < 12; i++) {
    const x = (i / 11) * (W + 120) - 60 + rnd() * 30;
    const r = 74 + rnd() * 66;
    const shade = mix(hex("#f9e3bb"), hex("#e8a56b"), row / 4 + rnd() * 0.12);
    ellipse(x, baseY + rnd() * 16, r, r * 0.42, shade, 0.96);
  }
}
for (let i = 0; i < 26; i++) {
  const x = rnd() * W;
  const y = 800 + rnd() * 190;
  glowEllipse(x, y, 60 + rnd() * 70, 13, hex("#fff6de"), 0.20);
}

// The name, set big at the top like a hand-lettered bill.
drawText("VELMORA", W / 2 + 4, 62, 96, INK, 0.55, 0.55);
drawText("VELMORA", W / 2, 56, 96, hex("#fff3d6"), 1, 0.55);
seg(196, 176, 572, 176, 3, hex("#fff3d6"), 0.8);

// Vignette to hold the corners.
for (let y = 0; y < H; y++) {
  const edge = Math.pow(Math.abs(y - H / 2) / (H / 2), 3) * 0.16;
  for (let x = 0; x < W; x++) {
    const ex = Math.pow(Math.abs(x - W / 2) / (W / 2), 3) * 0.16;
    const d = Math.min(0.3, edge + ex);
    if (d > 0.01) put(x, y, hex("#160f28"), d);
  }
}

// ---- PNG writer: CRC table, Sub-filtered rows, zlib stream ----
const CRC = [];
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC[n] = c >>> 0;
}
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
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
function encodePNG() {
  const raw = Buffer.alloc((W * 3 + 1) * H);
  for (let y = 0; y < H; y++) {
    const row = y * (W * 3 + 1);
    raw[row] = 1; // Sub filter
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 3;
      const left = x > 0 ? px[i - 3] : 0;
      raw[row + 1 + x * 3] = (px[i] - left) & 0xff;
      raw[row + 1 + x * 3 + 1] = (px[i + 1] - (x > 0 ? px[i - 2] : 0)) & 0xff;
      raw[row + 1 + x * 3 + 2] = (px[i + 2] - (x > 0 ? px[i - 1] : 0)) & 0xff;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8-bit truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const out = process.env.ENTRY_OUT || "/output/entry.png";
try { mkdirSync(out.slice(0, out.lastIndexOf("/")), { recursive: true }); } catch { /* sandbox provides it */ }
writeFileSync(out, encodePNG());
console.log("VELMORA poster written to", out);
