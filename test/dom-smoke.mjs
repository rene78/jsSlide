/**
 * Headless smoke test of the actual UI module.
 *
 *   node test/dom-smoke.mjs
 *
 * No browser is available in this environment, so this stubs just enough
 * DOM/canvas to import src/main.js and then drive it the way a user would:
 * load the tile, click a path, drag a vertex, press Slide, wait for
 * convergence, export GeoJSON, use the keyboard.
 *
 * It catches typos, missing element ids, temporal-dead-zone mistakes and
 * crashes in render/tick — things a plain syntax check would miss.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const IMG = 1024;
const STAGE_W = 800;
const STAGE_H = 600;

// geometry of the synthetic fixture
const BAND_Y = 420; // bright horizontal band drawn into the fake tile
const PATH_Y = 414; // the drawn line starts 6 px above it
const PATH_X = [300, 400, 500, 600, 700];

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures++;
};

/* ---------------------------------------------------------------- elements */
const elements = new Map();
const downloads = [];
const drawOps = { stroke: 0, fill: 0, fillRect: 0, drawImage: 0, fillText: 0 };

class El {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.style = {};
    this.children = [];
    this.classList = { add() {}, remove() {}, toggle() {} };
    this.className = '';
    this.textContent = '';
    this.disabled = false;
    this.value = '';
    this.checked = false;
    this.width = 0;
    this.height = 0;
    this.clientWidth = STAGE_W;
    this.clientHeight = STAGE_H;
    this._listeners = new Map();
    this._innerHTML = '';
  }
  addEventListener(type, fn) {
    if (!this._listeners.has(type)) this._listeners.set(type, []);
    this._listeners.get(type).push(fn);
  }
  removeEventListener() {}
  dispatch(type, event = {}) {
    for (const fn of [...(this._listeners.get(type) || [])]) fn(event);
  }
  click() {
    if (this.download) downloads.push(this.download);
    this.dispatch('click', { target: this, preventDefault() {} });
  }
  appendChild(child) {
    this.children.push(child);
    return child;
  }
  querySelector(sel) {
    const tag = String(sel).toUpperCase();
    return this.children.find((c) => c.tagName === tag) || null;
  }
  set innerHTML(v) {
    this._innerHTML = String(v);
    if (this._innerHTML.includes('<input')) this.children.push(new El('input'));
  }
  get innerHTML() {
    return this._innerHTML;
  }
  setPointerCapture() {}
  focus() {}
  getBoundingClientRect() {
    return { left: 0, top: 0, right: this.clientWidth, bottom: this.clientHeight };
  }
  getContext() {
    return this._ctx || (this._ctx = makeCtx(this));
  }
}

function makeCtx(canvas) {
  const noop = () => {};
  return {
    canvas,
    save: noop,
    restore: noop,
    setTransform: noop,
    transform: noop,
    clearRect: noop,
    beginPath: noop,
    moveTo: noop,
    lineTo: noop,
    arc: noop,
    closePath: noop,
    stroke() {
      drawOps.stroke++;
    },
    fill() {
      drawOps.fill++;
    },
    fillRect() {
      drawOps.fillRect++;
    },
    strokeRect: noop,
    fillText() {
      drawOps.fillText++;
    },
    drawImage() {
      drawOps.drawImage++;
    },
    createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
    putImageData: noop,
    getImageData(x, y, w, h) {
      // synthetic heat map: a bright horizontal band, so a line drawn just
      // above it has a clean gradient to slide down into
      const data = new Uint8ClampedArray(w * h * 4);
      for (let j = 0; j < h; j++) {
        const v = Math.exp(-(((j - BAND_Y) / 4) ** 2));
        const g = Math.round(255 * v);
        for (let i = 0; i < w; i++) {
          const o = (j * w + i) * 4;
          data[o] = g;
          data[o + 1] = g;
          data[o + 2] = g;
          data[o + 3] = 255;
        }
      }
      return { data, width: w, height: h };
    },
  };
}

