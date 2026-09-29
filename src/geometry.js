/**
 * Geometry helpers for Slide.
 *
 * Points are always flat Float64Array lists: [x0, y0, x1, y1, ...].
 * Inside the slide engine the units are metres (surface/mercator space);
 * the UI converts to and from image pixels.
 *
 * Ported from go.geo (github.com/paulmach/go.geo) to keep behaviour identical.
 */

/** Total euclidean length of a polyline. */
export function pathDistance(pts) {
  let total = 0;
  for (let i = 0; i + 3 < pts.length; i += 2) {
    total += Math.hypot(pts[i + 2] - pts[i], pts[i + 3] - pts[i + 1]);
  }
  return total;
}

/** True when every point coincides with the first one. */
function allEqual(pts) {
  for (let i = 2; i < pts.length; i += 2) {
    if (pts[i] !== pts[0] || pts[i + 1] !== pts[1]) return false;
  }
  return true;
}

/**
 * Re-sample a polyline into exactly `totalPoints` evenly spaced points.
 * First and last points are preserved. Mirrors geo.Path.Resample.
 */
export function resampleEven(pts, totalPoints) {
  if (totalPoints <= 0) return new Float64Array(0);

  const n = pts.length / 2;
  if (n <= 1) return pts.slice();

  if (allEqual(pts)) {
    const out = new Float64Array(totalPoints * 2);
    for (let i = 0; i < totalPoints; i++) {
      out[2 * i] = pts[0];
      out[2 * i + 1] = pts[1];
    }
    return out;
  }

  // pre-compute cumulative segment lengths
  const dists = new Float64Array(n - 1);
  let total = 0;
  for (let i = 0; i < n - 1; i++) {
    const d = Math.hypot(pts[2 * i + 2] - pts[2 * i], pts[2 * i + 3] - pts[2 * i + 1]);
    dists[i] = d;
    total += d;
  }

  const out = new Float64Array(totalPoints * 2);
  out[0] = pts[0];
  out[1] = pts[1];

  if (totalPoints === 1) return out;

  let written = 1;
  let travelled = 0;
  let target = total / (totalPoints - 1);

  for (let i = 0; i < n - 1 && written < totalPoints - 1; i++) {
    const segLen = dists[i];
    const segEnd = travelled + segLen;

    while (target <= segEnd && written < totalPoints - 1) {
      // guard against zero-length segments (would be 0/0 -> NaN in Go too)
      const pct = segLen > 0 ? (target - travelled) / segLen : 0;
      out[2 * written] = pts[2 * i] + pct * (pts[2 * i + 2] - pts[2 * i]);
      out[2 * written + 1] = pts[2 * i + 1] + pct * (pts[2 * i + 3] - pts[2 * i + 1]);
      written++;

      target = (total * written) / (totalPoints - 1);
      if (written === totalPoints - 1) target = total; // avoid round-off stalling
    }
    travelled = segEnd;
  }

  // last point always lands exactly on the original final point
  out[2 * (totalPoints - 1)] = pts[2 * (n - 1)];
  out[2 * (totalPoints - 1) + 1] = pts[2 * (n - 1) + 1];
  return out;
}

/** Re-sample so consecutive points are about `interval` apart. */
export function resampleInterval(pts, interval) {
  if (interval <= 0) return pts.slice();
  const total = pathDistance(pts);
  const totalPoints = Math.floor(total / interval) + 1;
  if (totalPoints <= 0) return new Float64Array(0);
  return resampleEven(pts, totalPoints);
}

/**
 * Douglas-Peucker simplification, iterative (same stack approach as go.geo).
 * `threshold` is a distance in the same units as the points.
 */
export function douglasPeucker(pts, threshold) {
  const n = pts.length / 2;
  if (n <= 2 || threshold <= 0) return pts.slice();

  const mask = new Uint8Array(n);
  mask[0] = 1;
  mask[n - 1] = 1;

  const t2 = threshold * threshold;
  const stack = [0, n - 1];

  while (stack.length) {
    const end = stack.pop();
    const start = stack.pop();

    const ax = pts[2 * start];
    const ay = pts[2 * start + 1];
    const ex = pts[2 * end] - ax;
    const ey = pts[2 * end + 1] - ay;
    const len2 = ex * ex + ey * ey;

    let maxDist = 0;
    let maxIndex = -1;
    for (let i = start + 1; i < end; i++) {
      const px = pts[2 * i] - ax;
      const py = pts[2 * i + 1] - ay;
      // perpendicular distance to the infinite line through start/end
      const d2 = len2 > 0 ? (px * ey - py * ex) ** 2 / len2 : px * px + py * py;
      if (d2 > maxDist) {
        maxDist = d2;
        maxIndex = i;
      }
    }

    if (maxIndex >= 0 && maxDist > t2) {
      mask[maxIndex] = 1;
      stack.push(start, maxIndex, maxIndex, end);
    }
  }

  let kept = 0;
  for (let i = 0; i < n; i++) if (mask[i]) kept++;
  const out = new Float64Array(kept * 2);
  let k = 0;
  for (let i = 0; i < n; i++) {
    if (!mask[i]) continue;
    out[k++] = pts[2 * i];
    out[k++] = pts[2 * i + 1];
  }
  return out;
}

/**
 * Drop points that sit within `radius` of either end of the line.
 * Mirrors slide/reducers.Trim exactly: the *endpoint itself* is always kept,
 * and what gets dropped is everything between it and the first point that is
 * far enough away.
 */
export function trimEnds(pts, radius) {
  if (radius <= 0) return pts.slice();

  const n = pts.length / 2;
  if (n <= 2) return pts.slice();

  const dist = (a, b) =>
    Math.hypot(pts[2 * b] - pts[2 * a], pts[2 * b + 1] - pts[2 * a + 1]);

  // front: anchor stays on p0, peel points off while they are too close to it
  let end = n - 1;
  let len = n;
  let k = 1;
  while (len > 2 && dist(0, k) < radius) {
    k++;
    len--;
  }

  // back: same from the other end
  let j = end - 1;
  while (len > 2 && dist(end, j) < radius) {
    j--;
    len--;
  }

  const midCount = Math.max(0, j - k + 1);
  const out = new Float64Array((midCount + 2) * 2);
  out[0] = pts[0];
  out[1] = pts[1];
  if (midCount) out.set(pts.subarray(2 * k, 2 * (j + 1)), 2);
  out[2 * (midCount + 1)] = pts[2 * end];
  out[2 * (midCount + 1) + 1] = pts[2 * end + 1];
  return out;
}
