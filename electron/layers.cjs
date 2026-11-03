// Layered render of a picture clip for the export: fit, look, chroma key, mask, opacity and transform produce a
// full-canvas RGBA layer, which is then composited over a base picture (the project background for main-track
// clips, the video so far for overlay clips). The preview in src/components/Preview.jsx follows the same order.
//
// The numbers (defaults, chroma mapping) mirror src/visual.js; scripts/test-layers.mjs checks they stay equal.

const DEFAULT_TRANSFORM = { scale: 1, scaleX: 1, scaleY: 1, uniform: true, x: 0, y: 0, rot: 0 };
const DEFAULT_CHROMA = { on: false, color: '#00ff00', intensity: 20, feather: 20, spill: 0 };
const DEFAULT_CROP = { l: 0, t: 0, r: 0, b: 0 };

// Crop fractions of the source picture (mirrors cropOf in src/visual.js, clamped the same way).
function cropOf(clip) {
  const c = { ...DEFAULT_CROP, ...(clip.crop || {}) };
  for (const k of ['l', 't', 'r', 'b']) c[k] = Math.min(0.9, Math.max(0, Number(c[k]) || 0));
  if (c.l + c.r > 0.95) { const s = 0.95 / (c.l + c.r); c.l *= s; c.r *= s; }
  if (c.t + c.b > 0.95) { const s = 0.95 / (c.t + c.b); c.t *= s; c.b *= s; }
  return c;
}
const hasCrop = (clip) => { const c = cropOf(clip); return c.l > 0 || c.t > 0 || c.r > 0 || c.b > 0; };
const hasCustomMask = (clip) => !!(clip.customMask && Array.isArray(clip.customMask.strokes) && clip.customMask.strokes.length > 0);
const BLEND_FF = {
  multiply: 'multiply', screen: 'screen', overlay: 'overlay', softlight: 'softlight', hardlight: 'hardlight',
  darken: 'darken', lighten: 'lighten', dodge: 'dodge', burn: 'burn', difference: 'difference', exclusion: 'exclusion', add: 'addition',
};

const even = (n) => Math.max(2, Math.round(n / 2) * 2);

function chromaParams(c) {
  return {
    similarity: 0.02 + (c.intensity / 100) * 0.4,
    blend: 0.01 + (c.feather / 100) * 0.3,
    spill: Math.min(1, Math.max(0, c.spill / 100)),
  };
}

// Piecewise-linear curve [[t, v], ...] as an FFmpeg expression of the time variable `v`:
// v0 + sum of slope * (clip(t, a, b) - a) over the segments. One point is a constant.
const fine = (n) => Number(n).toFixed(5);
function curveExpr(pts, _num, v = 't') {
  const num = fine;
  let e = num(pts[0][1]);
  for (let i = 1; i < pts.length; i++) {
    const [a, va] = pts[i - 1];
    const [b, vb] = pts[i];
    if (b - a <= 1e-6 || vb === va) continue;
    const k = (vb - va) / (b - a);
    e += `${k < 0 ? '-' : '+'}${num(Math.abs(k))}*(clip(${v},${num(a)},${num(b)})-${num(a)})`;
  }
  return e;
}
const moving = (pts) => pts && pts.length > 1;

// The curves of a clip shortened to start `from` seconds later (the frames of a transition).
function shiftCurves(curves, from) {
  if (!curves || from <= 0) return curves;
  const at = (pts) => {
    if (pts.length === 1 || from <= pts[0][0]) return pts[0][1];
    for (let i = 1; i < pts.length; i++) {
      const [a, va] = pts[i - 1];
      const [b, vb] = pts[i];
      if (from <= b) return va + ((vb - va) * (from - a)) / (b - a);
    }
    return pts[pts.length - 1][1];
  };
  const out = {};
  for (const [k, pts] of Object.entries(curves)) {
    const rest = pts.filter(([t]) => t > from + 1e-6).map(([t, v]) => [t - from, v]);
    out[k] = [[0, at(pts)], ...rest];
  }
  return out;
}

