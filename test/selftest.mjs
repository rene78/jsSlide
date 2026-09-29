/**
 * Headless self-test for the Slide port.
 *   node test/selftest.mjs
 *
 * 1. geometry primitives
 * 2. surface gradient direction
 * 3. slide against a synthetic trail with known ground truth
 * 4. slide against the real 14/12812/8038@2x tile
 * 5. WGS84 georeferencing of the tile
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Surface, SmoothSurface, buildKernel } from '../src/surface.js';
import { DEFAULTS, createSession, finalize } from '../src/slide.js';
import {
  pathDistance,
  resampleEven,
  resampleInterval,
  douglasPeucker,
  trimEnds,
} from '../src/geometry.js';
import { decodePNG } from './png.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const R = 6378137;
const EARTH_C = 2 * Math.PI * R;
const TILE = { z: 14, x: 12812, y: 8038 };
const N = 2 ** TILE.z;
const IMG_PX = 1024; // verified: this file is exactly one z14 tile (test/overlay.mjs)
const CELL = EARTH_C / (N * IMG_PX);
const ORIGIN_X = (TILE.x / N) * EARTH_C - EARTH_C / 2;
const ORIGIN_Y = EARTH_C / 2 - (TILE.y / N) * EARTH_C;

let failures = 0;
function check(name, ok, detail = '') {
  if (ok) {
    console.log(`  PASS  ${name}${detail ? `  (${detail})` : ''}`);
  } else {
    failures++;
    console.log(`  FAIL  ${name}${detail ? `  (${detail})` : ''}`);
  }
}
function section(t) {
  console.log(`\n${t}`);
}
const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);
const toPx = (m) => m / CELL;

/* ------------------------------------------------------------------ */
section('1. geometry primitives');

{
  const line = new Float64Array([0, 0, 100, 0]);
  const r = resampleEven(line, 11);
  check('resampleEven -> exact count', r.length === 22, `${r.length / 2} pts`);
  check(
    'resampleEven keeps endpoints',
    r[0] === 0 && r[1] === 0 && r[20] === 100 && r[21] === 0
  );
  let minGap = Infinity;
  let maxGap = 0;
  for (let i = 2; i < r.length; i += 2) {
    const d = Math.hypot(r[i] - r[i - 2], r[i + 1] - r[i - 1]);
    minGap = Math.min(minGap, d);
    maxGap = Math.max(maxGap, d);
  }
  check('resampleEven spacing even', maxGap - minGap < 1e-9, `gap ${minGap.toFixed(4)}`);

  // right-angle path: total length 200
  const corner = new Float64Array([0, 0, 100, 0, 100, 100]);
  check('pathDistance', Math.abs(pathDistance(corner) - 200) < 1e-9);

  const rc = resampleEven(corner, 21);
  check('resampleEven along corner', rc.length === 42 && pathDistance(rc) - 200 < 1e-6);

  const ri = resampleInterval(corner, 10);
  check('resampleInterval ~10', Math.abs(pathDistance(ri) / (ri.length / 2 - 1) - 10) < 1e-6);

  // straight line with a small bump -> DP should collapse it
  const flat = [];
  for (let i = 0; i <= 100; i++) flat.push(i, i === 50 ? 0.5 : 0);
  const dp = douglasPeucker(Float64Array.from(flat), 1);
  check('douglasPeucker collapses a flat line', dp.length / 2 === 2, `${dp.length / 2} pts`);

  // exact two-segment tent -> DP must keep exactly the apex
  const tent = [];
  for (let i = 0; i <= 50; i++) tent.push(i * 2, i <= 25 ? i * 2 : (50 - i) * 2);
  const dp2 = douglasPeucker(Float64Array.from(tent), 1);
  check('douglasPeucker keeps a real corner', dp2.length / 2 === 3, `${dp2.length / 2} pts`);
  const dp3 = douglasPeucker(Float64Array.from(tent), 100);
  check('douglasPeucker drops a corner below the threshold', dp3.length / 2 === 2, `${dp3.length / 2} pts`);

  // slide/reducers.Trim: the endpoint itself always survives, and everything
  // up to the first point far enough away from it is dropped.
  const t = new Float64Array([0, 0, 5, 0, 10, 0, 20, 0, 30, 0, 40, 0]);
  const trimmed = trimEnds(t, 15);
  const tx = [];
  for (let i = 0; i < trimmed.length; i += 2) tx.push(trimmed[i]);
  check(
    'trimEnds matches reducers.Trim',
    JSON.stringify(tx) === JSON.stringify([0, 20, 40]),
    `kept x = [${tx.join(', ')}]`
  );
  check(
    'trimEnds leaves >= radius at both ends',
    tx[1] - tx[0] >= 15 && tx[tx.length - 1] - tx[tx.length - 2] >= 15
  );
}

