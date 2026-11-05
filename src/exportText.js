// Renders the text layer for the export (same renderer as the preview). FFmpeg packs the frames into a lossless
// file while the next ones are drawn (electron/textstream.cjs). Only what changed since the previous frame is sent:
// the rectangle around the changed pixels, or a count for runs of transparent or unchanged frames.
import { drawTextLayer, textVisible } from './text/render.js';
import { fontsReady } from './fonts.js';
import { exportDuration } from './store.js';
import { overlayRanges } from './fx/apply.js';
import { drawFxOverlays } from './components/Preview.jsx';
import { changedRect, cutRect } from './frameDiff.js';
import { createProgressReporter } from './exportProgress.js';
import { textLayerSignature } from './text/staticFrame.js';

// Returns the number of frames written (0 when the project has no text), or -1 when canceled.
// onProgress(0..1); isCanceled() is polled between frames.
// Progress is reported for EVERY frame — visible, blank or unchanged — through a
// throttled monotonic reporter, so the bar keeps moving inside caption gaps
// (previously it was only reported inside the visible-text branch, every 5
// frames, and froze for the whole length of a gap).
export async function renderTextFrames(project, frameDir, onProgress, isCanceled) {
  const fxClips = overlayRanges(project);
  if (!project.textClips.length && !fxClips.length) return 0;
  await fontsReady();
  const { width: W, height: H, fps } = project;
  const count = Math.ceil(exportDuration(project) * fps);
  const reporter = createProgressReporter(onProgress || (() => {}));
  const canvas = new OffscreenCanvas(W, H);
  // The pixels are read back every frame: keep the canvas in memory rather than on the GPU.
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  await window.api.exportTextBegin(frameDir, W, H, fps);
  const clear = new Uint32Array(W * H);
  let prev = clear; // the last frame FFmpeg got (transparent at first and after transparent frames)
  let prevSig = null; // signature of the last DRAWN frame (see text/staticFrame.js)
  let run = null; // { blank: n } or { same: n } not sent yet
  const send = async (frame) => {
    if (run) await window.api.exportTextFrame(frameDir, run);
    run = null;
    if (frame) await window.api.exportTextFrame(frameDir, frame);
  };
  const holdRun = async (kind) => {
    if (run?.[kind]) run[kind]++;
    else if (kind === 'same' && run?.blank) run.blank++; // still transparent
    else { await send(); run = { [kind]: 1 }; }
  };
  for (let i = 0; i < count; i++) {
    if (isCanceled()) return -1;
    const t = i / fps;
    reporter.report(count ? i / count : 1);
    const fxActive = fxClips.some(([a, b]) => t >= a && t < b);
    if (!project.textClips.some((c) => textVisible(c, t)) && !fxActive) {
      await holdRun('blank');
      prev = clear;
      prevSig = null;
      continue;
    }
    // Static-frame skip: when the text layer is provably in the same drawn
    // state as the previous frame (settled clips, discrete highlight index)
    // and no effect overlay is active, the pixels are identical — reuse the
    // { same } run instead of redrawing and diffing a full frame. The test
    // hook window.__ccNoStaticSkip disables it (A/B measurement only).
    const sig = !fxActive && !(typeof window !== 'undefined' && window.__ccNoStaticSkip)
      ? textLayerSignature(project, t) : null;
    if (sig !== null && sig === prevSig) {
      await holdRun('same');
      continue;
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, W, H);
    drawFxOverlays(ctx, project, t, W, H);
    drawTextLayer(ctx, project, t, W, H);
    const px = ctx.getImageData(0, 0, W, H).data;
    const cur = new Uint32Array(px.buffer, px.byteOffset, W * H);
    const r = changedRect(prev, cur, W, H);
    if (!r) {
      if (run?.same) run.same++;
      else if (run?.blank) run.blank++; // still transparent
      else { await send(); run = { same: 1 }; }
      // prev is unchanged and still describes this frame.
      if (sig !== null) prevSig = sig;
    } else {
      await send({ ...r, data: cutRect(px, W, r) });
      prev = cur;
      prevSig = sig;
    }
  }
  await send();
  const written = await window.api.exportTextEnd(frameDir);
  reporter.finish();
  return written;
}
