import React, { useEffect, useRef, useState } from 'react';
import { FIT_VIEW, QUALITY_LABELS, QUALITY_MAX_SIDE, applyZoomChoice, clipLen, formatTime, freeLen, getPlaybackQuality, levelCopyState, previewPath, toFileUrl, videoLayout, zoomByFactor, zoomTransform } from '../store.js';
import { hasMotion } from '../anim.js';
import { fitFactors, mediaToStage, pinOffsetAt, stageToMedia, stateAtPinned } from '../track.js';
import { aspectRatioOf, dragCrop, moveCrop } from '../cropMath.js';
import { pictureGeometry, stageToSource } from '../pictureGeometry.js';
import { Check, ChevronLeft, ChevronRight, ChevronUp, Gauge, LoaderCircle, Maximize, Minimize, Pause, Play, SkipBack, SkipForward, ZoomIn } from 'lucide-react';
import { clipCss, textAnim } from '../effects.js';
import { drawTextLayer } from '../text/render.js';
import { applyElementVolume, resumeAudioGraph, wireElement } from '../audioTap.js';
import { fontsReady, onFontsChanged } from '../fonts.js';
import { isInternal, readPayload } from '../dnd.js';
import { applyChromaKey, blendOf, chromaOf, cropOf, customMaskCanvas, decoStyle, hasCrop, hasCustomMask, layerStyle, transformOf } from '../visual.js';
import TransformBox from './TransformBox.jsx';
import MediaPeek from './MediaPeek.jsx';
import { fxTransition } from '../fx/catalog.js';
import { easeValue } from '../fx/easing.js';
import { fxGL } from '../fx/gl.js';
import { classicViaShader, drawOverlayPasses, pixelPasses } from '../fx/apply.js';
import { anchorCorrection, interpolateTime } from '../playbackClock.js';


// Overlay effects (snow, sparkles, fire...) of every clip on screen at time t, drawn in project pixels.
// The export draws the same function into its text layer frames (src/exportText.js).
export function drawFxOverlays(ctx, project, t, W, H) {
  drawOverlayPasses(ctx, project, t, W, H);
}

// ---- Effect region outline: the selected effect's region as a draggable dashed box ----
// Resolves the selected effect instance (Effects-track clip, or an effect attached to a clip)
// to its region + the store write for it; null when the selection has no region to show.
export function regionTarget(project, selection) {
  if (selection?.track !== 'effect' || !selection.id) return null;
  if (!selection.id.includes('|')) {
    const c = (project.effectClips || []).find((x) => x.id === selection.id);
    return c?.region ? { region: c.region, write: (dispatch, region) => dispatch({ type: 'update', track: 'effect', id: c.id, patch: { region } }) } : null;
  }
  const [track, clipId, fx] = selection.id.split('|');
  const clip = (track === 'overlay' ? project.overlayClips || [] : project.videoClips || []).find((c) => c.id === clipId);
  const region = clip?.fxRegions?.[fx];
  return region ? { region, write: (dispatch, r) => dispatch({ type: 'update', track, id: clipId, patch: { fxRegions: { ...(clip.fxRegions || {}), [fx]: r } } }) } : null;
}

