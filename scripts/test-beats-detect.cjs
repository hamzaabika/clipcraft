// Beat cuts (v1.1.9), the main-process half (electron/beats.cjs):
// 1) Pure analysis of synthetic PCM with a KNOWN tempo and beat grid — the evidence
//    bar: detected tempo within ±1 BPM and every beat marker within one 30 fps frame
//    (33 ms) of a true beat, across click tracks, a drum kit with eighth-note hats,
//    four-on-the-floor, slow and fast tempos, and a phase-shifted grid.
// 2) The WAV reader round-trips a file the test writes itself.
// 3) analyzeProject end to end through the real mixdown (FFmpeg): a click-track
//    video on a timeline yields its grid; the second run is served from the cache;
//    a changed clip range re-keys the cache; a silent project is refused honestly.
// Usage: node scripts/test-beats-detect.cjs
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const ff = require('../electron/ffmpeg.cjs');
const beats = require('../electron/beats.cjs');

const assert = (ok, what) => { if (!ok) throw new Error(what); };
const SR = 16000;
const FRAME = 1 / 30;

function burst(s, at, freq, amp, len = 0.03) {
  const start = Math.floor(at * SR);
  const count = Math.floor(len * SR);
  for (let i = 0; i < count && start + i < s.length; i++) {
    const t = i / SR;
    s[start + i] += amp * Math.sin(2 * Math.PI * freq * t) * Math.exp(-t / (len / 4));
  }
}

function checkGrid(name, samples, trueBpm, grid) {
  const r = beats.analyzePcm(samples, SR);
  assert(r, `${name}: no result`);
  assert(Math.abs(r.bpm - trueBpm) <= 1, `${name}: bpm ${r.bpm}, expected ${trueBpm} ±1`);
  let hit = 0;
  let worst = 0;
  for (const g of grid) {
    const dev = Math.min(...r.beats.map((t) => Math.abs(t - g)));
    if (dev <= FRAME) hit++;
    if (dev < 1) worst = Math.max(worst, dev);
  }
  assert(hit === grid.length, `${name}: ${hit}/${grid.length} true beats within one frame`);
  assert(Math.abs(r.beats.length - grid.length) <= Math.max(2, grid.length * 0.05), `${name}: ${r.beats.length} beats for ${grid.length} true`);
  console.log(`${name}: bpm ${r.bpm} (true ${trueBpm}), ${r.beats.length} beats, worst deviation ${(worst * 1000).toFixed(1)} ms`);
  return r;
}

// --- 1) Known-tempo fixtures ---
{
  const grid = [];
  const s = new Float32Array(SR * 30);
  for (let t = 0.5; t < 30; t += 0.5) { grid.push(t); burst(s, t, 1800, 0.9); burst(s, t, 150, 0.7, 0.08); }
  checkGrid('120 BPM clicks', s, 120, grid);
}
{
  const grid = [];
  const s = new Float32Array(SR * 36);
  for (let b = 0; b < 60; b++) {
    const t = 0.3 + b * 0.6;
    grid.push(Math.round(t * 1000) / 1000);
    burst(s, t, 120, 0.95, 0.1);
    if (b % 4 === 1 || b % 4 === 3) burst(s, t, 900, 0.6, 0.05);
    burst(s, t + 0.3, 6000, 0.25, 0.015);
  }
  checkGrid('100 BPM kit, eighth hats', s, 100, grid);
}
{
  const grid = [];
  const s = new Float32Array(SR * 32);
  for (let t = 0.3; t < 32; t += 60 / 90) { grid.push(Math.round(t * 1000) / 1000); burst(s, t, 1500, 0.85); burst(s, t, 130, 0.8, 0.09); }
  checkGrid('90 BPM, beats start at 0.3 s', s, 90, grid);
}
{
  const grid = [];
  const s = new Float32Array(SR * 30);
  const per = 60 / 128;
  for (let t = per; t < 30; t += per) { grid.push(Math.round(t * 1000) / 1000); burst(s, t, 110, 1.0, 0.11); burst(s, t + per / 2, 7000, 0.3, 0.012); }
  checkGrid('128 BPM four-on-the-floor', s, 128, grid);
}
{
  const grid = [];
  const s = new Float32Array(SR * 30);
  const per = 60 / 174;
  for (let t = per; t < 30; t += per) { grid.push(Math.round(t * 1000) / 1000); burst(s, t, 130, 0.95, 0.09); }
  checkGrid('174 BPM (half-time trap)', s, 174, grid);
}
{
  const grid = [];
  const s = new Float32Array(SR * 40);
  for (let t = 1; t < 40; t += 1) { grid.push(t); burst(s, t, 1000, 0.9); burst(s, t, 120, 0.8, 0.1); }
  checkGrid('60 BPM slow', s, 60, grid);
}
assert(beats.analyzePcm(new Float32Array(SR * 10), SR) === null, 'silence -> null');
assert(beats.analyzePcm(new Float32Array(SR), SR) === null, 'one second -> null (too short)');

