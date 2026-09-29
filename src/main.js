/**
 * Slide test bench — canvas UI around the slide engine.
 *
 * Loads the local Strava heatmap tile, lets you click a polyline onto it, then
 * runs Slide and animates the line snapping onto the trails.
 */

import { Surface, SmoothSurface, buildKernel, colorValue } from './surface.js';
import { DEFAULTS, createSession, finalize } from './slide.js';

/* ------------------------------------------------------------------ *
 * Tile georeferencing: 14/12812/8038, one z14 tile at 1024 px
 * ------------------------------------------------------------------ */
// This file is exactly one z14 tile rendered at 1024 px (verified by overlaying
// OSM roads on the heatmap — see test/overlay.mjs), so the cell size is
// simply "world circumference / (tiles across * pixels across)".
const TILE = { z: 14, x: 12812, y: 8038, size: 1024, file: '8038@2x.png' };
const R = 6378137;
const EARTH_C = 2 * Math.PI * R;
const N = 2 ** TILE.z;
const IMG = TILE.size;
const CELL = EARTH_C / (N * IMG); // metres per image pixel
const ORIGIN_X = (TILE.x / N) * EARTH_C - EARTH_C / 2;
const ORIGIN_Y = EARTH_C / 2 - (TILE.y / N) * EARTH_C;

function tileLat(row) {
  return (Math.atan(Math.sinh(Math.PI - (2 * Math.PI * row) / N)) * 180) / Math.PI;
}
const MERC_SCALE = 1 / Math.cos((tileLat(TILE.y + 0.5) * Math.PI) / 180);

function toWGS84(mx, my) {
  const lon = ((ORIGIN_X + mx) / R) * (180 / Math.PI);
  const lat =
    (2 * Math.atan(Math.exp((ORIGIN_Y - my) / R)) - Math.PI / 2) * (180 / Math.PI);
  return [lon, lat];
}

/* ------------------------------------------------------------------ *
 * Parameter schema (drives the sidebar)
 * ------------------------------------------------------------------ */
const PARAM_DEFS = [
  // key, label, unit, step, min, max
  ['smoothingStdDev', 'Smoothing SD', 'm', 1, 0, 300],
  ['gradientScale', 'Gradient scale', '', 0.05, 0, 10],
  ['distanceScale', 'Distance scale', '', 0.01, 0, 5],
  ['angleScale', 'Angle scale', '', 0.01, 0, 5],
  ['momentumScale', 'Momentum', '', 0.05, 0, 0.95],
  ['resampleInterval', 'Resample interval', 'm', 0.5, 0.5, 100],
  ['minLoops', 'Min loops', '', 10, 0, 100000],
  ['maxLoops', 'Max loops', '', 100, 1, 100000],
  ['thresholdEpsilon', 'Score threshold', '', 0.0001, 0, 1],
  ['trimRadius', 'Trim ends', 'm', 1, 0, 300],
  ['simplifyTolerance', 'Simplify tolerance', 'm', 0.5, 0, 100],
  ['ghostCount', 'Ghost snapshots', '', 25, 0, 2000],
];

const TOGGLE_DEFS = [
  ['gradientPerCell', 'Gradient measured per cell'],
  ['showGhosts', 'Show intermediate ghosts'],
  ['showSmoothed', 'Show smoothed surface'],
];

const opts = {
  ...DEFAULTS,
  mercatorScale: MERC_SCALE,
  showGhosts: true,
  showSmoothed: false,
};

/* ------------------------------------------------------------------ *
 * State
 * ------------------------------------------------------------------ */
const state = {
  surface: null,
  smooth: null,
  srcCanvas: null,
  overlayCanvas: null,
  overlayDirty: true,
  pathPx: [], // current baseline, image pixels — the drawing, or a promoted result
  originPathPx: [], // what the user actually drew, frozen once a result is promoted
  promoted: false, // pathPx currently holds a slid result rather than the drawing
  pass: 1, // which chain pass the next run is (Slide promotes, Restart resets)
  resultPromoted: false, // guards against promoting the same result twice
  stoppedBy: null, // why the last run ended
  finished: false,
  session: null,
  result: null, // Float64Array in metres, set once converged
  running: false,
  paused: false,
  dirty: true,
  view: { scale: 1, ox: 0, oy: 0 },
};

