// Effect regions (src/fx/apply.js): an effect instance confined to { x, y, w, h, feather,
// shape, invert } must render as mix(original, effected, regionMask) — for ANY shader effect.
// Proven on the CPU expression runner (the preview/export share the same passes):
//   - blur on the Effects track, region = top-left quadrant: outside pixels bit-identical,
//     inside pixels changed (blurred);
//   - fx_invert attached to a clip, ellipse region on the right: left half identical, the
//     ellipse centre exactly inverted, the right corners (outside the ellipse) identical;
//   - invert: true swaps which side is effected;
//   - a feathered edge mixes partially just outside the boundary;
//   - no region -> the pass expression is the catalog's own, untouched.
// Run: node scripts/test-fxregion.mjs
import { pixelPasses, regionWrap } from '../src/fx/apply.js';
import { runEffect } from '../src/fx/run.js';
import { PIXEL_EFFECTS } from '../src/fx/catalog.js';

let fails = 0;
const ok = (cond, msg) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`); if (!cond) fails++; };

const W = 64, H = 48;
const src = new Uint8Array(W * H * 4);
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
  const i = (y * W + x) * 4;
  const checker = ((x >> 2) + (y >> 2)) % 2 ? 210 : 30;
  src[i] = checker; src[i + 1] = x * 4; src[i + 2] = y * 5; src[i + 3] = 255;
}
const px = (buf, x, y) => { const i = (y * W + x) * 4; return [buf[i], buf[i + 1], buf[i + 2]]; };
const same = (a, b) => a.every((v, i) => v === b[i]);
const runPasses = (passes, T = 0) => {
  let buf = src;
  for (const p of passes) { const out = new Uint8Array(buf.length); runEffect(buf, out, W, H, T, p.expr); buf = out; }
  return buf;
};
const proj = (effectClips, clip) => ({ effectClips, videoClips: [clip] });
const bareClip = { id: 'v1', mediaId: 'm', in: 0, out: 5, effects: [] };

// A) Effects-track Blur confined to the top-left quadrant.
{
  const region = { x: 0, y: 0, w: 0.5, h: 0.5, feather: 0, shape: 'rect', invert: false };
  const p = proj([{ id: 'e1', fx: 'blur', start: 0, duration: 5, region }], bareClip);
  const passes = pixelPasses(p, bareClip, 0, 1);
  ok(passes.length === 1, 'track blur with region yields one pass');
  const out = runPasses(passes);
  ok(same(px(out, 60, 44), px(src, 60, 44)), 'blur region: bottom-right pixel bit-identical');
  ok(same(px(out, 60, 4), px(src, 60, 4)), 'blur region: top-right pixel bit-identical');
  ok(!same(px(out, 16, 12), px(src, 16, 12)), 'blur region: inside pixel changed (blurred)');
}

// B) Per-clip fx_invert in an ellipse covering the right half.
{
  const region = { x: 0.5, y: 0, w: 0.5, h: 1, feather: 0, shape: 'ellipse', invert: false };
  const clip = { ...bareClip, effects: ['fx_invert'], fxRegions: { fx_invert: region } };
  const passes = pixelPasses(proj([], clip), clip, 0, 1);
  ok(passes.length === 1, 'clip invert with region yields one pass');
  const out = runPasses(passes);
  ok(same(px(out, 8, 24), px(src, 8, 24)), 'ellipse region: left half bit-identical');
  const c = px(src, 48, 24);
  ok(same(px(out, 48, 24), [255 - c[0], 255 - c[1], 255 - c[2]]), 'ellipse region: centre exactly inverted');
  ok(same(px(out, 63, 2), px(src, 63, 2)), 'ellipse region: right corner (outside ellipse) bit-identical');
}

// C) invert: true — the effect lands everywhere EXCEPT the region.
{
  const region = { x: 0, y: 0, w: 0.5, h: 0.5, feather: 0, shape: 'rect', invert: true };
  const p = proj([{ id: 'e1', fx: 'blur', start: 0, duration: 5, region }], bareClip);
  const out = runPasses(pixelPasses(p, bareClip, 0, 1));
  ok(same(px(out, 16, 12), px(src, 16, 12)), 'inverted region: inside pixel untouched');
  ok(!same(px(out, 60, 44), px(src, 60, 44)), 'inverted region: outside pixel effected');
}

// D) Feather: a pixel just outside the edge is a partial mix (between source and effected).
{
  const region = { x: 0, y: 0, w: 0.5, h: 0.5, feather: 0.2, shape: 'rect', invert: false };
  const clip = { ...bareClip, effects: ['fx_invert'], fxRegions: { fx_invert: region } };
  const out = runPasses(pixelPasses(proj([], clip), clip, 0, 1));
  const s = px(src, 35, 12)[0]; // 3px right of the region edge (x=32), inside the feather falloff
  const o = px(out, 35, 12)[0];
  ok(o !== s && o !== 255 - s, `feather: edge pixel partially mixed (src ${s}, out ${o}, full ${255 - s})`);
}

// E) No region: the pass is the catalog expression itself.
{
  const clip = { ...bareClip, effects: ['fx_invert'] };
  const passes = pixelPasses(proj([], clip), clip, 0, 1);
  const raw = PIXEL_EFFECTS.find((e) => e.id === 'fx_invert').expr;
  ok(passes[0].expr === raw, 'no region: expression untouched');
  const region = { x: 0.1, y: 0.1, w: 0.3, h: 0.3, feather: 0.05, shape: 'rect', invert: false };
  ok(regionWrap(raw, region).includes('st(9,'), 'region wrap stores the mask in register 9');
  ok(regionWrap(raw, null) === raw, 'regionWrap(null) is the identity');
}

if (fails) { console.error(`test-fxregion: ${fails} failure(s)`); process.exit(1); }
console.log('FX REGION OK');
