// Auto-reframe 9:16 (v1.1.8), the renderer half: cover geometry, face-path -> motion (smoothing,
// gap fill, keyframe generation), the project-copy builder, and an end-to-end export whose frames
// are pixel-checked: a bright box travels across a landscape clip, the copy's keyframes must keep
// it centred in the vertical export. The detector itself is covered by test-reframe-detect.cjs.
// Usage: node scripts/test-reframe.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildVerticalCopy, coverFor, pathToMotion, reframeClip } from '../src/reframe.js';
import { stateAt } from '../src/anim.js';
import { motionData } from '../src/anim.js';
import ff from '../electron/ffmpeg.cjs';

const assert = (ok, what) => { if (!ok) throw new Error(what); };
const near = (a, b, tol, what) => assert(Math.abs(a - b) <= tol, `${what}: got ${a}, expected ${b} ± ${tol}`);

const SHAPE = { width: 720, height: 1280 };
const MEDIA = { width: 1280, height: 720 };
const CLIP = { id: 'c1', mediaId: 'm0', in: 0, out: 6, speed: 1 };

// --- Cover geometry: 16:9 into 9:16 fits by width, so the cover scale is set by height.
{
  const c = coverFor(SHAPE, MEDIA, CLIP);
  near(c.fx, 1, 1e-9, 'fx');
  near(c.fy, 0.31640625, 1e-9, 'fy');
  near(c.s, 3.1604938271604937, 1e-9, 'cover scale');
  // A portrait clip in a portrait frame needs no scale at all.
  const p = coverFor(SHAPE, { width: 720, height: 1280 }, CLIP);
  near(p.s, 1, 1e-9, 'portrait cover scale');
}

// --- A still face becomes one static offset; the vertical axis is pinned (the scaled picture
// covers the frame height exactly, so any y shift would expose the background).
{
  const pts = Array.from({ length: 31 }, (_, i) => ({ t: i * 0.2, x: 0.25, y: 0.3 }));
  const m = pathToMotion(pts, CLIP, MEDIA, SHAPE);
  assert(m && m.at, 'static motion returned');
  near(m.at.x, 0.7901, 0.001, 'static x centres the face');
  near(m.at.y, 0, 1e-9, 'static y pinned');
}

// --- A moving face becomes keyframes; sampled through the app's own stateAt, the subject's
// stage position stays at the centre while it crosses the frame.
{
  const pts = Array.from({ length: 31 }, (_, i) => ({ t: i * 0.2, x: 0.2 + (0.6 * (i * 0.2)) / 6, y: 0.5 }));
  const proj = {
    id: 'p0', name: 'Walk', ratio: '16:9', resolution: 720, width: 1280, height: 720, fps: 30, background: '#000',
    media: [{ id: 'm0', type: 'video', width: 1280, height: 720, duration: 6 }],
    videoClips: [CLIP], overlayClips: [], textClips: [], audioClips: [], stickerClips: [], effectClips: [], markers: [],
  };
  const copy = buildVerticalCopy(proj, { c1: pts }, () => 'copyid');
  const cc = copy.videoClips[0];
  assert(cc.keyframes && cc.keyframes.x && cc.keyframes.x.length >= 2, 'x keyframes written');
  const { fx, s } = coverFor(SHAPE, MEDIA, cc);
  for (const lt of [1, 2, 3, 4, 5]) {
    const st = stateAt(cc, lt, 6);
    const rx = 0.2 + (0.6 * lt) / 6; // the face's true position at this moment
    const stage = 0.5 + st.transform.x + (rx - 0.5) * fx * s;
    near(stage, 0.5, 0.04, `subject centred at t=${lt}`);
  }
  // The copy's own shape and identity.
  assert(copy.id === 'copyid' && copy.name === 'Walk (9:16)' && copy.ratio === '9:16', 'copy identity');
  assert(copy.width === 720 && copy.height === 1280 && copy.ratioLocked === true, 'copy shape');
  assert(proj.videoClips[0].keyframes === undefined && proj.ratio === '16:9', 'original untouched');
}

// --- Jitter: a face wobbling ±0.02 at sample rate must not shake the window.
{
  const pts = Array.from({ length: 31 }, (_, i) => ({ t: i * 0.2, x: 0.5 + (i % 2 ? 0.02 : -0.02), y: 0.5 }));
  const m = pathToMotion(pts, CLIP, MEDIA, SHAPE);
  assert(m && m.at, 'jitter settles to a static offset');
  near(m.at.x, 0, 0.01, 'jitter centred');
}

// --- Holes: a second without a face holds the last position, never NaN.
{
  const pts = Array.from({ length: 31 }, (_, i) => {
    const t = i * 0.2;
    return t > 2 && t < 3 ? { t, x: null } : { t, x: 0.3 + 0.05 * Math.sin(t), y: 0.4 };
  });
  const m = pathToMotion(pts, CLIP, MEDIA, SHAPE);
  assert(m, 'motion across a hole');
  const lists = m.keys ? [m.keys.x, m.keys.y] : [];
  for (const l of lists) for (const k of l) assert(Number.isFinite(k.v) && Number.isFinite(k.t), 'finite keys across the hole');
  // No face anywhere: no motion, but the clip still gets its cover scale.
  assert(pathToMotion(pts.map((p) => ({ t: p.t, x: null })), CLIP, MEDIA, SHAPE) === null, 'no face -> no motion');
  const bare = reframeClip({ ...CLIP }, MEDIA, SHAPE, null);
  near(bare.transform.scale, 3.1604938271604937, 1e-4, 'faceless clip still covered');
  assert(!bare.keyframes, 'faceless clip has no keyframes');
}

