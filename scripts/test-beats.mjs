// Beat cuts (v1.1.9), the store + renderer half: the beat grid on the project
// (set / clear / normalize), Split at beats (one clip cut on every interior beat in
// ONE undo step, edges and slivers respected, linked audio cut in sync), and the
// toolbar targeting helpers in src/beats.js. The hearing itself (electron/beats.cjs)
// is covered by scripts/test-beats-detect.cjs.
// Usage: node scripts/test-beats.mjs
import { emptyProject, historyReducer, normalizeProject, projectDuration, splitClipAtBeats, videoLayout } from '../src/store.js';
import { beatSplitTarget, beatsOf, interiorBeats } from '../src/beats.js';

const assert = (ok, what) => { if (!ok) throw new Error(what); };
const near = (a, b, what) => assert(Math.abs(a - b) < 1e-9, `${what}: got ${a}, expected ${b}`);

const state = (project) => ({ past: [], present: project, future: [] });
const clip = (id, over = {}) => ({ id, mediaId: 'm0', in: 0, out: 10, speed: 1, volume: 1, muted: false, filter: 'none', adjust: {}, effects: [], transition: null, ...over });
const base = (videoClips, over = {}) => ({
  ...emptyProject(),
  media: [{ id: 'm0', type: 'video', duration: 40, width: 1280, height: 720, hasAudio: true }],
  videoClips,
  ...over,
});
const grid = (from, to, step) => {
  const t = [];
  for (let x = from; x <= to + 1e-9; x += step) t.push(Math.round(x * 1000) / 1000);
  return t;
};

// --- The grid on the project: stored sorted, cleared by null, dropped when malformed.
{
  let s = state(base([clip('v1')]));
  s = historyReducer(s, { type: 'setBeats', beats: { bpm: 120, times: [2, 0.5, 1] } });
  assert(s.present.beats.bpm === 120, 'bpm stored');
  assert(JSON.stringify(s.present.beats.times) === '[0.5,1,2]', 'times stored sorted');
  s = historyReducer(s, { type: 'setBeats', beats: null });
  assert(s.present.beats === null, 'grid cleared');
  const kept = normalizeProject({ ...base([clip('v1')]), beats: { bpm: 99, times: [1, 2] } });
  assert(kept.beats && kept.beats.bpm === 99 && kept.beats.times.length === 2, 'normalize keeps a valid grid');
  assert(normalizeProject({ ...base([clip('v1')]), beats: { bpm: 99 } }).beats === null, 'normalize drops a grid without times');
  assert(normalizeProject({ ...base([clip('v1')]), beats: { bpm: 99, times: [] } }).beats === null, 'normalize drops an empty grid');
  assert(beatsOf(base([clip('v1')])).length === 0, 'beatsOf empty without a grid');
}

// --- interiorBeats: the MIN_CLIP margins at both edges.
{
  const inside = interiorBeats([0.05, 0.5, 5, 9.95, 10.5], 0, 10);
  assert(JSON.stringify(inside) === '[0.5,5]', `interior beats ${inside}`);
}

// --- Split at beats: a 10 s clip on a 0.5 s grid becomes 20 exact pieces, one undo step.
{
  const p = base([clip('v1')], { beats: { bpm: 120, times: grid(0.5, 9.5, 0.5) } });
  let s = state(p);
  const newIds = Array.from({ length: 40 }, (_, i) => `nb${i}`);
  s = historyReducer(s, { type: 'splitAtBeats', id: 'v1', newIds });
  const layout = videoLayout(s.present.videoClips);
  assert(layout.length === 20, `pieces ${layout.length}, expected 20`);
  layout.forEach((l, i) => {
    near(l.start, i * 0.5, `piece ${i} start`);
    near(l.end, (i + 1) * 0.5, `piece ${i} end`);
    near(l.clip.in, i * 0.5, `piece ${i} source in`);
    near(l.clip.out, (i + 1) * 0.5, `piece ${i} source out`);
  });
  near(projectDuration(s.present), 10, 'total duration unchanged');
  assert(s.past.length === 1, 'the whole beat cut is one undo step');
  const undone = historyReducer(s, { type: 'undo' });
  assert(undone.present.videoClips.length === 1, 'one undo restores the whole clip');
  assert(splitClipAtBeats(p, 'v1', []) === p, 'no spare ids -> no cut');
}

