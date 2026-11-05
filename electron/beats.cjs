// Beat analysis of the project soundtrack, in the main process: an onset envelope
// (spectral flux over a short-time Fourier transform), a tempo estimate (the envelope's
// autocorrelation, weighted by a log prior around 120 BPM) and the beat times themselves
// (dynamic programming that chains onsets at a near-constant period — the classic
// Ellis 2007 method the common audio toolkits implement). Everything is computed
// locally from the app's own timeline mixdown (electron/ffmpeg.cjs renders it as a
// 16 kHz mono WAV, the same pipeline auto captions and silence search use); no new
// dependency, nothing leaves the PC. Results are cached by the soundtrack's shape —
// the files and ranges that feed the mix — like the other derivative analyses.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const WIN = 1024; // STFT window (samples): 64 ms at the mixdown's 16 kHz
const HOP = 256; // STFT hop: 16 ms — finer than one 30 fps frame (33 ms)
const MIN_BPM = 40;
const MAX_BPM = 240;
const PRIOR_BPM = 120; // tempo prior centre (the usual default)
const TIGHTNESS = 4; // DP penalty weight for straying from the period (local scores sit in [0, 1])

// ---------- FFT (iterative radix-2 Cooley–Tukey, in place) ----------

function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i]; re[i] = re[j]; re[j] = tr;
      const ti = im[i]; im[i] = im[j]; im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    const half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let cwr = 1;
      let cwi = 0;
      for (let k = 0; k < half; k++) {
        const a = i + k;
        const b = a + half;
        const vr = re[b] * cwr - im[b] * cwi;
        const vi = re[b] * cwi + im[b] * cwr;
        re[b] = re[a] - vr;
        im[b] = im[a] - vi;
        re[a] += vr;
        im[a] += vi;
        const nwr = cwr * wr - cwi * wi;
        cwi = cwr * wi + cwi * wr;
        cwr = nwr;
      }
    }
  }
}

const hann = (() => {
  const w = new Float32Array(WIN);
  for (let i = 0; i < WIN; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (WIN - 1));
  return w;
})();

// ---------- Onset envelope ----------

// Spectral flux: per STFT frame, the summed positive magnitude growth across the
// spectrum (the DC bin excluded). A sharp attack — a kick, a click, a snare — is a
// broadband jump, so flux spikes exactly where a beat lands. Frames are HOP apart.
function onsetEnvelope(samples, sr) {
  const frames = Math.max(0, Math.floor((samples.length - WIN) / HOP) + 1);
  const env = new Float32Array(frames);
  if (!frames) return env;
  const re = new Float32Array(WIN);
  const im = new Float32Array(WIN);
  const prev = new Float32Array(WIN / 2 + 1);
  const mag = new Float32Array(WIN / 2 + 1);
  for (let f = 0; f < frames; f++) {
    const off = f * HOP;
    for (let i = 0; i < WIN; i++) {
      re[i] = samples[off + i] * hann[i];
      im[i] = 0;
    }
    fft(re, im);
    let flux = 0;
    for (let k = 1; k <= WIN / 2; k++) {
      mag[k] = Math.hypot(re[k], im[k]);
      const d = mag[k] - prev[k];
      if (d > 0) flux += d;
      prev[k] = mag[k];
    }
    env[f] = flux;
  }
  return env;
}

// ---------- Tempo ----------

// The lag (in envelope frames) whose autocorrelation is strongest, weighted by a
// log-Gaussian prior centred on PRIOR_BPM so the double/half-time lags of the same
// pulse do not win on raw correlation alone. Returns { bpm, period } (period in frames).
function estimateTempo(env, hopSec) {
  const n = env.length;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += env[i];
  mean /= n || 1;
  const minLag = Math.max(2, Math.floor((60 / MAX_BPM) / hopSec));
  const maxLag = Math.min(n - 2, Math.ceil((60 / MIN_BPM) / hopSec));
  if (maxLag < minLag) return null;
  const acAt = (lag) => {
    let ac = 0;
    for (let i = 0; i + lag < n; i++) ac += (env[i] - mean) * (env[i + lag] - mean);
    return ac / (n - lag);
  };
  const scores = new Map();
  let bestLag = -1;
  let bestScore = -Infinity;
  for (let lag = minLag; lag <= maxLag; lag++) {
    const bpm = 60 / (lag * hopSec);
    const prior = Math.exp(-0.5 * Math.log2(bpm / PRIOR_BPM) ** 2);
    const score = acAt(lag) * prior;
    scores.set(lag, score);
    if (score > bestScore) { bestScore = score; bestLag = lag; }
  }
  if (bestLag < 0) return null;
  // Octave disambiguation: a perfectly periodic pulse correlates almost as well at
  // twice its period, and above ~150 BPM the prior cannot separate the two — a
  // 174 BPM kick line otherwise reports 87. When the half lag scores within 0.7 of
  // the winner, the faster reading is the true period (real subdivision content in
  // correct readings measures 0.55 or less; the half-time trap measures 0.8+).
  for (let step = 0; step < 2; step++) {
    const half = bestLag / 2;
    const cands = [Math.floor(half), Math.ceil(half)].filter((l) => l >= minLag && scores.has(l));
    if (!cands.length) break;
    const h = cands.reduce((x, y) => (scores.get(x) >= scores.get(y) ? x : y));
    if (scores.get(h) >= 0.7 * scores.get(bestLag)) bestLag = h;
    else break;
  }
  // Parabolic refinement of the period on the raw autocorrelation around the peak lag.
  const a = acAt(bestLag - 1);
  const b = acAt(bestLag);
  const c = acAt(bestLag + 1);
  const shift = a - 2 * b + c !== 0 ? (0.5 * (a - c)) / (a - 2 * b + c) : 0;
  const period = bestLag + Math.max(-0.5, Math.min(0.5, shift));
  return { bpm: 60 / (period * hopSec), period };
}

