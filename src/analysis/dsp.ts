// Vendored from Gondryator (https://github.com/FrunkQ/gondryator, The Unlicense), unchanged.
// Small, allocation-light DSP helpers used by the analysis worker.

export class FFT {
  readonly n: number;
  private rev: Uint32Array;
  private cos: Float64Array;
  private sin: Float64Array;
  readonly re: Float64Array;
  readonly im: Float64Array;
  readonly window: Float64Array;

  constructor(n: number) {
    this.n = n;
    this.re = new Float64Array(n);
    this.im = new Float64Array(n);
    this.rev = new Uint32Array(n);
    const bits = Math.log2(n);
    for (let i = 0; i < n; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
      this.rev[i] = r;
    }
    this.cos = new Float64Array(n / 2);
    this.sin = new Float64Array(n / 2);
    for (let i = 0; i < n / 2; i++) {
      this.cos[i] = Math.cos((-2 * Math.PI * i) / n);
      this.sin[i] = Math.sin((-2 * Math.PI * i) / n);
    }
    this.window = new Float64Array(n);
    for (let i = 0; i < n; i++) this.window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
  }

  /** Windowed magnitude spectrum of x[start .. start+n) into mags (length n/2+1). */
  magnitudes(x: Float32Array, start: number, mags: Float32Array): void {
    const { n, re, im, rev, window } = this;
    for (let i = 0; i < n; i++) {
      const j = start + i;
      const v = j >= 0 && j < x.length ? x[j] * window[i] : 0;
      re[rev[i]] = v;
      im[rev[i]] = 0;
    }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1;
      const step = n / size;
      for (let i = 0; i < n; i += size) {
        for (let k = 0; k < half; k++) {
          const wr = this.cos[k * step];
          const wi = this.sin[k * step];
          const a = i + k;
          const b = a + half;
          const tr = re[b] * wr - im[b] * wi;
          const ti = re[b] * wi + im[b] * wr;
          re[b] = re[a] - tr;
          im[b] = im[a] - ti;
          re[a] += tr;
          im[a] += ti;
        }
      }
    }
    for (let k = 0; k <= n / 2; k++) mags[k] = Math.hypot(re[k], im[k]);
  }
}

/** Biquad filter run over a whole buffer (returns a new buffer). RBJ cookbook. */
export function biquad(x: Float32Array, sr: number, type: 'lp' | 'hp', freq: number, q = Math.SQRT1_2): Float32Array {
  const w0 = (2 * Math.PI * freq) / sr;
  const alpha = Math.sin(w0) / (2 * q);
  const c = Math.cos(w0);
  let b0: number, b1: number, b2: number;
  if (type === 'lp') {
    b0 = (1 - c) / 2;
    b1 = 1 - c;
    b2 = (1 - c) / 2;
  } else {
    b0 = (1 + c) / 2;
    b1 = -(1 + c);
    b2 = (1 + c) / 2;
  }
  const a0 = 1 + alpha;
  const a1 = -2 * c;
  const a2 = 1 - alpha;
  const y = new Float32Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  const B0 = b0 / a0, B1 = b1 / a0, B2 = b2 / a0, A1 = a1 / a0, A2 = a2 / a0;
  for (let i = 0; i < x.length; i++) {
    const xi = x[i];
    const yi = B0 * xi + B1 * x1 + B2 * x2 - A1 * y1 - A2 * y2;
    y[i] = yi;
    x2 = x1; x1 = xi; y2 = y1; y1 = yi;
  }
  return y;
}

export function decimate(x: Float32Array, factor: number): Float32Array {
  const n = Math.floor(x.length / factor);
  const y = new Float32Array(n);
  for (let i = 0; i < n; i++) y[i] = x[i * factor];
  return y;
}

/** Halve the sample rate with a light 3-tap smoothing before dropping samples. */
export function halve(x: Float32Array): Float32Array {
  const n = Math.floor(x.length / 2);
  const y = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = x[2 * i - 1] ?? 0;
    const b = x[2 * i];
    const c = x[2 * i + 1] ?? 0;
    y[i] = 0.25 * a + 0.5 * b + 0.25 * c;
  }
  return y;
}

/**
 * YIN pitch estimate on x around `center`. Returns frequency in Hz, or 0 when unvoiced.
 * `scratch` must be at least tauMax+1 long.
 */
export function yin(
  x: Float32Array, center: number, win: number, tauMin: number, tauMax: number,
  sr: number, threshold: number, scratch: Float64Array,
): number {
  const start = center - (win >> 1);
  if (start < 0 || start + win + tauMax >= x.length) return 0;
  const d = scratch;
  d[0] = 1;
  let running = 0;
  for (let tau = 1; tau <= tauMax; tau++) {
    let s = 0;
    for (let j = 0; j < win; j++) {
      const diff = x[start + j] - x[start + j + tau];
      s += diff * diff;
    }
    running += s;
    d[tau] = running > 0 ? (s * tau) / running : 1;
  }
  let tau = -1;
  for (let t = tauMin; t <= tauMax; t++) {
    if (d[t] < threshold) {
      while (t + 1 <= tauMax && d[t + 1] < d[t]) t++;
      tau = t;
      break;
    }
  }
  if (tau < 0) return 0;
  let better = tau;
  if (tau > 1 && tau < tauMax) {
    const a = d[tau - 1], b = d[tau], c = d[tau + 1];
    const den = a + c - 2 * b;
    if (Math.abs(den) > 1e-12) better = tau + (0.5 * (a - c)) / den;
  }
  return sr / better;
}

export const hzToMidi = (f: number) => 69 + 12 * Math.log2(f / 440);
export const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);

export function percentile(arr: ArrayLike<number>, from: number, to: number, p: number, scratch: number[]): number {
  scratch.length = 0;
  const stride = Math.max(1, Math.floor((to - from) / 4000));
  for (let i = from; i < to; i += stride) scratch.push(arr[i]);
  if (scratch.length === 0) return 0;
  scratch.sort((a, b) => a - b);
  return scratch[Math.min(scratch.length - 1, Math.floor(p * scratch.length))];
}