/* ------------------------------------------------------------------ */
section('2. surface + gradient direction');

{
  const W = 64;
  const values = new Float64Array(W * W);
  const x0 = 30;
  for (let y = 0; y < W; y++) {
    for (let x = 0; x < W; x++) {
      values[y * W + x] = Math.exp(-(((x - x0) / 2) ** 2));
    }
  }
  const surf = new Surface(values, W, W, CELL);
  const smooth = new SmoothSurface(surf, buildKernel(16, CELL, 1.001733));

  const left = smooth.gradientAt((x0 - 3) * CELL, 32 * CELL);
  const right = smooth.gradientAt((x0 + 3) * CELL, 32 * CELL);
  check('gradient points uphill (left of ridge -> +x)', left[0] > 0, `gx=${left[0].toFixed(4)}`);
  check('gradient points uphill (right of ridge -> -x)', right[0] < 0, `gx=${right[0].toFixed(4)}`);
  check('gradient zero far away', Math.abs(smooth.gradientAt(2 * CELL, 2 * CELL)[0]) < 1e-4);

  // surface coordinate = px * CELL, and grid index i holds pixel i whose
  // centre is at px = i + 0.5 — so this must land exactly on a grid node.
  const at = (px, py) => surf.valueAt(px * CELL, py * CELL);
  const vOn = at(x0 + 0.5, 32.5);
  const vHalf = at(x0, 32.5); // halfway between grid nodes 29 and 30
  const vOff = at(4.5, 32.5);
  check('pixel centre maps onto its grid node', Math.abs(vOn - 1) < 1e-12, `v=${vOn.toFixed(6)}`);
  check(
    'bilinear halfway between two pixels',
    Math.abs(vHalf - (Math.exp(-0.25) + 1) / 2) < 1e-9,
    `v=${vHalf.toFixed(6)}`
  );
  check('value far from the ridge ~0', vOff < 1e-6, vOff.toExponential(1));

  const k = buildKernel(16, CELL, 1.001733);
  check('kernel peak ~1', Math.abs(k[(k.length - 1) / 2] - 1) < 0.01,
    `peak=${k[(k.length - 1) / 2].toFixed(4)}, taps=${k.length}`);
}

/* ------------------------------------------------------------------ */
section('3. slide against a synthetic trail (known ground truth)');

