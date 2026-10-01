# Slide — vector→raster map conflation, in vanilla JS

A browser test bench for [paulmach/slide](https://github.com/paulmach/slide), ported
from Go to dependency-free ES modules. Draw a rough polyline over a Strava heatmap
tile, press **Slide**, and watch the line snap onto the nearest bright trail.

This is Phase 1: prove the algorithm works and feels right in a canvas. Phase 2 is
folding it into the [iD editor](https://github.com/osm-editors/iD) behind a revived
`iD.actions.Slide`, fed by tiles from
[julcnx/strava-heatmap-extension](https://github.com/julcnx/strava-heatmap-extension).

## Run it

```sh
python3 -m http.server 8080
# → http://localhost:8080/
```

It must be served over HTTP(S) — `getImageData()` taints the canvas under `file://`.

## Test it

```sh
node test/run-all.mjs     # everything
```

| file | what it covers |
| --- | --- |
| `test/selftest.mjs` | geometry primitives, surface gradients, slide on a synthetic trail *and* on the real tile, georeferencing. Offline. |
| `test/dom-smoke.mjs` | imports the real `src/main.js` against a stubbed DOM and drives it like a user: load → draw → drag → slide → export → keyboard. Offline. |
| `test/overlay.mjs` | rasterises OSM roads over the heatmap under two competing tile scales and scores which one aligns. Uses Overpass (cached in `test/out/osm-tile.json`). |

No Go, no npm, no build step. Node 22 is enough (ESM is auto-detected from the
`.mjs` extension in `test/`, and `src/*.js` is loaded as modules by the browser).

## The tile scale, and how it was settled

`8038@2x.png` is 1024×1024 and named after the y-index of a **z14** tile
(`14/12812/8038`). Two readings were possible:

* **A** — one z14 tile rendered at 1024 px → `2.388657 m/px`
* **B** — a 2×2 block of z14 tiles squeezed into 1024 px → `4.777314 m/px`

`test/overlay.mjs` breaks the tie. It rasterises every OSM highway in the tile under
each hypothesis and reports how bright the heatmap is underneath those pixels:

```
roads-on-heatmap brightness (baseline, i.e. random pixels, = 0.0688)
  A one z14 tile : 0.4553 over 20720 px
  B 2x2 z14 tiles: 0.0807 over 10407 px
  => hypothesis A wins: the PNG is exactly one z14 tile.
```

Roads land on trails **6.6×** brighter than random under A, and are indistinguishable
from random under B. So:

```js
const CELL = EARTH_C / (N * IMG);   // world / (tiles across × pixels across) = 2.388657 m/px
```

The image spans lat 3.359889–3.381824, lon 101.513672–101.535645, i.e. exactly one
z14 tile.

## Coordinates

The algorithm runs in **Web-Mercator metres**, never in pixels or degrees:

```
canvas pixel p  →  surface metres  p * CELL
grid index  i   →  surface metres  (i + 0.5) * CELL     (pixel centres)
surface bounds  [0.5*CELL, (1023.5)*CELL]²
```

Because `gridBox = cellM`, grid index *i* is exactly pixel *i*, so the smoothed
surface's grid and the tile's pixels are the same lattice with no rounding drift.

Ground metres are distinguished from mercator metres by `mercatorScale = 1/cos(φ)`
at the tile's centre latitude (1.001733); the resample interval, trim radius and
simplify tolerance are all scaled by it, matching Go's haversine distances.

Exporting to GeoJSON inverts it:

```
lon = (ORIGIN_X + mx) / R * 180/π
lat = (2·atan(exp((ORIGIN_Y − my)/R)) − π/2) * 180/π
```

## The algorithm

> Full click-by-click walkthrough — px→metres, resampling, the four force terms,
> the stopping rule, trim and Douglas–Peucker: **[docs/slide-button-pipeline.md](docs/slide-button-pipeline.md)**

Each iteration moves every *interior* vertex by a weighted sum:

| term | default | what it does |
| --- | --- | --- |
| gradient | `0.5` | slides the vertex uphill on the **smoothed** surface |
| distance | `0.2` | keeps neighbouring beads evenly spaced along the line |
| angle | `0.1` | penalises sharp kinks |
| momentum | `0.7` | adds 70 % of the previous correction, for acceleration |

Endpoints are pinned. Stopping rule: the exponentially smoothed average of the
**unsmoothed** surface value changes by less than `thresholdEpsilon` (0.0005), after
at least `minLoops` (100) and before `maxLoops` (4000).

The score deliberately uses the *unsmoothed* surface — it is the honest measure of
"how bright is the line actually sitting" — while gradients use the smoothed one, so
they are stable enough to follow.

`createSession()` returns a resumable session rather than a blocking loop. The UI
runs it for ~12 ms per `requestAnimationFrame`, so Pause / Step / the ghost replay
animation / re-sliding from a finished result all come for free.

### `gradientPerCell`

The one place this port deliberately deviates. Go's step is
`gradientScale × dV/d(metre)`, which assumes a cell is roughly a metre (their Strava
surface was ~1.2 m/px). The resulting movement is `0.5·dV/dcell ÷ cell²` cells per
iteration — it falls off with the **square** of cell size. On our 2.39 m/px tile the
literal version would creep 5.7× too slowly to converge inside `maxLoops`.

Multiplying by `cell` gives `0.5·dV/dcell` cells per iteration instead: independent of
our cell size, and equivalent to Go on ~1 m cells. The toggle in the sidebar switches
between the two.

### Differences from Go

* `trimRadius` defaults to **0** (Go ships 15 m) so endpoints are visibly untouched;
  the checkbox-free numeric field turns it on. `trimEnds` reproduces
  `reducers.Trim`'s fixed-anchor semantics: the endpoint always survives, everything
  up to the first point far enough away is dropped, and the result is never shorter
  than three points.
* The line is stored as `Float64Array`s rather than go.geo's `Path`, and Douglas–Peucker
  runs at the end (on the converged path) instead of inside every step.

## Using it

| input | action |
| --- | --- |
| click | append a vertex |
| drag | move a vertex (invalidates any finished run) |
| double-click / `Enter` | finish the line |
| `Backspace` / right-click | undo the last vertex |
| `Esc` | clear |

**Slide** runs, **Pause** freezes it, **Step** advances one iteration,
**↺ Restart** throws the chain away and goes back to the line as drawn. Toggles:
`gradientPerCell`, ghost trails, and a quarter-resolution view of the smoothed
surface the gradient actually sees.

Editing — click, drag, undo — always applies to the *current* baseline: the
drawing before the first result is promoted, the slid result after it. It
invalidates the finished run either way.

**Export GeoJSON** downloads the converged line as a WGS84 `LineString` whose
`source` property records the tile it was conflated against, whose `origin` says
whether it is a fresh result (`slid`) or the current baseline (`baseline`), and
whose `pass` records which chained pass produced it.

### Iterative refinement (chaining)

A pass stops when the *average* surface score stops improving. That score is a
mean over every bead on the line, so once most of them sit on a bright trace the
delta drops below the threshold while a minority still lags — a line that has
clearly converged overall but still sags off the trail in places.

**Slide** is therefore also the continue button: when a finished result has not
been promoted yet, pressing it adopts that result as the new baseline and runs
again. Each pass re-arms `minLoops` with `delta` reset to `Infinity`, so a
lagging section gets a fresh 100-iteration budget no matter how flat the overall
score already looks. **↺ Restart** restores what you drew and resets the pass
counter; the original drawing is kept for the whole session, so both are one
click away.

Everything below is measured by `test/selftest.mjs` §6:

* **It is a perturb-and-re-settle, not a guaranteed ascent.** Every pass
  re-resamples and re-simplifies, so it settles at a *different* local
  equilibrium. Six passes on the real tile gave a mean distance to the traced
  trail of 3.11 → 3.42 → 3.00 → 2.97 → 3.25 → 2.94 px: the best pass beat the
  first, but not every pass did.
* **Endpoints never move.** They are anchors, so they survive promotion exactly.
  Any error in where you put them is spread inward by the distance and angle
  terms rather than corrected — so place them on the trail.
* **A pass usually stops at `minLoops`, not `maxLoops`.** On the real tile every
  pass ended at exactly 100 iterations with `delta ≈ 7e-5`, i.e. the line was
  already at a force equilibrium (gradient balanced by distance and angle), not
  cut off mid-creep. That is why more iterations alone do not straighten a sag.
* **Lowering Score threshold** (`thresholdEpsilon`) makes a pass run longer
  before the plateau exit — measured 100 → 146 → 529 iterations at 5e-4 → 1e-5 →
  1e-6 — so one pass covers more ground and fewer chained passes are needed. It
  does not by itself guarantee a line closer to the trail, for the equilibrium
  reason above.
* **Keep Trim ends at 0 while chaining.** `trimEnds` discards every vertex
  within `radius` of an endpoint (keeping the endpoint itself). That happens on
  every `finalize()`, so promoting the output makes the already-straightened
  near-anchor section the next baseline. Chaining is about letting the interior
  converge while the anchors hold still — trimming the ends works against that.

## Layout

```
index.html        sidebar + canvas shell
docs/             slide-button-pipeline.md — step-by-step run of the pipeline
src/geometry.js   resample, Douglas–Peucker, trim
src/surface.js    colour→value, gaussian kernel, Surface, SmoothSurface
src/slide.js      DEFAULTS, preparePath, createSession, finalize
src/main.js       tile georeferencing, parameter panel, drawing, rAF loop, render
test/*.mjs        headless checks (see above)
8038@2x.png       the heatmap tile under test
```
