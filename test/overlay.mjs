/**
 * Renders OSM highways over the heatmap under two competing georeferencing
 * hypotheses, so we can see which one lines up:
 *   A = the image is exactly one z14 tile   (2.3887 m/px)
 *   B = the image is 2x2 z14 tiles          (4.7773 m/px)
 *
 * Writes BMPs, converts to PNG with sips.
 */
import fs from 'node:fs';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodePNG } from './png.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const R = 6378137;
const C = 2 * Math.PI * R;
const N = 2 ** 14;
const ORIGIN_X = (12812 / N) * C - C / 2;
const ORIGIN_Y = C / 2 - (8038 / N) * C;

const { width: W, height: H, values } = decodePNG(
  fs.readFileSync(path.join(HERE, '..', '8038@2x.png'))
);

// Only the tile itself: that is the subset both hypotheses are scored on, and
// it keeps the Overpass query fast.
const bbox = {
  south: 3.3598,
  west: 101.5136,
  north: 3.3819,
  east: 101.5357,
};

const query = `[out:json][timeout:60];way["highway"](${bbox.south},${bbox.west},${bbox.north},${bbox.east});out geom;`;
const endpoints = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

console.log('querying overpass…');
const outDir = path.join(HERE, 'out');
fs.mkdirSync(outDir, { recursive: true });
const cacheFile = path.join(outDir, 'osm-tile.json');

let json = null;
if (fs.existsSync(cacheFile)) {
  json = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  console.log('  (from local cache)');
}
for (const endpoint of endpoints) {
  if (json) break;
  for (let attempt = 0; attempt < 2 && !json; attempt++) {
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        signal: AbortSignal.timeout(30000),
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'slide-demo-selftest/1.0',
          Accept: 'application/json',
        },
        body: 'data=' + encodeURIComponent(query),
      });
      if (!res.ok) {
        console.log(`  ${endpoint} -> ${res.status}`);
        continue;
      }
      json = await res.json();
    } catch (e) {
      console.log(`  ${endpoint} -> ${e.message}`);
    }
  }
}
if (!json) {
  console.log('overpass unavailable — skipping the georeferencing check.');
  process.exit(0);
}
fs.writeFileSync(cacheFile, JSON.stringify(json));
const ways = json.elements.filter((e) => e.type === 'way' && e.geometry && e.geometry.length > 1);
console.log(`got ${ways.length} highway ways`);
if (!ways.length) process.exit(1);

function project(lon, lat, cell) {
  const X = ((lon * Math.PI) / 180) * R;
  const Y = R * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
  return [(X - ORIGIN_X) / cell, (ORIGIN_Y - Y) / cell];
}

function render(cell, outBmp) {
  const buf = Buffer.alloc(W * H * 3);
  // base: heatmap as a dim blue-grey
  for (let i = 0; i < W * H; i++) {
    const v = values[i];
    const g = Math.round(30 + 140 * v);
    buf[i * 3] = Math.round(g * 0.55);
    buf[i * 3 + 1] = Math.round(g * 0.75);
    buf[i * 3 + 2] = g;
  }

  let inside = 0;
  const put = (x, y, r, g, b) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const o = (y * W + x) * 3;
    buf[o] = r;
    buf[o + 1] = g;
    buf[o + 2] = b;
  };
  const line = (x0, y0, x1, y1) => {
    const steps = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0)));
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      put(Math.round(x0 + (x1 - x0) * t), Math.round(y0 + (y1 - y0) * t), 255, 40, 40);
    }
  };

  for (const way of ways) {
    let prev = null;
    for (const node of way.geometry) {
      const [px, py] = project(node.lon, node.lat, cell);
      if (px >= 0 && py >= 0 && px < W && py < H) inside++;
      if (prev) line(prev[0], prev[1], px, py);
      prev = [px, py];
    }
  }
  writeBmp(outBmp, buf);
  return inside;
}