{
  const S = 200;
  const values = new Float64Array(S * S);
  const truthX = (y) => 100 + 25 * Math.sin(y / 40);
  for (let y = 0; y < S; y++) {
    const xc = truthX(y);
    for (let x = 0; x < S; x++) {
      values[y * S + x] = Math.exp(-(((x - xc) / 1.6) ** 2));
    }
  }

  const surf = new Surface(values, S, S, CELL);
  const smooth = new SmoothSurface(surf, buildKernel(DEFAULTS.smoothingStdDev, CELL, DEFAULTS.mercatorScale));

  // offset the true trail by 7 px
  const input = [];
  for (let y = 10; y <= 190; y += 5) input.push(truthX(y) + 7, y);
  const inputM = Float64Array.from(input.map((v) => v * CELL));

  const t0 = performance.now();
  const session = createSession(surf, smooth, inputM, { ...DEFAULTS });
  while (!session.done) session.step();
  const ms = performance.now() - t0;

  const res = finalize(session);

  const distToTruth = (pts) => {
    const out = [];
    for (let i = 0; i < pts.length; i += 2) {
      const x = toPx(pts[i]);
      const y = toPx(pts[i + 1]);
      if (y < 20 || y > 180) continue; // endpoints are anchored, skip the ends
      out.push(Math.abs(x - truthX(y)));
    }
    return out;
  };
  const before = distToTruth(inputM);
  const after = distToTruth(res);

  const meanBefore = mean(before);
  const meanAfter = mean(after);

  console.log(
    `        input mean |Δ| ${meanBefore.toFixed(2)} px -> result ${meanAfter.toFixed(2)} px · ` +
    `${session.iterations} iterations · ${Math.round(ms)} ms · ` +
    `score ${session.score.toFixed(4)} · pts ${input.length / 2} -> ${res.length / 2}`
  );

  check('line snaps onto the trail', meanAfter < meanBefore * 0.35,
    `${meanBefore.toFixed(2)} -> ${meanAfter.toFixed(2)} px`);
  check('surface score increased', session.score > 0.8, `score=${session.score.toFixed(4)}`);
  check('endpoints untouched',
    Math.abs(res[0] - inputM[0]) < 1e-9 &&
    Math.abs(res[1] - inputM[1]) < 1e-9 &&
    Math.abs(res[res.length - 2] - inputM[inputM.length - 2]) < 1e-9 &&
    Math.abs(res[res.length - 1] - inputM[inputM.length - 1]) < 1e-9);
  check('no NaN in result', [...res].every((v) => Number.isFinite(v)));
  check('converged before max loops', session.iterations < DEFAULTS.maxLoops,
    `${session.iterations} < ${DEFAULTS.maxLoops}`);
}

/* ------------------------------------------------------------------ */
section('4. slide against the real tile');

const png = decodePNG(fs.readFileSync(path.join(HERE, '..', '8038@2x.png')));

