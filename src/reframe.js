// Auto-reframe 9:16 (v1.1.8): build a NEW project copy at 9:16 from the current one, where every
// main-track picture is scaled to cover the vertical frame and its position follows the subject.
// The main process (electron/reframe.cjs) returns face-centre samples per clip; everything here is
// pure math over those samples and the store's own models, so tests import this file directly.
//
// How the moving window is expressed: a clip's crop is a static property, so the window cannot
// literally move — instead the copy scales the (cropped) picture up until it covers the frame and
// animates transform.x / y keyframes (the app's existing keyframe system, sampled identically by
// the preview and the export) so the subject stays centred. The original project is never touched.
import { sizeFor } from './effects.js';
import { cropOf, transformOf } from './visual.js';
import { keptFitFactors } from './pictureGeometry.js';

export const REFRAME_RATIO = '9:16';

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const round = (v, d = 4) => Math.round(v * 10 ** d) / 10 ** d;

// The cover geometry of one clip in the vertical frame: the fitted fractions of its cropped
// region (keptFitFactors against the 9:16 shape) and the uniform scale that makes it cover.
export function coverFor(shape, media, clip) {
  const { fx, fy } = keptFitFactors(shape, media, clip);
  if (!(fx > 0) || !(fy > 0)) return null;
  return { fx, fy, s: Math.max(1 / fx, 1 / fy) };
}

// Face-centre samples -> a full-length series: frames without a face hold the last known centre
// (a talking head does not vanish between samples); a leading run takes the first known centre.
// Returns null when the clip has no detected face at all.
function fillSeries(points) {
  const known = points.filter((p) => p && p.x !== null && p.x !== undefined);
  if (!known.length) return null;
  let last = known[0];
  return points.map((p) => {
    if (p && p.x !== null && p.x !== undefined) last = p;
    return { t: p.t, x: last.x, y: last.y };
  });
}

// Centred moving average over {x, y} samples (radius in samples, passes applied). The series is
// reflect-padded first: a truncated window at the ends would drag the path toward the middle
// there (and leave sample-rate jitter alive at the edges); reflection keeps the ends honest
// and eases the window into its first position.
function smooth(series, radius = 2, passes = 2) {
  const n = series.length;
  if (n < 3) return series;
  const pad = Math.min(radius * passes, n - 1);
  const at = (arr, i) => arr[i < 0 ? -i : i >= arr.length ? 2 * (arr.length - 1) - i : i];
  let cur = [];
  for (let i = -pad; i < n + pad; i++) cur.push(at(series, i));
  for (let pass = 0; pass < passes; pass++) {
    cur = cur.map((p, i) => {
      let sx = 0;
      let sy = 0;
      let c = 0;
      for (let j = Math.max(0, i - radius); j <= Math.min(cur.length - 1, i + radius); j++) {
        sx += cur[j].x;
        sy += cur[j].y;
        c++;
      }
      return { t: p.t, x: sx / c, y: sy / c };
    });
  }
  return cur.slice(pad, pad + n).map((p, i) => ({ ...p, t: series[i].t }));
}