function writeBmp(file, rgb) {
  const rowSize = Math.ceil((W * 3) / 4) * 4;
  const dataSize = rowSize * H;
  const header = Buffer.alloc(54);
  header.write('BM', 0);
  header.writeUInt32LE(54 + dataSize, 2);
  header.writeUInt32LE(54, 10);
  header.writeUInt32LE(40, 14);
  header.writeInt32LE(W, 18);
  header.writeInt32LE(H, 22);
  header.writeUInt16LE(1, 26);
  header.writeUInt16LE(24, 28);
  header.writeUInt32LE(dataSize, 34);

  const pixels = Buffer.alloc(dataSize);
  for (let y = 0; y < H; y++) {
    const srcRow = H - 1 - y; // BMP is bottom-up
    for (let x = 0; x < W; x++) {
      const s = (srcRow * W + x) * 3;
      const d = y * rowSize + x * 3;
      pixels[d] = rgb[s + 2];
      pixels[d + 1] = rgb[s + 1];
      pixels[d + 2] = rgb[s];
    }
  }
  fs.writeFileSync(file, Buffer.concat([header, pixels]));
}

const A = C / (N * 1024); // one z14 tile across 1024 px
const B = C / (N * 512); // 2x2 z14 tiles across 1024 px

for (const [label, cell] of [['A-one-tile', A], ['B-two-by-two', B]]) {
  const bmp = path.join(outDir, `overlay-${label}.bmp`);
  const inside = render(cell, bmp);
  const pngPath = bmp.replace('.bmp', '.png');
  execFileSync('sips', ['-s', 'format', 'png', bmp, '--out', pngPath], { stdio: 'ignore' });
  fs.rmSync(bmp, { force: true }); // 3 MB intermediate; the PNG is what we keep
  console.log(
    `${label}: ${cell.toFixed(4)} m/px · ${inside} road vertices inside the image · ${pngPath}`
  );
}

/* ------------------------------------------------------------------------ *
 * Quantitative version of the same test: rasterise the roads under each
 * hypothesis and compare how bright the heatmap is underneath them.
 *
 * The road subset is fixed to the ones that fall inside the image under
 * hypothesis A, so both candidates are scored on identical geometry.
 * ------------------------------------------------------------------------ */
function alignment(cell) {
  const mask = new Uint8Array(W * H);
  const put = (x, y) => {
    if (x >= 0 && y >= 0 && x < W && y < H) mask[y * W + x] = 1;
  };
  const line = (x0, y0, x1, y1) => {
    const steps = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0)));
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      put(Math.round(x0 + (x1 - x0) * t), Math.round(y0 + (y1 - y0) * t));
    }
  };

  for (const way of ways) {
    let prev = null;
    for (const node of way.geometry) {
      const a = project(node.lon, node.lat, A);
      if (a[0] < 0 || a[1] < 0 || a[0] >= W || a[1] >= H) {
        prev = null; // outside the subset this test is scored on
        continue;
      }
      const p = project(node.lon, node.lat, cell);
      if (prev) line(prev[0], prev[1], p[0], p[1]);
      prev = p;
    }
  }

  let sum = 0;
  let n = 0;
  for (let i = 0; i < values.length; i++) {
    if (!mask[i]) continue;
    sum += values[i];
    n++;
  }
  let ground = 0;
  let g = 0;
  for (let i = 0; i < values.length; i += 7) {
    ground += values[i];
    g++;
  }
  return { mean: n ? sum / n : 0, pixels: n, ground: ground / g };
}

const scoreA = alignment(A);
const scoreB = alignment(B);
console.log(
  `\n  roads-on-heatmap brightness (baseline, i.e. random pixels, = ${scoreA.ground.toFixed(4)})`
);
console.log(`    A one z14 tile : ${scoreA.mean.toFixed(4)} over ${scoreA.pixels} px`);
console.log(`    B 2x2 z14 tiles: ${scoreB.mean.toFixed(4)} over ${scoreB.pixels} px`);

if (scoreA.mean > scoreB.mean * 1.3) {
  console.log(`\n  => hypothesis A wins: the PNG is exactly one z14 tile.`);
} else if (scoreB.mean > scoreA.mean * 1.3) {
  console.log(`\n  => hypothesis B wins: the PNG spans 2x2 z14 tiles.`);
  process.exitCode = 1;
} else {
  console.log('\n  => inconclusive, inspect the overlay PNGs by eye.');
  process.exitCode = 1;
}
console.log('');