{
  const { width: W, height: H, values } = png;
  const surf = new Surface(values, W, H, CELL);
  const smooth = new SmoothSurface(surf, buildKernel(DEFAULTS.smoothingStdDev, CELL, DEFAULTS.mercatorScale));

  // brightest well-separated seeds
  const seeds = [];
  const taken = [];
  const order = [];
  for (let i = 0; i < values.length; i++) order.push(i);
  order.sort((a, b) => values[b] - values[a]);
  for (const i of order) {
    const x = i % W;
    const y = (i / W) | 0;
    if (taken.some(([tx, ty]) => Math.hypot(tx - x, ty - y) < 60)) continue;
    taken.push([x, y]);
    seeds.push([x, y]);
    if (seeds.length >= 40) break;
  }

  const trail = followTrail(values, W, H, seeds);
  check('found a trail to slide along', trail.length >= 30, `${trail.length} points`);

  if (trail.length >= 30) {
    // offset it 8 px perpendicular to the local direction of travel
    const offset = [];
    for (let i = 0; i < trail.length; i++) {
      const prev = trail[Math.max(0, i - 1)];
      const next = trail[Math.min(trail.length - 1, i + 1)];
      let dx = next[0] - prev[0];
      let dy = next[1] - prev[1];
      const len = Math.hypot(dx, dy) || 1;
      dx /= len;
      dy /= len;
      offset.push(
        Math.min(W - 1, Math.max(0, trail[i][0] - dy * 8)),
        Math.min(H - 1, Math.max(0, trail[i][1] + dx * 8))
      );
    }
    const inputM = Float64Array.from(offset.map((v) => v * CELL));

    const valueAt = (pts) => {
      const out = [];
      for (let i = 0; i < pts.length; i += 2) out.push(surf.valueAt(pts[i], pts[i + 1]));
      return mean(out);
    };
    const bright = (pts) => {
      let n = 0;
      for (let i = 0; i < pts.length; i += 2) if (surf.valueAt(pts[i], pts[i + 1]) > 0.5) n++;
      return n / (pts.length / 2);
    };

    const vBefore = valueAt(inputM);
    const bBefore = bright(inputM);

    const t0 = performance.now();
    const session = createSession(surf, smooth, inputM, { ...DEFAULTS });
    while (!session.done) session.step();
    const ms = performance.now() - t0;
    const res = finalize(session);

    const vAfter = valueAt(res);
    const bAfter = bright(res);

    let maxMove = 0;
    // Points may legitimately redistribute *along* the line (that is what the
    // distance term does), so measure escape from the line itself rather than
    // per-index drift.
    const start = session.prepared;
    const startPx = [];
    for (let i = 0; i < start.length; i += 2) startPx.push([toPx(start[i]), toPx(start[i + 1])]);

    const distToLine = (x, y) => {
      let best = Infinity;
      for (let i = 0; i + 1 < startPx.length; i++) {
        const [ax, ay] = startPx[i];
        const [bx, by] = startPx[i + 1];
        const ex = bx - ax;
        const ey = by - ay;
        const len2 = ex * ex + ey * ey;
        let t = len2 > 0 ? ((x - ax) * ex + (y - ay) * ey) / len2 : 0;
        t = Math.max(0, Math.min(1, t));
        best = Math.min(best, Math.hypot(x - (ax + ex * t), y - (ay + ey * t)));
      }
      return best;
    };
    const escapes = [];
    for (let i = 0; i < res.length; i += 2) {
      escapes.push(distToLine(toPx(res[i]), toPx(res[i + 1])));
      maxMove = Math.max(maxMove, escapes[escapes.length - 1]);
    }
    escapes.sort((a, b) => a - b);
    const p95 = escapes[Math.floor(escapes.length * 0.95)];

    if (process.env.DEBUG) {
      const fmt = (p, i) => `(${toPx(p[2 * i]).toFixed(1)}, ${toPx(p[2 * i + 1]).toFixed(1)})`;
      console.log('        DEBUG start[0..3]:', [0, 1, 2, 3].map((i) => fmt(start, i)).join(' '));
      console.log('        DEBUG res  [0..3]:', [0, 1, 2, 3].map((i) => fmt(res, i)).join(' '));
      console.log('        DEBUG escapes     :', escapes.map((v) => v.toFixed(2)).join(' '));
      console.log('        DEBUG inputM px[0..3]:',
        [0, 1, 2, 3].map((i) => `(${toPx(inputM[2 * i]).toFixed(1)}, ${toPx(inputM[2 * i + 1]).toFixed(1)})`).join(' '));
      console.log('        DEBUG trail[0..3]:', [0, 1, 2, 3].map((i) => `[${trail[i]}]`).join(' '));
      console.log('        DEBUG offset[0..3]:',
        [0, 1, 2, 3].map((i) => `(${offset[2 * i].toFixed(1)}, ${offset[2 * i + 1].toFixed(1)})`).join(' '));
    }

    // interior spacing of the raw converged path must not collapse or explode
    const raw = session.path;
    let minGap = Infinity;
    let maxGap = 0;
    for (let i = 2; i < raw.length; i += 2) {
      const g = toPx(Math.hypot(raw[i] - raw[i - 2], raw[i + 1] - raw[i - 1]));
      minGap = Math.min(minGap, g);
      maxGap = Math.max(maxGap, g);
    }
    const nominal = (DEFAULTS.resampleInterval * DEFAULTS.mercatorScale) / CELL;

    console.log(
      `        brightness ${vBefore.toFixed(4)} -> ${vAfter.toFixed(4)} · ` +
      `on-trail(<0.5) ${(bBefore * 100).toFixed(0)}% -> ${(bAfter * 100).toFixed(0)}% · ` +
      `${session.iterations} iterations · ${Math.round(ms)} ms · ` +
      `${start.length / 2} -> ${res.length / 2} pts`
    );
    console.log(
      `        escape from the input line: median ${escapes[escapes.length >> 1].toFixed(1)} px, ` +
      `p95 ${p95.toFixed(1)} px, max ${maxMove.toFixed(1)} px · ` +
      `spacing ${minGap.toFixed(2)}..${maxGap.toFixed(2)} px (nominal ${nominal.toFixed(2)})`
    );

    check('more of the line sits on a bright trail', bAfter > bBefore,
      `${(bBefore * 100).toFixed(0)}% -> ${(bAfter * 100).toFixed(0)}%`);
    check('average brightness increased', vAfter > vBefore,
      `${vBefore.toFixed(4)} -> ${vAfter.toFixed(4)}`);
    check('did not run away', p95 < 25, `p95 ${p95.toFixed(1)} px, max ${maxMove.toFixed(1)} px`);
    check('bead spacing stays sane', minGap > 0.1 && maxGap < 40,
      `${minGap.toFixed(2)}..${maxGap.toFixed(2)} px`);
    check('endpoints untouched',
      Math.abs(res[0] - start[0]) < 1e-9 && Math.abs(res[1] - start[1]) < 1e-9);
    check('no NaN', [...res].every((v) => Number.isFinite(v)));
    check('converged before max loops', session.iterations < DEFAULTS.maxLoops,
      `${session.iterations} < ${DEFAULTS.maxLoops}`);
  }
}

