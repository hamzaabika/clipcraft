// The animated-effects pass of the export: every frame that needs an animated effect or transition is decoded by
// FFmpeg (electron/fxjobs.cjs), drawn here with the preview's WebGL shaders, and stored for the final export.
import { videoLayout } from './store.js';
import { FX_TRANSITIONS } from './fx/catalog.js';
import { clipHasPixelFx, isPixel, isShaderFx, pixelPasses } from './fx/apply.js';
import { fxGL } from './fx/gl.js';
import { easeValue } from './fx/easing.js';

const fxTr = (c) => c.transition && FX_TRANSITIONS.find((t) => t.id === c.transition.type);
const unwrap = (r) => {
  if (!r.ok) throw new Error(r.error);
  return r.value;
};

// Picture clips to send through the effects pass: [{ track, clip, start, len }].
function fxClipsOf(project) {
  const out = [];
  for (const l of videoLayout(project.videoClips)) {
    if (!l.clip.gap && clipHasPixelFx(project, l.clip, l.start, l.end - l.start)) out.push({ track: 'video', clip: l.clip, start: l.start, len: l.end - l.start });
  }
  for (const c of project.overlayClips || []) {
    const len = (c.out - c.in) / (c.speed || 1);
    if (clipHasPixelFx(project, c, c.start, len)) out.push({ track: 'overlay', clip: c, start: c.start, len });
  }
  return out;
}

// Returns the frames to render, so the export can show progress (0 when the project has no animated effect).
export function fxWork(project) {
  const fps = project.fps;
  let frames = fxClipsOf(project).reduce((n, j) => n + j.len * fps, 0);
  for (const l of videoLayout(project.videoClips)) if (l.trans > 0 && fxTr(l.clip)) frames += l.trans * fps;
  return Math.round(frames);
}

// Returns the project to export: clips with animated effects point at their rendered files, animated transitions
// at their rendered segments. Returns null when canceled.
export async function renderFxPass(projectIn, onProgress, isCanceled) {
  const total = fxWork(projectIn);
  if (!total) return projectIn;
  const gl = fxGL();
  let done = 0;
  let project = { ...projectIn, fxSegments: {} };
  const step = () => { done++; if (done % 4 === 0) onProgress(Math.min(1, done / total)); };

  // 1) Picture clips under animated effects (their own, or effects on the Effects track), main track and overlays.
  const run = async ({ track, clip, start }) => {
    const job = unwrap(await window.api.fxBegin(project, { kind: 'clip', track, clipId: clip.id }));
    for (let k = 0; k < job.frames; k++) {
      if (isCanceled()) return false;
      const frame = unwrap(await window.api.fxRead(job.id));
      if (!frame) break;
      const passes = pixelPasses(projectIn, clip, start, k / job.fps);
      if (passes.length) {
        gl.effects({ data: frame }, job.width, job.height, passes);
        unwrap(await window.api.fxWrite(job.id, gl.read(job.width, job.height)));
      } else {
        unwrap(await window.api.fxWrite(job.id, frame));
      }
      step();
    }
    unwrap(await window.api.fxEnd(job.id));
    const baked = { ...clip, effects: (clip.effects || []).filter((id) => !isPixel(id)), videoOverride: { job: job.id, start: 0, end: job.len } };
    const key = track === 'overlay' ? 'overlayClips' : 'videoClips';
    project = { ...project, [key]: project[key].map((c) => (c.id === clip.id ? baked : c)) };
    return true;
  };
  for (const j of fxClipsOf(projectIn)) if (!(await run(j))) return null;
  // Effects on the Effects track are now inside the clips' pictures (shader effects and the
  // classic effects' shader forms alike); particle/light overlays stay for their own pass.
  project = { ...project, effectClips: (project.effectClips || []).filter((e) => !isShaderFx(e.fx)) };

  // 2) Animated transitions, from the clips as they now look.
  for (const l of videoLayout(project.videoClips)) {
    const t = l.trans > 0 && fxTr(l.clip);
    if (!t) continue;
    const job = unwrap(await window.api.fxBegin(project, { kind: 'transition', clipId: l.clip.id }));
    for (let k = 0; k < job.frames; k++) {
      if (isCanceled()) return null;
      const pair = unwrap(await window.api.fxRead(job.id));
      if (!pair) break;
      gl.transition({ data: pair.a }, { data: pair.b }, job.width, job.height, easeValue(l.clip.transition?.ease, k / job.fps / job.len), t.expr);
      unwrap(await window.api.fxWrite(job.id, gl.read(job.width, job.height)));
      step();
    }
    unwrap(await window.api.fxEnd(job.id));
    project = { ...project, fxSegments: { ...project.fxSegments, [l.clip.id]: job.id } };
  }
  onProgress(1);
  return project;
}