/* ------------------------------------------------------------ global stubs */
globalThis.document = {
  activeElement: { tagName: 'BODY' },
  getElementById(id) {
    if (!elements.has(id)) {
      const el = new El(id === 'canvas' ? 'canvas' : 'div');
      el.id = id;
      elements.set(id, el);
    }
    return elements.get(id);
  },
  createElement: (tag) => new El(tag),
};

globalThis.window = {
  devicePixelRatio: 1,
  addEventListener(type, fn) {
    if (!this._l) this._l = new Map();
    if (!this._l.has(type)) this._l.set(type, []);
    this._l.get(type).push(fn);
  },
  dispatch(type, event) {
    for (const fn of this._l?.get(type) || []) fn(event);
  },
};

class FakeImage {
  set src(v) {
    this._src = v;
    queueMicrotask(() => this.onload && this.onload());
  }
  get src() {
    return this._src;
  }
}
globalThis.Image = FakeImage;

globalThis.ResizeObserver = class {
  constructor(cb) {
    this.cb = cb;
  }
  observe() {}
  disconnect() {}
};

const rafQueue = [];
globalThis.requestAnimationFrame = (cb) => {
  rafQueue.push(cb);
  return rafQueue.length;
};
globalThis.cancelAnimationFrame = () => {};

// override unconditionally so we capture the payload Node's own stub would hide
let exportedBlob = null;
URL.createObjectURL = (blob) => {
  exportedBlob = blob;
  return 'blob:stub';
};
URL.revokeObjectURL = () => {};

const flushMicrotasks = () => new Promise((r) => setImmediate(r));
function frames(n) {
  for (let i = 0; i < n; i++) {
    const cbs = rafQueue.splice(0);
    if (!cbs.length) return;
    for (const cb of cbs) cb(performance.now());
  }
}