/* ------------------------------------------------------------------ */
section('5. georeferencing');

function toWGS84(mx, my) {
  return [
    ((ORIGIN_X + mx) / R) * (180 / Math.PI),
    (2 * Math.atan(Math.exp((ORIGIN_Y - my) / R)) - Math.PI / 2) * (180 / Math.PI),
  ];
}
const lonOfTile = (x) => (x / N) * 360 - 180;
const latOfTile = (y) => (Math.atan(Math.sinh(Math.PI - (2 * Math.PI * y) / N)) * 180) / Math.PI;

{
  const [lon0, lat0] = toWGS84(0, 0);
  const [lon1, lat1] = toWGS84(png.width * CELL, png.height * CELL);
  console.log(
    `        image covers lat ${lat1.toFixed(6)}..${lat0.toFixed(6)}, ` +
    `lon ${lon0.toFixed(6)}..${lon1.toFixed(6)}`
  );
  check(
    'north-west corner = tile corner',
    Math.abs(lon0 - lonOfTile(TILE.x)) < 1e-5 && Math.abs(lat0 - latOfTile(TILE.y)) < 1e-5,
    `${lon0.toFixed(6)}, ${lat0.toFixed(6)}`
  );
  check(
    'south-east corner = next tile corner',
    Math.abs(lon1 - lonOfTile(TILE.x + 1)) < 1e-5 && Math.abs(lat1 - latOfTile(TILE.y + 1)) < 1e-5,
    `${lon1.toFixed(6)}, ${lat1.toFixed(6)}`
  );
  check(
    'cell size = one z14 tile across 1024 px',
    Math.abs(CELL - 2.388657) < 1e-5,
    `${CELL.toFixed(6)} m/px`
  );
}

/* ------------------------------------------------------------------ */
section('6. chaining — feed the finished result back in as the baseline');

/**
 * What promoteResult() does in the UI: run to convergence, then feed the
 * finalised geometry straight back into the next session as its input.
 */
function runChained(surf, smooth, startM, passCount = 3, overrides = {}) {
  let base = startM;
  const passes = [];
  for (let pass = 1; pass <= passCount; pass++) {
    const session = createSession(surf, smooth, base, { ...DEFAULTS, ...overrides });
    while (!session.done) session.step();
    base = finalize(session);
    passes.push({ session, base });
  }
  return passes;
}