const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');
const stage = document.getElementById('stage');
const toastEl = document.getElementById('toast');

let rafId = null;

/* ------------------------------------------------------------------ *
 * Boot
 * ------------------------------------------------------------------ */
buildParamUI();

const img = new Image();
img.onload = () => {
  const c = document.createElement('canvas');
  c.width = IMG;
  c.height = IMG;
  const cctx = c.getContext('2d', { willReadFrequently: true });
  cctx.drawImage(img, 0, 0, IMG, IMG);

  const data = cctx.getImageData(0, 0, IMG, IMG).data;
  const values = new Float64Array(IMG * IMG);
  for (let i = 0, j = 0; i < values.length; i++, j += 4) {
    values[i] = colorValue(data[j], data[j + 1], data[j + 2]);
  }

  state.srcCanvas = c;
  state.surface = new Surface(values, IMG, IMG, CELL);
  state.smooth = new SmoothSurface(state.surface, currentKernel());

  status(`tile ${TILE.z}/${TILE.x}/${TILE.y} · ${CELL.toFixed(4)} m/px · ` +
         `${MERC_SCALE.toFixed(5)} mercator scale · ${IMG}×${IMG}`);
  updateButtons();
  requestRender();
};
img.onerror = () => {
  status(`could not load ${TILE.file} — serve this folder over http, e.g. ` +
         `"python3 -m http.server 8080"`);
};
img.src = TILE.file;

requestRender();

function currentKernel() {
  return buildKernel(opts.smoothingStdDev, CELL, opts.mercatorScale);
}

/* ------------------------------------------------------------------ *
 * Sidebar
 * ------------------------------------------------------------------ */
function buildParamUI() {
  const paramsEl = document.getElementById('params');
  for (const [key, label, unit, step, min, max] of PARAM_DEFS) {
    const row = document.createElement('label');
    row.className = 'row';
    row.innerHTML =
      `<span>${label}${unit ? ` <em>(${unit})</em>` : ''}</span>` +
      `<input type="number" data-key="${key}" step="${step}" min="${min}" max="${max}">`;
    paramsEl.appendChild(row);
    const input = row.querySelector('input');
    input.value = opts[key];
    input.addEventListener('input', () => {
      const v = parseFloat(input.value);
      if (Number.isNaN(v)) return;
      opts[key] = v;
      if (key === 'smoothingStdDev') {
        state.smooth?.setKernel(currentKernel());
        state.overlayDirty = true;
      }
      if (key === 'ghostCount' && state.session) state.session.ghosts.length = 0;
      requestRender();
    });
  }

  const togglesEl = document.getElementById('toggles');
  for (const [key, label] of TOGGLE_DEFS) {
    const row = document.createElement('label');
    row.className = 'row check';
    row.innerHTML =
      `<input type="checkbox" data-key="${key}"><span>${label}</span>`;
    togglesEl.appendChild(row);
    const input = row.querySelector('input');
    input.checked = !!opts[key];
    input.addEventListener('change', () => {
      opts[key] = input.checked;
      if (key === 'showSmoothed') state.overlayDirty = true;
      requestRender();
    });
  }
}

function readParams() {
  return { ...opts };
}

/* ------------------------------------------------------------------ *
 * Buttons
 * ------------------------------------------------------------------ */
const $ = (id) => document.getElementById(id);

$('btn-slide').addEventListener('click', startSlide);
$('btn-pause').addEventListener('click', () => {
  if (!state.session || state.session.done) return;
  state.paused = !state.paused;
  updateButtons();
  if (!state.paused) schedule();
});
$('btn-step').addEventListener('click', () => {
  if (!state.session || state.session.done) return;
  state.paused = true;
  state.session.step();
  if (state.session.done) finishSlide();
  updateButtons();
  requestRender();
});
$('btn-replay').addEventListener('click', restartSlide);
$('btn-clear').addEventListener('click', clearAll);
$('btn-export').addEventListener('click', exportGeoJSON);

/* ------------------------------------------------------------------ *
 * Path <-> engine conversions
 * ------------------------------------------------------------------ */
function clonePath(p) {
  return p.map((v) => [v[0], v[1]]);
}

function pxToMetres(path) {
  const out = new Float64Array(path.length * 2);
  for (let i = 0; i < path.length; i++) {
    out[2 * i] = path[i][0] * CELL;
    out[2 * i + 1] = path[i][1] * CELL;
  }
  return out;
}