/* ------------------------------------------------------- markup cross-check */
// The getElementById stub below invents any id it is asked for, so it could
// never notice that index.html forgot to define one. Do that statically.
console.log('\n0. markup cross-check');
{
  const src = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const ids = new Set();
  for (const re of [/\$\('([A-Za-z0-9_-]+)'\)/g, /getElementById\('([A-Za-z0-9_-]+)'\)/g, /\bset\('([A-Za-z0-9_-]+)'/g]) {
    for (const m of src.matchAll(re)) ids.add(m[1]);
  }
  const missing = [...ids].filter((id) => !html.includes(`id="${id}"`));
  check('every id used by main.js exists in index.html', missing.length === 0,
    missing.length ? `missing: ${missing.join(', ')}` : `${ids.size} ids`);
}

/* ------------------------------------------------------------------ import */
console.log('\n1. load the app headlessly');
let importError = null;
try {
  await import(path.join(ROOT, 'src', 'main.js'));
} catch (e) {
  importError = e;
}
check('src/main.js imports without throwing', !importError, importError ? String(importError.stack) : '');
if (importError) {
  console.log(`\n${failures} CHECK(S) FAILED\n`);
  process.exit(1);
}

await flushMicrotasks(); // Image.onload fires here
frames(4);

const canvas = document.getElementById('canvas');
check(
  'tile loaded',
  document.getElementById('status').textContent.includes('m/px'),
  document.getElementById('status').textContent
);
check('the map was drawn', drawOps.drawImage > 0, `${drawOps.drawImage} drawImage`);
check(
  'canvas sized from the stage',
  canvas.width === STAGE_W && canvas.height === STAGE_H,
  `${canvas.width}x${canvas.height}`
);

/* ------------------------------------------------------------- draw a path */
console.log('\n2. click a path onto the map');
const scale = Math.min(STAGE_W / IMG, STAGE_H / IMG);
const ox = (STAGE_W - IMG * scale) / 2;
const oy = (STAGE_H - IMG * scale) / 2;
const toClient = (x, y) => ({ clientX: ox + x * scale, clientY: oy + y * scale, pointerId: 1 });

const click = (x, y) => {
  const e = toClient(x, y);
  canvas.dispatch('pointerdown', e);
  canvas.dispatch('pointerup', e);
};

for (const x of PATH_X) click(x, PATH_Y);
frames(2);

check(
  'vertices registered',
  document.getElementById('st-input').textContent === String(PATH_X.length),
  `drawn points = ${document.getElementById('st-input').textContent}`
);
check('slide button enabled', document.getElementById('btn-slide').disabled === false);

// drag the middle vertex away and back — must not add or lose points
{
  canvas.dispatch('pointerdown', toClient(500, PATH_Y));
  canvas.dispatch('pointermove', toClient(504, PATH_Y + 6));
  canvas.dispatch('pointermove', toClient(500, PATH_Y));
  canvas.dispatch('pointerup', toClient(500, PATH_Y));
  frames(2);
  check(
    'dragging a vertex keeps the point count',
    document.getElementById('st-input').textContent === String(PATH_X.length)
  );
}

/* ------------------------------------------------------------------ slide */
console.log('\n3. run Slide');

// exercise the parameter panel (smoothing SD) and a debug toggle
const paramsEl = document.getElementById('params');
const sdInput = paramsEl.children[0].querySelector('input');
sdInput.value = '20';
sdInput.dispatch('input');
check('parameter panel is wired', sdInput.value === '20');

const togglesEl = document.getElementById('toggles');
const smoothToggle = togglesEl.children[togglesEl.children.length - 1].querySelector('input');
const drawsBefore = drawOps.drawImage;
smoothToggle.checked = true;
smoothToggle.dispatch('change');
frames(2);
check('smoothed-surface overlay builds', drawOps.drawImage > drawsBefore,
  `${drawsBefore} -> ${drawOps.drawImage}`);

document.getElementById('btn-slide').click();
check('run started (slide disabled)', document.getElementById('btn-slide').disabled === true);

for (let i = 0; i < 600 && document.getElementById('btn-export').disabled; i++) frames(1);
frames(3);

check('run converged', document.getElementById('btn-export').disabled === false);
const loops = document.getElementById('st-loops').textContent;
const score = document.getElementById('st-score').textContent;
check('stats populated', loops.includes('/') && score !== '—', `loops ${loops}, score ${score}`);
check('some geometry was stroked', drawOps.stroke > 0, `${drawOps.stroke} strokes`);

/* ----------------------------------------------------------------- export */
console.log('\n4. export GeoJSON');
document.getElementById('btn-export').click();
check('a download was triggered', downloads.includes('slide-result.geojson'), JSON.stringify(downloads));
check('a blob was produced', !!exportedBlob);

if (exportedBlob) {
  const geo = JSON.parse(await exportedBlob.text());
  check('valid LineString', geo.type === 'Feature' && geo.geometry.type === 'LineString');
  const coords = geo.geometry.coordinates;
  check('has coordinates', coords.length >= 2, `${coords.length} points`);

  // invert the georeferencing back to image pixels
  const R = 6378137;
  const C = 2 * Math.PI * R;
  const N = 2 ** 14;
  const ORIGIN_X = (12812 / N) * C - C / 2;
  const ORIGIN_Y = C / 2 - (8038 / N) * C;
  const CELL = C / (N * IMG);
  const xs = [];
  const ys = [];
  for (const [lon, lat] of coords) {
    xs.push(((lon * Math.PI) / 180 * R - ORIGIN_X) / CELL);
    const Y = R * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
    ys.push((ORIGIN_Y - Y) / CELL);
  }
  const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
  const meanX = mean(xs);
  const meanY = mean(ys);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);

  console.log(
    `        exported line: mean x=${meanX.toFixed(1)}, y=${meanY.toFixed(1)} px ` +
    `(y range ${minY.toFixed(1)}..${maxY.toFixed(1)})`
  );
  check('endpoints stayed put in x', Math.abs(meanX - 500) < 5, `${meanX.toFixed(1)} px`);
  check('line slid down onto the band (y -> 420)', meanY > PATH_Y + 2 && meanY < BAND_Y + 2,
    `${PATH_Y} -> ${meanY.toFixed(1)} px`);
  check('no vertex overshot past the band', maxY < BAND_Y + 4, `max y ${maxY.toFixed(1)}`);
}

