// static/analysis-worker.js
const EPS = 1e-8;
let prevMag = null;
let ewma = null;
let ewvar = null;
let cachedHann = null;
let cachedHannN = 0;

function clamp01(x) {
  return Math.max(0, Math.min(1, x));
}

function hann(n) {
  if (cachedHann && cachedHannN === n) return cachedHann;
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
  }
  cachedHann = w;
  cachedHannN = n;
  return w;
}

function fftMagnitude(signal) {
  const n = signal.length;
  const re = Float32Array.from(signal);
  const im = new Float32Array(n);

  let j = 0;
  for (let i = 1; i < n; i++) {
    let bit = n >> 1;
    while (j & bit) {
      j ^= bit;
      bit >>= 1;
    }
    j ^= bit;
    if (i < j) {
      const tr = re[i];
      re[i] = re[j];
      re[j] = tr;
    }
  }

  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wlenCos = Math.cos(ang);
    const wlenSin = Math.sin(ang);

    for (let i = 0; i < n; i += len) {
      let wRe = 1;
      let wIm = 0;

      for (let k = 0; k < len / 2; k++) {
        const uRe = re[i + k];
        const uIm = im[i + k];

        const vRe = re[i + k + len / 2] * wRe - im[i + k + len / 2] * wIm;
        const vIm = re[i + k + len / 2] * wIm + im[i + k + len / 2] * wRe;

        re[i + k] = uRe + vRe;
        im[i + k] = uIm + vIm;
        re[i + k + len / 2] = uRe - vRe;
        im[i + k + len / 2] = uIm - vIm;

        const nextWRe = wRe * wlenCos - wIm * wlenSin;
        const nextWIm = wRe * wlenSin + wIm * wlenCos;
        wRe = nextWRe;
        wIm = nextWIm;
      }
    }
  }

  const half = n >> 1;
  const mag = new Float32Array(half);
  for (let i = 0; i < half; i++) {
    mag[i] = Math.hypot(re[i], im[i]);
  }
  return mag;
}

function correlation(left, right) {
  let sumLR = 0;
  let sumL2 = 0;
  let sumR2 = 0;
  for (let i = 0; i < left.length; i++) {
    const l = left[i];
    const r = right[i];
    sumLR += l * r;
    sumL2 += l * l;
    sumR2 += r * r;
  }
  return sumLR / (Math.sqrt(sumL2 * sumR2) + EPS);
}

function rmsAndPeak(x) {
  let sum = 0;
  let peak = 0;
  for (let i = 0; i < x.length; i++) {
    const v = x[i];
    sum += v * v;
    peak = Math.max(peak, Math.abs(v));
  }
  const rms = Math.sqrt(sum / Math.max(1, x.length));
  return { rms, peak, crest: peak / (rms + EPS) };
}

function zeroCrossingRate(x) {
  let z = 0;
  for (let i = 1; i < x.length; i++) {
    if ((x[i - 1] >= 0 && x[i] < 0) || (x[i - 1] < 0 && x[i] >= 0)) z += 1;
  }
  return z / Math.max(1, x.length - 1);
}

function spectralStats(mag, sampleRate) {
  const binHz = sampleRate / (mag.length * 2);
  let total = EPS;
  let weighted = 0;
  let logSum = 0;
  let sub = 0;
  let low = 0;
  let lowMid = 0;
  let highMid = 0;
  let air = 0;
  let irregularity = 0;
  let prev = mag[0] || 0;
  const powers = new Float32Array(mag.length);

  for (let i = 0; i < mag.length; i++) {
    const f = i * binHz;
    const p = mag[i] * mag[i] + EPS;

    powers[i] = p;
    total += p;
    weighted += f * p;
    logSum += Math.log(p);

    if (f < 80) sub += p;
    else if (f < 250) low += p;
    else if (f < 1000) lowMid += p;
    else if (f < 4000) highMid += p;
    else air += p;

    if (i > 0 && f >= 150 && f <= 7000) irregularity += Math.abs(mag[i] - prev);
    prev = mag[i];
  }

  const centroid = weighted / total;
  let cum = 0;
  let rolloffHz = 0;
  for (let i = 0; i < powers.length; i++) {
    cum += powers[i];
    if (cum >= total * 0.85) {
      rolloffHz = i * binHz;
      break;
    }
  }

  const flatness = Math.exp(logSum / Math.max(1, mag.length)) / (total / Math.max(1, mag.length));
  const magSum = mag.reduce((acc, v) => acc + v, EPS);

  return {
    total,
    centroid,
    rolloffHz,
    flatness,
    irregularity: irregularity / magSum,
    subRatio: sub / total,
    lowRatio: low / total,
    lowMidRatio: lowMid / total,
    highMidRatio: highMid / total,
    airRatio: air / total,
  };
}

function positiveFlux(mag) {
  if (!prevMag || prevMag.length !== mag.length) {
    prevMag = mag.slice();
    return 0;
  }
  let sum = 0;
  for (let i = 0; i < mag.length; i++) {
    const d = mag[i] - prevMag[i];
    if (d > 0) sum += d;
    prevMag[i] = mag[i];
  }
  return sum / Math.max(1, mag.length);
}