function metresToPx(flat) {
  const out = [];
  for (let i = 0; i < flat.length; i += 2) out.push([flat[i] / CELL, flat[i + 1] / CELL]);
  return out;
}

/** Keep the "what you drew" snapshot in sync, until a result is promoted. */
function syncOrigin() {
  if (!state.promoted) state.originPathPx = clonePath(state.pathPx);
}

/**
 * Adopt the converged result as the new baseline so the next Slide run starts
 * from it instead of from the original drawing. Endpoints never move during a
 * run, so the anchor survives chaining exactly.
 */
function promoteResult() {
  if (!state.result || state.result.length < 4) return false;
  state.pathPx = metresToPx(state.result);
  state.promoted = true;
  state.resultPromoted = true;
  state.pass += 1;
  state.finished = true;
  toast(`Continuing from the previous result — pass ${state.pass}.`);
  return true;
}

function startSlide() {
  if (!state.surface || state.pathPx.length < 2) {
    toast('Click at least two points onto the map first.');
    return;
  }

  // a finished run that has not been promoted yet becomes the baseline
  if (state.result && !state.resultPromoted) promoteResult();

  state.session = createSession(
    state.surface,
    state.smooth,
    pxToMetres(state.pathPx),
    readParams()
  );
  state.result = null;
  state.resultPromoted = false;
  state.stoppedBy = null;
  state.running = true;
  state.paused = false;
  state.finished = true;
  updateButtons();
  requestRender();
}

/** Discard the chain and go back to the line as drawn. */
function restartSlide() {
  if (state.running) {
    toast('Pause or Clear before restarting.');
    return;
  }
  if (!state.originPathPx.length) {
    toast('Nothing to restart from yet.');
    return;
  }
  state.pathPx = clonePath(state.originPathPx);
  state.promoted = false;
  state.pass = 1;
  state.stoppedBy = null;
  state.session = null;
  state.result = null;
  state.resultPromoted = false;
  state.finished = true;
  startSlide();
}

/** Why the run ended — mirrors the three exits in slide.js step(). */
function stopReason(s) {
  if (
    s.iterations >= s.params.minLoops &&
    Number.isFinite(s.delta) &&
    s.delta < s.params.thresholdEpsilon
  ) {
    return 'score plateaued';
  }
  if (s.iterations >= s.params.maxLoops) return 'max loops';
  if (s.iterations === 0) return 'too few points';
  return 'stopped';
}

function finishSlide() {
  state.running = false;
  state.paused = false;
  state.result = finalize(state.session);
  state.resultPromoted = false;
  state.stoppedBy = stopReason(state.session);
  updateButtons();
}

function clearAll() {
  state.pathPx = [];
  state.originPathPx = [];
  state.promoted = false;
  state.pass = 1;
  state.resultPromoted = false;
  state.stoppedBy = null;
  state.session = null;
  state.result = null;
  state.running = false;
  state.paused = false;
  state.finished = false;
  updateButtons();
  requestRender();
}

function updateButtons() {
  const hasPath = state.pathPx.length >= 2;
  const busy = state.running;
  $('btn-slide').disabled = !hasPath || busy;
  $('btn-replay').disabled = state.originPathPx.length < 2 || busy;
  $('btn-pause').disabled = !busy;
  $('btn-step').disabled = !busy;
  // a promoted baseline is a converged result by definition, so it exports too
  $('btn-export').disabled =
    state.running ||
    !(state.result || (state.session && state.session.done) || state.promoted);
  $('btn-pause').textContent = state.paused ? '▶ Resume' : '❙❙ Pause';
}

function exportGeoJSON() {
  const result = state.result || (state.session && state.session.done && state.session.path);
  // fall back to the baseline so a promoted-then-nudged line still exports
  const path = result || pxToMetres(state.pathPx);
  if (!path || path.length < 4) return;

  const coords = [];
  for (let i = 0; i < path.length; i += 2) {
    const [lon, lat] = toWGS84(path[i], path[i + 1]);
    coords.push([+lon.toFixed(7), +lat.toFixed(7)]);
  }

  const params = readParams();
  const geojson = {
    type: 'Feature',
    properties: {
      source: `strava heatmap ${TILE.z}/${TILE.x}/${TILE.y}`,
      origin: result ? 'slid' : 'baseline',
      pass: state.pass,
      iterations: state.session ? state.session.iterations : null,
      score: state.session ? +state.session.score.toFixed(6) : null,
      points: coords.length / 2,
      parameters: params,
    },
    geometry: { type: 'LineString', coordinates: coords },
  };

  const blob = new Blob([JSON.stringify(geojson, null, 2)], {
    type: 'application/geo+json',
  });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'slide-result.geojson';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  toast(`exported ${coords.length} points as GeoJSON`);
}

