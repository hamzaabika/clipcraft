// The ONE source of truth for where a clip's picture is displayed on the stage.
// Every consumer that maps between what the user sees and the clip's source frame — the
// crop overlay, the transform box, the chroma colour sampler, the tracking pick — derives
// its geometry from here, so they cannot drift apart.
//
// Model: the renderer draws the picture through object-fit: contain into the project frame
// (the "fitted box"), then applies the clip transform (translate / rotate / scale about the
// frame centre) and the mirror/flip effects. When the clip is cropped, the picture that is
// fitted is the crop's surviving region (see keptFitFactors), so the box below is always
// the box of what is actually on screen. All fractions below are of the project frame
// ("stage fractions") unless named source fractions (0..1 across the SOURCE picture).
// Media width/height are DISPLAY dimensions everywhere in the app (electron probe turns
// phone rotation side-data into swapped width/height; ffmpeg export auto-rotates to the
// same geometry), so the fitted box computed from them is the box the user sees.
import { cropOf, scaleXY, transformOf } from './visual.js';

// How much of the frame the source media's fitted (contain) picture occupies.
export function fitFactors(project, media) {
  const mw = media?.width;
  const mh = media?.height;
  if (!mw || !mh || !project.width || !project.height) return { fx: 1, fy: 1 };
  const k = Math.min(project.width / mw, project.height / mh);
  return { fx: (mw * k) / project.width, fy: (mh * k) / project.height };
}

// The fitted box of the region that SURVIVES the clip's crop. Cropping replaces the
// source with its surviving region, and that region is contain-fitted like any picture
// (uniform scale — it is never stretched to the uncropped fit box, which used to squash
// or stretch the picture whenever a crop cut more on one axis than the other).
export function keptFitFactors(project, media, clip) {
  const mw = media?.width;
  const mh = media?.height;
  if (!mw || !mh || !project.width || !project.height) return { fx: 1, fy: 1 };
  const c = clip ? cropOf(clip) : { l: 0, t: 0, r: 0, b: 0 };
  const kw = 1 - c.l - c.r;
  const kh = 1 - c.t - c.b;
  const k = Math.min(project.width / (mw * kw), project.height / (mh * kh));
  return { fx: (mw * kw * k) / project.width, fy: (mh * kh * k) / project.height };
}

// The displayed picture box: centre (cx, cy) and size (w, h) in stage fractions, the
// rotation (degrees, clockwise on screen) and the mirror/flip state. `transform` overrides
// the clip's stored transform (the renderer passes the animated/pinned state, the crop
// mode passes its draft rotation) — the box follows exactly what is on screen.
export function pictureGeometry(project, media, clip, transform) {
  const t = transform || transformOf(clip || {});
  const { sx, sy } = scaleXY(t);
  const { fx, fy } = keptFitFactors(project, media, clip);
  const eff = (clip && clip.effects) || [];
  const c = clip ? cropOf(clip) : { l: 0, t: 0, r: 0, b: 0 };
  return {
    cx: 0.5 + (t.x || 0),
    cy: 0.5 + (t.y || 0),
    w: fx * Math.abs(sx || 1),
    h: fy * Math.abs(sy || 1),
    rot: t.rot || 0,
    flipX: eff.includes('mirror'),
    flipY: eff.includes('flipv'),
    fx, fy, t,
    // The surviving region in source fractions: box fractions land inside it.
    crop: { l: c.l, t: c.t, kw: 1 - c.l - c.r, kh: 1 - c.t - c.b },
  };
}

// Stage fractions -> source fractions: move to the box centre, un-rotate, divide by the
// box size, then un-flip (the displayed picture is mirrored, the source is not). The
// result is raw — values outside 0..1 mean the point is outside the picture; callers
// clamp as their interaction requires. This is the exact inverse of the renderer's
// placement, including rotation: the old crop drag read fractions off the rotated
// element's axis-aligned bounding rect, which is only correct at 0°/180°.
export function stageToSource(geom, sx, sy) {
  const dx = sx - geom.cx;
  const dy = sy - geom.cy;
  const a = (-geom.rot * Math.PI) / 180;
  const lx = dx * Math.cos(a) - dy * Math.sin(a);
  const ly = dx * Math.sin(a) + dy * Math.cos(a);
  let bx = 0.5 + lx / (geom.w || 1);
  let by = 0.5 + ly / (geom.h || 1);
  if (geom.flipX) bx = 1 - bx;
  if (geom.flipY) by = 1 - by;
  const c = geom.crop || { l: 0, t: 0, kw: 1, kh: 1 };
  return { x: c.l + bx * c.kw, y: c.t + by * c.kh };
}

// Source fractions -> stage fractions (the exact inverse of stageToSource).
export function sourceToStage(geom, px, py) {
  const c = geom.crop || { l: 0, t: 0, kw: 1, kh: 1 };
  const kx = (px - c.l) / (c.kw || 1);
  const ky = (py - c.t) / (c.kh || 1);
  const bx = geom.flipX ? 1 - kx : kx;
  const by = geom.flipY ? 1 - ky : ky;
  const lx = (bx - 0.5) * (geom.w || 1);
  const ly = (by - 0.5) * (geom.h || 1);
  const a = (geom.rot * Math.PI) / 180;
  const dx = lx * Math.cos(a) - ly * Math.sin(a);
  const dy = lx * Math.sin(a) + ly * Math.cos(a);
  return { x: geom.cx + dx, y: geom.cy + dy };
}
