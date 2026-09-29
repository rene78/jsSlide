/**
 * Minimal PNG decoder — just enough for this project's greyscale tile.
 * (colorType 0, 8-bit, non-interlaced; RGB/RGBA added for completeness)
 */
import zlib from 'node:zlib';

export function decodePNG(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');

  let o = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 8;
  let colorType = 0;
  const idat = [];

  while (o < buf.length) {
    const len = buf.readUInt32BE(o);
    const type = buf.toString('ascii', o + 4, o + 8);
    const data = buf.subarray(o + 8, o + 8 + len);

    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      if (data[12] !== 0) throw new Error('interlaced PNG not supported');
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    o += 12 + len;
  }

  if (bitDepth !== 8) throw new Error(`unsupported bit depth ${bitDepth}`);

  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new Error(`unsupported color type ${colorType}`);

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const pixels = unfilter(raw, width, height, channels);

  // -> grayscale 0..1 in row-major order, index = y * width + x
  const values = new Float64Array(width * height);
  for (let i = 0; i < width * height; i++) {
    const p = i * channels;
    if (channels === 1) {
      values[i] = pixels[p] / 255;
    } else if (channels === 2) {
      values[i] = pixels[p] / 255; // grey + alpha, use grey
    } else if (channels === 3 || channels === 4) {
      values[i] = Math.max(pixels[p], pixels[p + 1], pixels[p + 2]) / 255;
    }
  }
  return { width, height, values };
}

function unfilter(raw, width, height, bpp) {
  const stride = width * bpp;
  const out = Buffer.alloc(stride * height);
  let pos = 0;

  for (let y = 0; y < height; y++) {
    const filter = raw[pos++];
    const row = out.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;

    for (let x = 0; x < stride; x++) {
      const r = raw[pos++];
      const a = x >= bpp ? row[x - bpp] : 0;
      const b = prev ? prev[x] : 0;
      const c = x >= bpp && prev ? prev[x - bpp] : 0;
      let v;
      switch (filter) {
        case 0: v = r; break;
        case 1: v = r + a; break;
        case 2: v = r + b; break;
        case 3: v = r + ((a + b) >> 1); break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          v = r + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default: throw new Error(`bad PNG filter ${filter}`);
      }
      row[x] = v & 0xff;
    }
  }
  return out;
}
