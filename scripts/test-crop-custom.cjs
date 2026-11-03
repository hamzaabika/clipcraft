// Crop % and Custom removal proofs, through the real export pipeline.
// Crop: quadrant-coloured fixture; the exported frame must show exactly the surviving region,
// contain-fitted as the picture at a UNIFORM scale (its true aspect — never stretched to the
// uncropped fit box; the preview fits the same region the same way, Preview.jsx drawKeyed).
// Custom removal: strokes rasterized by src/customMask.js itself (the renderer's own rasterizer),
// handed to the export as the PNG the UI would send; erase removes, restore brings back, and a
// painted removal unions with chroma key.
// Usage: node scripts/test-crop-custom.cjs
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { ffmpegPath, probe, runExport } = require('../electron/ffmpeg.cjs');

const W = 320;
const H = 180;
let failures = 0;
const ok = (cond, msg) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`); if (!cond) failures++; };
const near = (a, b, tol, what) => ok(a.every((v, i) => Math.abs(v - b[i]) <= tol), `${what}: got rgb(${a}), expected ~rgb(${b}) ±${tol}`);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fve-crop-'));
const gen = (args) => execFileSync(ffmpegPath, ['-y', '-hide_banner', '-loglevel', 'error', ...args]);
const pixel = (file, t, x, y) => [...execFileSync(ffmpegPath, ['-v', 'error', '-ss', String(t), '-i', file, '-frames:v', '1',
  '-vf', `crop=4:4:${x}:${y},scale=1:1:flags=area`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'])];

(async () => {
  const customMask = await import('../src/customMask.js');
  // Quadrants: TL red, TR green, BL white, BR blue.
  const quad = path.join(dir, 'quad.mp4');
  gen(['-f', 'lavfi', '-i', `color=c=black:s=${W}x${H}:r=30:d=2,drawbox=x=0:y=0:w=160:h=90:color=0xff0000:t=fill,drawbox=x=160:y=0:w=160:h=90:color=0x00c000:t=fill,drawbox=x=0:y=90:w=160:h=90:color=white:t=fill,drawbox=x=160:y=90:w=160:h=90:color=0x0000ff:t=fill`, '-pix_fmt', 'yuv420p', quad]);
  const qMedia = [{ id: 'q', path: quad, name: 'quad', ...(await probe(quad)) }];
  const cb = { volume: 1, muted: false, filter: 'none', adjust: {}, effects: [], transition: null, speed: 1 };
  const proj = (clip, extra = {}) => ({
    name: 'crop', width: W, height: H, fps: 30, background: '#203040', media: qMedia,
    videoClips: [{ ...cb, id: 'c', mediaId: 'q', in: 0, out: 2, ...clip }],
    overlayClips: [], textClips: [], audioClips: [], stickerClips: [], ...extra,
  });
  const BG = [0x20, 0x30, 0x40];
  const exp = async (name, p) => { const out = path.join(dir, `${name}.mp4`); await runExport(p, out, () => {}).promise; return out; };

  // Crop left 25%: the surviving region (right 75%, 4:3) is contain-fitted — displayed
  // 240x180 centred, so the frame's outer 40 px on each side stay background and NOTHING
  // is stretched: a pixel's colour is the source colour at the matching fraction.
  let out = await exp('crop-l25', proj({ crop: { l: 0.25, t: 0, r: 0, b: 0 } }));
  near(pixel(out, 1, 8, 45), BG, 25, 'crop l25: left band is background (no stretch to the edge)');
  near(pixel(out, 1, 48, 45), [255, 0, 0], 30, 'crop l25: region starts at the source 25% line (red TL)');
  near(pixel(out, 1, 160, 45), [0, 192, 0], 40, 'crop l25: centre moved into the TR quadrant (green)');
  near(pixel(out, 1, 272, 135), [0, 0, 255], 30, 'crop l25: inside bottom-right is blue');
  near(pixel(out, 1, 312, 135), BG, 25, 'crop l25: right band is background');

  // Crop top 50% ONLY: the surviving bottom half (32:9) must keep its aspect — displayed
  // 320x90 centred vertically (y 45..135) with background above and below. The old
  // stretch-to-fit would have filled the whole height with the bottom half.
  out = await exp('crop-t50', proj({ crop: { l: 0, t: 0.5, r: 0, b: 0 } }));
  near(pixel(out, 1, 160, 10), BG, 25, 'crop t50: top band is background (no vertical stretch)');
  near(pixel(out, 1, 160, 170), BG, 25, 'crop t50: bottom band is background');
  near(pixel(out, 1, 80, 90), [255, 255, 255], 30, 'crop t50: centre-left is the BL quadrant (white)');
  near(pixel(out, 1, 240, 90), [0, 0, 255], 30, 'crop t50: centre-right is the BR quadrant (blue)');

  // Asymmetric crop: left half + top half away -> only the BR (blue) quadrant remains, full frame.
  out = await exp('crop-l50t50', proj({ crop: { l: 0.5, t: 0.5, r: 0, b: 0 } }));
  near(pixel(out, 1, 20, 20), [0, 0, 255], 30, 'crop l50/t50: top-left of frame is blue');
  near(pixel(out, 1, 300, 160), [0, 0, 255], 30, 'crop l50/t50: bottom-right of frame is blue');

  // Symmetric crop (all edges 25%): centre of the source fills the frame.
  out = await exp('crop-all25', proj({ crop: { l: 0.25, t: 0.25, r: 0.25, b: 0.25 } }));
  near(pixel(out, 1, 160, 20), [0, 192, 0], 45, 'crop all25: top-centre samples the TR quadrant');
  near(pixel(out, 1, 160, 160), [0, 0, 255], 45, 'crop all25: bottom-centre samples the BR quadrant');

  // Crop + transform: cropped clip at scale 0.5 sits in the middle over the background.
  out = await exp('crop-scale', proj({ crop: { l: 0.5, t: 0.5, r: 0, b: 0 }, transform: { scale: 0.5, x: 0, y: 0, rot: 0, uniform: true, scaleX: 1, scaleY: 1 } }));
  near(pixel(out, 1, 160, 90), [0, 0, 255], 30, 'crop+scale 0.5: centre is the cropped (blue) region');
  near(pixel(out, 1, 8, 8), BG, 25, 'crop+scale 0.5: corner is the background');

  // ---- Custom removal, rasterized by the app's own rasterizer. ----
  const maskPngUrl = (strokes) => {
    const keep = customMask.rasterizeCustomMask(strokes, W, H);
    const r = spawnSync(ffmpegPath, ['-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'gray', '-s', `${W}x${H}`, '-i', '-', '-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'png', '-'], { input: Buffer.from(keep) });
    if (r.status !== 0) throw new Error(`mask png encode failed: ${r.stderr}`);
    return `data:image/png;base64,${r.stdout.toString('base64')}`;
  };
  const eraseLeft = [{ tool: 'erase', size: 50, points: [[0.25, 0.02], [0.25, 0.98]] }];
  const withMask = (strokes, clipExtra = {}) => proj(
    { customMask: { strokes }, ...clipExtra },
    { customMaskImages: { c: maskPngUrl(strokes) } },
  );
  out = await exp('custom-erase', withMask(eraseLeft));
  near(pixel(out, 1, 40, 90), BG, 25, 'custom erase: painted left side shows the background');
  near(pixel(out, 1, 280, 45), [0, 192, 0], 40, 'custom erase: unpainted right side intact');

  const restored = [...eraseLeft, { tool: 'restore', size: 30, points: [[0.125, 0.75]] }];
  out = await exp('custom-restore', withMask(restored));
  near(pixel(out, 1, 40, 135), [255, 255, 255], 30, 'custom restore: painted-back spot shows the clip again (BL white)');
  near(pixel(out, 1, 40, 30), BG, 25, 'custom restore: the rest of the left side stays removed');

  // Union with chroma: green screen + red box; chroma takes the green, paint takes the box.
  const gs = path.join(dir, 'gs.mp4');
  gen(['-f', 'lavfi', '-i', `color=c=0x00ff00:s=${W}x${H}:r=30:d=2,drawbox=x=110:y=55:w=100:h=70:color=0xff0000:t=fill`, '-pix_fmt', 'yuv420p', gs]);
  const gMedia = [{ id: 'g', path: gs, name: 'gs', ...(await probe(gs)) }];
  const boxStroke = [{ tool: 'erase', size: 45, points: [[0.5, 0.5]] }];
  const unionProj = {
    name: 'union', width: W, height: H, fps: 30, background: '#203040', media: gMedia,
    videoClips: [{ ...cb, id: 'c', mediaId: 'g', in: 0, out: 2, chroma: { on: true, color: '#00ff00', intensity: 25, feather: 10, spill: 0 }, customMask: { strokes: boxStroke } }],
    overlayClips: [], textClips: [], audioClips: [], stickerClips: [],
    customMaskImages: { c: maskPngUrl(boxStroke) },
  };
  out = await exp('custom-union', unionProj);
  near(pixel(out, 1, 160, 90), BG, 25, 'union: painted box removed (chroma alone would keep it)');
  near(pixel(out, 1, 20, 20), BG, 25, 'union: keyed green removed (paint alone would keep it)');

  console.log(failures ? `\n${failures} FAILURE(S)` : '\nCROP+CUSTOM OK');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