// --- Beats outside the clip, on its edges, or too close together do not cut.
{
  const p = base(
    [clip('v1'), clip('v2', { in: 10, out: 20 })],
    { beats: { bpm: 120, times: [0.05, 3, 3.04, 9.97, 12, 25] } },
  );
  const out = splitClipAtBeats(p, 'v1', ['x1', 'x2', 'x3']);
  const layout = videoLayout(out.videoClips);
  // v1: only t=3 cuts (0.05 is inside MIN_CLIP of the start, 3.04 would leave a
  // sliver after 3, 9.97 is inside MIN_CLIP of the end, 12/25 belong to v2/outside).
  assert(layout.length === 3, `clips ${layout.length}, expected 3 (v1 in two + v2)`);
  near(layout[0].end, 3, 'first piece ends on the beat');
  near(layout[1].start, 3, 'second piece starts on the beat');
  near(layout[1].end, 10, 'second piece runs to the clip end');
  assert(splitClipAtBeats(p, 'v2', ['y1']).videoClips.length === 3, 'v2 cuts on its own beat at 12');
  // A gap is never cut, and a project without a grid is returned untouched.
  const gappy = base([{ id: 'g1', gap: true, in: 0, out: 4, speed: 1 }], { beats: { bpm: 120, times: [1, 2, 3] } });
  assert(splitClipAtBeats(gappy, 'g1', ['z1']) === gappy, 'gap clip untouched');
  const bare = base([clip('v1')]);
  assert(splitClipAtBeats(bare, 'v1', ['z1']) === bare, 'no grid -> unchanged');
}

// --- A detached (linked) soundtrack is cut at the same moments, pairs intact.
{
  const p = base(
    [{ ...clip('v1', { in: 0, out: 8 }), muted: true, linkId: 'L' }],
    {
      beats: { bpm: 120, times: [2, 4, 6] },
      audioClips: [{ id: 'a1', mediaId: 'm0', start: 0, in: 0, out: 8, speed: 1, volume: 1, fadeIn: 0, fadeOut: 0, linkId: 'L', linkOff: 0, linkInOff: 0 }],
    },
  );
  let s = state(p);
  s = historyReducer(s, { type: 'splitAtBeats', id: 'v1', newIds: ['b1', 'b2', 'b3'] });
  const vids = s.present.videoClips;
  const auds = s.present.audioClips;
  assert(vids.length === 4 && auds.length === 4, `linked pieces ${vids.length}/${auds.length}, expected 4/4`);
  const layout = videoLayout(vids);
  layout.forEach((l, i) => {
    near(l.start, i * 2, `linked piece ${i} start`);
    const partner = auds.find((a) => a.linkId === l.clip.linkId);
    assert(partner, `piece ${i} has its audio partner`);
    near(partner.start, l.start, `partner ${i} start`);
    near(partner.out - partner.in, l.clip.out - l.clip.in, `partner ${i} length`);
  });
  const linkIds = new Set(vids.map((c) => c.linkId));
  assert(linkIds.size === 4, 'each pair carries its own link id');
}

// --- Toolbar targeting: selection first, then the clip under the playhead.
{
  const p = base(
    [clip('v1'), clip('v2', { in: 10, out: 14 })],
    { beats: { bpm: 120, times: [1, 2, 11, 30] } },
  );
  const byPlayhead = beatSplitTarget(p, 2.5, null);
  assert(byPlayhead && byPlayhead.clip.id === 'v1' && byPlayhead.times.length === 2, 'playhead target: v1 with its 2 beats');
  const bySelection = beatSplitTarget(p, 2.5, { track: 'video', id: 'v2' });
  assert(bySelection && bySelection.clip.id === 'v2' && bySelection.times.length === 1, 'selection wins over the playhead');
  assert(beatSplitTarget(p, 2.5, { track: 'audio', id: 'zz' }).clip.id === 'v1', 'a non-video selection falls back to the playhead clip');
  assert(beatSplitTarget(p, 25, null) === null, 'playhead past the last clip -> no target');
  const noBeats = base([clip('v1')], { beats: { bpm: 120, times: [30] } });
  assert(beatSplitTarget(noBeats, 5, null) === null, 'no interior beat -> no target');
}

console.log('BEATS OK');
