import React, { useEffect, useRef, useState } from 'react';
import {
  Crop, Pipette, RotateCcw,
} from 'lucide-react';
import { clipLen, formatTime, uid } from '../store.js';
import { FILTERS, TRANSITIONS } from '../effects.js';
import { directionGroupFor } from '../fx/collections.js';
import {
  BLEND_MODES, DEFAULT_CHROMA, DEFAULT_CROP, DEFAULT_MASK, DEFAULT_TRANSFORM, MASK_SHAPES, chromaOf, cropOf, maskOf, scaleXY, transformOf,
} from '../visual.js';
import { CROP_ASPECTS, aspectRatioOf, cropForAspect } from '../cropMath.js';
import { hasCustomMask } from '../customMask.js';
import CustomMaskEditor from './CustomMaskEditor.jsx';
import Slider from './Slider.jsx';
import NumBoxBase from './NumBox.jsx';
import KeyNav from './KeyNav.jsx';
import AnimationPanel from './AnimationPanel.jsx';
import GradePanel from './GradePanel.jsx';
import AudioFxControls from './AudioFx.jsx';
import EnhanceVoice from './EnhanceVoice.jsx';
import { baseAt, editAt, hasAnyKeys, localTime, nextArrival, segmentEase, setSegmentEase } from '../anim.js';
import { findClipAnywhere, trackedClips } from '../track.js';
import CurveEditor from './CurveEditor.jsx';

const pct = (v) => `${Math.round(v * 100)}%`;
const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];

function Section({ title, onReset, children, check, keys }) {
  return (
    <section className="ci-section">
      <div className="ci-head">
        {check}
        <b>{title}</b>
        {keys}
        {onReset && <button className="icon-btn sm" aria-label={`Reset ${title}`} title="Reset" onClick={onReset}><RotateCcw size={13} /></button>}
      </div>
      {children}
    </section>
  );
}

function MaskIcon({ type }) {
  const p = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.6 };
  const shapes = {
    none: <path d="M6 6l20 20" {...p} />,
    split: <><rect x="4" y="4" width="24" height="24" rx="2" {...p} /><path d="M4 16h24" {...p} /></>,
    filmstrip: <><rect x="4" y="4" width="24" height="24" rx="2" {...p} /><path d="M4 11h24M4 21h24" {...p} /></>,
    circle: <circle cx="16" cy="16" r="10" {...p} />,
    rectangle: <rect x="7" y="9" width="18" height="14" rx="1" {...p} />,
    star: <path d="M16 5l3.2 7 7.3.6-5.6 4.8 1.8 7.3L16 20.8 9.3 24.7l1.8-7.3-5.6-4.8 7.3-.6z" {...p} />,
    heart: <path d="M16 26C5 18 6 9 11 8c3-.6 4.4 1.6 5 3 .6-1.4 2-3.6 5-3 5 1 6 10-5 18z" {...p} />,
    text: <path d="M9 8h14M16 8v17" {...p} />,
  };
  return <svg viewBox="0 0 32 32" width="26" height="26" aria-hidden="true">{shapes[type]}</svg>;
}