// --- Crop composition: with the left half cropped away, a face at the visible centre needs
// no pan at all (the path is measured inside the region the user actually sees).
{
  const clip = { ...CLIP, crop: { l: 0.5, t: 0, r: 0, b: 0 } };
  const pts = Array.from({ length: 11 }, (_, i) => ({ t: i * 0.2, x: 0.75, y: 0.5 }));
  const m = pathToMotion(pts, clip, MEDIA, SHAPE);
  assert(m && m.at, 'cropped static motion');
  near(m.at.x, 0, 0.01, 'face at the cropped centre -> no pan');
}

// --- Builder: gaps and non-picture structure pass through; an image is centred, not tracked.
{
  const proj = {
    id: 'p1', name: 'Mix', ratio: '16:9', resolution: 720, width: 1280, height: 720, fps: 30, background: '#000',
    media: [
      { id: 'm0', type: 'video', width: 1280, height: 720, duration: 6 },
      { id: 'm1', type: 'image', width: 1280, height: 720, duration: 0 },
    ],
    videoClips: [
      { id: 'g1', gap: true, in: 0, out: 2, speed: 1 },
      { id: 'c2', mediaId: 'm1', in: 0, out: 4, speed: 1 },
      { id: 'c3', mediaId: 'gone', in: 0, out: 4, speed: 1 },
    ],
    overlayClips: [], textClips: [{ id: 't1', text: 'Hi', start: 0, duration: 2 }],
    audioClips: [{ id: 'a1', mediaId: 'm0', start: 0, in: 0, out: 4, speed: 1 }], stickerClips: [], effectClips: [], markers: [],
  };
  const before = JSON.stringify(proj);
  const copy = buildVerticalCopy(proj, {}, () => 'id2');
  assert(JSON.stringify(proj) === before, 'builder never mutates the original');
  assert(!('transform' in copy.videoClips[0]), 'gap clip untouched');
  near(copy.videoClips[1].transform.scale, 3.1604938271604937, 1e-4, 'image covered');
  assert(!('transform' in copy.videoClips[2]), 'clip with missing media untouched');
  assert(copy.textClips[0].text === 'Hi' && copy.audioClips.length === 1, 'other tracks copied');
}

// --- End to end through the real export: a bright box crosses the frame; the vertical export
// must keep it centred (luminance centroid near the middle at three moments).
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fve-reframe-'));
  const src = path.join(dir, 'box.mp4');
  // The moving box is piped in as raw frames: this ffmpeg build does not evaluate drawbox
  // expressions, and a streamed fixture is exact anyway. Box: 240x240 white at (80 + 160t, 240)
  // on a near-black 1280x720 frame, 30 fps for 6 s.
  {
    const { spawn } = await import('node:child_process');
    const enc = spawn(ff.ffmpegPath, ['-y', '-loglevel', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgb24',
      '-s', '1280x720', '-r', '30', '-i', '-', '-pix_fmt', 'yuv420p', src]);
    const frame = Buffer.alloc(1280 * 720 * 3, 24);
    for (let n = 0; n < 180; n++) {
      const bx = Math.round(80 + (160 * n) / 30);
      for (let y = 240; y < 480; y++) frame.fill(255, (y * 1280 + bx) * 3, (y * 1280 + bx + 240) * 3);
      if (!enc.stdin.write(frame)) await new Promise((r) => enc.stdin.once('drain', r));
      for (let y = 240; y < 480; y++) frame.fill(24, (y * 1280 + bx) * 3, (y * 1280 + bx + 240) * 3);
    }
    enc.stdin.end();
    await new Promise((r) => enc.on('close', r));
  }
  const item = { ...(await ff.probe(src)), path: src };
  const media = [{ ...item, id: 'm0', name: 'box.mp4' }];
  // The box's centre in source fractions at time t — the path the detector would report.
  const pts = Array.from({ length: 31 }, (_, i) => {
    const t = i * 0.2;
    return { t, x: (200 + 160 * t) / 1280, y: 0.5, w: 0.19, h: 0.33, s: 0.99 };
  });
  const proj = {
    id: 'p2', name: 'Box', ratio: '16:9', resolution: 720, width: 1280, height: 720, fps: 30, background: '#000000',
    media, videoClips: [{ id: 'c1', mediaId: 'm0', in: 0, out: 6, speed: 1, volume: 1, filter: 'none', adjust: {}, effects: [], transition: null }],
    overlayClips: [], textClips: [], audioClips: [], stickerClips: [], effectClips: [], markers: [],
  };
  const copy = buildVerticalCopy(proj, { c1: pts }, () => 'copy2');
  const out = path.join(dir, 'vertical.mp4');
  await ff.runExport({ ...copy, motion: motionData(copy) }, out, () => {}).promise;
  const info = await ff.probe(out);
  assert(info.width === 720 && info.height === 1280, `export is vertical (${info.width}x${info.height})`);
  near(info.duration, 6, 0.15, 'export duration');
  for (const t of [1, 3, 5]) {
    const buf = execFileSync(ff.ffmpegPath, ['-v', 'error', '-ss', String(t), '-i', out, '-frames:v', '1',
      '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], { maxBuffer: 1e8 });
    let sw = 0;
    let sx = 0;
    for (let y = 0; y < 1280; y += 2) {
      for (let x = 0; x < 720; x += 2) {
        const v = buf[y * 720 + x];
        if (v > 128) { sw += v; sx += v * x; }
      }
    }
    assert(sw > 0, `bright subject present at t=${t}`);
    near(sx / sw, 360, 45, `subject centroid centred at t=${t}`);
  }
  console.log('REFRAME OK');
}
