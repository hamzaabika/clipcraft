// Static-frame detection for the text export (pure logic, no DOM).
//
// A frame of the text layer is PROVABLY unchanged from the previous frame when
// every visible clip is settled (its In animation has finished, its Out
// animation has not started, it has no loop animation and no motion pin) and
// every time-dependent highlight is in a discrete state whose index is part of
// the signature below. When the signature of frame i equals the signature of
// frame i-1, the drawn pixels are identical, so the exporter can reuse the
// { same: n } run mechanism instead of redrawing and diffing a full frame.
//
// Anything this module cannot prove static returns null (never static):
// karaoke sweeps (continuous), reveal/single highlights still inside their
// ease window, pinned (motion-tracked) clips, loop animations, and legacy
// `anim` clips whose timing model differs.

const DEFAULT_ANIM_IN = { id: 'fade', dur: 0.3 };
const DEFAULT_ANIM_OUT = { id: 'fade', dur: 0.25 };

// Word timings the renderer uses for a clip: its own word list when it matches
// the word count, otherwise an even split of the clip duration.
function wordTimes(clip, n) {
  if (Array.isArray(clip.words) && clip.words.length === n) return clip.words;
  const d = (clip.duration || 0) / Math.max(1, n);
  return Array.from({ length: n }, (_, i) => ({ start: i * d, end: (i + 1) * d }));
}

function activeIndex(times, lt) {
  let a = -1;
  for (let i = 0; i < times.length; i++) if (times[i].start <= lt) a = i;
  return a;
}

// Signature of one clip at local time lt, or null when it may be moving.
export function clipStaticSignature(clip, lt) {
  if (!clip || clip.pin) return null;
  if (clip.animIn === undefined && clip.anim !== undefined && clip.anim !== 'none') return null;
  const animIn = { ...DEFAULT_ANIM_IN, ...(clip.animIn || {}) };
  const animOut = { ...DEFAULT_ANIM_OUT, ...(clip.animOut || {}) };
  const animLoop = clip.animLoop || { id: 'none' };
  if (animLoop.id && animLoop.id !== 'none') return null;
  const settledIn = animIn.id === 'none' || !(animIn.dur > 0) || lt >= animIn.dur;
  const settledOut = animOut.id === 'none' || !(animOut.dur > 0) || (clip.duration - lt) >= animOut.dur;
  if (!settledIn || !settledOut) return null;
  const hl = clip.highlight || { mode: 'none' };
  const mode = hl.mode || 'none';
  if (mode === 'karaoke') return null; // the sweep moves continuously inside a word
  let active = -1;
  if (mode !== 'none') {
    const words = String(clip.text || '').split(/\s+/).filter(Boolean);
    if (!words.length) return `${clip.id}|-1`;
    const times = wordTimes(clip, words.length);
    active = activeIndex(times, lt);
    // 'reveal' / 'single' ease the active word in over ~0.15 s / 0.12 s after it
    // starts; inside that window (and before the first word) the frame moves.
    if (mode === 'reveal' || mode === 'single') {
      if (active < 0) return null;
      if (lt - (times[active].start || 0) < 0.2) return null;
    }
  }
  return `${clip.id}|${active}`;
}

// Signature of the whole text layer at timeline time t, or null when any
// visible clip may be moving (or no clip is visible — the caller's blank-run
// path handles that case).
export function textLayerSignature(project, t) {
  const parts = [];
  for (const c of project.textClips || []) {
    if (!(t >= c.start && t < c.start + c.duration)) continue;
    const sig = clipStaticSignature(c, t - c.start);
    if (sig === null) return null;
    parts.push(sig);
  }
  return parts.length ? parts.join(';') : null;
}
