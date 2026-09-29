/**
 * The Slide "surface": a raster field the polyline climbs into the valleys of.
 *
 * Ported from github.com/paulmach/slide (surfacers/) + go.geo (surface.go,
 * utils/smoothsurface).
 *
 * Coordinate space
 * ----------------
 * Points handed to these classes are in metres, measured from the top-left
 * corner of the tile. Grid index i corresponds to image pixel i, whose centre
 * sits at pixel coordinate i + 0.5, so:
 *
 *     bound origin (sw) = 0.5 * cellM
 *     grid box          = cellM      (metres per image pixel)
 *
 * Y grows downwards (image order) — the whole engine stays self-consistent
 * because the gradient is computed and consumed in the same space.
 */

/** Luminance-ish colour -> [0,1] surface value. */
export function colorValue(r, g, b) {
  // go.geo's ColorValue only handles greyscale; max() also works for the
  // blue/hot/bluered Strava palettes.
  return Math.max(r, g, b) / 255;
}

/**
 * Smoothing kernel: a Gaussian with a sharpened peak, per slide/utils.Kernel.
 *
 * `stdDevMeters` is the ground-plane standard deviation. Go sized the kernel
 * as ceil(stdDev * mercatorScale) *taps* — implicitly assuming a ~1 m cell —
 * so we divide by the cell size first. Identical to Go when cellM === 1.
 */
export function buildKernel(stdDevMeters, cellMeters, mercatorScale) {
  const stdDev = stdDevMeters / cellMeters;
  if (!stdDev || stdDev <= 0) return Float64Array.of(1.0);

  const addition = stdDev * 1.5;
  const sd = stdDev * mercatorScale;
  const depth = Math.sqrt(mercatorScale) / (addition + 1 / Math.sqrt(Math.E));

  const size = Math.max(1, Math.ceil(sd * 3.5));
  const kernel = new Float64Array(2 * size + 1);

  for (let i = 0; i <= size; i++) {
    let v;
    if (i < sd) {
      // linear cusp inside one std-dev: gives the kernel a sharp point
      v = (-addition / sd) * i + (addition + 1 / Math.sqrt(Math.E));
    } else {
      const t = i / sd;
      v = Math.exp(-t * t);
    }
    kernel[size - i] = v * depth;
    kernel[size + i] = v * depth;
  }
  return kernel;
}

/** Bilinearly sampled raster field. */
export class Surface {
  /**
   * @param {Float64Array} values grid values, index = y * width + x, 0..1
   */
  constructor(values, width, height, cellM) {
    this.values = values;
    this.width = width;
    this.height = height;
    this.cell = cellM;
    this.sw = 0.5 * cellM;
    this.boundW = (width - 1) * cellM;
    this.boundH = (height - 1) * cellM;
  }

  contains(x, y) {
    return (
      x >= this.sw &&
      x <= this.sw + this.boundW &&
      y >= this.sw &&
      y <= this.sw + this.boundH
    );
  }

  _index(xi, yi) {
    return this.values[yi * this.width + xi];
  }

  /** Unsmoothed surface value at a point (0 outside the bound). */
  valueAt(x, y) {
    if (!this.contains(x, y)) return 0;

    const gx = (x - this.sw) / this.cell;
    const gy = (y - this.sw) / this.cell;
    const xi = Math.floor(gx);
    const yi = Math.floor(gy);
    const dx = gx - xi;
    const dy = gy - yi;

    const xi1 = Math.min(xi + 1, this.width - 1);
    const yi1 = Math.min(yi + 1, this.height - 1);

    const w1 = this._index(xi, yi) * (1 - dx) + this._index(xi1, yi) * dx;
    const w2 = this._index(xi, yi1) * (1 - dx) + this._index(xi1, yi1) * dx;
    return w1 * (1 - dy) + w2 * dy;
  }
}

