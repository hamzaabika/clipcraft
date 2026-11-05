// Export text-phase progress + static-frame signatures.
// - The throttled reporter emits monotonic values, keeps emitting across a
//   long blank run (the old code only reported inside the visible branch,
//   every 5 frames, so the bar froze inside caption gaps), and ends at 1.
// - src/exportText.js wires report() for every frame iteration.
// - Static-frame signatures are only non-null when a frame is provably
//   identical to its predecessor. Usage: node scripts/test-export-progress.mjs
import assert from 'assert/strict';
import fs from 'fs';
import { createProgressReporter, monotonicProgress } from '../src/exportProgress.js';
import { clipStaticSignature, textLayerSignature } from '../src/text/staticFrame.js';

// Reporter over a simulated 300-frame run: frames 30..240 are a "blank run"
// (no visible text) — progress must keep moving through it.
{
  let now = 0;
  const seen = [];
  const r = createProgressReporter((v) => seen.push(v), { now: () => now });
  for (let i = 0; i < 300; i++) { now += 16; r.report(i / 300); }
  r.finish();
  assert.ok(seen.length > 10 && seen.length < 300, `throttled emissions (${seen.length})`);
  assert.ok(seen.every((v, i) => i === 0 || v > seen[i - 1]), 'emissions strictly increase');
  assert.ok(seen.some((v) => v > 0.3 && v < 0.7), 'progress moves through the blank middle of the run');
  assert.equal(seen[seen.length - 1], 1, 'finishes at 1');
  assert.equal(monotonicProgress(0.5, 0.2), 0.5, 'monotonic clamp holds');
  assert.equal(monotonicProgress(0.5, 0.7), 0.7);
}

// exportText wiring: report() runs for every frame, before the visible/blank
// branch, and the old every-5-frames visible-only call is gone.
{
  const src = fs.readFileSync(new URL('../src/exportText.js', import.meta.url), 'utf8');
  assert.ok(!src.includes('i % 5'), 'the old every-5-frames report is gone');
  const loop = src.slice(src.indexOf('for (let i = 0;'));
  assert.ok(loop.indexOf('reporter.report') >= 0 && loop.indexOf('reporter.report') < loop.indexOf('textVisible(c, t)'),
    'progress is reported before the blank/visible branch, for every frame');
  assert.ok(src.includes('reporter.finish()'), 'the phase always ends at 1');
}

// Static signatures.
const settled = { animIn: { id: 'none', dur: 0 }, animOut: { id: 'none', dur: 0 }, animLoop: { id: 'none', speed: 1 } };
const cap = (patch) => ({ id: 'a', text: 'hello world', start: 0, duration: 6, ...settled, highlight: { mode: 'none' }, ...patch });
assert.ok(clipStaticSignature(cap({}), 1) !== null, 'a settled caption is static');
assert.equal(clipStaticSignature(cap({}), 1), clipStaticSignature(cap({}), 3), 'same state, same signature');
assert.equal(clipStaticSignature(cap({ animIn: { id: 'fade', dur: 0.3 } }), 0.1), null, 'In animation still running: not static');
assert.ok(clipStaticSignature(cap({ animIn: { id: 'fade', dur: 0.3 } }), 2) !== null, 'In animation finished: static');
assert.equal(clipStaticSignature(cap({ animOut: { id: 'fade', dur: 0.25 } }), 5.9), null, 'Out animation started: not static');
assert.equal(clipStaticSignature(cap({ animLoop: { id: 'pulse', speed: 1 } }), 2), null, 'loop animation: never static');
assert.equal(clipStaticSignature(cap({ pin: { track: 'video' } }), 2), null, 'pinned clip: never static');
assert.equal(clipStaticSignature(cap({ highlight: { mode: 'karaoke', color: '#fff' } }), 2), null, 'karaoke sweep: never static');
// Discrete highlight: the active word index is part of the signature.
const wordy = cap({
  highlight: { mode: 'color', color: '#ffd400' },
  words: [{ text: 'hello', start: 0, end: 1 }, { text: 'world', start: 1, end: 2 }],
});
assert.notEqual(clipStaticSignature(wordy, 0.5), clipStaticSignature(wordy, 1.5), 'active word change changes the signature');
assert.equal(clipStaticSignature(wordy, 0.5), clipStaticSignature(wordy, 0.8), 'same active word: static');
// Reveal eases the word in after it starts: dynamic inside the window, static after.
const reveal = cap({ highlight: { mode: 'reveal', color: '#fff' }, words: wordy.words });
assert.equal(clipStaticSignature(reveal, 0.05), null, 'reveal inside its ease window: not static');
assert.ok(clipStaticSignature(reveal, 0.5) !== null, 'reveal settled after the window: static');
// Layer level: a moving clip anywhere makes the whole layer dynamic.
const proj = { textClips: [cap({}), cap({ id: 'b', start: 10, duration: 4 })] };
assert.ok(textLayerSignature(proj, 2) !== null, 'only the settled clip visible: static');
assert.equal(textLayerSignature({ textClips: [cap({ animLoop: { id: 'pulse', speed: 1 } })] }, 2), null);
assert.equal(textLayerSignature(proj, 20), null, 'nothing visible: null (blank-run path)');
console.log('export-progress OK');