const clamp01 = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export function RegionOverlay({ region, write, dispatch }) {
  const ref = useRef(null);
  const startDrag = (mode) => (e) => {
    e.stopPropagation();
    e.preventDefault();
    const box = ref.current?.parentElement?.getBoundingClientRect();
    if (!box) return;
    const o = { ...region };
    const x0 = e.clientX;
    const y0 = e.clientY;
    dispatch({ type: 'beginGesture' });
    const move = (ev) => {
      const dx = (ev.clientX - x0) / box.width;
      const dy = (ev.clientY - y0) / box.height;
      if (mode === 'move') write(dispatch, { ...o, x: clamp01(o.x + dx, 0, 1 - o.w), y: clamp01(o.y + dy, 0, 1 - o.h) });
      else write(dispatch, { ...o, w: clamp01(o.w + dx, 0.05, 1 - o.x), h: clamp01(o.h + dy, 0.05, 1 - o.y) });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      dispatch({ type: 'endGesture' });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  return (
    <div ref={ref} className={`fx-region ${region.shape === 'ellipse' ? 'ellipse' : ''}`} role="presentation"
      style={{ left: `${region.x * 100}%`, top: `${region.y * 100}%`, width: `${region.w * 100}%`, height: `${region.h * 100}%` }}
      onPointerDown={startDrag('move')}>
      <div className="fx-region-handle" onPointerDown={startDrag('size')} />
    </div>
  );
}

// Draws the current picture of a video or image into the slot's canvas with the crop, the chroma key, the AI
// background matte and the painted custom-removal mask (CPU, at most 640 px wide) and the animated effects
// (WebGL shaders, the same the export uses, up to 1280 px wide) applied. matte: the hidden video of the clip's
// matte (white = keep), or null. opts.crop: source-edge fractions cut away before the fit — the canvas IS the
// surviving region (its own aspect), so the layer's contain fit places it undistorted, exactly like the
// export; opts.custom: the painted keep-map canvas in source geometry.
// Every removal multiplies the alpha, so chroma + matte + custom union, as in electron/layers.cjs.
const matteCv = typeof document !== 'undefined' ? document.createElement('canvas') : null;
function drawKeyed(cv, src, w, h, chroma, passes = [], matte = null, opts = {}) {
  if (!w || !h) return;
  const crop = opts.crop || null;
  const custom = opts.custom || null;
  const cpu = chroma.on || !!matte || !!custom;
  // CPU work (chroma key, matte, custom mask) runs at 640 px; otherwise the frame is processed at the playback
  // quality's resolution — a scaled proxy needs no more, Full/High keep the 1280 px ceiling.
  const cap = cpu ? 640 : Math.min(1280, QUALITY_MAX_SIDE[getPlaybackQuality()] || 1280);
  const sw = crop ? w * (1 - crop.l - crop.r) : w;
  const sh = crop ? h * (1 - crop.t - crop.b) : h;
  // The canvas has the SURVIVING REGION's aspect (not the source's): the layer element's
  // object-fit: contain then fits the region into the frame at a uniform scale — the
  // picture is never stretched over the uncropped fit box (the export fits it the same
  // way, electron/layers.cjs).
  const k = Math.min(1, cap / sw);
  const cw = Math.max(2, Math.round(sw * k));
  const ch = Math.max(2, Math.round(sh * k));
  if (cv.width !== cw || cv.height !== ch) {
    cv.width = cw;
    cv.height = ch;
  }
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  // The sub-rectangle of a source-geometry companion (matte video, painted mask) that survives the crop,
  // in that companion's own pixels.
  const subRect = (ew, eh) => (crop
    ? [crop.l * ew, crop.t * eh, (1 - crop.l - crop.r) * ew, (1 - crop.t - crop.b) * eh]
    : [0, 0, ew, eh]);
  try {
    ctx.drawImage(src, ...(crop ? [crop.l * w, crop.t * h, sw, sh] : [0, 0, w, h]), 0, 0, cw, ch);
    if (cpu) {
      const frame = ctx.getImageData(0, 0, cw, ch);
      if (chroma.on) applyChromaKey(frame.data, chroma);
      const d = frame.data;
      const multiplyAlpha = (companion, ew, eh) => {
        if (matteCv.width !== cw || matteCv.height !== ch) {
          matteCv.width = cw;
          matteCv.height = ch;
        }
        const mctx = matteCv.getContext('2d', { willReadFrequently: true });
        mctx.drawImage(companion, ...subRect(ew, eh), 0, 0, cw, ch);
        const a = mctx.getImageData(0, 0, cw, ch).data;
        for (let i = 3; i < d.length; i += 4) d[i] = (d[i] * a[i - 3]) / 255;
      };
      if (matte) multiplyAlpha(matte, matte.videoWidth || cw, matte.videoHeight || ch);
      if (custom) multiplyAlpha(custom, custom.width, custom.height);
      ctx.putImageData(frame, 0, 0);
    }
    if (passes.length) {
      const out = fxGL().effects(cpu || crop ? cv : src, cw, ch, passes);
      ctx.clearRect(0, 0, cw, ch);
      ctx.drawImage(out, 0, 0);
    }
  } catch {
    // The frame is not decoded yet; the seeked / load handlers draw again.
  }
}

// Playback uses the wall clock as master; media elements are kept in sync with it.
// The main track uses two "slots" (clip index % 2) so that during a transition the outgoing
// and incoming clips are both on screen, mirroring FFmpeg's xfade at export.
const DRIFT = 0.25;

// Seamless source swaps (playback-quality copies landing, quality level switched): when the
// element's file changes, the element reloads and would restart at frame 0 — the playhead
// jumping back is the visible glitch. Instead the swap is armed: every sync while the new file
// loads records where playback should be, and the moment its metadata lands the element is
// placed on that exact position (and resumed, if playing) before any frame of it is shown.
const swapWants = new WeakMap(); // el -> { time, playing } wanted once the new source can seek
function armSwap(el) {
  const onMeta = () => {
    delete el.dataset.swap;
    const w = swapWants.get(el);
    if (!w) return;
    try { el.currentTime = Math.max(0, w.time); } catch { /* not seekable yet; the drift check below lands it */ }
    if (w.playing) el.play().catch(() => {});
  };
  el.addEventListener('loadedmetadata', onMeta, { once: true });
}

function syncMedia(el, url, localTime, playing, volume, rate = 1) {
  if (el.dataset.src !== url) {
    el.dataset.src = url;
    el.dataset.swap = '1';
    swapWants.set(el, { time: localTime, playing });
    el.src = url;
    armSwap(el);
  } else if (el.dataset.swap) {
    swapWants.set(el, { time: localTime, playing }); // keep the landing spot current while it loads
  }
  applyElementVolume(el, volume);
  if (el.playbackRate !== rate) el.playbackRate = rate;
  if (el.readyState >= 1 && Math.abs(el.currentTime - localTime) > (playing ? DRIFT * rate : 0.01)) el.currentTime = localTime;
  if (playing && el.paused && !el.dataset.swap) el.play().catch(() => {});
  if (!playing && !el.paused) el.pause();
}

// The AI background matte follows its clip's video: the same time when paused; while playing, its speed is nudged
// (not seeked) so the two stay within a frame or two without stutter. Both are in source seconds.
function syncMatte(mv, url, lead, playing, rate) {
  if (mv.dataset.src !== url) {
    mv.dataset.src = url;
    mv.src = url;
  }
  if (mv.readyState < 1 || lead.readyState < 1) return;
  const diff = lead.currentTime - mv.currentTime;
  if (!playing) {
    if (!mv.paused) mv.pause();
    mv.playbackRate = rate;
    if (Math.abs(diff) > 0.01) mv.currentTime = lead.currentTime;
    return;
  }
  if (Math.abs(diff) > 0.3) mv.currentTime = lead.currentTime;
  mv.playbackRate = rate * (1 + Math.max(-0.15, Math.min(0.15, diff * 1.5)));
  if (mv.paused) mv.play().catch(() => {});
}
const usesMatte = (c, m) => !!(c.bgRemove && m && m.type === 'video' && m.matte);

// The Voice Enhancer's cached file for a clip, when on and rendered for the clip's current
// range (a re-trim makes it stale and inert, exactly as in the export — electron/ffmpeg.cjs
// enhancePathOf). The file covers [clip.in, clip.out], so its timeline starts at 0.
const enhPath = (c) => {
  const e = c.enhance;
  if (!e || !e.on || !e.path) return null;
  if (Math.abs((e.from ?? -1) - (c.in || 0)) > 0.02 || Math.abs((e.to ?? -1) - (c.out ?? -1)) > 0.02) return null;
  return e.path;
};

function transitionStyles(type, p) {
  const s = { in: {}, out: {}, flash: null };
  switch (type) {
    case 'fade':
    case 'dissolve': s.in.opacity = p; break;
    case 'fadeblack':
    case 'fadewhite':
      s.in.opacity = p < 0.5 ? 0 : 1;
      s.flash = { color: type === 'fadeblack' ? '#000' : '#fff', opacity: p < 0.5 ? 2 * p : 2 * (1 - p) };
      break;
    case 'wipeleft': s.in.clipPath = `inset(0 0 0 ${(1 - p) * 100}%)`; break;
    case 'wiperight': s.in.clipPath = `inset(0 ${(1 - p) * 100}% 0 0)`; break;
    case 'slideleft': s.in.transform = `translateX(${(1 - p) * 100}%)`; s.out.transform = `translateX(${-p * 100}%)`; break;
    case 'slideright': s.in.transform = `translateX(${-(1 - p) * 100}%)`; s.out.transform = `translateX(${p * 100}%)`; break;
    case 'circleopen': s.in.clipPath = `circle(${p * 75}% at 50% 50%)`; break;
    default: s.in.opacity = p;
  }
  return s;
}

export default function Preview({
  project, editProject, selection, onSelect, dispatch, time, seekVer, playing, duration, onTime, onEnd, onTogglePlay, onSeek, onDropItem,
  peek, onClosePeek, onAddPeek, quality = 'full', onQualityChange, clockRef,
  trackPick, onTrackPoint,
  cropEdit, onCropDraft,
  colorPick, onColorPicked,
}) {
  const [dropOver, setDropOver] = useState(false);
  const slots = [useRef(null), useRef(null)];
  const vids = [useRef(null), useRef(null)];
  const mattes = [useRef(null), useRef(null)]; // hidden videos of the AI background mattes
  const decos = [useRef(null), useRef(null)]; // mask outline / glow above each clip
  const imgs = [useRef(null), useRef(null)];
  const layers = [useRef(null), useRef(null)];
  const keyed = [useRef(null), useRef(null)];
  const lastApply = useRef({ t: 0, playing: false });
  const leadRef = useRef(null); // the main-track video element the playback clock anchors to
  const trCanvas = useRef(null);
  const trBufs = useRef({ a: null, b: null });
  const flashRef = useRef(null);
  const audioEls = useRef({});
  const enhEls = useRef({}); // clip id -> hidden <audio> playing an enhanced picture clip's sound
  const overlayEls = useRef({}); // clip id -> { slot, layer, v, img, cv }
  const stageRef = useRef(null);
  const [scale, setScale] = useState(1);
  // Full screen player (button or F, Esc to leave): only the video and the transport bar.
  const playerRef = useRef(null);
  const [full, setFull] = useState(false);
  // Level meter tap (item 11): route every sounding element through the shared audio graph,
  // once per element. Runs each commit; the graph guards repeats. Matte/keying videos are muted
  // by design and are not part of the mix, so they are skipped.
  useEffect(() => {
    wireElement(vids[0].current);
    wireElement(vids[1].current);
    for (const o of Object.values(overlayEls.current)) wireElement(o && o.v);
    for (const el of Object.values(audioEls.current)) wireElement(el);
    for (const el of Object.values(enhEls.current)) wireElement(el);
  });
  useEffect(() => { if (playing) resumeAudioGraph(); }, [playing]);
  useEffect(() => {
    const on = () => setFull(document.fullscreenElement === playerRef.current);
    document.addEventListener('fullscreenchange', on);
    return () => document.removeEventListener('fullscreenchange', on);
  }, []);
  const toggleFull = () => {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else playerRef.current?.requestFullscreen().catch(() => {});
  };
  // Transport menus (playback quality, zoom): at most one open; closes on outside click / Escape.
  const [menu, setMenu] = useState(null); // 'quality' | 'zoom' | null
  useEffect(() => {
    if (!menu) return;
    const down = (e) => { if (!e.target.closest('.transport-menu-wrap')) setMenu(null); };
    const key = (e) => { if (e.key === 'Escape') setMenu(null); };
    document.addEventListener('mousedown', down);
    window.addEventListener('keydown', key);
    return () => { document.removeEventListener('mousedown', down); window.removeEventListener('keydown', key); };
  }, [menu]);
  // Player view zoom: session-only view state (never saved, never touches clips or export).
  const wrapRef = useRef(null);
  const [view, setView] = useState(FIT_VIEW);
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const onWheel = (e) => {
      e.preventDefault();
      const factor = Math.exp(-e.deltaY * 0.0016);
      setView((v) => zoomByFactor(v, factor, stageRef.current?.clientWidth, stageRef.current?.clientHeight));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);
  // Dragging empty stage area pans a zoomed view. Drags starting on the transform layer or any
  // control keep their own behaviour (the transform layer handles clip dragging itself).
  const onStageMouseDown = (e) => {
    // Crop mode owns the stage (CROP-3 addendum, 2026-11-01): while it is open, no
    // view pan — a drag there must only ever move the crop frame, never the picture.
    if (e.button !== 0 || view.fit || cropEdit || e.target.closest('.tbox-layer, button, input, select, textarea, a')) return;
    const sx = e.clientX;
    const sy = e.clientY;
    const v0 = view;
    const move = (ev) => setView((v) => {
      const w = stageRef.current?.clientWidth;
      const h = stageRef.current?.clientHeight;
      const mx = Math.max(0, ((v.z - 1) * (w || 0)) / 2) + 60;
      const my = Math.max(0, ((v.z - 1) * (h || 0)) / 2) + 60;
      return { ...v, x: Math.min(mx, Math.max(-mx, v0.x + ev.clientX - sx)), y: Math.min(my, Math.max(-my, v0.y + ev.clientY - sy)) };
    });
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  const stageDims = () => [stageRef.current?.clientWidth, stageRef.current?.clientHeight];
  // True while some video in the project still waits for its copy at the current quality level.
  const preparing = quality !== 'full' && project.media.some((m) => levelCopyState(m, quality) === 'fallback');
  useEffect(() => {
    const onKey = (e) => {
      if (e.key.toLowerCase() !== 'f' || e.ctrlKey || e.altKey || e.metaKey) return;
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName) || e.target.isContentEditable) return;
      e.preventDefault();
      toggleFull();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const mediaById = Object.fromEntries(project.media.map((m) => [m.id, m]));

  const apply = (t, isPlaying) => {
    lastApply.current = { t, playing: isPlaying };
    leadRef.current = null;
    const enhSounding = new Set(); // enhanced picture clips heard at t; the rest get paused below
    const layout = videoLayout(project.videoClips);
    const active = layout.filter((l) => t >= l.start && t < l.end && mediaById[l.clip.mediaId]);
    const incoming = active.length === 2 ? active[1] : null;
    const fxTr = incoming && incoming.trans > 0 ? fxTransition(incoming.clip.transition.type) : null;
    const tr = incoming && incoming.trans > 0 && !fxTr ? transitionStyles(incoming.clip.transition.type, (t - incoming.start) / incoming.trans) : null;

    [0, 1].forEach((k) => {
      const slot = slots[k].current;
      const v = vids[k].current;
      const img = imgs[k].current;
      const item = active.find((l) => l.index % 2 === k);
      slot.style.opacity = '1';
      slot.style.transform = '';
      slot.style.clipPath = 'none';
      const layer = layers[k].current;
      const cv = keyed[k].current;
      const mv = mattes[k].current;
      if (!item) {
        slot.style.visibility = 'hidden';
        if (!v.paused) v.pause();
        if (!mv.paused) mv.pause();
        return;
      }
      const c = item.clip;
      const m = mediaById[c.mediaId];
      const fx = c.effects || [];
      slot.style.visibility = 'visible';
      slot.style.zIndex = item === incoming ? 2 : 1;
      slot.style.filter = clipCss(c);
      slot.style.mixBlendMode = blendOf(c).css;
      const motionNow = (hasMotion(c) || c.pin) ? stateAtPinned(project, { track: 'video', clip: c }, t - item.start, clipLen(c)) : undefined;
      Object.assign(layer.style, layerStyle(c, project.width, project.height, motionNow));
      if (decos[k].current) Object.assign(decos[k].current.style, decoStyle(c, project.width, project.height, motionNow));
      const chroma = chromaOf(c);
      slot.classList.toggle('vignette', fx.includes('vignette') && !classicViaShader(c, 'vignette'));
      const flip = `scale(${fx.includes('mirror') && !classicViaShader(c, 'mirror') ? -1 : 1}, ${fx.includes('flipv') && !classicViaShader(c, 'flipv') ? -1 : 1})`;
      if (tr) Object.assign(slot.style, item === incoming ? tr.in : tr.out);
      if (m.type === 'image') {
        v.style.display = 'none';
        if (!v.paused) v.pause();
        img.style.display = 'block';
        img.style.transform = flip;
        const url = toFileUrl(m.path);
        if (img.dataset.src !== url) { img.dataset.src = url; img.src = url; }
      } else {
        img.style.display = 'none';
        v.style.display = 'block';
        v.style.transform = flip;
        const speed = c.speed || 1;
        // Voice Enhancer: the video element goes silent and a hidden audio element plays the
        // enhanced file (which starts at the clip's in-point, so its time is the local time).
        const ep = enhPath(c);
        syncMedia(v, toFileUrl(previewPath(m)), c.in + (t - item.start) * speed, isPlaying, ep || c.muted ? 0 : c.volume ?? 1, speed);
        if (ep && enhEls.current[c.id]) {
          enhSounding.add(c.id);
          syncMedia(enhEls.current[c.id], toFileUrl(ep), (t - item.start) * speed, isPlaying, c.muted ? 0 : c.volume ?? 1, speed);
        }
        // The playback clock anchors to the lead (non-incoming) clip's element.
        if (item !== incoming || !leadRef.current) leadRef.current = { el: v, item, clip: c };
      }
      const matte = usesMatte(c, m);
      if (matte) syncMatte(mv, toFileUrl(m.matte), v, isPlaying, c.speed || 1);
      else if (!mv.paused) mv.pause();
      // Chroma key / matte: the media element stays (it plays the sound and decodes), the keyed canvas is what shows.
      const src = m.type === 'image' ? img : v;
      const pfx = pixelPasses(project, c, item.start, t - item.start);
      // While this clip is being visually cropped, the player shows its FULL source so the
      // crop frame can be dragged over the whole picture; the crop applies again on Done.
      const crop = cropEdit && c.id === cropEdit.id ? null : (hasCrop(c) ? cropOf(c) : null);
      const custom = hasCustomMask(c) ? customMaskCanvas(c, m.width || project.width, m.height || project.height) : null;
      const processed = chroma.on || pfx.length > 0 || matte || !!crop || !!custom;
      cv.style.display = processed ? 'block' : 'none';
      src.style.visibility = processed ? 'hidden' : ''; // '' inherits: 'visible' would show through a hidden slot
      if (processed) {
        cv.style.transform = flip;
        if (m.type === 'image') { if (img.complete) drawKeyed(cv, img, img.naturalWidth, img.naturalHeight, chroma, pfx, null, { crop, custom }); }
        else if (v.readyState >= 2) drawKeyed(cv, v, v.videoWidth, v.videoHeight, chroma, pfx, matte && mv.readyState >= 2 ? mv : null, { crop, custom });
      }
    });

    // Animated transitions: both clips are drawn into small frames and mixed by the same expression the export uses.
    const tc = trCanvas.current;
    if (fxTr) {
      const outgoing = active[0];
      const pw = Math.min(960, project.width);
      const ph = Math.max(2, Math.round((pw * project.height) / project.width));
      if (tc.width !== pw || tc.height !== ph) { tc.width = pw; tc.height = ph; }
      const frameOf = (item, key) => {
        const k = item.index % 2;
        const m = mediaById[item.clip.mediaId];
        let off = trBufs.current[key];
        if (!off || off.width !== pw || off.height !== ph) { off = document.createElement('canvas'); off.width = pw; off.height = ph; trBufs.current[key] = off; }
        const octx = off.getContext('2d');
        octx.fillStyle = project.background || '#000';
        octx.fillRect(0, 0, pw, ph);
        const kc = keyed[k].current;
        const srcEl = kc.style.display === 'block' ? kc : m.type === 'image' ? imgs[k].current : vids[k].current;
        const sw = srcEl.videoWidth || srcEl.naturalWidth || srcEl.width;
        const sh = srcEl.videoHeight || srcEl.naturalHeight || srcEl.height;
        if (sw && sh) {
          const f = Math.min(pw / sw, ph / sh);
          try { octx.drawImage(srcEl, (pw - sw * f) / 2, (ph - sh * f) / 2, sw * f, sh * f); } catch { /* frame not ready */ }
        }
        return off;
      };
      const a = frameOf(outgoing, 'a');
      const b = frameOf(incoming, 'b');
      const out = fxGL().transition(a, b, pw, ph, easeValue(incoming.clip.transition?.ease, (t - incoming.start) / incoming.trans), fxTr.expr);
      tc.getContext('2d').drawImage(out, 0, 0);
      tc.style.display = 'block';
      slots.forEach((s) => { s.current.style.opacity = '0'; });
    } else if (tc) {
      tc.style.display = 'none';
    }
    const fl = flashRef.current;
    fl.style.opacity = tr && tr.flash ? tr.flash.opacity : 0;
    if (tr && tr.flash) fl.style.background = tr.flash.color;

    // Overlay clips (picture in picture): same layer model as the main track, drawn above it.
    (project.overlayClips || []).forEach((c) => {
      const el = overlayEls.current[c.id];
      const m = mediaById[c.mediaId];
      if (!el || !el.slot || !m) return;
      const lt = t - c.start;
      const on = lt >= 0 && lt < freeLen('overlay', c);
      el.slot.style.visibility = on ? 'visible' : 'hidden';
      if (!on) {
        if (el.v && !el.v.paused) el.v.pause();
        return;
      }
      const fx = c.effects || [];
      el.slot.style.filter = clipCss(c);
      el.slot.style.mixBlendMode = blendOf(c).css;
      const motionNow = (hasMotion(c) || c.pin) ? stateAtPinned(project, { track: 'overlay', clip: c }, lt, clipLen(c)) : undefined;
      Object.assign(el.layer.style, layerStyle(c, project.width, project.height, motionNow));
      if (el.deco) Object.assign(el.deco.style, decoStyle(c, project.width, project.height, motionNow));
      el.slot.classList.toggle('vignette', fx.includes('vignette') && !classicViaShader(c, 'vignette'));
      const flip = `scale(${fx.includes('mirror') && !classicViaShader(c, 'mirror') ? -1 : 1}, ${fx.includes('flipv') && !classicViaShader(c, 'flipv') ? -1 : 1})`;
      const chroma = chromaOf(c);
      const src = m.type === 'image' ? el.img : el.v;
      src.style.transform = flip;
      if (m.type === 'image') {
        const url = toFileUrl(m.path);
        if (el.img.dataset.src !== url) { el.img.dataset.src = url; el.img.src = url; }
      } else {
        const speed = c.speed || 1;
        const ep = enhPath(c);
        syncMedia(el.v, toFileUrl(previewPath(m)), c.in + lt * speed, isPlaying, ep || c.muted ? 0 : c.volume ?? 1, speed);
        if (ep && enhEls.current[c.id]) {
          enhSounding.add(c.id);
          syncMedia(enhEls.current[c.id], toFileUrl(ep), lt * speed, isPlaying, c.muted ? 0 : c.volume ?? 1, speed);
        }
      }
      const matte = usesMatte(c, m) && el.mv;
      if (matte) syncMatte(el.mv, toFileUrl(m.matte), el.v, isPlaying, c.speed || 1);
      else if (el.mv && !el.mv.paused) el.mv.pause();
      const pfx = pixelPasses(project, c, c.start, lt);
      const crop = cropEdit && c.id === cropEdit.id ? null : (hasCrop(c) ? cropOf(c) : null);
      const custom = hasCustomMask(c) ? customMaskCanvas(c, m.width || project.width, m.height || project.height) : null;
      const processed = chroma.on || pfx.length > 0 || !!matte || !!crop || !!custom;
      el.cv.style.display = processed ? 'block' : 'none';
      src.style.visibility = processed ? 'hidden' : ''; // '' inherits: 'visible' would show through a hidden slot
      if (processed) {
        el.cv.style.transform = flip;
        if (m.type === 'image') { if (el.img.complete) drawKeyed(el.cv, el.img, el.img.naturalWidth, el.img.naturalHeight, chroma, pfx, null, { crop, custom }); }
        else if (el.v.readyState >= 2) drawKeyed(el.cv, el.v, el.v.videoWidth, el.v.videoHeight, chroma, pfx, matte && el.mv.readyState >= 2 ? el.mv : null, { crop, custom });
      }
    });

    project.audioClips.forEach((c) => {
      const el = audioEls.current[c.id];
      const m = mediaById[c.mediaId];
      if (!el || !m) return;
      const len = freeLen('audio', c);
      const lt = t - c.start;
      if (lt >= 0 && lt < len) {
        let g = c.volume ?? 1;
        if (c.fadeIn > 0) g *= Math.min(1, lt / c.fadeIn);
        if (c.fadeOut > 0) g *= Math.min(1, (len - lt) / c.fadeOut);
        const ep = enhPath(c);
        syncMedia(el, toFileUrl(ep || m.path), ep ? lt * (c.speed || 1) : c.in + lt * (c.speed || 1), isPlaying, g, c.speed || 1);
      } else if (!el.paused) el.pause();
    });

    // Enhanced picture clips that are not on screen at t fall silent.
    for (const [id, el] of Object.entries(enhEls.current)) {
      if (el && !enhSounding.has(id) && !el.paused) el.pause();
    }
  };

  // Paused: when a seek or an image load finishes, draw again (keyed canvases need the decoded frame).
  const redraw = () => {
    if (!lastApply.current.playing) apply(lastApply.current.t, false);
  };

  // Paused: show the frame at `time`.
  useEffect(() => {
    if (!playing) {
      apply(time, false);
      if (clockRef) clockRef.current = { time, stamp: performance.now(), playing: false, rate: 1 };
    }
  });

  // Playing: a media-anchored clock. The position interpolates from the last anchor at
  // display rate; whenever the lead video element disagrees by more than 50 ms the anchor
  // is corrected — snapped forward if the media is ahead, HELD (never rewound) if the
  // media stalled, so a decode hiccup pauses the playhead instead of the old behaviour
  // (wall clock runs on, then a jump-cut seek when the drift threshold trips). The clock
  // is also published to clockRef every frame: the timeline's playhead reads it directly
  // from the DOM side, so it glides even when React renders drop frames.
  useEffect(() => {
    if (!playing) return;
    const master = { time, stamp: performance.now() };
    let raf;
    const tick = () => {
      let t = interpolateTime(master.time, master.stamp, performance.now(), 1);
      const lead = leadRef.current;
      if (lead?.el && lead.el.readyState >= 2 && !lead.el.paused && t >= lead.item.start && t < lead.item.end) {
        const mt = lead.item.start + (lead.el.currentTime - lead.clip.in) / (lead.clip.speed || 1);
        const fix = Number.isFinite(mt) ? anchorCorrection(mt, t) : null;
        if (fix) { master.time = fix.time; master.stamp = performance.now(); t = fix.time; }
      }
      if (t >= duration) {
        onTime(duration);
        onEnd();
        apply(duration, false);
        if (clockRef) clockRef.current = { time: duration, stamp: performance.now(), playing: false, rate: 1 };
        return;
      }
      apply(t, true);
      onTime(t);
      if (clockRef) clockRef.current = { time: t, stamp: performance.now(), playing: true, rate: 1 };
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // Restart the loop when play state toggles, the user seeks (seekVer bumps) or the project changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, seekVer, project, duration]);

  // Scale overlays from project pixels (e.g. 1280x720) to the on-screen stage.
  useEffect(() => {
    const ro = new ResizeObserver(() => {
      if (stageRef.current) setScale(stageRef.current.clientWidth / project.width);
    });
    ro.observe(stageRef.current);
    return () => ro.disconnect();
  }, [project.width]);

  // Text layer: drawn with the same canvas renderer the export uses.
  const textCanvas = useRef(null);
  const [fontTick, setFontTick] = useState(0);
  useEffect(() => {
    fontsReady().then(() => setFontTick((n) => n + 1));
    return onFontsChanged(() => setFontTick((n) => n + 1));
  }, []);
  useEffect(() => {
    const cv = textCanvas.current;
    const stage = stageRef.current;
    if (!cv || !stage) return;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(stage.clientWidth * dpr);
    const h = Math.round(stage.clientHeight * dpr);
    if (cv.width !== w || cv.height !== h) {
      cv.width = w;
      cv.height = h;
    }
    const ctx = cv.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.setTransform(w / project.width, 0, 0, h / project.height, 0, 0);
    drawFxOverlays(ctx, project, time, project.width, project.height);
    drawTextLayer(ctx, project, time, project.width, project.height);
  }, [time, project, scale, fontTick]);

  return (
    <section ref={playerRef} className={`player ${dropOver ? 'drop-target' : ''} ${full ? 'is-full' : ''} ${peek ? 'peeking' : ''}`} aria-label="Player"
      onDragOver={(e) => { if (!isInternal(e)) return; e.preventDefault(); e.stopPropagation(); setDropOver(true); }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setDropOver(false); }}
      onDrop={(e) => { if (!isInternal(e)) return; e.preventDefault(); e.stopPropagation(); setDropOver(false); onDropItem(readPayload(e)); }}>
      <div className="panel-head">
        <span className="panel-title">Player</span>
        {peek ? <span className="pill peek-pill" title={peek.name}>{peek.assetPath ? 'Asset' : 'Media'} · {peek.name}</span>
          : <span className="pill">{project.ratio} · {project.width}×{project.height} · {project.fps} fps</span>}
      </div>
      {peek && <MediaPeek m={peek} fps={project.fps} onClose={onClosePeek} onAdd={onAddPeek} />}
      <div className={`stage-wrap ${view.z > 1 ? 'zoomed' : ''}`} ref={wrapRef} onMouseDown={onStageMouseDown}>
        <div className="stage" ref={stageRef} style={{
          aspectRatio: `${project.width} / ${project.height}`, background: project.background,
          width: `min(100cqw, calc(100cqh * ${project.width / project.height}))`,
          transform: zoomTransform(view),
        }}>
          {[0, 1].map((k) => (
            <div key={k} className="slot" ref={slots[k]}>
              <div className="layer" ref={layers[k]}>
                <video ref={vids[k]} preload="auto" playsInline onSeeked={redraw} onLoadedData={redraw} />
                <video ref={mattes[k]} className="matte-src" preload="auto" playsInline muted onSeeked={redraw} onLoadedData={redraw} />
                <img ref={imgs[k]} alt="" onLoad={redraw} />
                <canvas ref={keyed[k]} className="keyed" />
              </div>
              <div className="layer deco" ref={decos[k]} />
            </div>
          ))}
          <canvas className="fx-transition" ref={trCanvas} />
          <div className="flash" ref={flashRef} />
          {(project.overlayClips || []).map((c) => {
            const m = mediaById[c.mediaId];
            const reg = (part) => (node) => {
              const el = overlayEls.current[c.id] || (overlayEls.current[c.id] = {});
              if (node) el[part] = node;
              else delete overlayEls.current[c.id];
            };
            return (
              <div key={c.id} className="slot ov" ref={reg('slot')} style={{ visibility: 'hidden' }}>
                <div className="layer" ref={reg('layer')}>
                  <video ref={reg('v')} preload="auto" playsInline onSeeked={redraw} onLoadedData={redraw}
                    style={{ display: m?.type === 'video' ? 'block' : 'none' }} />
                  <img ref={reg('img')} alt="" onLoad={redraw} style={{ display: m?.type === 'image' ? 'block' : 'none' }} />
                  <video ref={reg('mv')} className="matte-src" preload="auto" playsInline muted onSeeked={redraw} onLoadedData={redraw} />
                  <canvas ref={reg('cv')} className="keyed" />
                </div>
                <div className="layer deco" ref={reg('deco')} />
              </div>
            );
          })}
          {project.audioClips.map((c) => (
            <audio key={c.id} ref={(el) => { if (el) audioEls.current[c.id] = el; else delete audioEls.current[c.id]; }} preload="auto" />
          ))}
          {[...project.videoClips, ...(project.overlayClips || [])].filter((c) => enhPath(c)).map((c) => (
            <audio key={`enh-${c.id}`} ref={(el) => { if (el) enhEls.current[c.id] = el; else delete enhEls.current[c.id]; }} preload="auto" />
          ))}
          <canvas ref={textCanvas} className="text-layer" />
          {!cropEdit && !colorPick && (
            <TransformBox project={editProject || project} time={time} selection={selection} onSelect={onSelect} dispatch={dispatch}
              sw={project.width * scale} sh={project.height * scale} />
          )}
          {!cropEdit && !colorPick && (() => {
            const target = regionTarget(project, selection);
            return target ? <RegionOverlay region={target.region} write={target.write} dispatch={dispatch} /> : null;
          })()}
          {cropEdit && (() => {
            const srcClip = [...project.videoClips, ...(project.overlayClips || [])].find((c) => c.id === cropEdit.id);
            const srcMedia = srcClip && project.media.find((m) => m.id === srcClip.mediaId);
            if (!srcClip || !srcMedia) return null;
            const track = (project.overlayClips || []).some((c) => c.id === srcClip.id) ? 'overlay' : 'video';
            return <CropEditOverlay project={project} clip={srcClip} media={srcMedia} value={cropEdit.draftCrop} aspectId={cropEdit.draftAspect} onDraft={onCropDraft} time={time} />;
          })()}
          {colorPick && (
            <div className="color-pick" role="button" aria-label="Click the color to key out"
              onClick={async (e) => {
                const srcClip = [...project.videoClips, ...(project.overlayClips || [])].find((c) => c.id === colorPick.id);
                const srcMedia = srcClip && project.media.find((m) => m.id === srcClip.mediaId);
                if (!srcClip || !srcMedia) { onColorPicked(null); return; }
                const track = (project.overlayClips || []).some((c) => c.id === srcClip.id) ? 'overlay' : 'video';
                const r = e.currentTarget.getBoundingClientRect();
                const res = await pickColorAt({
                  project, clip: srcClip, media: srcMedia, track, time, overlayEls,
                  sx: (e.clientX - r.left) / r.width, sy: (e.clientY - r.top) / r.height,
                });
                if (res === 'miss') return; // clicked outside the picture: stay in the mode
                onColorPicked(res); // hex, or null when sampling failed (exits without changes)
              }} />
          )}
          {trackPick && (() => {
            const srcClip = [...project.videoClips, ...(project.overlayClips || [])].find((c) => c.id === trackPick.id);
            const srcMedia = srcClip && project.media.find((m) => m.id === srcClip.mediaId);
            const at = trackPick.point && srcMedia ? mediaToStage(project, srcMedia, trackPick.point) : null;
            const fit = srcMedia ? fitFactors(project, srcMedia) : { fx: 1, fy: 1 };
            const bw = trackPick.box ? trackPick.box.w * fit.fx * 100 : 9;
            const bh = trackPick.box ? trackPick.box.h * fit.fy * 100 : 9;
            return (
              <div className="track-pick" role="button" aria-label="Click the object to track"
                onClick={(e) => {
                  const r = e.currentTarget.getBoundingClientRect();
                  const sx = (e.clientX - r.left) / r.width;
                  const sy = (e.clientY - r.top) / r.height;
                  if (srcMedia) onTrackPoint(stageToMedia(project, srcMedia, sx, sy));
                }}>
                {at && (
                  <>
                    <span className="track-box" style={{
                      left: `${at.x * 100 - bw / 2}%`, top: `${at.y * 100 - bh / 2}%`,
                      width: `${bw}%`, height: `${bh}%`,
                    }} />
                    <span className="track-dot" style={{ left: `${at.x * 100}%`, top: `${at.y * 100}%` }} />
                  </>
                )}
                <span className="track-pick-hint">{trackPick.point ? 'Click again to move the point, then Track in the inspector' : 'Click the object you want to follow'}</span>
              </div>
            );
          })()}
          {!project.videoClips.length && (
            <div className="stage-empty">
              <img src="./logo.png" alt="" draggable={false} />
              <span>Drop a video or photo here, or on the timeline</span>
            </div>
          )}
        </div>
      </div>
      <div className="transport">
        <span className="tc"><b>{formatTime(time)}</b><span> / {formatTime(duration)}</span></span>
        <div className="transport-btns">
          <button className="icon-btn" aria-label="Go to start (Home)" title="Go to start (Home)" onClick={() => onSeek(0)}><SkipBack size={16} /></button>
          <button className="icon-btn" aria-label="Previous frame (←)" title="Previous frame (←)" onClick={() => onSeek(time - 1 / project.fps)}><ChevronLeft size={18} /></button>
          <button className="play-btn" onClick={onTogglePlay} aria-label={playing ? 'Pause (Space)' : 'Play (Space)'} title="Space">
            {playing ? <Pause size={18} fill="currentColor" /> : <Play size={18} fill="currentColor" />}
          </button>
          <button className="icon-btn" aria-label="Next frame (→)" title="Next frame (→)" onClick={() => onSeek(time + 1 / project.fps)}><ChevronRight size={18} /></button>
          <button className="icon-btn" aria-label="Go to end" title="Go to end" onClick={() => onSeek(duration)}><SkipForward size={16} /></button>
        </div>
        <span className="tc-spacer">
          {onQualityChange && (
            <span className="transport-menu-wrap">
              <button className={`proxy-btn quality-btn ${quality !== 'full' ? 'on' : ''}`} onClick={() => setMenu(menu === 'quality' ? null : 'quality')}
                aria-haspopup="menu" aria-expanded={menu === 'quality'}
                title="Playback quality: lower levels play a scaled copy so editing stays smooth. Export always uses the original videos.">
                <Gauge size={12} /> {QUALITY_LABELS[quality]} <ChevronUp size={11} />
              </button>
              {menu === 'quality' && (
                <div className="transport-menu" role="menu" aria-label="Playback quality">
                  {[
                    ['full', 'Full quality', 'Original video resolution'],
                    ['high', 'High quality', 'Smooth playback, no impact on exported video'],
                    ['medium', 'Medium quality', 'Smoother playback, no impact on exported video'],
                    ['low', 'Low quality', 'Smoothest playback, no impact on exported video'],
                  ].map(([id, name, desc]) => (
                    <button key={id} className={`transport-menu-item ${quality === id ? 'active' : ''}`} role="menuitemradio" aria-checked={quality === id}
                      onClick={() => { setMenu(null); onQualityChange(id); }}>
                      <span className="tm-check">{quality === id ? <Check size={14} /> : null}</span>
                      <span className="tm-text"><b>{name}</b><small>{desc}</small></span>
                      {preparing && quality === id && (
                        <span className="tm-busy" role="status" title="Building this level's copies in the background — playback continues with the current copy">
                          <LoaderCircle size={12} />
                        </span>
                      )}
                    </button>
                  ))}
                </div>
              )}
            </span>
          )}
          <span className="transport-menu-wrap">
            <button className={`proxy-btn zoom-btn ${view.fit ? '' : 'on'}`} onClick={() => setMenu(menu === 'zoom' ? null : 'zoom')}
              aria-haspopup="menu" aria-expanded={menu === 'zoom'}
              title="Zoom the preview (view only — clips and export are not affected). Mouse wheel over the video zooms too.">
              <ZoomIn size={12} /> {view.fit ? 'Fit' : `${Math.round(view.z * 100)}%`} <ChevronUp size={11} />
            </button>
            {menu === 'zoom' && (
              <div className="transport-menu zoom-menu" role="menu" aria-label="Preview zoom">
                {[
                  ['fit', 'Fit'],
                  [50, '50%'],
                  [100, '100%'],
                  [150, '150%'],
                  [200, '200%'],
                ].map(([choice, label]) => {
                  const active = choice === 'fit' ? view.fit : !view.fit && Math.round(view.z * 100) === choice;
                  return (
                    <button key={label} className={`transport-menu-item ${active ? 'active' : ''}`} role="menuitemradio" aria-checked={active}
                      onClick={() => { setMenu(null); setView((v) => applyZoomChoice(v, choice, ...stageDims())); }}>
                      <span className="tm-check">{active ? <Check size={14} /> : null}</span>
                      <span className="tm-text"><b>{label}</b></span>
                    </button>
                  );
                })}
              </div>
            )}
          </span>
          <button className="icon-btn" onClick={toggleFull} aria-label={full ? 'Exit full screen (Esc)' : 'Full screen (F)'} title={full ? 'Exit full screen (Esc)' : 'Full screen (F)'}>
            {full ? <Minimize size={16} /> : <Maximize size={16} />}
          </button>
        </span>
      </div>
    </section>
  );
}

// ---- Visual crop mode overlay (CROP-2, geometry rebuilt in CROP-3) ----------------------
// The clip renders UNCROPPED while this is up (the redraw paths above skip its crop), so
// the frame below sits over the whole source picture: the violet frame bounds what stays,
// everything outside it is dimmed, and a rule-of-thirds grid plus centre alignment guides
// inside help the composition. The overlay copies the layer's own transform, and inside it
// the FITTED picture box (the contain-fit rectangle every layer element uses).
//
// CROP-3: the edit is BUFFERED — `value` is App's draft crop and drags only call
// `onDraft`; the store (and with it autosave and the export) sees nothing until App
// commits the draft as one undo step on Done, and Cancel simply throws the draft away.
// Pointer mapping goes through src/pictureGeometry.js: the pointer is read in STAGE
// fractions (the overlay root fills the stage) and un-rotated / un-scaled / un-flipped
// into source fractions — the previous version read fractions off the source element's
// axis-aligned bounding rect, which is only correct at 0°/180° rotation, so any rotated
// clip's frame drifted away from the pointer. The transform used is the one the renderer
// is showing at the current time (animated/pinned state included), with App's draft
// rotation already folded into the project this overlay receives. Dragging inside the
// kept region moves the whole frame (centre move).
const CROP_HANDLES = ['tl', 't', 'tr', 'r', 'br', 'b', 'bl', 'l'];
const CROP_CURSORS = { tl: 'nwse-resize', br: 'nwse-resize', tr: 'nesw-resize', bl: 'nesw-resize', t: 'ns-resize', b: 'ns-resize', l: 'ew-resize', r: 'ew-resize' };

function CropEditOverlay({ project, clip, media, value, aspectId, onDraft, time = 0 }) {
  const rootRef = useRef(null);
  const [stage, setStage] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return undefined;
    const measure = () => { const r = el.getBoundingClientRect(); setStage({ w: r.width, h: r.height }); };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const crop = value || cropOf(clip);
  // The transform the renderer is using for this clip right now (its animated/pinned
  // state when it has one) — the geometry must describe the picture on screen, not the
  // clip's base values, or the frame and the drag mapping diverge for moving clips.
  const len = clipLen(clip);
  let startTl = clip.start || 0;
  {
    const item = videoLayout(project.videoClips).find((l) => l.clip.id === clip.id);
    if (item) startTl = item.start;
  }
  const lt = Math.min(len, Math.max(0, time - startTl));
  const tNow = (hasMotion(clip) || clip.pin)
    ? stateAtPinned(project, { track: (project.overlayClips || []).some((c) => c.id === clip.id) ? 'overlay' : 'video', clip }, lt, len).transform
    : transformOf(clip);
  // The clip renders UNCROPPED in this mode, so the geometry must describe the full
  // source's fitted box — pass a crop-less view of the clip (pictureGeometry is otherwise
  // crop-aware: it boxes the surviving region the renderer would show).
  const geom = pictureGeometry(project, media, { ...clip, crop: undefined }, tNow);
  const aspect = aspectRatioOf(aspectId, media.width, media.height);
  const midX = (crop.l + 1 - crop.r) / 2;
  const midY = (crop.t + 1 - crop.b) / 2;
  // A handle centred exactly on the picture's right/bottom edge lands on the stage's clip
  // boundary and stops receiving the pointer (found in QA: those handles were dead at a
  // zero crop). Keep every handle's centre a few px inside the picture; the drag math uses
  // the pointer's absolute position, so the grip point and the crop edge stay consistent.
  // The picture's on-screen size comes from the shared geometry (unrotated box size times
  // the stage size), not from the rotated element's bounding rect.
  const picW = geom.w * (stage.w || 0);
  const picH = geom.h * (stage.h || 0);
  const insetX = picW ? Math.min(0.08, 9 / picW) : 0.02;
  const insetY = picH ? Math.min(0.08, 9 / picH) : 0.02;
  const gx = (v) => Math.min(1 - insetX, Math.max(insetX, v));
  const gy = (v) => Math.min(1 - insetY, Math.max(insetY, v));
  const pos = {
    tl: [gx(crop.l), gy(crop.t)], t: [gx(midX), gy(crop.t)], tr: [gx(1 - crop.r), gy(crop.t)], r: [gx(1 - crop.r), gy(midY)],
    br: [gx(1 - crop.r), gy(1 - crop.b)], b: [gx(midX), gy(1 - crop.b)], bl: [gx(crop.l), gy(1 - crop.b)], l: [gx(crop.l), gy(midY)],
  };
  const toSource = (ev) => {
    const el = rootRef.current;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    return stageToSource(geom, (ev.clientX - r.left) / r.width, (ev.clientY - r.top) / r.height);
  };
  const startDrag = (e, handle) => {
    e.preventDefault();
    e.stopPropagation();
    const start = { ...crop };
    const startPt = toSource(e);
    let last = start;
    const move = (ev) => {
      const pt = toSource(ev);
      if (!pt) return;
      const next = handle === 'move'
        ? (startPt ? moveCrop(start, pt.x - startPt.x, pt.y - startPt.y) : last)
        : dragCrop(start, handle, pt, aspect, media.width, media.height);
      if (JSON.stringify(next) === JSON.stringify(last)) return;
      last = next;
      onDraft(next);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  return (
    <div className="crop-edit" aria-label="Crop frame" ref={rootRef}>
      <div className="crop-edit-xform" style={{ transform: layerStyle(clip, project.width, project.height, (hasMotion(clip) || clip.pin) ? { transform: tNow, opacity: 1 } : undefined).transform }}>
        <div className="crop-edit-src"
          style={{ left: `${((1 - geom.fx) / 2) * 100}%`, top: `${((1 - geom.fy) / 2) * 100}%`, width: `${geom.fx * 100}%`, height: `${geom.fy * 100}%`, transform: `scale(${geom.flipX ? -1 : 1}, ${geom.flipY ? -1 : 1})` }}>
          <div className="crop-dim" style={{ left: 0, right: 0, top: 0, height: `${crop.t * 100}%` }} />
          <div className="crop-dim" style={{ left: 0, right: 0, bottom: 0, height: `${crop.b * 100}%` }} />
          <div className="crop-dim" style={{ left: 0, width: `${crop.l * 100}%`, top: `${crop.t * 100}%`, height: `${(1 - crop.t - crop.b) * 100}%` }} />
          <div className="crop-dim" style={{ right: 0, width: `${crop.r * 100}%`, top: `${crop.t * 100}%`, height: `${(1 - crop.t - crop.b) * 100}%` }} />
          <div className="crop-keep"
            style={{ left: `${crop.l * 100}%`, top: `${crop.t * 100}%`, width: `${(1 - crop.l - crop.r) * 100}%`, height: `${(1 - crop.t - crop.b) * 100}%`, pointerEvents: 'auto', cursor: 'move' }}
            onPointerDown={(e) => startDrag(e, 'move')}>
            <i className="crop-grid-v" style={{ left: '33.333%' }} />
            <i className="crop-grid-v" style={{ left: '66.666%' }} />
            <i className="crop-grid-h" style={{ top: '33.333%' }} />
            <i className="crop-grid-h" style={{ top: '66.666%' }} />
            <i className="crop-grid-v crop-center" style={{ left: '50%' }} />
            <i className="crop-grid-h crop-center" style={{ top: '50%' }} />
          </div>
          {CROP_HANDLES.map((h) => (
            <span key={h} className="crop-handle" role="slider" aria-label={`Crop edge ${h}`} title="Drag to crop"
              style={{ left: `${pos[h][0] * 100}%`, top: `${pos[h][1] * 100}%`, cursor: CROP_CURSORS[h] }}
              onPointerDown={(e) => startDrag(e, h)} />
          ))}
        </div>
      </div>
    </div>
  );
}

// ---- Chroma color pick (K6) ------------------------------------------------------------
// Maps a stage click into the clip's SOURCE frame and reads that pixel's color. The
// geometry mirrors TransformBox.geo: the displayed picture is the contain-fitted box,
// centred at (0.5 + t.x, 0.5 + t.y), sized by the fit fractions and the transform scale,
// rotated by t.rot — so the click is un-rotated around the box centre, turned into a
// box fraction, un-flipped (the mirror/flipv effects flip the element inside the layer),
// then mapped through the crop (the kept region fills the fitted box) into source
// fractions. Sampling prefers the clip's own media element (its current frame is exactly
// what the user sees); if that readback is unavailable it falls back to the media:frame
// IPC grab of the same source instant. Returns a hex string, 'miss' when the click
// landed outside the picture, or null when sampling failed.
function sampleDrawable(drawable, w, h, fx, fy) {
  try {
    if (!w || !h) return null;
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    const cx = cv.getContext('2d', { willReadFrequently: true });
    if (!cx) return null;
    cx.drawImage(drawable, 0, 0, w, h);
    const d = cx.getImageData(Math.min(w - 1, Math.max(0, Math.floor(fx * w))), Math.min(h - 1, Math.max(0, Math.floor(fy * h))), 1, 1).data;
    return '#' + [d[0], d[1], d[2]].map((v) => v.toString(16).padStart(2, '0')).join('');
  } catch {
    return null;
  }
}

async function pickColorAt({ project, clip, media, track, time, sx, sy, overlayEls }) {
  const len = clipLen(clip);
  let start = clip.start || 0;
  if (track === 'video') {
    const item = videoLayout(project.videoClips).find((l) => l.clip.id === clip.id);
    if (item) start = item.start;
  }
  const lt = Math.min(len, Math.max(0, time - start));
  const t = (hasMotion(clip) || clip.pin)
    ? stateAtPinned(project, { track, clip }, lt, len).transform
    : transformOf(clip);
  // The mapping is the shared displayed-picture geometry (src/pictureGeometry.js) — the
  // same one the crop overlay and the transform box consume.
  const geom = pictureGeometry(project, media, clip, t);
  if (!geom.w || !geom.h) return null;
  const pt = stageToSource(geom, sx, sy);
  const bx = pt.x;
  const by = pt.y;
  if (bx < 0 || bx > 1 || by < 0 || by > 1) return 'miss';
  const crop = cropOf(clip);
  const srcX = crop.l + bx * (1 - crop.l - crop.r);
  const srcY = crop.t + by * (1 - crop.t - crop.b);
  // Route 1: the clip's own element, showing this exact frame.
  let el = null;
  if (track === 'overlay' && overlayEls && overlayEls.current) {
    const o = overlayEls.current[clip.id];
    if (o) el = media.type === 'image' ? o.img : o.v;
  }
  if (!el) {
    const url = toFileUrl(media.path);
    el = [...document.querySelectorAll('.stage video, .stage img')].find((n) => (n.currentSrc || n.src) === url) || null;
  }
  if (el) {
    const ready = media.type === 'image' ? (el.complete && !!el.naturalWidth) : el.readyState >= 2;
    if (ready) {
      const hex = sampleDrawable(el, media.type === 'image' ? el.naturalWidth : el.videoWidth, media.type === 'image' ? el.naturalHeight : el.videoHeight, srcX, srcY);
      if (hex) return hex;
    }
  }
  // Route 2: a full-res frame grab of the same source instant via IPC.
  try {
    const at = media.type === 'video' ? (clip.in || 0) + lt * (clip.speed || 1) : 0;
    const res = await window.api.frameGrab(media.path, at);
    if (res && res.ok) {
      const img = new Image();
      await new Promise((done, fail) => { img.onload = done; img.onerror = fail; img.src = toFileUrl(res.path); });
      return sampleDrawable(img, img.naturalWidth, img.naturalHeight, srcX, srcY);
    }
  } catch { /* fall through */ }
  return null;
}