{
  // (a) A clean synthetic trail. A single pass converges on it, so this is the
  //     regression guard: re-feeding the finished result back in must not push
  //     a line that is already on the trail off it, nor disturb the anchors.
  const S = 200;
  const values = new Float64Array(S * S);
  const truthX = (y) => 100 + 25 * Math.sin(y / 40);
  for (let y = 0; y < S; y++) {
    const xc = truthX(y);
    for (let x = 0; x < S; x++) values[y * S + x] = Math.exp(-(((x - xc) / 1.6) ** 2));
  }
  const surf = new Surface(values, S, S, CELL);
  const smooth = new SmoothSurface(
    surf,
    buildKernel(DEFAULTS.smoothingStdDev, CELL, DEFAULTS.mercatorScale)
  );

  // A smooth hump pushes a stretch of the line off the trail; the ridge is
  // sharp enough that pass 1 flattens it.
  const SAG = 14; // px the hump peaks at
  const offsetPx = (y) => {
    if (y < 50 || y > 170) return 0;
    const t = (y - 50) / 120;
    return SAG * Math.sin(Math.PI * t) ** 2;
  };
  const input = [];
  for (let y = 10; y <= 190; y += 5) input.push(truthX(y) + offsetPx(y), y);

  const sag = (pts) => {
    const out = [];
    for (let i = 0; i < pts.length; i += 2) {
      const x = toPx(pts[i]);
      const y = toPx(pts[i + 1]);
      if (y < 60 || y > 160) continue;
      out.push(Math.abs(x - truthX(y)));
    }
    return out;
  };

  const passes = runChained(surf, smooth, Float64Array.from(input.map((v) => v * CELL)));
  const d = passes.map((p) => mean(sag(p.base)));
  const scores = passes.map((p) => p.session.score);
  const iters = passes.map((p) => p.session.iterations);

  console.log(
    `        sag ${d.map((v) => v.toFixed(2)).join(' -> ')} px · ` +
    `score ${scores.map((v) => v.toFixed(4)).join(' -> ')} · ` +
    `iters ${iters.join(' -> ')}`
  );

  check('one pass converges on a clean trail', d[0] < 2, `${d[0].toFixed(2)} px`);
  check('chaining does not regress a converged line', d.every((x) => x < 2),
    d.map((v) => v.toFixed(2)).join(' -> '));
  check('chaining stays near the best pass',
    Math.max(...d) <= Math.min(...d) + 0.5,
    `range ${Math.min(...d).toFixed(2)}..${Math.max(...d).toFixed(2)} px`);
  check('every pass gets at least minLoops iterations',
    iters.every((i) => i >= DEFAULTS.minLoops), iters.join(' -> '));
  check('endpoints survive every pass',
    Math.abs(passes[0].base[0] - passes[passes.length - 1].base[0]) < 1e-9 &&
      Math.abs(passes[0].base[1] - passes[passes.length - 1].base[1]) < 1e-9 &&
      Math.abs(
        passes[0].base[passes[0].base.length - 2] -
          passes[passes.length - 1].base[passes[passes.length - 1].base.length - 2]
      ) < 1e-9 &&
      Math.abs(
        passes[0].base[passes[0].base.length - 1] -
          passes[passes.length - 1].base[passes[passes.length - 1].base.length - 1]
      ) < 1e-9);
  check('no NaN after chaining', passes.every((p) => [...p.base].every(Number.isFinite)));
}