// ---------- Beat tracking (dynamic programming) ----------

// Chains the envelope into beats at a near-constant period: the cumulative score of
// ending a beat at frame i is its local onset strength plus the best predecessor a
// half-to-two periods earlier, penalised by how far its gap strays from the period.
// The local score is the envelope with a slow baseline removed (so a loud chorus does
// not outvote a quiet verse) and scaled so its strong frames sit near 1.
function trackBeats(env, period) {
  const n = env.length;
  if (!n || !(period > 0)) return [];
  // Baseline: a centred moving average over ~4 periods, from prefix sums.
  const rad = Math.max(8, Math.round(period * 2));
  const pre = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) pre[i + 1] = pre[i] + env[i];
  const local = new Float32Array(n);
  const positives = [];
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - rad);
    const b = Math.min(n, i + rad + 1);
    const base = (pre[b] - pre[a]) / (b - a);
    local[i] = Math.max(0, env[i] - base * 0.75);
    if (local[i] > 0) positives.push(local[i]);
  }
  if (!positives.length) return [];
  // Scale so a typical strong onset sits near 1 (the 95th percentile of the positive
  // frames) — one freak transient early on must not mute the rest of the track.
  positives.sort((a, b) => a - b);
  const scale = positives[Math.min(positives.length - 1, Math.floor(positives.length * 0.95))] || positives[positives.length - 1];
  if (!(scale > 0)) return [];
  for (let i = 0; i < n; i++) local[i] = Math.min(1.5, local[i] / scale);

  const lo = Math.max(1, Math.round(period / 2));
  const hi = Math.max(lo + 1, Math.round(period * 2));
  const cum = new Float64Array(n);
  const back = new Int32Array(n).fill(-1);
  for (let i = 0; i < n; i++) {
    if (i - lo < 0) { cum[i] = local[i]; continue; }
    let bestVal = -Infinity;
    let bestJ = -1;
    const jEnd = i - lo;
    const jStart = Math.max(0, i - hi);
    for (let j = jStart; j <= jEnd; j++) {
      const ratio = (i - j) / period;
      const v = cum[j] - TIGHTNESS * Math.log(ratio) ** 2;
      if (v > bestVal) { bestVal = v; bestJ = j; }
    }
    cum[i] = local[i] + Math.max(0, bestVal);
    back[i] = bestVal > 0 ? bestJ : -1;
  }
  // The chain ends at the strongest cumulative score in the last period.
  let end = -1;
  let endVal = -Infinity;
  for (let i = Math.max(0, n - Math.ceil(period)); i < n; i++) {
    if (cum[i] > endVal) { endVal = cum[i]; end = i; }
  }
  if (end < 0) return [];
  const frames = [];
  for (let i = end; i >= 0; i = back[i]) {
    frames.push(i);
    if (back[i] < 0) break;
  }
  frames.reverse();
  // Beats the chain stepped over at the very start (before its first full period)
  // are not invented — but a chain that starts late because the first onset is the
  // strongest anchor keeps what it found; nothing is extrapolated either way.
  return frames;
}

// ---------- Whole-signal analysis ----------

// samples: mono PCM in [-1, 1]; sr: its sample rate. Returns { bpm, beats } with
// beat times in seconds (the centre of the STFT window that first heard the onset),
// or null when no steady tempo is found (silence, speech, rubato).
function analyzePcm(samples, sr) {
  if (!samples || samples.length < sr * 2) return null; // under two seconds: no pulse to find
  const env = onsetEnvelope(samples, sr);
  const hopSec = HOP / sr;
  let energy = 0;
  for (let i = 0; i < env.length; i++) energy += env[i];
  if (!(energy > 0)) return null;
  const tempo = estimateTempo(env, hopSec);
  if (!tempo) return null;
  const frames = trackBeats(env, tempo.period);
  if (frames.length < 4) return null;
  const beats = frames.map((f) => Math.round((f * HOP + WIN / 2) / sr * 1000) / 1000);
  // The tracked period, re-measured from the beats themselves, is the tempo we
  // report: it is the grid the markers actually sit on. The MEAN gap over the whole
  // chain, not the median — when the true period is not a whole number of hops the
  // gaps alternate between two frame counts and the median picks one side, which at
  // 100 BPM already reads 1.3 BPM off.
  const meanGap = ((frames[frames.length - 1] - frames[0]) / (frames.length - 1)) * hopSec;
  return { bpm: Math.round((60 / meanGap) * 10) / 10, beats };
}