/* ------------------------------------------------------------------ *
 * Drawing interaction — click to add a vertex, drag to move one
 * ------------------------------------------------------------------ */
let drag = null;
let lastClickAdded = false;

canvas.addEventListener('pointerdown', (e) => {
  if (!state.surface) return;
  lastClickAdded = false;
  const p = screenToImage(e.clientX, e.clientY);
  const index = hitVertex(p);
  drag = { index, x: e.clientX, y: e.clientY, moved: false, p };
  canvas.setPointerCapture(e.pointerId);
});

canvas.addEventListener('pointermove', (e) => {
  if (!drag) {
    canvas.style.cursor = state.surface ? 'crosshair' : 'default';
    return;
  }
  if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) > 3) drag.moved = true;

  if (drag.index >= 0 && drag.moved) {
    state.pathPx[drag.index] = clampToImage(screenToImage(e.clientX, e.clientY));
    syncOrigin();
    state.finished = false;
    state.session = null;
    state.result = null;
    state.running = false;
    updateButtons();
    requestRender();
  }
});

canvas.addEventListener('pointerup', (e) => {
  if (!drag) return;
  const wasClick = !drag.moved;
  const index = drag.index;
  drag = null;

  if (!wasClick || index >= 0) return; // dragging a vertex, or click on one

  const p = clampToImage(screenToImage(e.clientX, e.clientY));

  if (state.running) {
    toast('Pause or Clear before editing the path.');
    return;
  }

  if (state.finished) {
    toast('Path is finished — press Esc or "Clear" to start a new one.');
    return;
  }

  state.pathPx.push(p);
  lastClickAdded = true;
  syncOrigin();
  // editing invalidates any previous run
  state.session = null;
  state.result = null;
  state.running = false;
  updateButtons();
  requestRender();
});

canvas.addEventListener('dblclick', (e) => {
  e.preventDefault();
  if (lastClickAdded && state.pathPx.length > 2) state.pathPx.pop();
  lastClickAdded = false;
  syncOrigin();
  if (state.pathPx.length >= 2) {
    state.finished = true;
    toast('Finished — drag vertices to tweak, or hit Slide.');
    updateButtons();
    requestRender();
  }
});

canvas.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  undoVertex();
});

function undoVertex() {
  if (!state.pathPx.length) return;
  state.pathPx.pop();
  syncOrigin();
  state.finished = false;
  state.session = null;
  state.result = null;
  state.running = false;
  updateButtons();
  requestRender();
}

window.addEventListener('keydown', (e) => {
  const tag = document.activeElement && document.activeElement.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') return;

  if (e.key === 'Enter') {
    e.preventDefault();
    if (state.finished && state.pathPx.length >= 2 && !state.running) startSlide();
    else if (state.pathPx.length >= 2) {
      state.finished = true;
      toast('Finished — hit Slide.');
      requestRender();
    }
  } else if (e.key === 'Escape') {
    clearAll();
  } else if (e.key === 'Backspace') {
    e.preventDefault();
    undoVertex();
  }
});

function screenToImage(cx, cy) {
  const r = canvas.getBoundingClientRect();
  const sx = cx - r.left;
  const sy = cy - r.top;
  return [
    (sx - state.view.ox) / state.view.scale,
    (sy - state.view.oy) / state.view.scale,
  ];
}

function clampToImage(p) {
  return [Math.max(0, Math.min(IMG, p[0])), Math.max(0, Math.min(IMG, p[1]))];
}

/**
 * Which vertices get a draggable handle.
 *
 * A promoted result has ~20 points at ~7 px spacing, which would smear the
 * handles across the line. Keep both endpoints always, then greedily keep
 * interior points far enough apart to stay readable on screen (~14 px).
 * Dragging still mutates the real pathPx index, so geometry is unaffected —
 * only which points *have* a handle changes.
 */