// Auto removal (AI): the people in a video are found on this PC (the model downloads once, about
// 15 MB) and a matte is made once per video; then the background is transparent in the preview and the export.
function AutoRemoval({ clip, media, set, dispatch }) {
  const [job, setJob] = useState(null); // { stage: 'download' | 'matte', fraction } while working
  const [error, setError] = useState('');
  useEffect(() => window.api.onMattingProgress((p) => { if (p.path === media.path) setJob({ stage: p.stage, fraction: p.fraction }); }), [media.path]);
  const isVideo = media.type === 'video';
  const ready = !!media.matte;
  const on = !!clip.bgRemove && ready;
  const run = async () => {
    setError('');
    setJob({ stage: 'matte', fraction: 0 });
    const { path, width, height, duration, fps, hdr } = media;
    const res = await window.api.mattingRun({ path, width, height, duration, fps, hdr });
    setJob(null);
    if (res.matte) {
      dispatch({ type: 'mediaVisuals', path, patch: { matte: res.matte } });
      set({ bgRemove: true });
    } else if (res.error) setError(res.error);
  };
  const toggle = (checked) => {
    if (!checked) return set({ bgRemove: false });
    if (ready) return set({ bgRemove: true });
    return run();
  };
  const pctOf = (f) => `${Math.round((f || 0) * 100)}%`;
  return (
    <Section title="Auto removal"
      check={<input type="checkbox" aria-label="Auto removal" checked={on || !!job} disabled={!isVideo || !!job} onChange={(e) => toggle(e.target.checked)} />}>
      <p className="dim small">
        {isVideo ? 'AI finds the people in the video and removes the background, without a green screen. Runs on this PC.' : 'Auto removal works on videos.'}
      </p>
      {job && (
        <div className="progress-block" aria-live="polite">
          <span>{job.stage === 'download' ? `Downloading the AI model (15 MB)… ${pctOf(job.fraction)}` : `Removing the background… ${pctOf(job.fraction)}`}</span>
          <div className="progress"><div style={{ width: pctOf(job.fraction) }} /></div>
          <button className="btn btn-sm" onClick={() => window.api.mattingCancel()}>Cancel</button>
        </div>
      )}
      {!job && isVideo && !ready && <p className="dim small">The first time takes a while (about 3 times the video's length on a laptop); then it is instant.</p>}
      {error && <p className="error-text">{error}</p>}
    </Section>
  );
}

// Stabilize: the clip's part of the video is steadied by the main process (vid.stab) into a new file,
// which the clip then plays. clip.stabilize keeps the level and the original { mediaId, in, out }, so Off (or
// another level) starts again from the original.
const STAB_LEVELS = [['off', 'Off'], ['minimal', 'Minimal crop'], ['recommended', 'Recommended'], ['most', 'Most stable']];
function Stabilize({ clip, media, project, set, dispatch }) {
  const [job, setJob] = useState(null); // { fraction } while working
  const [error, setError] = useState('');
  const st = clip.stabilize || null;
  const orig = st ? project.media.find((m) => m.id === st.mediaId) : media;
  useEffect(() => window.api.onStabilizeProgress((p) => { if (p.path === orig?.path) setJob({ fraction: p.fraction }); }), [orig?.path]);
  if (!orig || orig.type !== 'video') return null;
  const choose = async (level) => {
    setError('');
    if (level === 'off') {
      if (st) set({ mediaId: st.mediaId, in: st.in, out: st.out, stabilize: null });
      return;
    }
    const from = st ? st.in : clip.in;
    const to = st ? st.out : clip.out;
    setJob({ fraction: 0 });
    const res = await window.api.stabilizeRun({ path: orig.path, duration: orig.duration, hdr: orig.hdr }, from, to, level);
    setJob(null);
    if (res.canceled) return;
    if (res.error) return setError(res.error);
    let m = project.media.find((x) => x.path === res.path);
    if (!m) {
      m = { ...res, id: uid(), origin: 'stabilize' }; // Media tree: Generated ▸ Processed
      dispatch({ type: 'addMedia', items: [m] });
    }
    set({ mediaId: m.id, in: 0, out: m.duration, stabilize: { level, mediaId: st ? st.mediaId : clip.mediaId, in: from, out: to } });
  };
  return (
    <Section title="Stabilize">
      <p className="dim small">Steadies shaky camera footage, like a gimbal. The picture is zoomed in a little to hide the moving edges.</p>
      <div className="seg-tabs small stab-levels" role="radiogroup" aria-label="Stabilize">
        {STAB_LEVELS.map(([id, name]) => (
          <button key={id} role="radio" aria-checked={(st?.level || 'off') === id} className={(st?.level || 'off') === id ? 'on' : ''}
            disabled={!!job} onClick={() => choose(id)}>{name}</button>
        ))}
      </div>
      {job && (
        <div className="progress-block" aria-live="polite">
          <span>{job.fraction < 0.5 ? 'Analyzing the camera shake…' : 'Stabilizing…'} {Math.round(job.fraction * 100)}%</span>
          <div className="progress"><div style={{ width: `${Math.round(job.fraction * 100)}%` }} /></div>
          <button className="btn btn-sm" onClick={() => window.api.stabilizeCancel()}>Cancel</button>
        </div>
      )}
      {error && <p className="error-text">{error}</p>}
    </Section>
  );
}

// Motion tracking: the point is picked on the player (App drives the pick mode), the engine follows it
// through the clip in the main process, and the path is stored on the clip (clip.track). Followers pin
// to it with PinToTrack below. Progress and cancel live in App's render-job pill, like the other renders.
function MotionTracking({ clip, media, set, onTrackPick, track }) {
  if (!media || media.type !== 'video') return null;
  const tr = clip.track && clip.track.points && clip.track.points.length ? clip.track : null;
  const low = tr ? tr.points.filter((p) => (p.c ?? 1) < 0.35).length : 0;
  return (
    <Section title="Motion tracking">
      <p className="dim small">Follow a moving point in this clip — a face, a product, a car. Overlay and text clips can then be pinned to it and travel with it.</p>
      {tr ? (
        <>
          <p className="dim small">Tracked {tr.points.length} points across the clip{low ? `; ${low} were uncertain and held their place (for example behind something)` : ''}.</p>
          <div className="row">
            <button className="btn btn-sm" disabled={!onTrackPick} onClick={() => onTrackPick({ track, id: clip.id })}>Track again…</button>
            <button className="btn btn-sm btn-ghost" onClick={() => set({ track: null })}>Remove track</button>
          </div>
        </>
      ) : (
        <button className="btn btn-sm" disabled={!onTrackPick} onClick={() => onTrackPick({ track, id: clip.id })}>Track motion…</button>
      )}
    </Section>
  );
}

// Pin to track: this clip keeps its position relative to a tracked point in another clip and follows
// it (src/track.js evaluates the offset live, in the preview and the export alike). Rendered as a
// Section inside ClipInspector and as a card in the text inspector (card prop).
export function PinToTrack({ clip, project, set, card = false }) {
  const sources = trackedClips(project).filter((s) => s.clip.id !== clip.id);
  const pinnedTo = clip.pin && clip.pin.to ? findClipAnywhere(project, clip.pin.to) : null;
  const nameOf = (ref) => {
    const m = ref && project.media.find((x) => x.id === ref.clip.mediaId);
    return m?.name || 'a clip';
  };
  const body = pinnedTo ? (
    <>
      <p className="dim small">Following the motion tracked in “{nameOf(pinnedTo)}”. The clip keeps the position it has when it starts, then travels with the point.</p>
      <button className="btn btn-sm" onClick={() => set({ pin: null })}>Unpin</button>
    </>
  ) : sources.length ? (
    <>
      <p className="dim small">Make this clip follow a moving point tracked in another clip.</p>
      {sources.map((s) => (
        <button key={s.clip.id} className="btn btn-sm" onClick={() => set({ pin: { to: s.clip.id } })}>Pin to “{nameOf(s)}”</button>
      ))}
    </>
  ) : (
    <p className="dim small">No tracked clips yet. Select a video clip and use Track motion in its inspector first.</p>
  );
  if (card) return <div className="insp-card"><div className="insp-card-title">Pin to track</div>{body}</div>;
  return <Section title="Pin to track">{body}</Section>;
}

// Properties of a picture clip (main track or overlay), the clip properties panel.
// time: playhead; start: where the clip starts on the timeline (values and keyframes follow the playhead).
export default function ClipInspector({ clip, media, project, set, dispatch, track, time = 0, start = 0, onSeek = () => {}, onEnhance = null, onTrackPick = null, onCropEdit = null, onColorPick = null }) {
  const [tab, setTab] = useState('video');
  const [sub, setSub] = useState('basic');
  const [maskEdit, setMaskEdit] = useState(false);
  const S = (p) => <Slider dispatch={dispatch} {...p} />;
  // The shared scrub field, with a scrub wrapped in a single undo gesture. The wrapper's identity
  // must be STABLE across renders (useRef), or React remounts the field mid-scrub and kills the drag.
  const numBoxRef = useRef(null);
  if (!numBoxRef.current) {
    numBoxRef.current = (p) => <NumBoxBase {...p}
      onDragStart={() => dispatch({ type: 'beginGesture' })} onDragEnd={() => dispatch({ type: 'endGesture' })} />;
  }
  const NumBox = numBoxRef.current;
  const W = project.width;
  const H = project.height;
  const isVideo = media?.type === 'video';

  const len = clipLen(clip);
  const fps = project.fps || 30;
  const inside = time >= start - 1e-6 && time <= start + len + 1e-6;
  const lt = inside ? Math.min(len, Math.max(0, time - start)) : null;
  // Values at the playhead (keyframes applied); an edit of a keyframed value adds a keyframe there.
  const at = baseAt(clip, lt ?? 0);
  const t = { ...transformOf(clip), scale: at.scale, x: at.x, y: at.y, rot: at.rot };
  const { sx } = scaleXY(t);
  const setT = (patch) => set(editAt(clip, patch, lt ?? 0));
  const keys = (props, label) => (
    <KeyNav clip={clip} props={props} lt={lt} start={start} fps={fps} set={set} onSeek={onSeek} label={label} />
  );
  const dropKeys = (props) => {
    const k = { ...(clip.keyframes || {}) };
    props.forEach((p) => delete k[p]);
    return k;
  };
  const chroma = chromaOf(clip);
  const setC = (patch) => set({ chroma: { ...chroma, ...patch } });
  const mask = maskOf(clip);
  const setM = (patch) => set({ mask: { ...mask, ...patch } });

  // Align the scaled picture to a frame edge or center (rotation ignored).
  const cropNow = cropOf(clip);
  const fitW = media?.width ? Math.min(1, (media.width / media.height) / (W / H)) : 1;
  const fitH = media?.width ? Math.min(1, (media.height / media.width) / (H / W)) : 1;
  const { sx: ex, sy: ey } = scaleXY(t);
  // Align pad anchors for one axis, from the scaled picture's size on it as a fraction of the
  // frame (w). Smaller than the frame: flush inside it (left cell = picture's left edge on the
  // frame's left edge). Larger: pan, so the chosen edge of the picture meets the frame's edge
  // and the picture keeps covering the frame. Exactly filling the axis (|w − 1| within half a
  // percent): edge alignment is vacuous — the picture already touches both edges at once, so
  // every flush anchor collapses to the centred position and the pad could never move the clip
  // (the dead pad on a full-frame clip at 100%). There the centre snaps to the frame's
  // third-points instead, so the cells still take the clip where their labels say.
  const axisAnchors = (w) => {
    if (w > 1.005) { const a = (w - 1) / 2; return [a, 0, -a]; }
    if (w < 0.995) { const a = (1 - w) / 2; return [-a, 0, a]; }
    return [-1 / 3, 0, 1 / 3];
  };
  const anchorsX = axisAnchors(fitW * ex);
  const anchorsY = axisAnchors(fitH * ey);
  // The pad reflects the current anchor only when BOTH axes sit on one (within a rounding pixel).
  const matchAxis = (v, anchors, eps) => {
    for (let i = 0; i < 3; i++) if (Math.abs(v - anchors[i]) <= eps) return i;
    return -1;
  };
  const acol = matchAxis(t.x, anchorsX, 0.6 / W);
  const arow = matchAxis(t.y, anchorsY, 0.6 / H);
  const activeAnchor = acol >= 0 && arow >= 0 ? arow * 3 + acol : -1;
  const PAD_LABELS = ['Align top-left', 'Align top', 'Align top-right', 'Align left', 'Align center', 'Align right', 'Align bottom-left', 'Align bottom', 'Align bottom-right'];
  const alignPad = PAD_LABELS.map((label, i) => ({
    label,
    patch: { x: anchorsX[i % 3], y: anchorsY[Math.floor(i / 3)] },
    dot: { left: `${[14, 50, 86][i % 3]}%`, top: `${[18, 50, 82][Math.floor(i / 3)]}%` },
  }));

  // Pick samples a color from the player itself (an App stage mode, like track-pick): the
  // OS EyeDropper it used before silently rejects under Electron on Linux, so the button
  // did nothing there. The in-app sampler behaves the same on every platform.

  // Fit / Fill (item 13): the transform's scale 1 is the contain fit in both preview and
  // export, so Fit = scale 1 centred, and Fill = the cover/contain ratio, centred. Both write
  // through setT like every other transform control (keyframe-safe).
  const fitFill = (mode) => {
    if (!media?.width || !media?.height || !W || !H) return;
    if (mode === 'fit') { setT({ uniform: true, scale: 1, x: 0, y: 0 }); return; }
    const contain = Math.min(W / media.width, H / media.height);
    const cover = Math.max(W / media.width, H / media.height);
    setT({ uniform: true, scale: Math.min(4, cover / contain), x: 0, y: 0 });
  };

  const tabs = [['video', 'Video'], ['animation', 'Animation'], ...(isVideo ? [['audio', 'Audio'], ['speed', 'Speed']] : []), ['adjust', 'Adjust']];

  return (
    <div className="clip-inspector">
      <div className="ci-tabs" role="tablist">
        {tabs.map(([id, name]) => (
          <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? 'on' : ''} onClick={() => setTab(id)}>{name}</button>
        ))}
      </div>
      <div className="info">{media?.name}<br />
        <span className="dim">{media?.width}×{media?.height}{isVideo ? ` · ${formatTime(media.duration)}` : ' · photo'} · on timeline: {clipLen(clip).toFixed(2)}s</span>
      </div>

      {tab === 'video' && (
        <>
          <div className="seg-tabs small" role="tablist">
            {[['basic', 'Basic'], ['removebg', 'Remove BG'], ['mask', 'Mask']].map(([id, name]) => (
              <button key={id} role="tab" aria-selected={sub === id} className={sub === id ? 'on' : ''} onClick={() => setSub(id)}>{name}</button>
            ))}
          </div>

          {sub === 'basic' && (
            <>
              <Section title="Transform" keys={keys(['scale', 'x', 'y', 'rot'], 'transform')}
                onReset={() => set({ transform: { ...DEFAULT_TRANSFORM }, keyframes: dropKeys(['scale', 'x', 'y', 'rot']) })}>
                {S({ label: 'Scale', value: t.scale, min: 0.05, max: 4, step: 0.01, fmt: pct, numScale: 100, onChange: (scale) => setT({ scale }), extra: keys(['scale'], 'scale') })}
                <div className="fitfill-row">
                  <button type="button" className="btn btn-sm" onClick={() => fitFill('fit')}
                    title="Show the whole picture inside the frame">Fit</button>
                  <button type="button" className="btn btn-sm" onClick={() => fitFill('fill')}
                    title="Cover the whole frame with the picture (the overflow is cropped)">Fill</button>
                  <span className="dim small">Fit: whole picture visible · Fill: frame covered, overflow cropped</span>
                </div>
                <label className="field row">
                  <span>Uniform scale</span>
                  <input type="checkbox" className="switch" checked={t.uniform} onChange={(e) => setT({ uniform: e.target.checked })} />
                </label>
                {!t.uniform && (
                  <>
                    {S({ label: 'Scale width', value: t.scaleX, min: 0.05, max: 4, step: 0.01, fmt: pct, numScale: 100, onChange: (scaleX) => setT({ scaleX }) })}
                    {S({ label: 'Scale height', value: t.scaleY, min: 0.05, max: 4, step: 0.01, fmt: pct, numScale: 100, onChange: (scaleY) => setT({ scaleY }) })}
                  </>
                )}
                <div className="numrow keyed">
                  <span className="numrow-label">Position</span>
                  <NumBox label="X" value={Number((t.x * W).toFixed(1))} precision={1} suffix="px" onChange={(v) => setT({ x: v / W })} />
                  <NumBox label="Y" value={Number((t.y * H).toFixed(1))} precision={1} suffix="px" onChange={(v) => setT({ y: v / H })} />
                  {keys(['x', 'y'], 'position')}
                </div>
                <div className="numrow keyed">
                  <span className="numrow-label">Rotate</span>
                  <NumBox label="" value={t.rot} step={1} precision={1} suffix="°" onChange={(rot) => setT({ rot })} />
                  <input type="range" className="rot-range" min="-180" max="180" step="1" value={t.rot} aria-label="Rotate"
                    onPointerDown={() => dispatch({ type: 'beginGesture' })} onPointerUp={() => dispatch({ type: 'endGesture' })}
                    onChange={(e) => setT({ rot: Number(e.target.value) })} />
                  {keys(['rot'], 'rotation')}
                </div>
                <div className="align-wrap">
                  <div className="align-pad" role="group" aria-label="Align to frame">
                    {alignPad.map((cell, i) => (
                      <button key={cell.label} type="button" className={i === activeAnchor ? 'on' : ''}
                        aria-label={cell.label} aria-pressed={i === activeAnchor} title={cell.label}
                        onClick={() => setT(cell.patch)}><i style={cell.dot} /></button>
                    ))}
                  </div>
                  <span className="dim small">Snap the clip to a corner, edge or the center of the frame.</span>
                </div>
                <span className="dim small">Scale {pct(sx)} · ◇ adds a keyframe at the playhead: the clip moves from one keyframe to the next</span>
              </Section>
              {hasAnyKeys(clip) && lt !== null && nextArrival(clip, lt, fps) !== null && (
                <Section title="Segment easing">
                  <span className="dim small">How the motion travels into the keyframe at {localTime(clip, nextArrival(clip, lt, fps)).toFixed(2)}s. New segments start on Smooth.</span>
                  <CurveEditor compact value={segmentEase(clip, lt, fps)} resetValue="smooth"
                    onChange={(ease) => set(setSegmentEase(clip, lt, ease, fps))} />
                </Section>
              )}
              {media && <Stabilize clip={clip} media={media} project={project} set={set} dispatch={dispatch} />}
              {media && <MotionTracking clip={clip} media={media} set={set} onTrackPick={onTrackPick} track={track} />}
              {track === 'overlay' && <PinToTrack clip={clip} project={project} set={set} />}
              <Section title="Blend" onReset={() => set({ blend: 'normal', opacity: 1, keyframes: dropKeys(['opacity']) })}>
                <label className="field">
                  <span>Mode</span>
                  <select value={clip.blend || 'normal'} onChange={(e) => set({ blend: e.target.value })}>
                    {BLEND_MODES.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                  </select>
                </label>
                {S({ label: 'Opacity', value: at.opacity, min: 0, max: 1, step: 0.01, fmt: pct, numScale: 100, onChange: (opacity) => setT({ opacity }), extra: keys(['opacity'], 'opacity') })}
                {['mirror', 'flipv'].map((id) => (
                  <label className="field row" key={id}>
                    <span>{id === 'mirror' ? 'Flip horizontal' : 'Flip vertical'}</span>
                    <input type="checkbox" className="switch" aria-label={id === 'mirror' ? 'Flip horizontal' : 'Flip vertical'}
                      checked={(clip.effects || []).includes(id)}
                      onChange={(e) => {
                        const fx = clip.effects || [];
                        set({ effects: e.target.checked ? [...fx.filter((x) => x !== id), id] : fx.filter((x) => x !== id) });
                      }} />
                  </label>
                ))}
              </Section>
              <Section title="Crop" onReset={() => set({ crop: { ...DEFAULT_CROP }, cropAspect: 'free' })}>
                <p className="dim small">Cut away the edges of the picture, in percent of the source. The part that remains fills the clip's place, in the preview and the export.</p>
                <div className="chips pad-x" role="group" aria-label="Crop aspect">
                  {CROP_ASPECTS.map((a) => {
                    const cur = (clip.cropAspect || 'free') === a.id;
                    return (
                      <button key={a.id} type="button" className={`chip ${cur ? 'on' : ''}`} aria-pressed={cur}
                        onClick={() => {
                          if (a.id === 'free') { set({ cropAspect: 'free' }); return; }
                          const R = aspectRatioOf(a.id, media?.width, media?.height);
                          if (!R) return;
                          set({ crop: cropForAspect(cropNow, media.width, media.height, R), cropAspect: a.id });
                        }}>{a.label}</button>
                    );
                  })}
                </div>
                {[['l', 'Left'], ['t', 'Top'], ['r', 'Right'], ['b', 'Bottom']].map(([k, name]) => (
                  <div className="numrow" key={k}>
                    <span className="numrow-label">{name}</span>
                    <NumBox label="" value={Number((cropNow[k] * 100).toFixed(1))} step={1} precision={1} min={0} max={90} suffix="%"
                      onChange={(v) => set({ crop: { ...cropNow, [k]: Math.min(90, Math.max(0, v)) / 100 }, cropAspect: 'free' })} />
                  </div>
                ))}
                <button type="button" className="btn btn-sm" disabled={!onCropEdit || !media}
                  onClick={() => onCropEdit && onCropEdit({ track, id: clip.id })}>
                  <Crop size={13} /> Crop on the player
                </button>
                <p className="dim small">Drag the frame on the player itself — you can keep playing or scrubbing while you crop.</p>
              </Section>
            </>
          )}

          {sub === 'removebg' && media && <AutoRemoval clip={clip} media={media} set={set} dispatch={dispatch} />}
          {sub === 'removebg' && (
            <Section title="Chroma key" onReset={() => set({ chroma: { ...DEFAULT_CHROMA } })}
              check={<input type="checkbox" aria-label="Chroma key" checked={chroma.on} onChange={(e) => setC({ on: e.target.checked })} />}>
              <p className="dim small">Removes a solid background color, such as a green screen.</p>
              <div className="numrow">
                <span className="numrow-label">Color</span>
                <input type="color" value={chroma.color} aria-label="Key color" onChange={(e) => setC({ on: true, color: e.target.value })} />
                <button className="btn btn-sm" disabled={!onColorPick} onClick={() => onColorPick && onColorPick({ track, id: clip.id })} title="Pick a color from the player"><Pipette size={13} /> Pick</button>
                <span className="chips">
                  {['#00ff00', '#00b140', '#0047bb', '#ffffff', '#000000'].map((c) => (
                    <button key={c} className="swatch" style={{ background: c }} aria-label={`Key ${c}`} onClick={() => setC({ on: true, color: c })} />
                  ))}
                </span>
              </div>
              {S({ label: 'Intensity', value: chroma.intensity, min: 0, max: 100, step: 1, onChange: (intensity) => setC({ intensity }) })}
              {S({ label: 'Feather edge', value: chroma.feather, min: 0, max: 100, step: 1, onChange: (feather) => setC({ feather }) })}
              {S({ label: 'Remove color spill', value: chroma.spill, min: 0, max: 100, step: 1, onChange: (spill) => setC({ spill }) })}
            </Section>
          )}
          {sub === 'removebg' && (
            <Section title="Custom removal">
              <p className="dim small">Paint over the parts to remove by hand, or paint removed parts back. The painted mask applies to the whole clip, and combines with Auto removal and Chroma key (everything painted or keyed away stays away).</p>
              {hasCustomMask(clip) && <p className="dim small">{clip.customMask.strokes.length} stroke{clip.customMask.strokes.length === 1 ? '' : 's'} painted.</p>}
              <div className="fitfill-row">
                <button type="button" className="btn btn-sm" onClick={() => setMaskEdit(true)}>Paint removal…</button>
                {hasCustomMask(clip) && <button type="button" className="btn btn-sm" onClick={() => set({ customMask: null })}>Clear</button>}
              </div>
            </Section>
          )}

          {sub === 'mask' && (
            <>
              <Section title="Mask" onReset={() => set({ mask: { ...DEFAULT_MASK } })}>
                <div className="mask-grid">
                  {[{ id: 'none', name: 'None' }, ...MASK_SHAPES].map((m) => (
                    <button key={m.id} className={`mask-tile ${mask.type === m.id ? 'on' : ''}`} aria-pressed={mask.type === m.id}
                      onClick={() => setM(['circle', 'star', 'heart'].includes(m.id)
                        ? { type: m.id, h: Math.min(2, (mask.w * W) / H) } // square in pixels
                        : { type: m.id })}>
                      <MaskIcon type={m.id} /><span>{m.name}</span>
                    </button>
                  ))}
                </div>
              </Section>
              {mask.type !== 'none' && (
                <Section title="Mask settings">
                  {mask.type === 'text' && (
                    <label className="field">
                      <span>Text</span>
                      <input type="text" value={mask.text} onChange={(e) => setM({ text: e.target.value })} />
                    </label>
                  )}
                  <div className="numrow">
                    <span className="numrow-label">Position</span>
                    <NumBox label="X" value={Number((mask.x * W).toFixed(1))} precision={1} suffix="px" onChange={(v) => setM({ x: v / W })} />
                    <NumBox label="Y" value={Number((mask.y * H).toFixed(1))} precision={1} suffix="px" onChange={(v) => setM({ y: v / H })} />
                  </div>
                  {S({ label: 'Rotate', value: mask.rot, min: -180, max: 180, step: 1, fmt: (v) => `${v}°`, onChange: (rot) => setM({ rot }) })}
                  {mask.type !== 'split' && S({ label: mask.type === 'filmstrip' ? 'Band height' : 'Height', value: mask.h, min: 0.02, max: 2, step: 0.01, fmt: pct, numScale: 100, onChange: (h) => setM({ h }) })}
                  {!['split', 'filmstrip', 'text'].includes(mask.type) && S({ label: 'Width', value: mask.w, min: 0.02, max: 2, step: 0.01, fmt: pct, numScale: 100, onChange: (w) => setM({ w }) })}
                  {mask.type === 'rectangle' && S({ label: 'Round corners', value: mask.round, min: 0, max: 1, step: 0.01, fmt: pct, numScale: 100, onChange: (round) => setM({ round }) })}
                  {S({ label: 'Feather', value: mask.feather, min: 0, max: 100, step: 1, onChange: (feather) => setM({ feather }) })}
                  <label className="field row">
                    <span>Invert</span>
                    <input type="checkbox" checked={mask.invert} onChange={(e) => setM({ invert: e.target.checked })} />
                  </label>
                </Section>
              )}
              {mask.type !== 'none' && (
                <Section title="Outline and glow" onReset={() => setM({ stroke: 0, strokeColor: DEFAULT_MASK.strokeColor, glow: 0, glowColor: DEFAULT_MASK.glowColor, glowStrength: DEFAULT_MASK.glowStrength })}>
                  <div className="numrow">
                    <span className="numrow-label">Stroke</span>
                    <input type="color" value={mask.strokeColor} aria-label="Stroke color" onChange={(e) => setM({ strokeColor: e.target.value, stroke: mask.stroke || 6 })} />
                    <span className="chips">
                      {['#ffffff', '#000000', '#ec4899', '#facc15', '#22d3ee'].map((c) => (
                        <button key={c} className="chip-color" style={{ background: c }} aria-label={`Stroke ${c}`} onClick={() => setM({ strokeColor: c, stroke: mask.stroke || 6 })} />
                      ))}
                    </span>
                  </div>
                  {S({ label: 'Stroke width', value: mask.stroke, min: 0, max: 40, step: 1, fmt: (v) => (v ? `${v}px` : 'Off'), onChange: (stroke) => setM({ stroke }) })}
                  <div className="numrow">
                    <span className="numrow-label">Glow</span>
                    <input type="color" value={mask.glowColor} aria-label="Glow color" onChange={(e) => setM({ glowColor: e.target.value, glow: mask.glow || 20 })} />
                    <span className="chips">
                      {['#ec4899', '#a855f7', '#22d3ee', '#22c55e', '#facc15', '#ffffff'].map((c) => (
                        <button key={c} className="chip-color" style={{ background: c }} aria-label={`Glow ${c}`} onClick={() => setM({ glowColor: c, glow: mask.glow || 20 })} />
                      ))}
                    </span>
                  </div>
                  {S({ label: 'Glow size', value: mask.glow, min: 0, max: 80, step: 1, fmt: (v) => (v ? `${v}px` : 'Off'), onChange: (glow) => setM({ glow }) })}
                  {mask.glow > 0 && S({ label: 'Glow strength', value: mask.glowStrength, min: 5, max: 100, step: 1, fmt: (v) => `${v}%`, onChange: (glowStrength) => setM({ glowStrength }) })}
                </Section>
              )}
            </>
          )}
        </>
      )}

      {tab === 'animation' && <AnimationPanel clip={clip} len={len} set={set} dispatch={dispatch} />}

      {tab === 'audio' && (
        <>
          <Section title="Basic">
            {S({ label: 'Volume', value: clip.volume ?? 1, max: 2, fmt: pct, numScale: 100, onChange: (volume) => set({ volume }) })}
            <AudioFxControls fx={clip.audioFx} onChange={(audioFx) => set({ audioFx })} />
            <label className="field row">
              <span>Mute</span>
              <input type="checkbox" checked={!!clip.muted} onChange={(e) => set({ muted: e.target.checked })} />
            </label>
          </Section>
          <Section title="Enhance voice">
            <EnhanceVoice clip={clip} media={media} set={set} onEnhance={onEnhance} />
          </Section>
        </>
      )}

      {tab === 'speed' && (
        <Section title="Standard">
          <label className="field">
            <span>Speed <b>{clip.speed || 1}×</b></span>
            <div className="chips">
              {SPEEDS.map((s) => (
                <button key={s} className={`chip ${(clip.speed || 1) === s ? 'on' : ''}`} onClick={() => set({ speed: s })}>{s}×</button>
              ))}
            </div>
          </label>
          <div className="numrow">
            <span className="numrow-label">Source</span>
            <NumBox label="In" step={0.1} value={clip.in} onChange={(v) => set({ in: Math.max(0, Math.min(v, clip.out - 0.1)) })} />
            <NumBox label="Out" step={0.1} value={clip.out} onChange={(v) => set({ out: Math.max(clip.in + 0.1, Math.min(v, media?.duration ?? v)) })} />
          </div>
        </Section>
      )}

      {maskEdit && media && (
        <CustomMaskEditor clip={clip} media={media}
          onClose={() => setMaskEdit(false)}
          onSave={(strokes) => { set({ customMask: strokes.length ? { strokes } : null }); setMaskEdit(false); }} />
      )}
      {tab === 'adjust' && (
        <>
          {track === 'overlay' && (
            <Section title="Timeline">
              <div className="numrow">
                <span className="numrow-label">Start</span>
                <NumBox label="" step={0.1} suffix="s" value={clip.start} onChange={(v) => set({ start: Math.max(0, v) })} />
              </div>
            </Section>
          )}
          {!isVideo && (
            <Section title="Photo">
              <div className="numrow">
                <span className="numrow-label">Duration</span>
                <NumBox label="" step={0.1} suffix="s" value={clip.out} onChange={(v) => set({ in: 0, out: Math.max(0.1, v) })} />
              </div>
            </Section>
          )}
          <Section title="Filter" onReset={() => set({ filter: 'none' })}>
            <select value={clip.filter || 'none'} aria-label="Filter" onChange={(e) => set({ filter: e.target.value })}>
              {FILTERS.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
            </select>
          </Section>
          <Section title="Basic">
            <GradePanel grade={clip.grade} adjust={clip.adjust} dispatch={dispatch} autoFrom={media ? { media, clip } : undefined}
              onGrade={(grade) => set({ grade })} onAdjust={(adjust) => set({ adjust })}
              onApplyAll={() => dispatch({ type: 'updateMany', updates: [
                ...project.videoClips.filter((c) => !c.gap).map((c) => ({ track: 'video', id: c.id, patch: { grade: { ...(clip.grade || {}) }, adjust: { ...(clip.adjust || {}) } } })),
                ...(project.overlayClips || []).map((c) => ({ track: 'overlay', id: c.id, patch: { grade: { ...(clip.grade || {}) }, adjust: { ...(clip.adjust || {}) } } })),
              ] })} />
          </Section>
          {track === 'video' && (
            <Section title="Transition in">
              <select value={clip.transition?.type || 'none'} aria-label="Transition in"
                onChange={(e) => set({ transition: e.target.value === 'none' ? null : { type: e.target.value, duration: clip.transition?.duration || 0.5, ...(/zoom/i.test(e.target.value) ? { ease: 'smooth' } : {}) } })}>
                {[{ id: 'none', name: 'None' }, ...TRANSITIONS].map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
              </select>
              {clip.transition && S({
                label: 'Duration', value: clip.transition.duration, min: 0.2, max: 2, step: 0.1, fmt: (v) => `${v.toFixed(1)}s`,
                onChange: (d) => set({ transition: { ...clip.transition, duration: d } }),
              })}
              {clip.transition && directionGroupFor(clip.transition.type) && (() => {
                const { group, dir } = directionGroupFor(clip.transition.type);
                const arrows = { left: '←', right: '→', up: '↑', down: '↓' };
                return (
                  <div className="dir-seg" role="group" aria-label={`${group.name} direction`}>
                    {['left', 'right', 'up', 'down'].map((d) => (
                      <button key={d} className={`btn btn-sm ${d === dir ? 'btn-primary' : ''}`} aria-pressed={d === dir}
                        title={`${group.name} ${d}`} onClick={() => set({ transition: { ...clip.transition, type: group.ids[d] } })}>{arrows[d]} {d}</button>
                    ))}
                  </div>
                );
              })()}
            </Section>
          )}
          {!!clip.effects?.length && <div className="dim">Effects: {clip.effects.join(', ')}</div>}
        </>
      )}
    </div>
  );
}