function updateNovelty(vector) {
  if (!ewma) {
    ewma = vector.slice();
    ewvar = vector.map(() => 1e-4);
    return { novelty: 0, loudnessJump: 0 };
  }

  let acc = 0;
  let loudnessJump = 0;

  for (let i = 0; i < vector.length; i++) {
    const diff = vector[i] - ewma[i];
    const sigma = Math.sqrt(ewvar[i] + 1e-6);
    const z = Math.abs(diff) / (sigma + EPS);
    acc += z;

    if (i === 0) loudnessJump = clamp01(z / 3.5);

    ewma[i] += 0.06 * diff;
    const resid = vector[i] - ewma[i];
    ewvar[i] = 0.94 * ewvar[i] + 0.06 * resid * resid;
  }

  return {
    novelty: clamp01((acc / vector.length) / 4.0),
    loudnessJump,
  };
}

function analyzeFrame(left, right, sampleRate, t) {
  const n = Math.min(left.length, right.length);
  const mono = new Float32Array(n);
  for (let i = 0; i < n; i++) mono[i] = 0.5 * (left[i] + right[i]);

  const { rms, peak, crest } = rmsAndPeak(mono);
  const zcr = zeroCrossingRate(mono);
  const corr = correlation(left, right);

  const win = hann(n);
  const windowed = new Float32Array(n);
  for (let i = 0; i < n; i++) windowed[i] = mono[i] * win[i];

  const mag = fftMagnitude(windowed);
  const spec = spectralStats(mag, sampleRate);

  const flux = clamp01(positiveFlux(mag) * 12);
  const tonality = clamp01(1 - spec.flatness);
  const sharpness = clamp01((spec.highMidRatio * 1.15 + spec.airRatio * 1.9) * 1.8);
  const roughness = clamp01(spec.irregularity * 6 + flux * 0.35);
  const impulsiveness = clamp01((crest - 2.2) / 5.0);
  const onset = clamp01(
    0.58 * flux +
    0.24 * impulsiveness +
    0.18 * clamp01((peak - rms) / (peak + EPS))
  );

  const { novelty, loudnessJump } = updateNovelty([
    rms,
    spec.centroid / 5000,
    flux,
    sharpness,
    roughness,
    Math.abs(corr),
  ]);

  const speechLike = clamp01(
    spec.lowMidRatio * 0.9 +
    tonality * 0.35 +
    clamp01((2500 - Math.abs(spec.centroid - 1500)) / 2500) * 0.5 -
    spec.subRatio * 0.25
  );

  const alarmLike = clamp01(
    tonality * 0.55 +
    onset * 0.75 +
    sharpness * 0.55 +
    clamp01((spec.centroid - 1400) / 2600) * 0.35
  );

  const metallicLike = clamp01(
    roughness * 0.75 +
    sharpness * 0.65 +
    tonality * 0.35
  );

  const salience = clamp01(
    0.17 * loudnessJump +
    0.17 * flux +
    0.11 * onset +
    0.12 * sharpness +
    0.11 * roughness +
    0.08 * tonality +
    0.06 * impulsiveness +
    0.08 * novelty +
    0.04 * speechLike +
    0.06 * alarmLike +
    0.05 * metallicLike +
    0.03 * clamp01((0.8 - corr) / 0.8)
  );

  const focusRisk = clamp01(
    salience +
    0.18 * clamp01((spec.subRatio - 0.16) / 0.24) +
    0.15 * clamp01((spec.airRatio - 0.22) / 0.26) +
    0.12 * sharpness +
    0.08 * flux
  );

  const reasons = [
    ["novelty spike", novelty],
    ["brightness jump", clamp01(sharpness * 0.65 + flux * 0.35)],
    ["roughness", roughness],
    ["onset/transient", onset],
    ["sub dominance", clamp01((spec.subRatio - 0.16) / 0.24)],
    ["air hiss", clamp01((spec.airRatio - 0.22) / 0.26)],
    ["alarm-like", alarmLike],
    ["speech-like", speechLike],
    ["metallic edge", metallicLike],
  ]
    .filter(([, score]) => score > 0.22)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([label]) => label);

  return {
    t,
    sampleRate,
    salience,
    focusRisk,
    novelty,
    rms,
    peak,
    crest,
    zcr,
    centroidHz: spec.centroid,
    rolloffHz: spec.rolloffHz,
    flatness: spec.flatness,
    flux,
    onset,
    roughness,
    sharpness,
    tonality,
    impulsiveness,
    stereoCorrelation: corr,
    speechLike,
    alarmLike,
    metallicLike,
    subRatio: spec.subRatio,
    lowRatio: spec.lowRatio,
    lowMidRatio: spec.lowMidRatio,
    highMidRatio: spec.highMidRatio,
    airRatio: spec.airRatio,
    reasons,
  };
}

self.onmessage = (event) => {
  const data = event.data;
  if (!data || data.type !== "audio_frame") return;
  const summary = analyzeFrame(data.left, data.right, data.sampleRate, data.t);
  self.postMessage({ type: "analysis", summary });
};