// Auto-reframe analysis: face tracking over a clip's range, in the main process. Frames are pulled from
// FFmpeg at 5 fps as small RGB pictures (320x240, the detector's input size) and run through an
// ultra-light face detector (RFB-320, ONNX) on the ONNX runtime the app already bundles for background
// removal. The model (1.3 MB, MIT, from its own GitHub repo) is downloaded on first use, like the
// speech and matting models; nothing leaves the PC. The result is a path of face centres in source
// fractions — { t (source seconds), x, y, w, h, s } per sampled frame, x/y null when no face is seen —
// cached by file, range and model like the other derivative renders (matte / track / stabilize).
// The renderer (src/reframe.js) turns the path into a smoothed, keyframed crop on a 9:16 project copy.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const MODEL = {
  file: 'ultralight-face-rfb320.onnx',
  url: 'https://raw.githubusercontent.com/Linzaer/Ultra-Light-Fast-Generic-Face-Detector-1MB/master/models/onnx/version-RFB-320.onnx',
  size: 1270727,
  sha256: '34cd7e60aeff28744c657de7a3dc64e872d506741de66987f3426f2b79f88017',
};
const W = 320; // detector input size (the graph is fixed at 320x240)
const H = 240;
const SAMPLE_FPS = 5; // face samples per source second — the renderer smooths the path from these
const SCORE_MIN = 0.5; // candidate face threshold (the model's own demos use 0.5-0.7)
const NMS_IOU = 0.3;

const modelPath = (dir) => path.join(dir, MODEL.file);
const status = (dir) => ({ installed: fs.existsSync(modelPath(dir)) && fs.statSync(modelPath(dir)).size === MODEL.size });

async function sha256File(file) {
  const h = crypto.createHash('sha256');
  await new Promise((resolve, reject) => {
    const s = fs.createReadStream(file);
    s.on('data', (d) => h.update(d));
    s.on('end', resolve);
    s.on('error', reject);
  });
  return h.digest('hex');
}

// Downloads the model once and verifies it (size + sha256) before it counts as installed.
// onProgress(fraction).
async function install(dir, onProgress, fetchImpl = fetch) {
  if (status(dir).installed) return;
  fs.mkdirSync(dir, { recursive: true });
  const res = await fetchImpl(MODEL.url, { redirect: 'follow' });
  if (!res || !res.ok) throw new Error('Could not download the face detection model.');
  const total = Number(res.headers.get('content-length')) || MODEL.size;
  const tmp = `${modelPath(dir)}.part`;
  const out = fs.createWriteStream(tmp);
  let got = 0;
  if (res.body && typeof res.body.getReader === 'function') {
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      got += value.length;
      out.write(Buffer.from(value));
      onProgress?.(Math.min(0.99, got / total));
    }
    await new Promise((resolve) => out.end(resolve));
  } else {
    const buf = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(tmp, buf);
    onProgress?.(1);
  }
  if (fs.statSync(tmp).size !== MODEL.size || (await sha256File(tmp)) !== MODEL.sha256) {
    fs.rmSync(tmp, { force: true });
    throw new Error('The face detection model download did not verify. Try again.');
  }
  fs.renameSync(tmp, modelPath(dir));
  onProgress?.(1);
}

// ---------- Pure decode (scripts/test-reframe-detect.cjs exercises these directly) ----------

const iou = (a, b) => {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);
  if (x2 <= x1 || y2 <= y1) return 0;
  const inter = (x2 - x1) * (y2 - y1);
  return inter / (a.w * a.h + b.w * b.h - inter);
};

// The graph emits 4420 priors with scores [1,N,2] and boxes [1,N,4] already decoded to source
// fractions [x1,y1,x2,y2]. Threshold + greedy NMS leaves the real faces.
function decodeFaces(scores, boxes, threshold = SCORE_MIN) {
  const n = scores.length / 2;
  const cands = [];
  for (let i = 0; i < n; i++) {
    const s = scores[i * 2 + 1];
    if (s < threshold) continue;
    const x = boxes[i * 4];
    const y = boxes[i * 4 + 1];
    const w = boxes[i * 4 + 2] - x;
    const h = boxes[i * 4 + 3] - y;
    if (!(w > 0.01 && h > 0.01)) continue;
    cands.push({ x, y, w, h, s });
  }
  cands.sort((a, b) => b.s - a.s);
  const kept = [];
  for (const c of cands) if (kept.every((k) => iou(k, c) <= NMS_IOU)) kept.push(c);
  return kept;
}

// The subject of a frame: the face nearest the previous subject when there is one (a talking head
// does not teleport between frames), otherwise the most prominent face (area x score).
function pickSubject(cands, prev) {
  if (!cands.length) return null;
  if (prev) {
    const near = cands.filter((c) => Math.hypot(c.x + c.w / 2 - prev.x, c.y + c.h / 2 - prev.y) < 0.3);
    if (near.length) return near.sort((a, b) => b.w * b.h - a.w * a.h)[0];
  }
  return [...cands].sort((a, b) => b.w * b.h * b.s - a.w * a.h * a.s)[0];
}

// ---------- Analysis ----------