function handleIndices() {
  const n = state.pathPx.length;
  if (!n) return [];
  if (n === 1) return [0];

  const minPx = 14 / (state.view.scale || 1);
  const out = [0];
  let lastX = state.pathPx[0][0];
  let lastY = state.pathPx[0][1];
  for (let i = 1; i < n - 1; i++) {
    const [x, y] = state.pathPx[i];
    if (Math.hypot(x - lastX, y - lastY) >= minPx) {
      out.push(i);
      lastX = x;
      lastY = y;
    }
  }
  out.push(n - 1);
  return out;
}

function hitVertex(p) {
  const tol = 9 / state.view.scale;
  const handles = handleIndices();
  for (let k = handles.length - 1; k >= 0; k--) {
    const i = handles[k];
    const v = state.pathPx[i];
    if (Math.hypot(v[0] - p[0], v[1] - p[1]) <= tol) return i;
  }
  return -1;
}

/* ------------------------------------------------------------------ *
 * Run loop — a slice of work per frame so it animates instead of blocking
 * ------------------------------------------------------------------ */
function schedule() {
  if (rafId === null) rafId = requestAnimationFrame(tick);
}
function requestRender() {
  state.dirty = true;
  schedule();
}

function tick() {
  rafId = null;

  if (state.running && !state.paused && state.session) {
    const budget = 12; // ms of refinement per frame
    const t0 = performance.now();
    while (!state.session.done && performance.now() - t0 < budget) {
      state.session.step();
    }
    if (state.session.done) finishSlide();
    state.dirty = true;
  }

  if (state.dirty) {
    render();
    updateStats();
    state.dirty = false;
  }

  if (state.running || state.dirty) schedule();
}

/* ------------------------------------------------------------------ *
 * Rendering
 * ------------------------------------------------------------------ */
function resize() {
  const dpr = window.devicePixelRatio || 1;
  const w = stage.clientWidth;
  const h = stage.clientHeight;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    state.dirty = true;
  }
}
new ResizeObserver(() => {
  resize();
  requestRender();
}).observe(stage);