// ---------- WAV reading ----------

// Minimal RIFF/WAVE reader for the mixdown the app itself writes (16-bit PCM, mono).
function readWavPcm(file) {
  const buf = fs.readFileSync(file);
  if (buf.length < 44 || buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WAVE') {
    throw new Error('The rendered soundtrack could not be read back.');
  }
  let fmt = null;
  let data = null;
  for (let off = 12; off + 8 <= buf.length;) {
    const id = buf.toString('latin1', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === 'fmt ') fmt = { format: buf.readUInt16LE(off + 8), channels: buf.readUInt16LE(off + 10), rate: buf.readUInt32LE(off + 12), bits: buf.readUInt16LE(off + 22) };
    if (id === 'data') { data = buf.subarray(off + 8, off + 8 + size); break; }
    off += 8 + size + (size % 2);
  }
  if (!fmt || !data || fmt.format !== 1 || fmt.bits !== 16) throw new Error('The rendered soundtrack could not be read back.');
  const count = Math.floor(data.length / 2 / fmt.channels);
  const out = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    let v = 0;
    for (let ch = 0; ch < fmt.channels; ch++) v += data.readInt16LE((i * fmt.channels + ch) * 2) / 32768;
    out[i] = v / fmt.channels;
  }
  return { samples: out, rate: fmt.rate };
}

// ---------- Project analysis (cached) ----------

// The soundtrack's identity: every file and range that feeds the mixdown, with the
// files' sizes and mtimes — any edit that changes what is heard re-keys the cache.
function projectKey(project) {
  const mediaById = new Map((project.media || []).map((m) => [m.id, m]));
  const stamp = (m) => {
    if (!m || !m.path) return 'gone';
    try {
      const st = fs.statSync(m.path);
      return `${m.path}|${st.size}|${Math.round(st.mtimeMs)}`;
    } catch { return `${m.path}|gone`; }
  };
  const parts = [];
  for (const c of project.videoClips || []) {
    if (c.gap) { parts.push(`gap|${c.out - c.in}`); continue; }
    const m = mediaById.get(c.mediaId);
    parts.push(`v|${stamp(m)}|${c.in}|${c.out}|${c.speed || 1}|${c.volume ?? 1}|${c.muted ? 1 : 0}|${JSON.stringify(c.audioFx || null)}`);
  }
  for (const c of project.audioClips || []) {
    const m = mediaById.get(c.mediaId);
    parts.push(`a|${stamp(m)}|${c.start}|${c.in}|${c.out}|${c.speed || 1}|${c.volume ?? 1}|${JSON.stringify(c.audioFx || null)}`);
  }
  return crypto.createHash('sha1').update(`beats1|${parts.join(';')}`).digest('hex').slice(0, 16);
}

function hasSound(project) {
  const mediaById = new Map((project.media || []).map((m) => [m.id, m]));
  const audible = (c) => {
    const m = mediaById.get(c.mediaId);
    return !!m && m.type !== 'image' && !!m.hasAudio && !c.muted;
  };
  return (project.videoClips || []).some((c) => !c.gap && audible(c)) || (project.audioClips || []).some(audible);
}

// Analyses the project's soundtrack. Returns { bpm, beats, cached } — beats are
// timeline seconds. Throws Error('...') with a user-facing message, or an error with
// .canceled set when isCanceled() turns true.
async function analyzeProject(project, { cacheDir, onProgress, isCanceled = () => false }) {
  if (!hasSound(project)) throw new Error('Add a clip with sound to the timeline first — the beats are heard in its soundtrack.');
  fs.mkdirSync(cacheDir, { recursive: true });
  const key = projectKey(project);
  const out = path.join(cacheDir, `${key}-beats.json`);
  if (fs.existsSync(out)) {
    try {
      const hit = JSON.parse(fs.readFileSync(out, 'utf8'));
      if (hit && Array.isArray(hit.beats)) return { ...hit, cached: true };
    } catch { /* a corrupt cache entry is re-analysed */ }
  }
  const { renderTimelineAudio } = require('./ffmpeg.cjs');
  const wav = path.join(cacheDir, `${key}-mix.wav`);
  onProgress?.('render', 0.05);
  await renderTimelineAudio(project, wav, 'all');
  if (isCanceled()) {
    fs.rmSync(wav, { force: true });
    const e = new Error('Canceled.');
    e.canceled = true;
    throw e;
  }
  onProgress?.('analyze', 0.75);
  const { samples, rate } = readWavPcm(wav);
  fs.rmSync(wav, { force: true });
  const found = analyzePcm(samples, rate);
  if (!found) throw new Error('No steady beat could be heard in the soundtrack. Beat detection works best on music with a regular pulse.');
  const result = { bpm: found.bpm, beats: found.beats };
  fs.writeFileSync(out, JSON.stringify(result));
  onProgress?.('analyze', 1);
  return { ...result, cached: false };
}

module.exports = { analyzePcm, analyzeProject, onsetEnvelope, estimateTempo, trackBeats, readWavPcm, projectKey, hasSound, HOP, WIN };
