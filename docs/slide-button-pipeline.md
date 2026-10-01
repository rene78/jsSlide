# What happens when you click **Slide**

A step-by-step trace of the whole pipeline, from the click event to the green
line on the canvas. Every step names the file and function it lives in, so you
can follow along in the source.

```
click
  └─ startSlide()                        src/main.js
       ├─ promote a finished result?     (chaining)
       ├─ px → metres                    pxToMetres()
       └─ createSession()                src/slide.js
            ├─ preparePath()  → resampleEven()      src/geometry.js
            └─ returns a resumable session
                 └─ tick() loop (rAF, 12 ms/frame)  src/main.js
                      └─ session.step()  ×N         src/slide.js
                           ├─ gradient + distance + angle + momentum
                           ├─ score the line on the raw surface
                           └─ stop when the score plateaus
                                └─ finishSlide()
                                     └─ finalize()  src/slide.js
                                          ├─ trimEnds()       (optional)
                                          └─ douglasPeucker()
```

---

## 0. State before the click

The button is only live once `updateButtons()` (`src/main.js`) sees a drawable
path:

| condition | effect |
| --- | --- |
| `state.pathPx.length >= 2` | **Slide** enabled |
| `state.running` | **Slide** disabled, **Pause**/**Step** enabled |
| `state.originPathPx.length >= 2` | **↺ Restart** enabled |
| a result / finished session / promoted baseline exists | **Export GeoJSON** enabled |

`state.pathPx` is the path in **image pixels** — `[[x₀,y₀], [x₁,y₁], …]` where
the coordinates are positions inside the 1024×1024 tile, *not* screen
coordinates (those were already mapped through `screenToImage()` when you
clicked).

Before anything moves, the two rasters are already built (on tile load):

* `state.surface` — the `Surface`: one value per pixel,
  `colorValue(r,g,b) = max(r,g,b)/255`, i.e. how bright the heatmap is.
* `state.smooth` — the `SmoothSurface`: the same raster convolved with a
  sharpened Gaussian kernel, computed lazily and cached per cell.

---

## 1. The click handler

```js
$('btn-slide').addEventListener('click', startSlide);   // src/main.js:194
```

`startSlide()` (`src/main.js:258`) is the whole entry point:

1. **Guard** — needs a loaded surface and ≥ 2 points, otherwise a toast:
   *"Click at least two points onto the map first."*
2. **Promote** — if the previous run finished and hasn't been adopted yet, do
   that first (see §2).
3. **Convert** — `pxToMetres(state.pathPx)`.
4. **Create the session** — `createSession(surface, smooth, metres, params)`.
5. **Flip the UI state** — `running = true`, `paused = false`, clear
   `result`/`stoppedBy`, `updateButtons()`, `requestRender()`.

No work happens yet: `createSession()` only *prepares* the path. The iteration
starts on the next animation frame.

---

## 2. Chaining — adopting the previous result

```js
if (state.result && !state.resultPromoted) promoteResult();
```

If you press **Slide** after a run has finished, the converged result becomes
the new baseline instead of your drawing:

* `state.pathPx = metresToPx(state.result)` — back into image pixels
* `state.promoted = true`, `state.pass += 1`
* toast: *"Continuing from the previous result — pass N."*

Endpoints never move during a run, so the anchors survive promotion exactly.
**↺ Restart** throws the chain away and restores `state.originPathPx` (what you
originally drew).

Why this matters: a pass stops when the *average* score plateaus, so a minority
of beads can still lag off the trail. Re-running re-arms `minLoops` with
`delta` reset to `Infinity`, giving those beads a fresh 100-iteration budget.

---

## 3. Convert pixels to metres

```js
function pxToMetres(path) {
  out[2*i]   = path[i][0] * CELL;
  out[2*i+1] = path[i][1] * CELL;
}
```

Everything from here on runs in **Web-Mercator metres measured from the tile's
top-left corner** — never pixels, never degrees.

```
CELL = EARTH_C / (N * IMG)
     = (2π · 6378137) / (2¹⁴ · 1024)
     = 2.388657 m per image pixel
```

So a 1024 px tile spans ≈ 2446 m. `y` still grows **downwards** (image order);
the engine stays self-consistent because gradients are computed and consumed in
the same space.

The result is a flat `Float64Array` — `[x₀, y₀, x₁, y₁, …]` — which is the
representation all of `src/geometry.js` and `src/slide.js` work on.

Two unit systems coexist, and the difference is the **Mercator scale**:

```
mercatorScale = 1 / cos(φ_tile_centre) = 1.001733
```

Mercator metres are stretched relative to ground metres by that factor, so
every parameter the user states in *ground* metres gets multiplied by it — the
resample interval, the trim radius, the simplify tolerance. This mirrors Go's
haversine distances.

---

## 4. `createSession()` — prepare the path

`src/slide.js:68`

### 4.1 Merge parameters

`{ ...DEFAULTS, ...params }`, where `params` is the sidebar (`readParams()`)
with `mercatorScale` overridden to the tile's real value.

| parameter | default | unit | meaning |
| --- | --- | --- | --- |
| `smoothingStdDev` | 16 | m | σ of the Gaussian the *gradient* sees |
| `gradientScale` | 0.5 | – | weight of the uphill force |
| `distanceScale` | 0.2 | – | weight of the even-spacing force |
| `angleScale` | 0.1 | – | weight of the anti-kink force |
| `momentumScale` | 0.7 | – | fraction of the previous correction reused |
| `resampleInterval` | 5 | m | bead spacing |
| `minLoops` | 100 | – | don't stop before this many iterations |
| `maxLoops` | 4000 | – | hard stop |
| `thresholdEpsilon` | 0.0005 | – | score delta that counts as "plateaued" |
| `scoreSmoothing` | 0.2 | – | EMA factor for the score |
| `trimRadius` | 0 | m | 0 = trimming off (Go ships 15) |
| `simplifyTolerance` | 1 | m | Douglas–Peucker threshold |
| `gradientPerCell` | true | – | see below |

### 4.2 `preparePath()` → **resample the line**

```js
const total     = pathDistance(ptsMeters);              // polyline length, m
const interval  = params.resampleInterval * mercatorScale;   // 5 × 1.001733 = 5.009 m
const count     = Math.max(1, Math.ceil(total / interval));
return resampleEven(ptsMeters, count + 3);
```

* `pathDistance()` sums the Euclidean length of every segment.
* The interval is bumped from ground metres to mercator metres.
* Point count is `ceil(total / interval) + 3` (the `+3` mirrors Go's
  `Slide.Do()`), then **`resampleEven()`** (`src/geometry.js:32`) walks along
  the cumulative segment lengths and emits points at exactly
  `total / (N−1)` spacing:

  * **first and last points are preserved bit-exactly** — this is why the
    anchors never drift;
  * interior vertices are *interpolated between* your drawn vertices, so a
    400 m path drawn as 6 clicks becomes ~83 evenly spaced beads;
  * zero-length segments are guarded against (they'd produce `0/0 → NaN`).

  The whole "string of beads" idea starts here: the algorithm assumes uniform
  spacing, because the distance term's job is only to *maintain* it.

### 4.3 Allocate the working buffers

* `corrections` — `Float64Array(n*2)`, the momentum history (previous
  correction per vertex).
* `cur` — a *copy* of the prepared path (it must not alias `prepared`, or the
  rotation below would clobber the reference result).
* `scratch` — the buffer written each iteration; `cur` and `scratch` swap every
  step (ping-pong, no allocation inside the hot loop).
* **Ghosts** — intermediate snapshots for the replay animation. Most movement
  happens in the first iterations, so the first `min(30, ghostCount/4)` = 30
  snapshots are captured densely, then one every
  `floor((maxLoops − 30) / (ghostCount − 30))` = 23 iterations, up to
  `ghostCount` = 200 total.

If the path has fewer than 3 points, `session.done = true` immediately — there
are no interior vertices to move.

---

## 5. The run loop

`src/main.js:576` — `tick()`, driven by `requestAnimationFrame`:

```js
const budget = 12; // ms of refinement per frame
while (!state.session.done && performance.now() - t0 < budget) {
  state.session.step();
}
if (state.session.done) finishSlide();
```

The engine is **resumable**: `createSession()` returns an object with a `step()`
method rather than blocking. That buys three things for free:

* the UI animates instead of freezing the tab;
* **Pause** / **Step** are just "don't call `step()`" / "call it once";
* the ghost trail can be recorded as it goes.

Each frame: run up to 12 ms of iterations → `render()` → `updateStats()` →
schedule the next frame while `running`.

---

## 6. One iteration — `session.step()`

`src/slide.js:108`. For every **interior** vertex `i = 1 … n−2`, accumulate a
correction `(cx, cy)` from four terms, then apply it. Endpoints are never
touched.

### 6.1 Gradient — slide uphill on the *smoothed* surface

```js
const g = smooth.gradientAt(px, py);           // value per mercator metre
const k = p.gradientPerCell ? p.gradientScale * surface.cell : p.gradientScale;
cx += g[0] * k;  cy += g[1] * k;
```

* `SmoothSurface.gradientAt()` (`src/surface.js:185`) bilinearly interpolates
  the difference of the four surrounding **smoothed** cells, divided by `cell`.
* The smoothed field is a separable Gaussian applied lazily with two caches
  (`verticalValue` → `smoothedGrid`), so only touched cells are ever computed.
* The kernel (`buildKernel`) is a Gaussian with a **linear cusp inside one
  σ** — a sharpened peak, per `slide/utils.Kernel`. At the default 16 m σ on a
  2.39 m/px tile that's σ ≈ 6.7 px → a 49-tap kernel.

**Why smoothed for the gradient but raw for the score?** The gradient needs a
stable, wide basin to follow; the raw raster is speckly and would trap beads in
single bright pixels. The score is the honest measure of how bright the line
actually sits.

**`gradientPerCell` (the one deliberate deviation from Go):** Go's step is
`gradientScale × dV/d(metre)`, which only behaves when a cell is ~1 m (their
Strava surface was ~1.2 m/px). The realised movement is `0.5·dV/dcell ÷ cell²`
cells per iteration — it falls off with the **square** of cell size, and on our
2.39 m/px tile would creep ~5.7× too slowly to converge inside `maxLoops`.
Multiplying by `cell` instead gives `0.5·dV/dcell` cells per iteration:
size-independent, and equivalent to Go on ~1 m cells. Default **on**, toggle in
the sidebar.

### 6.2 Distance — keep the beads evenly spaced

```js
// centre = projection of this vertex onto the line prev → next
const t = (ux*vx + uy*vy) / dot;
cx += (m1x + m2x) * p.distanceScale;
```

The vertex is projected onto the chord `prev → next`, and the two offsets
(prev − centre) and (next − centre) are summed and scaled by `0.2`. The effect
is a spring that pulls the vertex toward the *midpoint* of its neighbours —
uniform bead spacing along the line, and a gentle straightening force (a sagging
vertex has its neighbours' midpoint on the far side of the chord).

### 6.3 Angle — penalise kinks

```js
const factor = Math.cbrt(n1x*n2x + n1y*n2y) + 1;   // unit vectors from the vertex
const mag = Math.min(len1, len2) * p.angleScale * factor;
```

Both legs are normalised (pointing *away* from the vertex). For a perfectly
straight line they are anti-parallel: `dot = −1 → cbrt = −1 → factor = 0`, i.e.
**no force**. Any kink raises `dot` above `−1`, so `factor > 0` and the vertex
is pushed along the normalised sum of the two legs — the bisector, away from the
corner — with a magnitude proportional to the shorter leg. Net effect: the line
resists folding back on itself.

### 6.4 Momentum

```js
cx += corrections[2*i] * p.momentumScale;   // 0.7 × the previous correction
```

70 % of the last correction is carried over, which speeds up convergence —
essentially a heavy-ball integrator over the force field.

### 6.5 Optional depth-based reduction (off by default)

If `depthBasedReduction` is on, the whole correction is damped by
`sqrt(1 − v)` where `v` is the raw surface value — beads already sitting in a
valley move less, so they don't jitter out of it.

### 6.6 Apply, swap, record

```js
corrections[2*i] = cx;                 // remember for momentum
scratch[2*i] = px + cx;                // write the new position
// …
scratch[0] = cur[0];  scratch[1] = cur[1];                    // endpoints pinned
scratch[2*(n-1)] = cur[2*(n-1)];  scratch[2*(n-1)+1] = cur[2*(n-1)+1];

const tmp = cur; cur = scratch; scratch = tmp;                // ping-pong swap
```

`session.iterations++`, and — if the ghost schedule says so — `cur.slice()` is
pushed onto `session.ghosts`.

---

## 7. Scoring and the stopping rule

Still inside `step()`:

```js
// score = average *unsmoothed* surface value along the line
let sum = 0;
for (let i = 0; i < n; i++) sum += surface.valueAt(cur[2*i], cur[2*i+1]);
const raw = sum / n;

session.smoothScore = 0.2 * previous + 0.8 * raw;   // scoreSmoothing EMA
session.delta       = Math.abs(session.smoothScore - previous);
```

* `surface.valueAt()` is a bilinear sample of the **raw** tile values; points
  outside the surface bounds score `0`, so a line wandering off the tile is
  punished.
* The raw score is fed through an exponential moving average (`scoreSmoothing
  = 0.2`) so one bead jumping across a bright pixel doesn't re-trigger the loop.

**Stop when:**

```js
if (session.iterations >= minLoops && session.delta < thresholdEpsilon) done = true;
else if (session.iterations >= maxLoops)                            done = true;
```

| exit | `Stopped by` in the sidebar |
| --- | --- |
| ≥ 100 iterations **and** delta < 0.0005 | `score plateaued` |
| 4000 iterations reached | `max loops` |
| path had < 3 points | `too few points` |

In practice a pass usually ends at `minLoops`, not `maxLoops`: the line is
already at a force equilibrium (gradient balanced by distance + angle), which is
exactly why chaining — not more iterations — is the way to straighten a remaining
sag.

---

## 8. `finishSlide()` → `finalize()` — trim and simplify

`src/main.js:318` / `src/slide.js:239`

```js
state.result   = finalize(state.session);
state.stoppedBy = stopReason(state.session);
```

`finalize()` runs the post-processing reducers, both with **ground metres ×
mercatorScale**:

### 8.1 Trim the ends — `trimRadius` (default 0 = off)

```js
out = resampleInterval(out, 2 * ms);   // re-space to ~2 m so the walk is uniform
out = trimEnds(out, trimRadius * ms);
```

`trimEnds()` (`src/geometry.js:160`) mirrors `slide/reducers.Trim`: the
**endpoint itself always survives**, and everything between it and the first
point far enough away is dropped — from both ends — and the result is never
shorter than three points. It's off by default so the anchors are visibly
untouched (and because running it on every chained pass would progressively
straighten — then discard — the near-anchor section).

### 8.2 Simplify — **Douglas–Peucker** (default tolerance 1 m)

```js
out = douglasPeucker(out, params.simplifyTolerance * params.mercatorScale);
```

`douglasPeucker()` (`src/geometry.js:102`), an iterative (explicit-stack)
version identical in behaviour to go.geo's:

1. Seed the stack with the chord `(0, n−1)` — both endpoints are always kept.
2. Pop a `(start, end)` pair and find the interior point with the **maximum
   perpendicular distance** to the infinite line through start and end
   (squared distances throughout — no `sqrt` in the inner loop).
3. If that distance `> threshold²`, keep the point and push `(start, k)` and
   `(k, end)`.
4. Repeat until the stack is empty; emit only the masked points.

With the default 1 m tolerance (≈ 1.002 mercator m ≈ 0.42 px) the converged
path — resampled to ~5 m spacing, so hundreds of points on a long line — shrinks
to the few dozen vertices needed to describe the shape it settled into. This is
a big part of why the **Output points** count drops between *Resampled points*
and *Output points* in the sidebar.

`state.result` is now a `Float64Array` in mercator metres, and
`resultPromoted = false` — i.e. pressing **Slide** again will adopt it (§2).

---

## 9. Back in the UI

**Buttons** (`updateButtons()`): **Slide** re-enabled (and now acts as
"continue"), **Pause**/**Step** disabled, **Export GeoJSON** enabled,
**↺ Restart** enabled.