/* ----------------------------------------------------------------- chaining */
console.log('\n5. chaining (re-slide from the finished result)');

const pass1 = document.getElementById('st-pass').textContent;
const stop1 = document.getElementById('st-stopped').textContent;
const input1 = document.getElementById('st-input').textContent;
const output1 = document.getElementById('st-output').textContent;
const score1 = parseFloat(document.getElementById('st-score').textContent);

check('first run is pass 1', pass1 === '1', pass1);
check('stopped-by is reported', stop1 !== '—', stop1);
check('drawn points still hold the original line', input1 === '5', input1);

document.getElementById('btn-slide').click(); // promotes, then runs pass 2
frames(2);
check('Slide re-arms as pass 2', document.getElementById('st-pass').textContent.startsWith('2'),
  document.getElementById('st-pass').textContent);

for (let i = 0; i < 600 && document.getElementById('btn-export').disabled; i++) frames(1);
frames(3);

const pass2 = document.getElementById('st-pass').textContent;
const score2 = parseFloat(document.getElementById('st-score').textContent);
const input2 = document.getElementById('st-input').textContent;
const output2 = document.getElementById('st-output').textContent;

check('pass counter chained', pass2.startsWith('2'), pass2);
check('baseline replaced by the slid geometry', input2 === output1,
  `input ${input2} vs previous output ${output1}`);
check('pass 2 produced a new result', output2 !== '—' && !Number.isNaN(+output2),
  `output ${output2}`);
check('chained score holds up', score2 >= score1 - 0.005,
  `${score1.toFixed(5)} -> ${score2.toFixed(5)}`);

document.getElementById('btn-export').click();
if (exportedBlob) {
  const geo = JSON.parse(await exportedBlob.text());
  check('chained export is tagged as slid',
    geo.properties.origin === 'slid' && geo.properties.pass === 2,
    `origin=${geo.properties.origin} pass=${geo.properties.pass}`);
}

document.getElementById('btn-replay').click(); // restart from the drawing
for (let i = 0; i < 600 && document.getElementById('btn-export').disabled; i++) frames(1);
frames(3);

check('Restart restores the line as drawn',
  document.getElementById('st-input').textContent === input1,
  document.getElementById('st-input').textContent);
check('Restart resets the pass counter',
  document.getElementById('st-pass').textContent === '1',
  document.getElementById('st-pass').textContent);
check('Restart reproduces the first result',
  document.getElementById('st-output').textContent === output1,
  document.getElementById('st-output').textContent);

/* --------------------------------------------------------------- keyboard */
console.log('\n6. keyboard');
window.dispatch('keydown', { key: 'Escape', preventDefault() {} });
frames(2);
check('Escape clears the path', document.getElementById('st-input').textContent === '0');

click(100, 100);
click(200, 200);
window.dispatch('keydown', { key: 'Enter', preventDefault() {} });
frames(2);
check('Enter finishes the path', document.getElementById('toast').textContent.includes('Finished'));

click(300, 300);
check(
  'clicking a finished path does not add to it',
  document.getElementById('st-input').textContent === '2',
  document.getElementById('toast').textContent
);

window.dispatch('keydown', { key: 'Backspace', preventDefault() {} });
frames(2);
check('Backspace undoes a vertex', document.getElementById('st-input').textContent === '1');

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n`);
process.exit(failures === 0 ? 0 : 1);