/**
 * Separable Gaussian smoothing applied lazily with two caches, exactly like
 * go.geo's LazySmoothSurface: `verticalValue` caches the first pass,
 * `smoothedGrid` the second. Only cells actually touched get computed.
 */
export class SmoothSurface {
  constructor(surface, kernel) {
    this.surface = surface;
    this.setKernel(kernel);
  }

  setKernel(kernel) {
    this.kernel = kernel;
    this.size = (kernel.length - 1) / 2;
    const n = this.surface.width * this.surface.height;
    this.gridCache = new Float64Array(n).fill(NaN);
    this.midCache = new Float64Array(n).fill(NaN);
  }

  /** value after smoothing in y, cached */
  verticalValue(x, y) {
    const key = y * this.surface.width + x;
    const hit = this.midCache[key];
    if (!Number.isNaN(hit)) return hit;

    const { height, values } = this.surface;
    const size = this.size;
    let sum = 0;
    for (let j = y - size; j <= y + size; j++) {
      const k = j < 0 ? 0 : j >= height ? height - 1 : j;
      sum += this.kernel[j - (y - size)] * values[k * this.surface.width + x];
    }
    this.midCache[key] = sum;
    return sum;
  }

  /** value after smoothing in both directions, cached */
  smoothedGrid(x, y) {
    const key = y * this.surface.width + x;
    const hit = this.gridCache[key];
    if (!Number.isNaN(hit)) return hit;

    const { width } = this.surface;
    const size = this.size;
    let sum = 0;
    for (let j = x - size; j <= x + size; j++) {
      const k = j < 0 ? 0 : j >= width ? width - 1 : j;
      sum += this.kernel[j - (x - size)] * this.verticalValue(k, y);
    }
    this.gridCache[key] = sum;
    return sum;
  }

  /** Smoothed surface value at a point (0 outside the bound). */
  valueAt(x, y) {
    const s = this.surface;
    if (!s.contains(x, y)) return 0;

    const gx = (x - s.sw) / s.cell;
    const gy = (y - s.sw) / s.cell;
    const xi = Math.floor(gx);
    const yi = Math.floor(gy);
    const w = gx - xi;
    const h = gy - yi;

    const xi1 = Math.min(xi + 1, s.width - 1);
    const yi1 = Math.min(yi + 1, s.height - 1);

    const a = this.smoothedGrid(xi, yi) * (1 - w) + this.smoothedGrid(xi1, yi) * w;
    const b = this.smoothedGrid(xi, yi1) * (1 - w) + this.smoothedGrid(xi1, yi1) * w;
    return a * (1 - h) + b * h;
  }

  /**
   * Gradient of the smoothed surface, in value per metre.
   * Bilinearly interpolated from the four surrounding smoothed cells.
   */
  gradientAt(x, y) {
    const s = this.surface;
    if (!s.contains(x, y)) return [0, 0];

    const gx = (x - s.sw) / s.cell;
    const gy = (y - s.sw) / s.cell;
    let xi = Math.floor(gx);
    let yi = Math.floor(gy);
    let dx = gx - xi;
    let dy = gy - yi;

    let xi1 = xi + 1;
    if (xi1 > s.width - 1) {
      xi = s.width - 2;
      xi1 = s.width - 1;
      dx = 1;
    }
    let yi1 = yi + 1;
    if (yi1 > s.height - 1) {
      yi = s.height - 2;
      yi1 = s.height - 1;
      dy = 1;
    }

    const s00 = this.smoothedGrid(xi, yi);
    const s10 = this.smoothedGrid(xi1, yi);
    const s01 = this.smoothedGrid(xi, yi1);
    const s11 = this.smoothedGrid(xi1, yi1);

    const u1 = s00 * (1 - dx) + s10 * dx;
    const u2 = s01 * (1 - dx) + s11 * dx;

    const w1 = (1 - dy) * (s10 - s00);
    const w2 = dy * (s11 - s01);

    return [(w1 + w2) / s.cell, (u2 - u1) / s.cell];
  }
}
