/**
 * Slide: vector-to-raster map conflation.
 *
 * A vanilla-JS port of github.com/paulmach/slide (slide.go + refine.go).
 *
 * The input line is treated as a "string of beads": resample it, then iterate
 * where every *interior* vertex gets corrected by
 *
 *     gradient  +  distance  +  angle  +  momentum(previous correction)
 *
 * — gradient slides it uphill on the (smoothed) surface, distance keeps the
 * beads evenly spaced, angle keeps the line from kinking, momentum accelerates
 * convergence. Endpoints never move.
 *
 * Loop until the exponentially smoothed average surface value stops changing.
 */

import { pathDistance, resampleEven, resampleInterval, douglasPeucker, trimEnds } from './geometry.js';

/** Defaults mirror slide.New() + the stravaheat SuggestedOptions. */
export const DEFAULTS = {
  smoothingStdDev: 16, // metres
  gradientScale: 0.5,
  distanceScale: 0.2,
  angleScale: 0.1,
  momentumScale: 0.7,
  resampleInterval: 5, // metres
  minLoops: 100,
  maxLoops: 4000,
  thresholdEpsilon: 0.0005,
  scoreSmoothing: 0.2, // slide/refine.go scoreSmoothingFactor
  depthBasedReduction: false,
  /**
   * Express the gradient step per *grid cell* rather than per metre.
   *
   * Go's correction is `gradientScale * dV/d(metre)`, which only behaves well
   * when a cell is about a metre — their Strava surface was ~1.2 m/px. The
   * step that lands on a vertex is `0.5 * dV/dcell / cell²` cells, so it
   * shrinks with the square of the cell size: on our 2.39 m/px tile the line
   * would crawl ~5.7x too slowly to ever converge inside maxLoops.
   *
   * Multiplying by `cell` instead gives `0.5 * dV/dcell` cells per iteration,
   * which is size-independent and matches Go's behaviour on ~1 m cells.
   * Turn off for the literal per-metre version.
   */
  gradientPerCell: true,
  trimRadius: 0, // metres, 0 = off (Go uses 15)
  simplifyTolerance: 1, // metres, 0 = off
  ghostCount: 200, // intermediate snapshots kept for the replay animation
  mercatorScale: 1.001733, // 1 / cos(centre latitude)
};

/** Resample the drawn path the way Slide.Do() does: ~resampleInterval metres. */
export function preparePath(ptsMeters, params) {
  const total = pathDistance(ptsMeters);
  const interval = params.resampleInterval * params.mercatorScale;
  const count = Math.max(1, Math.ceil(total / interval));
  return resampleEven(ptsMeters, count + 3);
}

/**
 * Create a resumable slide run. Call `step()` once per iteration; the UI drives
 * it from requestAnimationFrame so it can animate instead of blocking.
 *
 * @param {import('./surface.js').Surface} surface  unsmoothed, for scoring
 * @param {import('./surface.js').SmoothSurface} smooth  smoothed, for gradients
 */