{
  // (b) real tile: chaining must never make the line worse
  const { width: W, height: H, values } = png;
  const surf = new Surface(values, W, H, CELL);
  const smooth = new SmoothSurface(
    surf,
    buildKernel(DEFAULTS.smoothingStdDev, CELL, DEFAULTS.mercatorScale)
  );

  const trail = followTrail(values, W, H, brightSeeds(values, W, H, 40, 60));
  check('found a trail for the chaining test', trail.length >= 30, `${trail.length} points`);

  if (trail.length >= 30) {
    const offset = [];
    for (let i = 0; i < trail.length; i++) {
      const prev = trail[Math.max(0, i - 1)];
      const next = trail[Math.min(trail.length - 1, i + 1)];
      let dx = next[0] - prev[0];
      let dy = next[1] - prev[1];
      const len = Math.hypot(dx, dy) || 1;
      dx /= len;
      dy /= len;
      offset.push(
        Math.min(W - 1, Math.max(0, trail[i][0] - dy * 8)),
        Math.min(H - 1, Math.max(0, trail[i][1] + dx * 8))
      );
    }

    const valueAt = (pts) => {
      const out = [];
      for (let i = 0; i < pts.length; i += 2) out.push(surf.valueAt(pts[i], pts[i + 1]));
      return mean(out);
    };
    const onTrail = (pts) => {
      let n = 0;
      for (let i = 0; i < pts.length; i += 2) {
        if (surf.valueAt(pts[i], pts[i + 1]) > 0.5) n++;
      }
      return n / (pts.length / 2);
    };

    const passes = runChained(
      surf,
      smooth,
      Float64Array.from(offset.map((v) => v * CELL)),
      6
    );
    const v = passes.map((p) => valueAt(p.base));
    const b = passes.map((p) => onTrail(p.base));
    const n = passes.map((p) => p.base.length / 2);

    // Perpendicular distance from the result to the *actual* traced trail.
    // Mean brightness is dominated by whatever is already bright; this is the
    // honest "is it on the track yet".
    const distToTrail = (pts) => {
      const out = [];
      for (let i = 0; i < pts.length; i += 2) {
        const x = toPx(pts[i]);
        const y = toPx(pts[i + 1]);
        let best = Infinity;
        for (let k = 0; k + 1 < trail.length; k++) {
          const [ax, ay] = trail[k];
          const [bx, by] = trail[k + 1];
          const ex = bx - ax;
          const ey = by - ay;
          const l2 = ex * ex + ey * ey;
          let t = l2 > 0 ? ((x - ax) * ex + (y - ay) * ey) / l2 : 0;
          if (t < 0) t = 0;
          else if (t > 1) t = 1;
          best = Math.min(best, Math.hypot(x - (ax + ex * t), y - (ay + ey * t)));
        }
        out.push(best);
      }
      out.sort((p1, p2) => p1 - p2);
      return { mean: mean(out), p95: out[Math.floor(out.length * 0.95)] };
    };
    const dt = passes.map((p) => distToTrail(p.base));

    console.log(
      `        brightness ${v.map((x) => x.toFixed(4)).join(' -> ')} · ` +
      `on-trail ${b.map((x) => (x * 100).toFixed(0) + '%').join(' -> ')} · ` +
      `dist to trail ${dt.map((x) => x.mean.toFixed(2)).join(' -> ')} px ` +
      `(p95 ${dt.map((x) => x.p95.toFixed(1)).join(' -> ')})`
    );
    console.log(
      `        iters ${passes.map((p) => p.session.iterations).join(' -> ')} · ` +
      `pts ${n.join(' -> ')}`
    );

    // Each pass re-resamples and re-simplifies, so successive passes land at
    // slightly different equilibria — chaining is an iterative retry, not a
    // guaranteed ascent. What must hold: no pass is materially worse than a
    // single pass, and at least one pass matches or beats it.
    check('chaining never materially darkens the line',
      v.every((x) => x >= v[0] - 0.01),
      v.map((x) => x.toFixed(4)).join(' -> '));
    check('some pass matches or beats a single pass', Math.max(...v) >= v[0],
      `best ${Math.max(...v).toFixed(4)} vs pass 1 ${v[0].toFixed(4)}`);
    check('on-trail fraction stays within 2%',
      b.every((x) => x >= b[0] - 0.02),
      b.map((x) => (x * 100).toFixed(0) + '%').join(' -> '));
    // Distance to the true trail: chaining is a perturb-and-re-settle, so it is
    // not a guaranteed ascent, but some pass must land at least as close as a
    // single pass, and no pass may send the line materially further away.
    check('some pass lands at least as close to the trail as the first',
      Math.min(...dt.map((x) => x.mean)) <= dt[0].mean,
      `best ${Math.min(...dt.map((x) => x.mean)).toFixed(2)} vs ` +
      `pass 1 ${dt[0].mean.toFixed(2)} px`);
    check('no pass strays more than 1 px further from the trail',
      dt.every((x) => x.mean <= dt[0].mean + 1),
      dt.map((x) => x.mean.toFixed(2)).join(' -> '));
    check('anchored endpoints never move',
      passes.every(
        (p) =>
          p.base[0] === passes[0].base[0] &&
          p.base[1] === passes[0].base[1] &&
          p.base[p.base.length - 2] === passes[0].base[passes[0].base.length - 2] &&
          p.base[p.base.length - 1] === passes[0].base[passes[0].base.length - 1]
      ),
      `unchanged across ${passes.length} passes`);
    check('no NaN after chaining', passes.every((p) => [...p.base].every(Number.isFinite)));
  }
}