function render() {
  resize();
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.width / dpr;
  const h = canvas.height / dpr;

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#050505';
  ctx.fillRect(0, 0, w, h);

  if (!state.srcCanvas) {
    ctx.fillStyle = '#666';
    ctx.font = '13px system-ui, sans-serif';
    ctx.fillText('loading tile…', 16, 24);
    return;
  }

  const scale = Math.min(w / IMG, h / IMG);
  if (!(scale > 0)) return; // stage not laid out yet
  const ox = (w - IMG * scale) / 2;
  const oy = (h - IMG * scale) / 2;
  state.view = { scale, ox, oy };

  // heatmap
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(state.srcCanvas, ox, oy, IMG * scale, IMG * scale);

  // smoothed-surface debug overlay
  if (opts.showSmoothed) {
    if (state.overlayDirty) buildOverlay();
    if (state.overlayCanvas) {
      ctx.imageSmoothingEnabled = true;
      ctx.globalAlpha = 0.5;
      ctx.drawImage(state.overlayCanvas, ox, oy, IMG * scale, IMG * scale);
      ctx.globalAlpha = 1;
      ctx.imageSmoothingEnabled = false;
    }
  }

  // work in image-pixel coordinates from here on
  ctx.setTransform(dpr * scale, 0, 0, dpr * scale, dpr * ox, dpr * oy);
  const inv = 1 / scale; // keep stroke widths constant on screen
  const toPx = (m) => m / CELL;

  // intermediate ghosts
  if (opts.showGhosts && state.session) {
    ctx.lineWidth = 1.2 * inv;
    ctx.strokeStyle = 'rgba(255, 69, 58, 0.13)';
    for (const ghost of state.session.ghosts) {
      strokePolyline(ghost, toPx);
    }
  }

  // the path as drawn
  if (state.pathPx.length) {
    ctx.lineWidth = 3 * inv;
    ctx.strokeStyle = '#ff453a';
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    strokePolylineArr(state.pathPx);
  }

  // the slided path
  const live = currentPathM();
  if (live && live.length >= 4) {
    ctx.lineWidth = 3.5 * inv;
    ctx.strokeStyle = '#32d74b';
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    strokePolyline(live, toPx);
  }

  // vertex handles (thinned — see handleIndices)
  ctx.lineWidth = 1.5 * inv;
  const handles = handleIndices();
  for (const i of handles) {
    const [x, y] = state.pathPx[i];
    const r = 4.5 * inv;
    const isEnd = i === 0 || i === state.pathPx.length - 1;
    ctx.fillStyle = isEnd ? '#0a84ff' : '#f2f2f7';
    ctx.strokeStyle = 'rgba(0,0,0,0.85)';
    if (isEnd) {
      ctx.fillRect(x - r, y - r, r * 2, r * 2);
      ctx.strokeRect(x - r, y - r, r * 2, r * 2);
    } else {
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
  }

  drawLegend(w, h);
}

/** Draw a Float64Array path already expressed in metres. */
function strokePolyline(pts, toPx) {
  ctx.beginPath();
  for (let i = 0; i < pts.length; i += 2) {
    const x = toPx(pts[i]);
    const y = toPx(pts[i + 1]);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
}

/** Draw the on-canvas vertex list (already image pixels). */
function strokePolylineArr(pts) {
  ctx.beginPath();
  for (let i = 0; i < pts.length; i++) {
    if (i === 0) ctx.moveTo(pts[i][0], pts[i][1]);
    else ctx.lineTo(pts[i][0], pts[i][1]);
  }
  ctx.stroke();
}

function drawLegend(w, h) {
  const items = [
    ['#ff453a', 'drawn path'],
    ['#32d74b', state.session && !state.session.done ? 'sliding…' : 'slid result'],
    ['#0a84ff', 'fixed endpoints'],
  ];
  if (opts.showGhosts && state.session) items.push(['#ff453a', 'intermediate steps']);

  const dpr = window.devicePixelRatio || 1;
  ctx.save();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.font = '12px system-ui, sans-serif';
  ctx.textBaseline = 'middle';
  let y = h - 22;
  for (const [color, label] of items) {
    ctx.fillStyle = color;
    ctx.fillRect(16, y - 4, 14, 8);
    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    ctx.fillText(label, 36, y);
    y -= 16;
  }
  ctx.restore();
}

function currentPathM() {
  if (state.result) return state.result;
  if (state.session) return state.session.done ? null : state.session.path;
  return null;
}

/* ------------------------------------------------------------------ *
 * Smoothed-surface overlay (quarter resolution, lazily built)
 * ------------------------------------------------------------------ */
function buildOverlay() {
  const size = 256;
  const step = IMG / size;
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const cctx = c.getContext('2d');
  const id = cctx.createImageData(size, size);

  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const mx = (i + 0.5) * step * CELL;
      const my = (j + 0.5) * step * CELL;
      const v = Math.max(0, Math.min(1, state.smooth.valueAt(mx, my)));
      const o = (j * size + i) * 4;
      id.data[o] = 255;
      id.data[o + 1] = 150;
      id.data[o + 2] = 20;
      id.data[o + 3] = Math.round(220 * v);
    }
  }
  cctx.putImageData(id, 0, 0);
  state.overlayCanvas = c;
  state.overlayDirty = false;
}

/* ------------------------------------------------------------------ *
 * Status / stats
 * ------------------------------------------------------------------ */
function status(msg) {
  document.getElementById('status').textContent = msg;
}
function toast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => toastEl.classList.remove('show'), 2600);
}

function updateStats() {
  const s = state.session;
  const set = (id, v) => {
    const el = document.getElementById(id);
    if (el.textContent !== v) el.textContent = v;
  };

  set('st-input', String(state.pathPx.length));
  set('st-pass', state.pass > 1 ? `${state.pass} (chained)` : '1');
  set('st-stopped', state.stoppedBy || '—');
  set('st-resampled', s ? String(s.prepared.length / 2) : '—');
  set(
    'st-loops',
    s ? `${s.iterations} / ${s.params.maxLoops}` : '—'
  );
  set('st-score', s ? s.score.toFixed(5) : '—');
  set(
    'st-delta',
    s && Number.isFinite(s.delta)
      ? `${s.delta.toExponential(2)} (limit ${s.params.thresholdEpsilon})`
      : '—'
  );
  set('st-output', state.result ? String(state.result.length / 2) : '—');
  set('st-runtime', s ? `${Math.round(s.runtime)} ms` : '—');
}