// Escaping for a sendcmd command inside a filter graph: the filter option level, then the graph level.
const escOpt = (s) => s.replace(/[\\':]/g, (c) => `\\${c}`);
const escGraph = (s) => s.replace(/[\\'[\],;]/g, (c) => `\\${c}`);

function isLayered(clip, motion) {
  if (motion) return true;
  const t = { ...DEFAULT_TRANSFORM, ...(clip.transform || {}) };
  const sx = t.uniform ? t.scale : t.scale * t.scaleX;
  const sy = t.uniform ? t.scale : t.scale * t.scaleY;
  const chroma = { ...DEFAULT_CHROMA, ...(clip.chroma || {}) };
  return sx !== 1 || sy !== 1 || t.x !== 0 || t.y !== 0 || t.rot !== 0
    || (clip.mask && clip.mask.type && clip.mask.type !== 'none')
    || chroma.on || (clip.opacity !== undefined && clip.opacity < 1) || (clip.blend && clip.blend !== 'normal')
    || hasCrop(clip) || hasCustomMask(clip)
    || !!clip.bgRemove;
}

// o: { clip, media: { width, height }, W, H, fps, len, tag, srcLabel, maskIdx, decoIdx, matteLabel, customMaskIdx }
//   srcLabel: label (without brackets) of the trimmed, speed-adjusted picture stream at its native size.
//   maskIdx: index of a looped mask PNG input (the same frame size as the project), or null.
//   matteLabel: label of the AI background matte (grayscale, timed like srcLabel), or null: it becomes the alpha.
//   customMaskIdx: index of a looped custom-removal PNG input (grayscale keep-map in SOURCE geometry), or null.
// h: { lookFilters(clip, w, h) -> [filter], num, hex } from ffmpeg.cjs.
// Returns { filters: [string], out: label } where `out` is a W x H RGBA stream, transparent outside the picture.
// Order inside the layer: crop (source geometry) -> fit + look + chroma -> matte / custom mask (alpha
// multiplies, so removals union) -> pad to the frame -> shape mask -> deco -> opacity -> transform.
// The preview applies the same order (src/components/Preview.jsx drawKeyed + layerStyle).
function buildLayer(o, h) {
  const { clip, media, W, H, fps, len, tag, srcLabel, maskIdx } = o;
  const t = { ...DEFAULT_TRANSFORM, ...(clip.transform || {}) };
  const chroma = { ...DEFAULT_CHROMA, ...(clip.chroma || {}) };
  const filters = [];

  // Fit the picture inside the frame (the frame itself is padded later so the mask and the transform see the whole frame).
  // Crop first: the surviving region of the source BECOMES the picture — it is contain-fitted
  // at a uniform scale (fw x fh from the SURVIVING region's size), then the transform applies.
  // It is never stretched to the uncropped fit box: that squashed the picture whenever a crop
  // cut more on one axis than the other. The preview fits the same region the same way
  // (Preview.jsx drawKeyed + src/pictureGeometry.js keptFitFactors).
  const mw = media.width || W;
  const mh = media.height || H;
  const crop = cropOf(clip);
  const cropped = hasCrop(clip);
  const kw = 1 - crop.l - crop.r;
  const kh = 1 - crop.t - crop.b;
  const k = Math.min(W / (mw * kw), H / (mh * kh));
  const fw = even(mw * kw * k);
  const fh = even(mh * kh * k);
  const cropFilter = cropped
    ? `crop=w='iw*${h.num(1 - crop.l - crop.r)}':h='ih*${h.num(1 - crop.t - crop.b)}':x='iw*${h.num(crop.l)}':y='ih*${h.num(crop.t)}'`
    : null;
  const chain = [...(cropFilter ? [cropFilter] : []), `scale=${fw}:${fh}`, 'setsar=1', ...h.lookFilters(clip, fw, fh)];
  if (chroma.on) {
    const p = chromaParams(chroma);
    chain.push('format=yuva420p', `chromakey=color=${h.hex(chroma.color)}:similarity=${h.num(p.similarity)}:blend=${h.num(p.blend)}`);
    const n = parseInt(chroma.color.slice(1), 16);
    const r = (n >> 16) & 255;
    const g = (n >> 8) & 255;
    const b = n & 255;
    // despill only knows green and blue spill.
    if (p.spill > 0 && (g >= r || b >= r)) chain.push('format=gbrap', `despill=type=${g >= b ? 'green' : 'blue'}:mix=${h.num(p.spill)}:expand=0`);
  }
  const pad = `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black@0`;
  let cur = `fr${tag}`;
  if (o.matteLabel) {
    // Auto removal: the matte (white = keep) is the picture's transparency. The matte lives in
    // source geometry, so it takes the same crop before the fit scale.
    filters.push(
      `[${srcLabel}]${chain.join(',')},format=rgba[pm${tag}]`,
      `[${o.matteLabel}]${cropFilter ? `${cropFilter},` : ''}scale=${fw}:${fh},format=gray[mt2${tag}]`,
      `[pm${tag}][mt2${tag}]alphamerge,format=rgba[fit${tag}]`,
    );
  } else filters.push(`[${srcLabel}]${chain.join(',')},format=rgba[fit${tag}]`);
  if (o.customMaskIdx !== null && o.customMaskIdx !== undefined) {
    // Custom removal: the painted keep-map (source geometry, so the same crop + fit) MULTIPLIES
    // the alpha the picture already has — painted removals union with chroma and the AI matte.
    filters.push(
      `[fit${tag}]split[a${tag}][b${tag}]`,
      `[b${tag}]alphaextract[pa${tag}]`,
      `[${o.customMaskIdx}:v]${cropFilter ? `${cropFilter},` : ''}scale=${fw}:${fh},format=gray[cmg${tag}]`,
      `[pa${tag}][cmg${tag}]blend=all_mode=multiply:shortest=1[ma${tag}]`,
      `[a${tag}][ma${tag}]alphamerge[cmk${tag}]`,
    );
    filters.push(`[cmk${tag}]${pad}[${cur}]`);
  } else filters.push(`[fit${tag}]${pad}[${cur}]`);

  // Mask: the alpha of the mask picture multiplies the alpha the picture already has (from the chroma key).
  if (maskIdx !== null && maskIdx !== undefined) {
    filters.push(
      `[${cur}]split[a${tag}][b${tag}]`,
      `[b${tag}]alphaextract[pa${tag}]`,
      `[${maskIdx}:v]alphaextract[mg${tag}]`,
      `[pa${tag}][mg${tag}]blend=all_mode=multiply:shortest=1[ma${tag}]`,
      `[a${tag}][ma${tag}]alphamerge[mk${tag}]`,
    );
    cur = `mk${tag}`;
  }
  // The mask's outline / glow on top (a picture the size of the frame, in the same place as the mask).
  if (o.decoIdx !== null && o.decoIdx !== undefined) {
    filters.push(`[${o.decoIdx}:v]format=rgba[dc${tag}]`, `[${cur}][dc${tag}]overlay=format=auto:shortest=1,format=rgba[dk${tag}]`);
    cur = `dk${tag}`;
  }

  if (o.motion) return { filters: [...filters, ...animatedPlace(o, h, t, cur)], out: `L${tag}` };

  // Opacity, then scale / rotate the whole frame and place it around the canvas center.
  const post = [];
  if (clip.opacity !== undefined && clip.opacity < 1) post.push(`colorchannelmixer=aa=${h.num(Math.max(0, clip.opacity))}`);
  const sx = t.uniform ? t.scale : t.scale * t.scaleX;
  const sy = t.uniform ? t.scale : t.scale * t.scaleY;
  const moved = sx !== 1 || sy !== 1 || t.x !== 0 || t.y !== 0 || t.rot !== 0;
  if (sx !== 1 || sy !== 1) post.push(`scale=w='max(2,trunc(iw*${h.num(sx)}/2)*2)':h='max(2,trunc(ih*${h.num(sy)}/2)*2)'`);
  if (t.rot !== 0) {
    const rad = h.num((t.rot * Math.PI) / 180);
    post.push(`rotate=a=${rad}:ow=rotw(${rad}):oh=roth(${rad}):c=none`);
  }
  if (post.length) {
    filters.push(`[${cur}]${post.join(',')}[xf${tag}]`);
    cur = `xf${tag}`;
  }
  if (!moved) return { filters, out: cur };

  filters.push(
    `color=c=black@0:s=${W}x${H}:r=${fps}:d=${h.num(len)},format=rgba[cv${tag}]`,
    `[cv${tag}][${cur}]overlay=x='(W-w)/2+${h.num(t.x * W)}':y='(H-h)/2+${h.num(t.y * H)}':format=auto:shortest=1[L${tag}]`,
  );
  return { filters, out: `L${tag}` };
}

// Opacity and placement that change over time (animations, keyframes). o.motion holds the curves of
// src/anim.js motionCurves: s (uniform scale), x, y (fractions of the frame), r (degrees), o (opacity), in local
// seconds. A static non-uniform scale comes first, then the rotation, then the (animated) uniform scale, so the
// result matches the preview's CSS translate / rotate / scale. Opacity goes through sendcmd because
// colorchannelmixer takes no expression.
function animatedPlace(o, h, t, cur) {
  const { W, H, fps, len, tag, motion: mo } = o;
  const num = h.num;
  const chain = [];
  if (moving(mo.o)) {
    const cmd = `0-${num(len + 1)} [expr] colorchannelmixer@op${tag} aa '${curveExpr(mo.o, num, 'T')}'`;
    chain.push(`sendcmd=c=${escGraph(escOpt(cmd))}`, `colorchannelmixer@op${tag}=aa=${num(Math.max(0, Math.min(1, mo.o[0][1])))}`);
  } else if (mo.o[0][1] < 1) chain.push(`colorchannelmixer=aa=${num(Math.max(0, mo.o[0][1]))}`);
  if (!t.uniform && (t.scaleX !== 1 || t.scaleY !== 1)) {
    chain.push(`scale=w='max(2,trunc(iw*${num(t.scaleX)}/2)*2)':h='max(2,trunc(ih*${num(t.scaleY)}/2)*2)'`);
  }
  if (moving(mo.r) || mo.r[0][1] !== 0) {
    const a = `(${curveExpr(mo.r, num)})*PI/180`;
    // A fixed square that holds the frame at any angle; transparent around it.
    chain.push(`rotate=a='${a}':ow='ceil(hypot(iw,ih)/2)*2':oh=ow:c=black@0`);
  }
  if (moving(mo.s)) {
    const s = curveExpr(mo.s, num);
    chain.push(`scale=w='max(2,trunc(iw*(${s})/2)*2)':h='max(2,trunc(ih*(${s})/2)*2)':eval=frame`);
  } else if (mo.s[0][1] !== 1) {
    chain.push(`scale=w='max(2,trunc(iw*${num(mo.s[0][1])}/2)*2)':h='max(2,trunc(ih*${num(mo.s[0][1])}/2)*2)'`);
  }
  const filters = [];
  let src = cur;
  if (chain.length) {
    filters.push(`[${cur}]${chain.join(',')}[xf${tag}]`);
    src = `xf${tag}`;
  }
  const x = `(W-w)/2+(${curveExpr(mo.x, num)})*${W}`;
  const y = `(H-h)/2+(${curveExpr(mo.y, num)})*${H}`;
  filters.push(
    `color=c=black@0:s=${W}x${H}:r=${fps}:d=${num(len)},format=rgba[cv${tag}]`,
    `[cv${tag}][${src}]overlay=x='${x}':y='${y}':eval=frame:format=auto:shortest=1[L${tag}]`,
  );
  return filters;
}

// Composites a layer over a base picture and ends with yuv420p. Normal blending is a plain overlay; the other modes
// blend the layer with the base and fade that result in through the layer's alpha.
// The RGB -> YUV step uses the BT.709 matrix explicitly: the export tags its files BT.709 (see ffmpeg.cjs), but
// swscale's default RGB -> YUV matrix is BT.601, which shifted every blended colour on decode (worst in
// difference mode, which amplifies small shifts). scripts/test-compositing.cjs proves the parity.
const TO_YUV709 = 'scale=out_color_matrix=bt709:out_range=tv,format=yuv420p';
function composite({ base, layer, blend, tag, out }) {
  const mode = BLEND_FF[blend];
  if (!mode) return [`[${base}][${layer}]overlay=format=auto:shortest=1,${TO_YUV709}[${out}]`];
  return [
    `[${layer}]split[l1${tag}][l2${tag}]`,
    `[l2${tag}]alphaextract[la${tag}]`,
    `[l1${tag}]format=gbrp[lc${tag}]`,
    `[${base}]format=gbrp,split[b1${tag}][b2${tag}]`,
    `[b1${tag}][lc${tag}]blend=all_mode=${mode}:shortest=1[bl${tag}]`,
    `[b2${tag}][bl${tag}][la${tag}]maskedmerge,${TO_YUV709}[${out}]`,
  ];
}

module.exports = { buildLayer, composite, isLayered, curveExpr, shiftCurves, chromaParams, cropOf, hasCrop, DEFAULT_TRANSFORM, DEFAULT_CHROMA, DEFAULT_CROP, BLEND_FF };