// Douglas-Peucker over one axis of a (t, v) series: keeps the endpoints and any point whose value
// strays more than tol from the straight line between its kept neighbours.
function simplifyAxis(pts, tol) {
  if (pts.length <= 2) return pts;
  const keep = new Array(pts.length).fill(false);
  keep[0] = keep[pts.length - 1] = true;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    if (b - a < 2) continue;
    const [ta, va] = pts[a];
    const [tb, vb] = pts[b];
    let worst = -1;
    let worstD = tol;
    for (let i = a + 1; i < b; i++) {
      const [ti, vi] = pts[i];
      const expect = va + ((vb - va) * (ti - ta)) / (tb - ta || 1);
      const d = Math.abs(vi - expect);
      if (d > worstD) { worstD = d; worst = i; }
    }
    if (worst >= 0) {
      keep[worst] = true;
      stack.push([a, worst], [worst, b]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

// The transform path of one reframed clip from its face samples (source-time seconds, centres in
// source fractions). Returns { keys: { x: [...], y: [...] } } when the window moves, { at: {x, y} }
// when it settles in one place, or null when there is no face to follow.
// Transform units are stage fractions: the fitted box (fx wide after the cover scale) is centred
// at 0.5 + tx, so the subject at region fraction rx sits at 0.5 + tx + (rx - 0.5) * fx * s;
// tx = -(rx - 0.5) * fx * s centres it, clamped so the picture always covers the frame.
export function pathToMotion(points, clip, media, shape) {
  const filled = fillSeries(points || []);
  if (!filled) return null;
  const cover = coverFor(shape, media, clip);
  if (!cover) return null;
  const { fx, fy, s } = cover;
  const c = cropOf(clip);
  const kw = 1 - c.l - c.r;
  const kh = 1 - c.t - c.b;
  const maxTx = Math.max(0, (fx * s - 1) / 2);
  const maxTy = Math.max(0, (fy * s - 1) / 2);
  const series = smooth(filled).map((p) => {
    const rx = kw > 0 ? clamp((p.x - c.l) / kw, 0, 1) : 0.5;
    const ry = kh > 0 ? clamp((p.y - c.t) / kh, 0, 1) : 0.5;
    return {
      t: p.t,
      x: clamp(-(rx - 0.5) * fx * s, -maxTx, maxTx),
      y: clamp(-(ry - 0.5) * fy * s, -maxTy, maxTy),
    };
  });
  const span = (k) => Math.max(...series.map((p) => p[k])) - Math.min(...series.map((p) => p[k]));
  if (span('x') < 0.012 && span('y') < 0.012) {
    const mid = series[Math.floor(series.length / 2)];
    return { at: { x: round(mid.x), y: round(mid.y) } };
  }
  // Per axis: a settled axis becomes ONE key (the caller turns it into a static offset);
  // a moving axis becomes its simplified key list.
  const toKeys = (k) => {
    if (span(k) < 0.012) {
      const mid = series[Math.floor(series.length / 2)];
      return [{ t: round(mid.t, 3), v: round(mid[k]) }];
    }
    // No easing on these keys: the series is already smoothed, and an eased segment would
    // bend the window off the subject between keys.
    return simplifyAxis(series.map((p) => [p.t, p[k]]), 0.004)
      .map(([t, v]) => ({ t: round(t, 3), v: round(v) }));
  };
  return { keys: { x: toKeys('x'), y: toKeys('y') } };
}

// One clip of the copy: cover scale applied on top of its own scale; when a face path exists,
// its position is replaced by the tracked motion (a static offset or x/y keyframes in source
// time, like every keyframe in the app). Previous scale/x/y keyframes are dropped — the reframe
// owns position in the copy; rotation and opacity keyframes survive untouched.
export function reframeClip(clip, media, shape, points) {
  const cover = coverFor(shape, media, clip);
  if (!cover) return clip;
  const t = transformOf(clip);
  const out = { ...clip, transform: { ...t, scale: round((t.scale || 1) * cover.s), x: 0, y: 0 } };
  const keyframes = { ...(clip.keyframes || {}) };
  delete keyframes.scale;
  delete keyframes.x;
  delete keyframes.y;
  const motion = points && points.length ? pathToMotion(points, clip, media, shape) : null;
  if (motion && motion.keys) {
    if (motion.keys.x.length > 1) keyframes.x = motion.keys.x;
    else if (motion.keys.x.length === 1) out.transform.x = motion.keys.x[0].v;
    if (motion.keys.y.length > 1) keyframes.y = motion.keys.y;
    else if (motion.keys.y.length === 1) out.transform.y = motion.keys.y[0].v;
  } else if (motion && motion.at) {
    out.transform.x = motion.at.x;
    out.transform.y = motion.at.y;
  }
  if (Object.keys(keyframes).length) out.keyframes = keyframes;
  else delete out.keyframes;
  return out;
}

// The vertical copy of a whole project. paths: { [clipId]: points } from the face analysis
// (clips without an entry — images, gaps, clips whose analysis found no face — are centred).
// makeId mints the copy's project id (the store's uid, injected so tests stay deterministic).
export function buildVerticalCopy(project, paths = {}, makeId) {
  const size = sizeFor(REFRAME_RATIO, project.resolution || 720);
  const shape = { width: size.width, height: size.height };
  const copy = JSON.parse(JSON.stringify(project));
  copy.id = makeId();
  copy.name = /\(9:16\)\s*$/.test(copy.name || '') ? copy.name : `${copy.name || 'Untitled'} (9:16)`;
  copy.ratio = REFRAME_RATIO;
  copy.width = size.width;
  copy.height = size.height;
  copy.ratioLocked = true;
  const mediaById = new Map((project.media || []).map((m) => [m.id, m]));
  copy.videoClips = (copy.videoClips || []).map((clip) => {
    if (clip.gap) return clip;
    const media = mediaById.get(clip.mediaId);
    if (!media || !media.width || !media.height) return clip;
    return reframeClip(clip, media, shape, paths[clip.id]);
  });
  return copy;
}