**Render** (`render()`): the green line comes from `currentPathM()`, which
returns `state.result` once the run has finished; while running it returns
`state.session.path`, so the line is redrawn live every frame. Drawn in image
pixels via `m / CELL`. The translucent red trails are `session.ghosts`.

**Stats** (`updateStats()`):

| sidebar row | source |
| --- | --- |
| Drawn points | `state.pathPx.length` |
| Pass | `state.pass` (marked *chained* if > 1) |
| Stopped by | `state.stoppedBy` |
| Resampled points | `session.prepared.length / 2` — **§4.2** |
| Iterations | `session.iterations / maxLoops` |
| Surface score | `session.score` — raw average, **§7** |
| Score delta | `session.delta` vs `thresholdEpsilon` |
| Output points | `state.result.length / 2` — **§8.2** |
| Runtime | `session.runtime` — ms actually spent inside `step()` |

---

## 10. Pressing **Slide** again

1. `promoteResult()` makes the green result the new red baseline, `pass → 2`.
2. The path is re-converted, **re-resampled** and re-simplified — a fresh
   session with `delta = Infinity` and a fresh `minLoops` budget.
3. It settles at a *different* local equilibrium (this is a
   perturb-and-re-settle, not a guaranteed ascent — measured in
   `test/selftest.mjs` §6).

**↺ Restart** restores the original drawing and resets the pass counter.

---

## Quick reference

| stage | function | file |
| --- | --- | --- |
| click entry | `startSlide()` | `src/main.js:258` |
| px → m | `pxToMetres()` | `src/main.js:221` |
| session setup | `createSession()` | `src/slide.js:68` |
| resample | `preparePath()` → `resampleEven()` | `src/slide.js:54`, `src/geometry.js:32` |
| run loop | `tick()` | `src/main.js:576` |
| one iteration | `session.step()` | `src/slide.js:108` |
| gradient | `SmoothSurface.gradientAt()` | `src/surface.js:185` |
| score | `Surface.valueAt()` | `src/surface.js:89` |
| finish | `finishSlide()` → `stopReason()` | `src/main.js:318` |
| trim | `trimEnds()` | `src/geometry.js:160` |
| simplify | `douglasPeucker()` | `src/geometry.js:102` |
| promote (chain) | `promoteResult()` | `src/main.js:247` |