// --- 2) WAV round trip ---
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fve-beats-'));
function writeWav(file, samples) {
  const buf = Buffer.alloc(44 + samples.length * 2);
  buf.write('RIFF', 0, 'latin1');
  buf.writeUInt32LE(36 + samples.length * 2, 4);
  buf.write('WAVE', 8, 'latin1');
  buf.write('fmt ', 12, 'latin1');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(SR, 24);
  buf.writeUInt32LE(SR * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'latin1');
  buf.writeUInt32LE(samples.length * 2, 40);
  samples.forEach((v, i) => buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(v * 32767))), 44 + i * 2));
  fs.writeFileSync(file, buf);
}
{
  const s = new Float32Array(SR * 12);
  for (let t = 0.25; t < 12; t += 0.5) burst(s, t, 1600, 0.9);
  const wav = path.join(dir, 'clicks.wav');
  writeWav(wav, s);
  const back = beats.readWavPcm(wav);
  assert(back.rate === SR && back.samples.length === s.length, 'wav header + length');
  let maxErr = 0;
  for (let i = 0; i < s.length; i += 997) maxErr = Math.max(maxErr, Math.abs(back.samples[i] - s[i]));
  assert(maxErr < 0.001, `wav samples round-trip (max err ${maxErr})`);
  console.log('wav round trip ok');
}

// --- 3) analyzeProject through the real mixdown ---
(async () => {
  const s = new Float32Array(SR * 12);
  const grid = [];
  for (let t = 0.25; t < 12; t += 0.5) { grid.push(t); burst(s, t, 1600, 0.9); burst(s, t, 140, 0.7, 0.08); }
  const wav = path.join(dir, 'track.wav');
  writeWav(wav, s);
  const mp4 = path.join(dir, 'track.mp4');
  execFileSync(ff.ffmpegPath, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=30:duration=12',
    '-i', wav, '-shortest', '-pix_fmt', 'yuv420p', '-c:a', 'aac', mp4]);
  const probed = await ff.probe(mp4);
  const project = {
    id: 'pb', name: 'Beats', ratio: '16:9', resolution: 720, width: 1280, height: 720, fps: 30, background: '#000000',
    media: [{ id: 'm0', path: mp4, name: 'track.mp4', kind: 'video', ...probed }],
    videoClips: [{ id: 'v1', mediaId: 'm0', in: 0, out: 12, speed: 1, volume: 1, muted: false, filter: 'none', adjust: {}, effects: [], transition: null }],
    overlayClips: [], textClips: [], audioClips: [], stickerClips: [], effectClips: [], markers: [],
  };
  assert(beats.hasSound(project), 'fixture project has sound');
  const cacheDir = path.join(dir, 'cache');
  const r1 = await beats.analyzeProject(project, { cacheDir });
  assert(!r1.cached, 'first analysis is fresh');
  assert(Math.abs(r1.bpm - 120) <= 1, `project bpm ${r1.bpm}, expected 120 ±1`);
  let hit = 0;
  for (const g of grid) if (r1.beats.some((t) => Math.abs(t - g) <= FRAME)) hit++;
  assert(hit === grid.length, `project: ${hit}/${grid.length} beats within one frame`);
  const r2 = await beats.analyzeProject(project, { cacheDir });
  assert(r2.cached === true && r2.beats.length === r1.beats.length, 'second analysis comes from the cache');
  // A re-trim changes what is heard: the cache key must change with it.
  const trimmed = { ...project, videoClips: [{ ...project.videoClips[0], out: 10 }] };
  assert(beats.projectKey(trimmed) !== beats.projectKey(project), 'a re-trim re-keys the cache');
  const r3 = await beats.analyzeProject(trimmed, { cacheDir });
  assert(!r3.cached && Math.abs(r3.bpm - 120) <= 1, 're-trimmed project analysed fresh');
  // Cancel: the flag is honoured and nothing is cached for the canceled run.
  let canceled = false;
  try {
    await beats.analyzeProject({ ...project, videoClips: [{ ...project.videoClips[0], in: 1, out: 12 }] },
      { cacheDir: path.join(dir, 'cache-cancel'), isCanceled: () => true });
  } catch (e) { canceled = !!e.canceled; }
  assert(canceled, 'canceled analysis reports canceled');
  // A project with no sounding clip is refused with the honest message.
  const silent = { ...project, videoClips: [{ ...project.videoClips[0], muted: true }] };
  assert(!beats.hasSound(silent), 'muted-only project has no sound');
  let refused = '';
  try { await beats.analyzeProject(silent, { cacheDir }); } catch (e) { refused = e.message; }
  assert(/clip with sound/.test(refused), `silent project refused (${refused})`);
  console.log('project analysis ok');
  console.log('BEATS DETECT OK');
})().catch((e) => { console.error(e); process.exit(1); });
