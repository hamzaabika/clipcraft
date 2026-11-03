// Displayed-picture geometry (src/pictureGeometry.js): the single source of truth the crop
// overlay, the transform box and the chroma sampler share. Pure math, no app.
// Usage: node scripts/test-picture-geometry.mjs
import assert from 'assert/strict';
import { fitFactors, pictureGeometry, stageToSource, sourceToStage } from '../src/pictureGeometry.js';

const near = (a, b, tol = 1e-9) => assert.ok(Math.abs(a - b) <= tol, `${a} ≈ ${b}`);
const proj = { width: 1920, height: 1080 };
const clip = (transform, effects) => ({ transform, effects });

// Fit: portrait source in a landscape frame is pillarboxed (fx < 1, fy = 1).
{
  const { fx, fy } = fitFactors(proj, { width: 1080, height: 1920 });
  near(fx, (1080 * (1080 / 1920)) / 1920, 1e-12);
  near(fy, 1);
}
// Round-trip under every combination that used to break the crop drag: rotation, scale,
// repositioning, flips. stage -> source -> stage must be the identity, and the picture
// centre must map to the source centre.
for (const t of [
  { scale: 1, scaleX: 1, scaleY: 1, uniform: true, x: 0, y: 0, rot: 0 },
  { scale: 0.85, scaleX: 1, scaleY: 1, uniform: true, x: 0, y: 0, rot: 5 },
  { scale: 0.6, scaleX: 1, scaleY: 1, uniform: true, x: 0.1, y: -0.05, rot: -23 },
  { scale: 1.7, scaleX: 1, scaleY: 1, uniform: true, x: -0.2, y: 0.15, rot: 90 },
  { scale: 1, scaleX: 1.4, scaleY: 0.7, uniform: false, x: 0, y: 0, rot: 37 },
]) {
  for (const eff of [undefined, ['mirror'], ['flipv'], ['mirror', 'flipv']]) {
    const g = pictureGeometry(proj, { width: 1080, height: 1920 }, clip(t, eff));
    const c = stageToSource(g, g.cx, g.cy);
    near(c.x, 0.5, 1e-9); near(c.y, 0.5, 1e-9);
    for (const [sx, sy] of [[0.13, 0.71], [0.5, 0.5], [0.92, 0.08], [0.31, 0.44]]) {
      const s = stageToSource(g, sx, sy);
      const back = sourceToStage(g, s.x, s.y);
      near(back.x, sx, 1e-9); near(back.y, sy, 1e-9);
    }
  }
}
// The CROP-3 regression case, computed exactly: a matched-aspect clip at scale 0.85
// rotated +5°. The stage point the verification drive places at source (0.75, 0.80)
// must map back to that source point (the AABB mapping landed at (0.713, 0.778)).
{
  const g = pictureGeometry({ width: 1920, height: 1080 }, { width: 1920, height: 1080 },
    clip({ scale: 0.85, scaleX: 1, scaleY: 1, uniform: true, x: 0, y: 0, rot: 5 }));
  const stagePt = sourceToStage(g, 0.75, 0.80);
  const back = stageToSource(g, stagePt.x, stagePt.y);
  near(back.x, 0.75, 1e-9); near(back.y, 0.80, 1e-9);
  // And the drive's closed-form stage point agrees with sourceToStage.
  const th = 5 * Math.PI / 180;
  const dx = 0.25 * 0.85, dy = 0.30 * 0.85;
  near(stagePt.x, 0.5 + dx * Math.cos(th) - dy * Math.sin(th), 1e-9);
  near(stagePt.y, 0.5 + dx * Math.sin(th) + dy * Math.cos(th), 1e-9);
}
// Corners: the source's bottom-right corner sits at the picture box's rotated corner.
{
  const g = pictureGeometry(proj, { width: 1920, height: 1080 }, clip({ scale: 1, scaleX: 1, scaleY: 1, uniform: true, x: 0, y: 0, rot: 0 }));
  const br = sourceToStage(g, 1, 1);
  near(br.x, 1); near(br.y, 1);
  const tl = stageToSource(g, 0, 0);
  near(tl.x, 0); near(tl.y, 0);
}
// Crop: the box is the CONTAIN FIT of the surviving region (uniform scale — the region
// keeps its true aspect, it is never stretched to the uncropped fit box), and stage <->
// source mapping lands inside the surviving region. 1920x1080 source, crop l .25 / t .5:
// surviving region 1440x540 (8:3) fits the 16:9 frame at fx = 1, fy = 2/3.
{
  const cropped = { transform: { scale: 1, scaleX: 1, scaleY: 1, uniform: true, x: 0, y: 0, rot: 0 }, effects: [], crop: { l: 0.25, t: 0.5, r: 0, b: 0 } };
  const g = pictureGeometry(proj, { width: 1920, height: 1080 }, cropped);
  near(g.fx, 1, 1e-12); near(g.fy, 2 / 3, 1e-12);
  // The box's centre is the surviving region's centre in source fractions.
  const c = stageToSource(g, g.cx, g.cy);
  near(c.x, 0.625, 1e-9); near(c.y, 0.75, 1e-9);
  // The box's corners are the surviving region's corners.
  const tl = sourceToStage(g, 0.25, 0.5);
  near(tl.x, g.cx - g.w / 2, 1e-9); near(tl.y, g.cy - g.h / 2, 1e-9);
  const brc = sourceToStage(g, 1, 1);
  near(brc.x, g.cx + g.w / 2, 1e-9); near(brc.y, g.cy + g.h / 2, 1e-9);
  // Round-trip with crop + rotation + flip.
  const g2 = pictureGeometry(proj, { width: 1920, height: 1080 },
    { transform: { scale: 0.8, scaleX: 1, scaleY: 1, uniform: true, x: 0.05, y: 0, rot: 30 }, effects: ['mirror'], crop: { l: 0.1, t: 0.2, r: 0.3, b: 0.1 } });
  for (const [sx, sy] of [[0.3, 0.4], [0.62, 0.77]]) {
    const s = stageToSource(g2, sx, sy);
    const back = sourceToStage(g2, s.x, s.y);
    near(back.x, sx, 1e-9); near(back.y, sy, 1e-9);
  }
}
console.log('PICTURE-GEOMETRY OK');