// Where the face path of a range goes: one per file content, range and model.
function pathFile(item, from, to, cacheDir) {
  const st = fs.statSync(item.path);
  const key = crypto.createHash('sha1')
    .update(`${item.path}|${st.size}|${st.mtimeMs}|faces1|${Number(from).toFixed(3)}|${Number(to).toFixed(3)}|${SAMPLE_FPS}`)
    .digest('hex').slice(0, 16);
  return path.join(cacheDir, `${key}-faces.json`);
}

let sessionPromise = null;
function getSession(dir) {
  if (!sessionPromise) {
    const ort = require('onnxruntime-node');
    const threads = Math.max(1, Math.min(8, require('os').cpus().length - 1));
    sessionPromise = ort.InferenceSession.create(modelPath(dir), {
      executionProviders: ['cpu'], graphOptimizationLevel: 'all', intraOpNumThreads: threads,
    }).catch((e) => { sessionPromise = null; throw e; });
  }
  return sessionPromise;
}

// Analyses item's frames in [from, to] (source seconds). Returns { points, detected, cached }:
// one point per sampled frame — { t, x, y, w, h, s } with x/y the face centre in source fractions,
// or { t, x: null } when the frame has no usable face. onProgress(fraction); isCanceled().
async function analyze(item, { dir, cacheDir, ffmpegPath, toSdr = () => '', from = 0, to, onProgress, isCanceled = () => false }) {
  if (!status(dir).installed) throw new Error('The face detection model is not downloaded yet.');
  fs.mkdirSync(cacheDir, { recursive: true });
  const out = pathFile(item, from, to, cacheDir);
  if (fs.existsSync(out)) {
    try { return { ...JSON.parse(fs.readFileSync(out, 'utf8')), cached: true }; } catch { /* a corrupt cache entry is re-analysed */ }
  }
  const session = await getSession(dir);
  const ort = require('onnxruntime-node');
  const end = to === undefined || to === null ? (item.duration || 0) : to;
  const dur = Math.max(0.1, end - from);
  const total = Math.max(1, Math.round(dur * SAMPLE_FPS));
  const sdr = toSdr(item);
  const vf = `${sdr ? `${sdr.replace(/^,/, '')},` : ''}fps=${SAMPLE_FPS},scale=${W}:${H}`;
  const dec = spawn(ffmpegPath, ['-v', 'error', '-ss', String(from), '-i', item.path, '-t', String(dur), '-an',
    '-vf', vf, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { windowsHide: true });

  const plane = W * H;
  const frameBytes = plane * 3;
  const input = new Float32Array(3 * plane);
  const points = [];
  let detected = 0;
  let prev = null;
  let n = 0;
  let stopped = false;
  const runFrame = async (frame) => {
    for (let i = 0; i < plane; i++) {
      input[i] = (frame[i * 3] - 127) / 128;
      input[plane + i] = (frame[i * 3 + 1] - 127) / 128;
      input[2 * plane + i] = (frame[i * 3 + 2] - 127) / 128;
    }
    const r = await session.run({ input: new ort.Tensor('float32', input, [1, 3, H, W]) });
    const face = pickSubject(decodeFaces(r.scores.data, r.boxes.data), prev);
    const t = Math.round((from + n / SAMPLE_FPS) * 1000) / 1000;
    if (face) {
      const p = { t, x: face.x + face.w / 2, y: face.y + face.h / 2, w: face.w, h: face.h, s: Math.round(face.s * 1000) / 1000 };
      points.push(p);
      prev = p;
      detected++;
    } else {
      points.push({ t, x: null });
    }
    n++;
    if (n % 5 === 0) onProgress?.(Math.min(0.99, n / total));
  };

  // Frames are taken from FFmpeg's output one at a time (the decoder waits while the model works),
  // the same flow as the matte render.
  let pending = Buffer.alloc(0);
  let work = Promise.resolve();
  dec.stdout.on('data', (d) => {
    if (stopped) return;
    dec.stdout.pause();
    pending = pending.length ? Buffer.concat([pending, d]) : d;
    work = work.then(async () => {
      while (!stopped && pending.length >= frameBytes) {
        if (isCanceled()) {
          stopped = true;
          dec.kill();
          dec.stdout.resume();
          break;
        }
        const f = pending.subarray(0, frameBytes);
        pending = pending.subarray(frameBytes);
        await runFrame(f);
      }
      if (!stopped) dec.stdout.resume();
    });
  });
  let decErr = '';
  dec.stderr.on('data', (d) => { decErr = (decErr + d).slice(-1000); });
  const decCode = await new Promise((resolve) => dec.on('close', resolve));
  await work;
  if (stopped) {
    const e = new Error('Canceled.');
    e.canceled = true;
    throw e;
  }
  if (decCode !== 0 || n === 0) throw new Error(`Could not read the video for face tracking. ${decErr.trim().split('\n').pop() || ''}`.trim());
  const result = { points, detected };
  fs.writeFileSync(out, JSON.stringify(result));
  onProgress?.(1);
  return result;
}

module.exports = { status, install, analyze, pathFile, decodeFaces, pickSubject, MODEL, SAMPLE_FPS };