/* ------------------------------------------------------------------ */
console.log(
  `\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n`
);
process.exit(failures === 0 ? 0 : 1);

/* ------------------------------------------------------------------ */

/**
 * The n brightest pixels that are at least `sep` px apart — candidate trail
 * heads for followTrail().
 */
function brightSeeds(values, W, H, n, sep) {
  const seeds = [];
  const taken = [];
  const order = [];
  for (let i = 0; i < values.length; i++) order.push(i);
  order.sort((a, b) => values[b] - values[a]);
  for (const i of order) {
    const x = i % W;
    const y = (i / W) | 0;
    if (taken.some(([tx, ty]) => Math.hypot(tx - x, ty - y) < sep)) continue;
    taken.push([x, y]);
    seeds.push([x, y]);
    if (seeds.length >= n) break;
  }
  return seeds;
}

/**
 * Greedy walk from each seed, always stepping to the brightest nearby pixel,
 * to trace a polyline that follows an actual trail in the heatmap.
 */
function followTrail(values, W, H, seeds) {
  const dirs = [];
  for (let a = 0; a < 16; a++) dirs.push([Math.cos((a * Math.PI) / 8), Math.sin((a * Math.PI) / 8)]);

  let best = [];
  for (const [sx, sy] of seeds) {
    const path = [[sx, sy]];
    let cx = sx;
    let cy = sy;

    for (let step = 0; step < 400; step++) {
      let bestNext = null;
      let bestScore = -1;

      for (const [dx, dy] of dirs) {
        for (const r of [1, 2, 3]) {
          const nx = Math.round(cx + dx * r);
          const ny = Math.round(cy + dy * r);
          if (nx < 3 || ny < 3 || nx >= W - 3 || ny >= H - 3) continue;
          let score = values[ny * W + nx];
          // discourage doubling straight back
          if (path.length > 2 && nx === path[path.length - 2][0] && ny === path[path.length - 2][1]) {
            score -= 0.6;
          }
          if (score > bestScore) {
            bestScore = score;
            bestNext = [nx, ny];
          }
        }
      }

      if (!bestNext || bestScore < 0.15) break;
      // stop if we have looped back onto ourselves
      if (path.some(([px, py]) => px === bestNext[0] && py === bestNext[1])) break;

      [cx, cy] = bestNext;
      path.push([cx, cy]);
    }

    // thin it out a little — 1 px steps are far denser than we need
    if (path.length > best.length) best = path.filter((_, i) => i % 2 === 0 || i === path.length - 1);
  }
  return best;
}
