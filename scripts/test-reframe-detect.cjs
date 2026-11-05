// Auto-reframe face detection (v1.1.8), the main-process half (electron/reframe.cjs):
// 1) The pure decode: NMS collapses the 4420 priors to the real faces; subject picking is
//    continuous (a nearby face wins over a bigger far one).
// 2) The real model (downloaded once, skipped with --offline): a public-domain portrait is
//    placed at a known spot of a test scene; the reported face path must sit on the face,
//    come back from the cache the second time, and a canceled run leaves nothing behind.
// Usage: node scripts/test-reframe-detect.cjs [--offline]
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const ff = require('../electron/ffmpeg.cjs');
const reframe = require('../electron/reframe.cjs');

const assert = (ok, what) => { if (!ok) throw new Error(what); };
const run = (args) => execFileSync(ff.ffmpegPath, ['-v', 'error', '-y', ...args]);

// --- Pure decode + subject picking (synthetic tensors, no model needed) ---
{
  const N = 4420;
  const scores = new Float32Array(N * 2);
  const boxes = new Float32Array(N * 4);
  const put = (i, s, x1, y1, x2, y2) => { scores[i * 2 + 1] = s; boxes.set([x1, y1, x2, y2], i * 4); };
  put(10, 0.99, 0.40, 0.10, 0.60, 0.40); // the face
  put(11, 0.95, 0.41, 0.11, 0.61, 0.41); // the same face, shifted a hair (NMS must drop it)
  put(12, 0.90, 0.05, 0.60, 0.15, 0.75); // a different, smaller face
  put(13, 0.40, 0.70, 0.10, 0.80, 0.30); // below threshold
  const faces = reframe.decodeFaces(scores, boxes);
  assert(faces.length === 2, `NMS kept ${faces.length} faces, expected 2`);
  assert(Math.abs(faces[0].x - 0.40) < 1e-6, 'strongest face first');
  const prev = { x: 0.10, y: 0.675 }; // previous subject: the small face at lower left
  const picked = reframe.pickSubject(faces, prev);
  assert(Math.abs(picked.x - 0.05) < 1e-6, 'continuity: the nearby face wins');
  const fresh = reframe.pickSubject(faces, null);
  assert(Math.abs(fresh.x - 0.40) < 1e-6, 'no history: the most prominent face wins');
  assert(reframe.pickSubject([], null) === null, 'no faces -> no subject');
  console.log('decode + picking ok');
}

(async () => {
  if (process.argv.includes('--offline')) { console.log('REFRAME DETECT OK (offline: model part skipped)'); return; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fve-reframe-detect-'));
  const modelDir = path.join(os.tmpdir(), 'fve-reframe-model'); // kept between runs (1.3 MB)
  const photo = path.join(modelDir, 'portrait.jpg');
  if (!fs.existsSync(photo)) {
    fs.mkdirSync(modelDir, { recursive: true });
    const res = await fetch('https://upload.wikimedia.org/wikipedia/commons/8/8d/President_Barack_Obama.jpg');
    assert(res.ok, 'portrait download failed');
    fs.writeFileSync(photo, Buffer.from(await res.arrayBuffer()));
  }
  assert(!reframe.status(path.join(dir, 'fresh')).installed, 'fresh dir has no model');
  await reframe.install(modelDir, () => {});
  assert(reframe.status(modelDir).installed, 'model installed + verified');
  await reframe.install(modelDir, () => {}); // second install is a no-op

  // Scene: the portrait (2687x3356, face centre at fractions ~(0.493, 0.200), measured with the
  // detector itself) scaled to 720 tall (576 wide) on an 854x720 black canvas at x=140.
  // Expected face centre in the scene: ((140 + 0.493*576) / 854, 0.200) = (0.4965, 0.200).
  const scene = path.join(dir, 'scene.mp4');
  run(['-loop', '1', '-i', photo, '-f', 'lavfi', '-i', 'color=c=black:s=854x720:r=30:d=4',
    '-filter_complex', '[0:v]scale=-2:720[p];[1:v][p]overlay=140:0:shortest=1[out]',
    '-map', '[out]', '-t', '4', '-pix_fmt', 'yuv420p', scene]);
  const item = { ...(await ff.probe(scene)), path: scene };
  const opts = { dir: modelDir, cacheDir: path.join(dir, 'cache'), ffmpegPath: ff.ffmpegPath, toSdr: ff.toSdr, from: 0, to: 4 };
  const r1 = await reframe.analyze(item, opts);
  assert(r1.points.length >= 18, `sampled ${r1.points.length} frames`);
  assert(r1.detected >= 15, `face found in ${r1.detected}/${r1.points.length} frames`);
  const xs = r1.points.filter((p) => p.x !== null).map((p) => p.x).sort((a, b) => a - b);
  const ys = r1.points.filter((p) => p.x !== null).map((p) => p.y).sort((a, b) => a - b);
  const med = (a) => a[Math.floor(a.length / 2)];
  assert(Math.abs(med(xs) - 0.4965) < 0.045, `face centre x ${med(xs)}, expected ~0.4965`);
  assert(Math.abs(med(ys) - 0.200) < 0.05, `face centre y ${med(ys)}, expected ~0.200`);
  const r2 = await reframe.analyze(item, opts);
  assert(r2.cached === true && r2.detected === r1.detected, 'second analysis comes from the cache');

  // A canceled run throws the canceled error and writes no cache entry.
  const long = path.join(dir, 'long.mp4');
  run(['-stream_loop', '3', '-i', scene, '-c', 'copy', long]);
  const longItem = { ...(await ff.probe(long)), path: long };
  let canceled = false;
  try {
    await reframe.analyze(longItem, { ...opts, cacheDir: path.join(dir, 'cache2'), from: 0, to: 12, isCanceled: () => true });
  } catch (e) { canceled = !!e.canceled; }
  assert(canceled, 'canceled analysis reports canceled');
  assert(!fs.existsSync(path.join(dir, 'cache2')) || fs.readdirSync(path.join(dir, 'cache2')).length === 0, 'canceled run left no cache');
  console.log('REFRAME DETECT OK');
})().catch((e) => { console.error(e); process.exit(1); });
