// Duration truth: exportDuration() (what the Export dialog shows) must equal
// buildExportArgs' total (what FFmpeg progress divides by) on every fixture —
// plain clips, gaps, transitions with overlap, speed != 1, image clips, and a
// clip whose media is missing (the case that actually diverged: the encoder
// drops it, the dialog used to keep counting it).
// Usage: node scripts/test-export-duration.mjs
import assert from 'assert/strict';
import { createRequire } from 'node:module';
import { exportDuration } from '../src/store.js';

const require = createRequire(import.meta.url);
const { buildExportArgs } = require('../electron/ffmpeg.cjs');

const media = [
  { id: 'v1', path: '/x/a.mp4', type: 'video', duration: 30, hasAudio: true, width: 1280, height: 720 },
  { id: 'v2', path: '/x/b.mp4', type: 'video', duration: 30, hasAudio: false, width: 1280, height: 720 },
  { id: 'im', path: '/x/p.png', type: 'image', duration: 0, hasAudio: false, width: 800, height: 800 },
];
const clip = (patch) => ({ volume: 1, muted: false, filter: 'none', adjust: {}, effects: [], transition: null, speed: 1, ...patch });
const proj = (videoClips) => ({
  width: 1280, height: 720, fps: 30, background: '#000000', media,
  videoClips, overlayClips: [], textClips: [], audioClips: [],
});
const cases = {
  'plain clips': proj([clip({ id: 'a', mediaId: 'v1', in: 0, out: 2 }), clip({ id: 'b', mediaId: 'v2', in: 0, out: 3 })]),
  'gap between clips': proj([clip({ id: 'a', mediaId: 'v1', in: 0, out: 2 }), { id: 'g', gap: true, in: 0, out: 1.5, speed: 1 }, clip({ id: 'b', mediaId: 'v2', in: 0, out: 2 })]),
  'transition overlap': proj([clip({ id: 'a', mediaId: 'v1', in: 0, out: 4 }), clip({ id: 'b', mediaId: 'v2', in: 0, out: 4, transition: { type: 'fade', duration: 1 } })]),
  'transition clamped to half a clip': proj([clip({ id: 'a', mediaId: 'v1', in: 0, out: 4 }), clip({ id: 'b', mediaId: 'v2', in: 0, out: 4, transition: { type: 'fade', duration: 5 } })]),
  'speeds differ from 1': proj([clip({ id: 'a', mediaId: 'v1', in: 0, out: 6, speed: 2 }), clip({ id: 'b', mediaId: 'v2', in: 0, out: 2, speed: 0.5 })]),
  'image clip': proj([clip({ id: 'a', mediaId: 'im', in: 0, out: 4 }), clip({ id: 'b', mediaId: 'v1', in: 0, out: 2 })]),
  'trimmed + sped + transition': proj([clip({ id: 'a', mediaId: 'v1', in: 5, out: 11, speed: 1.5 }), clip({ id: 'b', mediaId: 'v2', in: 2, out: 5, speed: 1, transition: { type: 'fadeblack', duration: 0.6 } })]),
  'missing media clip is dropped by both': proj([clip({ id: 'a', mediaId: 'v1', in: 0, out: 2 }), clip({ id: 'x', mediaId: 'gone', in: 0, out: 3 }), clip({ id: 'b', mediaId: 'v2', in: 0, out: 2 })]),
};
for (const [name, p] of Object.entries(cases)) {
  const shown = exportDuration(p);
  const { total } = buildExportArgs(p, '/tmp/out.mp4');
  assert.ok(Math.abs(shown - total) < 1e-9, `${name}: dialog ${shown} != encoder total ${total}`);
  console.log(`  ${name}: ${shown}s == ${total}s`);
}
console.log('export-duration OK — dialog duration and encoder total agree on all fixtures');