export function createSession(surface, smooth, ptsMeters, params) {
  const p = { ...DEFAULTS, ...params };
  const prepared = preparePath(ptsMeters, p);
  const n = prepared.length / 2;

  const corrections = new Float64Array(n * 2); // momentum history

  // NOTE: `cur` must NOT alias `prepared` — the two working buffers rotate, so
  // the prepared path would get clobbered by later iterations and anyone
  // comparing against it would be comparing against the moving result.
  let cur = prepared.slice();
  let scratch = new Float64Array(prepared.length);

  // Ghosts feed the replay animation. Most of the movement happens in the
  // first few iterations, so capture those densely and then space them out.
  const denseHead = Math.min(30, Math.floor(p.ghostCount / 4));
  const rest = p.ghostCount - denseHead;
  const ghostEvery =
    rest > 0 && p.maxLoops > denseHead
      ? Math.max(1, Math.floor((p.maxLoops - denseHead) / rest))
      : Infinity;

  const session = {
    params: p,
    prepared,
    ghosts: [],
    iterations: 0,
    score: 0, // raw average surface value
    smoothScore: 0, // exponentially smoothed
    delta: Infinity,
    done: n < 3,
    runtime: 0,
    get path() {
      return cur;
    },
    step,
  };

  if (session.done) return session;

  function step() {
    if (session.done) return;
    const t0 = performance.now();

    for (let i = 1; i < n - 1; i++) {
      const px = cur[2 * i];
      const py = cur[2 * i + 1];
      let cx = 0;
      let cy = 0;

      // --- gradient: move uphill on the smoothed surface -------------------
      if (p.gradientScale !== 0) {
        const g = smooth.gradientAt(px, py); // value per metre
        const k = p.gradientPerCell
          ? p.gradientScale * surface.cell
          : p.gradientScale;
        cx += g[0] * k;
        cy += g[1] * k;
      }

      // --- distance: keep neighbours evenly spaced -------------------------
      if (p.distanceScale !== 0) {
        const vx = px - cur[2 * i - 2];
        const vy = py - cur[2 * i - 1];
        const ux = cur[2 * i + 2] - cur[2 * i - 2];
        const uy = cur[2 * i + 3] - cur[2 * i - 1];
        const dot = ux * ux + uy * uy;
        if (dot !== 0) {
          // centre = projection of this vertex onto the line prev -> next
          const t = (ux * vx + uy * vy) / dot;
          const ccx = ux * t + cur[2 * i - 2];
          const ccy = uy * t + cur[2 * i - 1];
          const m1x = cur[2 * i - 2] - ccx;
          const m1y = cur[2 * i - 1] - ccy;
          const m2x = cur[2 * i + 2] - ccx;
          const m2y = cur[2 * i + 3] - ccy;
          cx += (m1x + m2x) * p.distanceScale;
          cy += (m1y + m2y) * p.distanceScale;
        }
      }

      // --- angle: widen vertex angles (rigidity) ---------------------------
      if (p.angleScale !== 0) {
        let n1x = cur[2 * i - 2] - px;
        let n1y = cur[2 * i - 1] - py;
        let n2x = cur[2 * i + 2] - px;
        let n2y = cur[2 * i + 3] - py;
        const len1 = Math.hypot(n1x, n1y);
        const len2 = Math.hypot(n2x, n2y);

        if (len1 > 0 && len2 > 0) {
          n1x /= len1;
          n1y /= len1;
          n2x /= len2;
          n2y /= len2;

          // straight line -> dot = -1 -> cbrt = -1 -> factor 0 (no force)
          const factor = Math.cbrt(n1x * n2x + n1y * n2y) + 1;
          let bx = n1x + n2x;
          let by = n1y + n2y;
          const bl = Math.hypot(bx, by);
          if (bl > 0) {
            bx /= bl;
            by /= bl;
            const mag = Math.min(len1, len2) * p.angleScale * factor;
            cx += bx * mag;
            cy += by * mag;
          }
        }
      }

      // --- momentum --------------------------------------------------------
      cx += corrections[2 * i] * p.momentumScale;
      cy += corrections[2 * i + 1] * p.momentumScale;

      // --- optional: damp the correction where we're already in a valley ----
      if (p.depthBasedReduction) {
        const v = Math.min(1, Math.max(0, surface.valueAt(px, py)));
        const f = Math.sqrt(1 - v);
        cx *= f;
        cy *= f;
      }

      corrections[2 * i] = cx;
      corrections[2 * i + 1] = cy;
      scratch[2 * i] = px + cx;
      scratch[2 * i + 1] = py + cy;
    }

    // endpoints are fixed
    scratch[0] = cur[0];
    scratch[1] = cur[1];
    scratch[2 * (n - 1)] = cur[2 * (n - 1)];
    scratch[2 * (n - 1) + 1] = cur[2 * (n - 1) + 1];

    const tmp = cur;
    cur = scratch;
    scratch = tmp;

    session.iterations++;
    if (
      p.ghostCount > 0 &&
      session.ghosts.length < p.ghostCount &&
      (session.iterations <= denseHead || session.iterations % ghostEvery === 0)
    ) {
      session.ghosts.push(cur.slice());
    }

    // score = average *unsmoothed* surface value along the line
    let sum = 0;
    for (let i = 0; i < n; i++) sum += surface.valueAt(cur[2 * i], cur[2 * i + 1]);
    const raw = sum / n;

    const previous = session.smoothScore;
    session.score = raw;
    session.smoothScore = p.scoreSmoothing * previous + (1 - p.scoreSmoothing) * raw;
    session.delta = Math.abs(session.smoothScore - previous);

    session.runtime += performance.now() - t0;

    if (session.iterations >= p.minLoops && session.delta < p.thresholdEpsilon) {
      session.done = true;
    } else if (session.iterations >= p.maxLoops) {
      session.done = true;
    }
  }

  return session;
}

/** Trim + simplify the converged path, matching Slide.Do()'s GeoReduce step. */
export function finalize(session) {
  const { params } = session;
  let out = session.path;
  if (params.trimRadius > 0) {
    // Go measures these in ground metres (haversine); our space is mercator
    const ms = params.mercatorScale;
    out = resampleInterval(out, 2 * ms);
    out = trimEnds(out, params.trimRadius * ms);
  }
  if (params.simplifyTolerance > 0) {
    out = douglasPeucker(out, params.simplifyTolerance * params.mercatorScale);
  }
  return out;
}
