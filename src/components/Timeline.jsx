import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  ArrowLeftRight, ArrowLeftToLine, ArrowRightToLine, AudioLines, Copy, CopyPlus, Eye, EyeOff, Film, Flag, GripVertical, Layers, Link2, Lock, LockOpen, Magnet, Mic, MoreHorizontal, MousePointer2, Music, Pencil, Plus, Scissors, Slice,
  Sparkles, Square, StretchHorizontal, Target, Trash2, Type, Undo2, Unlink, Volume2, VolumeX, Redo2, X, ZoomIn, ZoomOut, Captions,
} from 'lucide-react';
import { LAYERED, MIN_CLIP, clipLayer, effectObjects, formatTime, freeLen, isLayerLocked, layerCount, layerFree, layerName, layerOf, layerStateOf, toFileUrl, trimActions, uid, videoClipAt, videoLayout } from '../store.js';
import { animById, animOf, keyTimes, moveKeys } from '../anim.js';
import { filterName } from '../fx/filters.js';
import { EFFECTS, TRANSITIONS } from '../effects.js';
import { FILTERS, clipCss } from '../effects.js';
import { activeDrag, isFiles, isInternal, laneFor, readPayload } from '../dnd.js';
import { followScrollTarget, interpolateTime, playheadX } from '../playbackClock.js';
import AudioMeter from './AudioMeter.jsx';
import ContextMenu from './ContextMenu.jsx';

const HEADER = 192; // lane-head width: title + layer rows share one control grid (lock/eye/speaker/solo/more) and names get 60px
const HEAD_TITLE_H = 22; // height of a lane head's title strip; layer control rows stack below it
const ROW = 34; // height of one stacked row on the Effects / Text tracks
const ROW_H = { overlay: 44, audio: 40 }; // taller layers for pictures and waveforms
const rowOf = (lane) => ROW_H[lane] || ROW;
// Overlay and text layers are shown above the main track, so their layer 0 is the bottom row; audio
// layers are below it, layer 0 on top.
const ABOVE = { overlay: true, text: true };
const rowToLayer = (lane, row, count) => (ABOVE[lane] ? count - 1 - row : row);

// Overlapping clips on a free track get their own row (first row that is free at the clip's start).
function stackRows(clips) {
  const ends = [];
  const rows = {};
  [...clips].sort((a, b) => a.start - b.start).forEach((c) => {
    let r = ends.findIndex((e) => e <= c.start + 1e-6);
    if (r < 0) {
      r = ends.length;
      ends.push(0);
    }
    ends[r] = c.start + c.duration;
    rows[c.id] = r;
  });
  return { rows, count: Math.max(1, ends.length) };
}
const LANES = [
  { id: 'effect', name: 'Effects', icon: Sparkles, noMagnet: true },
  { id: 'text', name: 'Text', icon: Type },
  { id: 'overlay', name: 'Overlay', icon: Layers },
  { id: 'video', name: 'Main', icon: Film, main: true },
  { id: 'audio', name: 'Audio', icon: Music },
];

export default function Timeline({
  project, time, duration, selection, onSelect, onSeek, dispatch, onSplit, onDelete, onDuplicate,
  onDropItem, onDropFiles, canUndo, canRedo, tool, setTool, onTrimSide, onMarker, recorder, onToggleRecord, onClipMenu, overlay, onAddText, clockRef, playing,
  onDetach, detachOk, onLinkToggle, linkMode,
}) {
  const [pps, setPps] = useState(60); // pixels per second (zoom)
  const [drop, setDrop] = useState(null); // { lane, time, index, clipId }
  const [snapAt, setSnapAt] = useState(null); // timeline time of the active snap guide
  const [trimHud, setTrimHud] = useState(null); // { x, text } readout chip while an edge is dragged
  const playheadRef = useRef(null);
  const projectRef = useRef(project);
  projectRef.current = project;
  const timeRef = useRef(time);
  timeRef.current = time;
  const ppsRef = useRef(pps);
  ppsRef.current = pps;
  const [razorAt, setRazorAt] = useState(null); // where the razor would cut (hover guide)
  const [layerMenu, setLayerMenu] = useState(null); // { x, y, track, layer } — layer (track) header menu, item 13
  const [renaming, setRenaming] = useState(null); // { track, layer, draft } — inline layer rename
  // Right-click on a lane header: the layer under the pointer (header rows share the lane's
  // geometry), or the main track itself for the Main lane.
  const openLayerMenu = (e, lane) => {
    e.preventDefault();
    let layer = 0;
    if (LAYERED[lane]) {
      const count = layerCount(project, lane);
      const rect = e.currentTarget.getBoundingClientRect();
      const row = Math.floor((e.clientY - rect.top - HEAD_TITLE_H) / rowOf(lane));
      layer = rowToLayer(lane, Math.max(0, Math.min(count - 1, row)), count);
    }
    setLayerMenu({ x: e.clientX, y: e.clientY, track: lane, layer });
  };
  // Layer state toggles dispatch setLayerState: applied by the history reducer WITHOUT an
  // undo step (a lock is not a document edit), and undo never reverts them.
  const setLayer = (track, layer, patch) => dispatch({ type: 'setLayerState', track, layer, patch });
  const layerMenuItems = (m) => {
    const st = layerStateOf(project, m.track, m.layer);
    const name = layerName(project, m.track, m.layer);
    const audioCap = m.track === 'audio' || m.track === 'video' || m.track === 'overlay';
    const items = [
      { label: st.locked ? `Unlock layer — ${name}` : `Lock layer — ${name}`, icon: st.locked ? LockOpen : Lock,
        onClick: () => setLayer(m.track, m.layer, { locked: !st.locked }) },
      { label: st.hidden ? `Show layer — ${name}` : `Hide layer — ${name}`, icon: st.hidden ? Eye : EyeOff,
        onClick: () => setLayer(m.track, m.layer, { hidden: !st.hidden }) },
    ];
    if (audioCap) {
      items.push(
        { label: st.muted ? `Unmute layer — ${name}` : `Mute layer — ${name}`, icon: st.muted ? Volume2 : VolumeX,
          onClick: () => setLayer(m.track, m.layer, { muted: !st.muted }) },
        { label: st.solo ? `Solo off — ${name}` : `Solo layer — ${name}`, icon: AudioLines,
          onClick: () => setLayer(m.track, m.layer, { solo: !st.solo }) },
      );
    }
    if (m.track === 'effect') return items; // the Effects lane is one row: state toggles only
    const srcCount = m.track === 'video'
      ? project.videoClips.filter((c) => !c.gap).length
      : project[LAYERED[m.track]].filter((c) => layerOf(c) === m.layer).length;
    items.push('sep',
      { label: `Duplicate layer — ${name}`, icon: CopyPlus,
        onClick: () => dispatch({ type: 'duplicateLayer', track: m.track, layer: m.layer, newIds: Array.from({ length: srcCount }, () => uid()) }) },
      { label: 'Rename layer…', icon: Pencil,
        onClick: () => setRenaming({ track: m.track, layer: m.layer, draft: layerName(project, m.track, m.layer) }) },
      'sep',
      { label: 'Delete layer', icon: Trash2, disabled: st.locked, hint: 'Unlock the layer first',
        onClick: () => dispatch({ type: 'deleteLayer', track: m.track, layer: m.layer }) });
    return items;
  };
  // ---- Reorder layers by dragging a header row (Stage C) ----
  const [layerDrag, setLayerDrag] = useState(null); // { track, overRow } while a header row is dragged
  const startLayerDrag = (e, lane, layer) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const count = layerCount(project, lane);
    const fromRow = ABOVE[lane] ? count - 1 - layer : layer;
    const stackEl = e.currentTarget.closest('.tl-layer-stack');
    let overRow = fromRow;
    setLayerDrag({ track: lane, overRow });
    const move = (ev) => {
      if (!stackEl) return;
      const r = stackEl.getBoundingClientRect();
      overRow = Math.max(0, Math.min(count - 1, Math.floor((ev.clientY - r.top) / rowOf(lane))));
      setLayerDrag({ track: lane, overRow });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setLayerDrag(null);
      if (overRow !== fromRow) dispatch({ type: 'moveLayer', track: lane, from: layer, to: rowToLayer(lane, overRow, count) });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  // One header control row per layer (below the lane's title strip): lock, visibility,
  // mute + solo on sound-carrying lanes, and the layer menu — the reference's pattern in
  // our icon language. Rows line up with the layer bands in the lane body.
  const layerCtlRow = (lane, layer, displayRow) => {
    const st = layerStateOf(project, lane, layer);
    const audioCap = lane === 'audio' || lane === 'video' || lane === 'overlay';
    const name = layerName(project, lane, layer);
    const dragHere = layerDrag && layerDrag.track === lane && layerDrag.overRow === displayRow;
    return (
      <div key={layer} className={`tl-layer-row ${st.locked ? 'locked' : ''} ${st.hidden ? 'is-hidden' : ''} ${dragHere ? 'drop-hint' : ''}`}
        style={{ height: rowOf(lane) }}>
        {LAYERED[lane] && layerCount(project, lane) > 1 ? (
          <span className="tl-grip" role="button" aria-label={`Reorder layer ${name}`} title="Drag to reorder this layer"
            onPointerDown={(e) => startLayerDrag(e, lane, layer)}><GripVertical size={11} /></span>
        ) : (
          <span className="tl-grip-slot" aria-hidden="true" />
        )}
        <span className="tl-layer-name" title={name}>{name}</span>
        <button className={`tl-ctl ${st.locked ? 'on lock' : ''}`} aria-pressed={st.locked}
          aria-label={`${st.locked ? 'Unlock' : 'Lock'} layer ${name}`} title={st.locked ? 'Unlock layer' : 'Lock layer: clips cannot be selected or edited'}
          onClick={() => setLayer(lane, layer, { locked: !st.locked })}>{st.locked ? <Lock size={12} /> : <LockOpen size={12} />}</button>
        <button className={`tl-ctl ${st.hidden ? 'on hide' : ''}`} aria-pressed={st.hidden}
          aria-label={`${st.hidden ? 'Show' : 'Hide'} layer ${name}`} title={st.hidden ? 'Show layer' : 'Hide layer: left out of the preview and the export'}
          onClick={() => setLayer(lane, layer, { hidden: !st.hidden })}>{st.hidden ? <EyeOff size={12} /> : <Eye size={12} />}</button>
        {audioCap ? (
          <button className={`tl-ctl ${st.muted ? 'on mute' : ''}`} aria-pressed={st.muted}
            aria-label={`${st.muted ? 'Unmute' : 'Mute'} layer ${name}`} title={st.muted ? 'Unmute layer' : 'Mute layer'}
            onClick={() => setLayer(lane, layer, { muted: !st.muted })}>{st.muted ? <VolumeX size={12} /> : <Volume2 size={12} />}</button>
        ) : (
          <span className="tl-ctl-slot" aria-hidden="true" />
        )}
        {audioCap ? (
          <button className={`tl-ctl solo ${st.solo ? 'on' : ''}`} aria-pressed={st.solo}
            aria-label={`Solo layer ${name}`} title={st.solo ? 'Solo off: every layer sounds again' : 'Solo: only soloed layers sound'}
            onClick={() => setLayer(lane, layer, { solo: !st.solo })}>S</button>
        ) : (
          <span className="tl-ctl-slot" aria-hidden="true" />
        )}
        <button className="tl-ctl" aria-label={`Layer menu for ${name}`} title="Layer menu"
          onClick={(e) => setLayerMenu({ x: e.clientX, y: e.clientY, track: lane, layer })}><MoreHorizontal size={12} /></button>
      </div>
    );
  };
  // The layers of a lane in display order (top row first), as control rows for the head.
  const layerCtlRows = (lane) => {
    if (!LAYERED[lane]) return [layerCtlRow(lane, 0, 0)];
    const count = layerCount(project, lane);
    return Array.from({ length: count }, (_, row) => layerCtlRow(lane, rowToLayer(lane, row, count), row));
  };
  // The inline rename field (a plain render helper, not a component, so the input keeps focus
  // across keystrokes). Enter/blur commits, Esc cancels; an empty name restores the default.
  const layerRenameInput = (track, layer) => (
    <input className="layer-rename" autoFocus value={renaming.draft} aria-label="Layer name"
      onPointerDown={(e) => e.stopPropagation()}
      onChange={(e) => setRenaming({ ...renaming, draft: e.target.value })}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') { dispatch({ type: 'renameLayer', track, layer, name: renaming.draft }); setRenaming(null); }
        if (e.key === 'Escape') setRenaming(null);
      }}
      onBlur={() => { dispatch({ type: 'renameLayer', track, layer, name: renaming.draft }); setRenaming(null); }} />
  );
  const markers = project.markers || [];
  const magnet = project.magnet || {};
  const scrollRef = useRef(null);
  const mediaById = Object.fromEntries(project.media.map((m) => [m.id, m]));
  const layout = videoLayout(project.videoClips);
  // Room after the last clip is a fixed width in pixels, so zooming out to fit does not leave a huge empty tail.
  const width = Math.max(duration * pps + 600, 900);
  const overlays = project.overlayClips || [];
  const empty = !project.videoClips.length && !overlays.length && !project.audioClips.length && !project.textClips.length;

  const timeFromEvent = (e) => {
    const rect = scrollRef.current.getBoundingClientRect();
    return Math.max(0, (e.clientX - rect.left - HEADER + scrollRef.current.scrollLeft) / pps);
  };

  // Layer at a height on a layered lane; one past the last (a new layer) just outside its rows.
  const layerAtY = (lane, laneEl, y) => {
    const count = layerCount(project, lane);
    const row = Math.floor((y - laneEl.getBoundingClientRect().top - 4 - HEAD_TITLE_H) / rowOf(lane));
    if (ABOVE[lane] ? row < 0 : row >= count) return count;
    return rowToLayer(lane, Math.max(0, Math.min(count - 1, row)), count);
  };

  // ---- Drop from the asset panels / Explorer ----
  const dropInfo = (e) => {
    const t = timeFromEvent(e);
    const laneEl = e.target.closest?.('[data-lane]');
    const overLane = laneEl?.dataset.lane;
    const lane = isFiles(e) && !isInternal(e) ? 'files' : laneFor(activeDrag());
    if (!lane) return null;
    // The layer under the pointer, for what lands on that lane's own kind of clips.
    const at = LAYERED[overLane] ? { layerLane: overLane, layer: layerAtY(overLane, laneEl, e.clientY) } : {};
    // Videos and photos dropped on the Overlay lane become picture-in-picture clips.
    if ((lane === 'video' || lane === 'files') && overLane === 'overlay') return { lane: 'overlay', time: t, ...at };
    const info = { lane, time: t, ...at };
    if (lane === 'video' || lane === 'files') {
      info.index = layout.filter((l) => (l.start + l.end) / 2 < t).length;
      info.at = info.index < layout.length ? layout[info.index].start : layout.length ? layout[layout.length - 1].end : 0;
    }
    if (lane === 'clip') {
      // An effect dropped on the Effects lane becomes a free effect there.
      if (activeDrag()?.kind === 'effect' && overLane === 'effect') return { lane: 'effect', time: t };
      if (overLane !== 'video') return { lane, time: t };
      const hit = layout.filter((l) => t >= l.start && t < l.end).pop();
      if (hit) info.clipId = hit.clip.id;
    }
    return info;
  };

  const onDragOver = (e) => {
    if (!isInternal(e) && !isFiles(e)) return;
    e.preventDefault();
    e.stopPropagation();
    const info = dropInfo(e);
    e.dataTransfer.dropEffect = info && (info.lane !== 'clip' || info.clipId) ? 'copy' : 'none';
    setDrop(info);
  };

  const onDrop = (e) => {
    const info = dropInfo(e);
    setDrop(null);
    if (!info) return;
    e.preventDefault();
    e.stopPropagation();
    if (info.lane === 'files') onDropFiles([...e.dataTransfer.files], info);
    else onDropItem(readPayload(e), info);
  };

  // ---- Pointer editing ----
  // Generic pointer drag: calls onMove(deltaSeconds, event) until release, wrapped in one undo step.
  const drag = (e, onMove, onEnd) => {
    e.stopPropagation();
    e.preventDefault();
    const x0 = e.clientX;
    dispatch({ type: 'beginGesture' });
    const move = (ev) => onMove((ev.clientX - x0) / pps, ev);
    const up = (ev) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      onEnd?.(ev); // inside the gesture, so a move to another track is part of the same undo step
      dispatch({ type: 'endGesture' });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  // Drag a keyframe diamond along its clip (all the properties keyed at that moment move together).
  // Lands on whole frames and snaps to the playhead; a click without moving puts the playhead on it.
  const startKeyDrag = (e, track, clip, t, length, start) => {
    if (e.button !== 0) return;
    if (trackLocked(track, clip)) return;
    const fps = project.fps || 30;
    let moved = false;
    drag(e, (d) => {
      if (!moved && Math.abs(d * pps) < 3) return;
      moved = true;
      let to = clamp(Math.round((t + d) * fps) / fps, 0, length);
      if (project.snapping && Math.abs((start + to - time) * pps) < 6) to = clamp(time - start, 0, length);
      setSnapAt(Math.abs(start + to - time) < 1e-6 ? time : null);
      dispatch({ type: 'update', track, id: clip.id, patch: moveKeys(clip, t, to, fps) });
    }, () => {
      setSnapAt(null);
      if (!moved) onSeek(start + t);
    });
  };

  // Snapping: pull a dragged clip's start or end (or a razor cut) to a nearby edge: other clips, markers, the playhead, zero.
  const edgeTimes = (excludeId) => {
    const edges = [0, time, ...markers.map((m) => m.time)];
    layout.forEach((l) => edges.push(l.start, l.end));
    project.audioClips.forEach((c) => c.id !== excludeId && edges.push(c.start, c.start + freeLen('audio', c)));
    project.textClips.forEach((c) => c.id !== excludeId && edges.push(c.start, c.start + c.duration));
      (project.effectClips || []).forEach((c) => c.id !== excludeId && edges.push(c.start, c.start + c.duration));
    overlays.forEach((c) => c.id !== excludeId && edges.push(c.start, c.start + freeLen('overlay', c)));
    return edges;
  };
  const snapMove = (start, len, excludeId) => {
    const thr = 10 / pps;
    let best = null;
    for (const e of edgeTimes(excludeId)) {
      for (const pos of [start, start + len]) {
        const dd = e - pos;
        if (Math.abs(dd) < thr && (!best || Math.abs(dd) < Math.abs(best.dd))) best = { dd, at: e };
      }
    }
    return best ? { start: Math.max(0, start + best.dd), at: best.at } : { start, at: null };
  };
  const snapPoint = (t) => {
    const thr = 10 / pps;
    let best = t;
    for (const e of edgeTimes(null)) if (Math.abs(e - t) < thr && Math.abs(e - t) < Math.abs(best - t) + (best === t ? thr : 0)) best = e;
    return best;
  };

  // Where a clip starts and how long it is, per track — the same expressions the lanes render with.
  const TRACK_ARRAY = { text: 'textClips', effect: 'effectClips', audio: 'audioClips', overlay: 'overlayClips' };
  const clipSpan = (p, track, id) => {
    if (track === 'video') {
      const l = videoLayout(p.videoClips).find((x) => x.clip.id === id);
      return l ? { start: l.start, len: l.end - l.start } : null;
    }
    const c = (p[TRACK_ARRAY[track]] || []).find((x) => x.id === id);
    if (!c) return null;
    if (track === 'audio') return { start: c.start, len: freeLen('audio', c) };
    if (track === 'overlay') return { start: c.start, len: freeLen('overlay', c) };
    return { start: c.start, len: c.duration };
  };

  // Trim wrapper: while an edge is dragged, the preview/playhead follows the edge being
  // trimmed and a readout chip shows the edge time + the clip's resulting length; the snap
  // guide lights when the edge lands on a snap target (playhead, neighbour, marker, zero).
  // The drag itself — values, clamping, undo — is exactly the existing handler.
  const trimAware = (track, clip, mode, onMove) => (d, ev) => {
    onMove(d, ev);
    const span = clipSpan(projectRef.current, track, clip.id);
    if (!span) return;
    const edgeTime = mode === 'left' ? span.start : span.start + span.len;
    onSeek(edgeTime);
    setTrimHud({ x: playheadX(edgeTime, pps, HEADER), text: `${formatTime(edgeTime)} · ${span.len.toFixed(2)}s` });
    if (projectRef.current.snapping) {
      const targets = edgeTimes(clip.id).filter((e) => Math.abs(e - span.start) > 1e-9 && Math.abs(e - (span.start + span.len)) > 1e-9);
      const hit = targets.find((e) => Math.abs(e - edgeTime) * pps < 2);
      setSnapAt(hit ?? null);
    }
  };
  const endTrim = (onEnd) => (ev) => { setTrimHud(null); setSnapAt(null); onEnd?.(ev); };

  // Locked layers refuse every pointer edit (the reducer guard is the backstop; the UI
  // never starts a gesture it knows will be refused).
  const trackLocked = (track, clip) => isLayerLocked(project, track, clipLayer(track, clip));

  // Razor tool: a click on a clip cuts it at the pointer.
  const razorSplit = (e, track, clip) => {
    e.stopPropagation();
    e.preventDefault();
    if (trackLocked(track, clip)) return;
    const raw = timeFromEvent(e);
    dispatch({ type: 'split', track, id: clip.id, t: project.snapping ? snapPoint(raw) : raw, newId: uid() });
    onSelect(null);
  };

  const scrub = (e) => {
    onSelect(null);
    onSeek(timeFromEvent(e));
    const move = (ev) => onSeek(timeFromEvent(ev));
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  // Box selection: drag on an empty part of the tracks to select every clip the box touches (Ctrl / Shift keeps
  // the clips already selected). A plain click still moves the playhead and clears the selection.
  const [box, setBox] = useState(null); // { x, y, w, h } in timeline content pixels
  const contentRef = useRef(null);
  const startBox = (e) => {
    if (e.button !== 0 || tool === 'razor') return scrub(e);
    e.preventDefault();
    const keep = e.ctrlKey || e.shiftKey || e.metaKey;
    const base = keep && selection ? (selection.items || [{ track: selection.track, id: selection.id }]) : [];
    const x0 = e.clientX;
    const y0 = e.clientY;
    let moved = false;
    const rectOf = (ev) => ({ left: Math.min(x0, ev.clientX), right: Math.max(x0, ev.clientX), top: Math.min(y0, ev.clientY), bottom: Math.max(y0, ev.clientY) });
    const move = (ev) => {
      if (!moved && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 4) return;
      moved = true;
      const r = rectOf(ev);
      const c = contentRef.current.getBoundingClientRect();
      setBox({ x: r.left - c.left, y: r.top - c.top, w: r.right - r.left, h: r.bottom - r.top });
      const hit = [...contentRef.current.querySelectorAll('[data-sel-id]')].filter((el) => {
        const b = el.getBoundingClientRect();
        return b.right > r.left && b.left < r.right && b.bottom > r.top && b.top < r.bottom;
      }).map((el) => ({ track: el.dataset.selTrack, id: el.dataset.selId }));
      const items = [...base];
      hit.forEach((h) => { if (!items.some((x) => x.track === h.track && x.id === h.id)) items.push(h); });
      onSelect(makeSelection(items));
    };
    const up = (ev) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setBox(null);
      if (!moved) {
        if (!keep) onSelect(null);
        onSeek(timeFromEvent(ev));
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const laneAt = (ev) => document.elementFromPoint(ev.clientX, ev.clientY)?.closest?.('[data-lane]')?.dataset.lane;

  const startVideoDrag = (e, clip, mode) => {
    if (tool === 'razor') return razorSplit(e, 'video', clip);
    if (isLayerLocked(project, 'video', 0)) return;
    onSelect({ track: 'video', id: clip.id });
    if (clip.gap) {
      // Gaps only resize (and cannot be moved).
      if (mode === 'move') return;
      drag(e, trimAware('video', clip, mode, (d) => dispatch({ type: 'trimClip', track: 'video', id: clip.id, edge: mode, delta: mode === 'left' ? d : -d })), endTrim());
      return;
    }
    const media = mediaById[clip.mediaId];
    const isImage = media.type === 'image';
    const o = { ...clip };
    const sp = clip.speed || 1;
    const grab = timeFromEvent(e) - (layout.find((l) => l.clip.id === clip.id)?.start ?? 0);
    let toOverlay = null; // time where the clip lands when dropped on the Overlay lane
    const videoMove = (d, ev) => {
      if (mode === 'move' && laneAt(ev) === 'overlay') {
        // Dragged up onto the Overlay lane: show where it will land.
        toOverlay = Math.max(0, timeFromEvent(ev) - grab);
        setDrop({ lane: 'overlay', time: toOverlay });
        return;
      }
      if (toOverlay !== null) { toOverlay = null; setDrop(null); }
      if (mode === 'left' || (!magnet.video && mode !== 'move')) {
        // Left edge (either magnet state) and every magnet-off trim go through trimClip:
        // it anchors the edge that is NOT dragged — a left trim keeps the clip's right edge
        // fixed, moves the start and advances the source in-offset by the same delta (the
        // frame under any fixed timeline point does not change), and the removed head
        // becomes a gap before the clip. (This branch used to patch `in` alone for the
        // magnet-on left edge: the start stayed put, the right edge rushed in and the
        // content slipped — the clip collapsed instead of trimming.)
        dispatch({ type: 'trimClip', track: 'video', id: clip.id, edge: mode, delta: mode === 'left' ? d : -d });
      } else if (mode === 'right') {
        dispatch({ type: 'update', track: 'video', id: clip.id, patch: { out: clamp(o.out + d * sp, o.in + MIN_CLIP * sp, isImage ? 3600 : media.duration) } });
      } else {
        // Reorder on the magnetic main track: drop index from the pointer position among the other clips.
        const others = videoLayout(project.videoClips.filter((c) => c.id !== clip.id));
        const pos = timeFromEvent(ev);
        const toIndex = others.filter((l) => (l.start + l.end) / 2 < pos).length;
        dispatch({ type: 'moveVideo', id: clip.id, toIndex });
      }
    };
    const videoEnd = () => {
      if (toOverlay === null) return;
      setDrop(null);
      dispatch({ type: 'moveToOverlay', id: clip.id, at: toOverlay });
      onSelect({ track: 'overlay', id: clip.id });
    };
    if (mode === 'move') drag(e, videoMove, videoEnd);
    else drag(e, trimAware('video', clip, mode, videoMove), endTrim(videoEnd));
  };

  const startFreeDrag = (e, track, clip, mode) => {
    if (tool === 'razor') return razorSplit(e, track, clip);
    if (trackLocked(track, clip)) return;
    // Moving one clip of a multiple selection moves every selected clip off the main track by the same time.
    // Members on locked layers stay behind (their updates would be refused anyway).
    const group = mode === 'move' && selection?.items && isSelected(selection, track, clip.id)
      ? selection.items.map((it) => ({ ...it, clip: findFree(it) })).filter((it) => it.clip && !trackLocked(it.track, it.clip)) : null;
    if (group && group.length > 1) {
      const minStart = Math.min(...group.map((g) => g.clip.start));
      drag(e, (d) => {
        const dd = Math.max(-minStart, d);
        group.forEach((g) => dispatch({ type: 'update', track: g.track, id: g.id, patch: { start: g.clip.start + dd } }));
      });
      return;
    }
    onSelect({ track, id: clip.id });
    const o = { ...clip };
    let toMain = null; // overlay clip dragged down onto the main track: insert index
    const freeMove = (d, ev) => {
      if (track === 'overlay' && mode === 'move' && laneAt(ev) === 'video') {
        const t = timeFromEvent(ev);
        toMain = layout.filter((l) => (l.start + l.end) / 2 < t).length;
        setDrop({ lane: 'video', time: t, at: toMain < layout.length ? layout[toMain].start : layout.length ? layout[layout.length - 1].end : 0 });
        return;
      }
      if (toMain !== null) { toMain = null; setDrop(null); }
      if (mode === 'move') {
        let start = Math.max(0, o.start + d);
        if (project.snapping) {
          const r = snapMove(start, freeLen(track, o), clip.id);
          setSnapAt(r.at);
          start = r.start;
        }
        const patch = { start };
        // Up or down to another layer of the same lane (or a new one past the last), when the clip fits there.
        const laneEl = LAYERED[track] && scrollRef.current?.querySelector(`[data-lane="${track}"]`);
        if (laneEl) {
          const want = layerAtY(track, laneEl, ev.clientY);
          if (want !== layerOf(o) && layerFree(project, track, want, start, freeLen(track, o), clip.id)) {
            patch.layer = want;
            o.layer = want;
          }
        }
        dispatch({ type: 'update', track, id: clip.id, patch });
        return;
      }
      if (magnet[track]) {
        // Magnet on: trimming closes up the space (later clips shift with the edit).
        dispatch({ type: 'trimClip', track, id: clip.id, edge: mode, delta: mode === 'left' ? d : -d });
        return;
      }
      if (project.snapping && (track === 'text' || track === 'effect')) {
        // Duration-based clips: pull the dragged edge onto a snap target, like moves do.
        const edge0 = mode === 'left' ? o.start + d : o.start + o.duration + d;
        const snapped = snapPoint(edge0);
        if (snapped !== edge0) { d += snapped - edge0; setSnapAt(snapped); }
      }
      let patch;
      if (track === 'text' || track === 'effect') {
        if (mode === 'left') {
          const start = clamp(o.start + d, 0, o.start + o.duration - MIN_CLIP);
          patch = { start, duration: o.start + o.duration - start };
        } else patch = { duration: Math.max(MIN_CLIP, o.duration + d) };
      } else {
        // Audio and overlay clips: timeline seconds times speed give source seconds; photos have no end.
        const sp = o.speed || 1;
        const m = mediaById[o.mediaId];
        const len = m?.type === 'image' ? Infinity : m?.duration ?? o.out;
        if (mode === 'left') {
          const dd = clamp(d, -Math.min(o.in / sp, o.start), (o.out - o.in) / sp - MIN_CLIP);
          patch = { in: o.in + dd * sp, start: o.start + dd };
        } else patch = { out: clamp(o.out + d * sp, o.in + MIN_CLIP * sp, len) };
      }
      dispatch({ type: 'update', track, id: clip.id, patch });
    };
    const freeEnd = () => {
      setSnapAt(null);
      if (toMain === null) return;
      setDrop(null);
      dispatch({ type: 'moveToMain', id: clip.id, index: toMain });
      onSelect({ track: 'video', id: clip.id });
    };
    if (mode === 'move') drag(e, freeMove, freeEnd);
    else drag(e, trimAware(track, clip, mode, freeMove), endTrim(freeEnd));
  };

  // Zoom keeping one moment of the timeline under the same spot on screen (the mouse for Ctrl + wheel, the
  // playhead for the zoom buttons and slider). The scroll is fixed after the new width is laid out.
  const zoomAnchor = useRef(null);
  const zoomTo = (next, at, x) => {
    const el = scrollRef.current;
    const n = clamp(next, 2, 300);
    if (el) {
      const t = at ?? time;
      zoomAnchor.current = { t, x: x ?? t * pps - el.scrollLeft };
    }
    setPps(n);
  };
  useLayoutEffect(() => {
    const a = zoomAnchor.current;
    const el = scrollRef.current;
    if (!a || !el) return;
    zoomAnchor.current = null;
    el.scrollLeft = Math.max(0, a.t * pps - a.x);
  }, [pps]);

  // The playhead is painted from the shared playback clock on rAF, straight to the DOM:
  // it glides at display rate (interpolated from the media anchor) even when React renders
  // drop frames, and its x comes from the same playheadX mapping as the ruler and clips.
  // While playing it also keeps itself in view (followScrollTarget never fights a manual
  // scroll that keeps the playhead visible).
  useEffect(() => {
    let raf = 0;
    const loop = () => {
      raf = requestAnimationFrame(loop);
      const el = playheadRef.current;
      const sc = scrollRef.current;
      if (!el) return;
      const c = clockRef?.current;
      const t = c?.playing ? interpolateTime(c.time, c.stamp, performance.now(), c.rate || 1) : timeRef.current;
      const x = playheadX(t, ppsRef.current, HEADER);
      el.style.transform = `translateX(${x}px)`;
      if (c?.playing && sc) {
        const target = followScrollTarget(x, sc.scrollLeft, sc.clientWidth, HEADER);
        if (target !== null && Math.abs(target - sc.scrollLeft) > 2) sc.scrollTo({ left: target, behavior: 'smooth' });
      }
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Mouse wheel: Ctrl + wheel (or a touchpad pinch) zooms around the mouse, Shift + wheel scrolls
  // left / right. A plain wheel keeps scrolling the tracks up and down.
  const wheelState = useRef({});
  wheelState.current = { pps, zoomTo };
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return undefined;
    const onWheel = (e) => {
      const unit = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? el.clientWidth : 1;
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault(); // also stops the window from zooming
        const { pps: cur, zoomTo: zoom } = wheelState.current;
        const r = el.getBoundingClientRect();
        const x = Math.max(0, e.clientX - r.left - HEADER);
        const t = (x + el.scrollLeft) / cur;
        zoom(cur * Math.exp(-e.deltaY * unit * 0.002), t, x);
      } else if (e.shiftKey) {
        e.preventDefault();
        el.scrollLeft += (Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY) * unit;
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  // Zoom so the whole project fits the visible timeline.
  const fit = () => {
    const w = (scrollRef.current?.clientWidth || 900) - HEADER - 32;
    setPps(clamp(w / Math.max(duration, 1), 2, 300));
    scrollRef.current?.scrollTo({ left: 0 });
  };

  const markerEls = markers.map((m) => (
    <button key={m.id} className="marker" style={{ left: m.time * pps }} aria-label={`Marker at ${formatTime(m.time)}`}
      title={`Marker ${formatTime(m.time)}${m.label ? ` · ${m.label}` : ''}\nClick to jump here, double-click to remove`}
      onPointerDown={(e) => e.stopPropagation()} onClick={() => onSeek(m.time)}
      onDoubleClick={() => dispatch({ type: 'removeMarker', id: m.id })}>
      <Flag size={11} fill="currentColor" />
    </button>
  ));

  // Ruler ticks: pick a step that keeps labels ~90px apart.
  const step = [0.5, 1, 2, 5, 10, 15, 30, 60].find((s) => s * pps >= 90) || 120;
  const ticks = [];
  for (let t = 0; t * pps < width; t += step) ticks.push(t);

  // A selected clip that lives on a free track (everything but the main track), with its current values.
  const findFree = (it) => {
    const key = { overlay: 'overlayClips', text: 'textClips', audio: 'audioClips', effect: 'effectClips' }[it.track];
    return key ? (project[key] || []).find((c) => c.id === it.id) : null;
  };
  const laneClass = (id) => `tl-lane ${drop && (drop.lane === id || (drop.lane === 'files' && id === 'video')) ? 'drop-target' : ''}`;
  // Several clips selected (box selection, Ctrl + click): selection.items lists them all; selection.track / id is
  // the first one, shown in the properties panel.
  const toggleSel = (track, id) => {
    const items = selection ? (selection.items || [{ track: selection.track, id: selection.id }]) : [];
    const has = items.some((x) => x.track === track && x.id === id);
    onSelect(makeSelection(has ? items.filter((x) => !(x.track === track && x.id === id)) : [...items, { track, id }]));
  };
  const common = { pps, selection, onMenu: onClipMenu, onToggle: toggleSel,
    layerStateFor: (track, clip) => layerStateOf(project, track, clipLayer(track, clip)) };
  // The filter of a picture clip as a chip on the clip, removable from the timeline.
  const lookTags = (track, clip) => {
    if (!clip.filter || clip.filter === 'none') return null;
    const name = filterName(clip.filter);
    return [{ key: 'filter', label: name, title: `Filter: ${name}`, onRemove: () => dispatch({ type: 'update', track, id: clip.id, patch: { filter: 'none' } }) }];
  };
  const fxObjects = effectObjects(project);
  // Rows of a layered lane: one per layer, empty ones included.
  const layerRows = (lane, clips) => {
    const count = layerCount(project, lane);
    const rows = {};
    clips.forEach((c) => { rows[c.id] = rowToLayer(lane, layerOf(c), count); });
    return { rows, count };
  };
  const stacks = {
    effect: stackRows(fxObjects.map((o) => ({ id: o.key, start: o.start, duration: o.duration }))),
    text: layerRows('text', project.textClips),
    overlay: layerRows('overlay', overlays),
    audio: layerRows('audio', project.audioClips),
  };
  const rowHeight = (id) => (stacks[id] ? Math.max(46, HEAD_TITLE_H + stacks[id].count * rowOf(id) + 8) : undefined);
  // The layers of a lane as faint bands; an empty one can be removed. Locked bands get the
  // diagonal treatment, hidden ones fade back — the state is readable without the header.
  const layerBands = (lane) => {
    if (!LAYERED[lane]) return null;
    const { count } = stacks[lane];
    const clips = project[LAYERED[lane]];
    return Array.from({ length: count }, (_, row) => {
      const layer = rowToLayer(lane, row, count);
      const empty = !clips.some((c) => layerOf(c) === layer);
      const st = layerStateOf(project, lane, layer);
      return (
        <div key={`band-${row}`} className={`layer-band ${st.locked ? 'locked' : ''} ${st.hidden ? 'is-hidden' : ''}`} style={{ top: HEAD_TITLE_H + row * rowOf(lane), height: rowOf(lane) - 4 }}>
          {empty && count > 1 && (
            <button className="layer-remove" title="Remove this empty layer" aria-label="Remove this empty layer"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => { e.stopPropagation(); dispatch({ type: 'removeLayer', track: lane, layer }); }}><X size={11} /></button>
          )}
          {renaming && renaming.track === lane && renaming.layer === layer
            ? layerRenameInput(lane, layer)
            : (count > 1 || (project.layerNames && project.layerNames[lane] && project.layerNames[lane][layer])) && (
              <span className="layer-band-name">{layerName(project, lane, layer)}</span>
            )}
        </div>
      );
    });
  };

  const renderLane = (id) => {
    if (id === 'effect') {
      // One bar per effect applied to a clip; it follows the clip. Select it to see it in the panel, Delete removes it.
      return fxObjects.map((o) => {
        const e = EFFECTS.find((x) => x.id === o.fx);
        return (
          <Clip {...common} key={o.key} track={o.free ? 'effect free' : 'effect bound'} selTrack="effect" clip={o.free ? o.clip : { id: o.key }}
            start={o.start} length={o.duration} row={stacks.effect.rows[o.key]}
            icon={<span className="clip-emoji">{e?.icon || '✨'}</span>} label={o.free ? e?.name || o.fx : `${e?.name || o.fx} · on clip`}
            onDown={o.free ? (ev, mode) => startFreeDrag(ev, 'effect', o.clip, mode)
              : (ev, mode) => { ev.stopPropagation(); if (mode === 'move') onSelect({ track: 'effect', id: o.key }); }} />
        );
      });
    }
    if (id === 'overlay') {
      return overlays.map((c) => {
        const m = mediaById[c.mediaId];
        const len = freeLen('overlay', c);
        return (
          <Clip {...common} key={c.id} track="overlay" clip={c} start={c.start} length={len} row={stacks.overlay.rows[c.id]} rowH={rowOf('overlay')}
            icon={<Layers size={12} />} label={m?.name ?? '?'} tags={lookTags('overlay', c)} onDown={(e, mode) => startFreeDrag(e, 'overlay', c, mode)}
            onKeyDrag={(e, t) => startKeyDrag(e, 'overlay', c, t, len, c.start)}>
            <Filmstrip m={m} clip={c} width={len * pps} pps={pps} />
          </Clip>
        );
      });
    }
    if (id === 'text') {
      return project.textClips.map((c) => (
        <Clip {...common} key={c.id} track={c.caption ? 'text caption' : 'text'} selTrack="text" clip={c} start={c.start} length={c.duration} row={stacks.text.rows[c.id]}
          icon={c.caption ? <Captions size={12} /> : <Type size={12} />} label={c.text}
          onDown={(e, mode) => startFreeDrag(e, 'text', c, mode)} />
      ));
    }
    if (id === 'video') {
      return (
        <>
          {layout.map((l) => {
            if (l.clip.gap) {
              return (
                <Clip {...common} key={l.clip.id} track="video gap" selTrack="video" clip={l.clip} start={l.start} length={l.end - l.start}
                  label="Gap" onDown={(e, mode) => startVideoDrag(e, l.clip, mode)} />
              );
            }
            const m = mediaById[l.clip.mediaId];
            const sp = l.clip.speed || 1;
            return (
              <Clip {...common} key={l.clip.id} track="video" clip={l.clip} start={l.start} length={l.end - l.start}
                label={videoLabel(l.clip, m)} dropHere={drop?.clipId === l.clip.id} tags={lookTags('video', l.clip)}
                onDown={(e, mode) => startVideoDrag(e, l.clip, mode)}
                onKeyDrag={(e, t) => startKeyDrag(e, 'video', l.clip, t, l.end - l.start, l.start)}>
                <Filmstrip m={m} clip={l.clip} width={(l.end - l.start) * pps} pps={pps} />
                {m?.wave && !l.clip.muted && <ClipWave m={m} clip={l.clip} pps={pps} />}
              </Clip>
            );
          })}
          {layout.filter((l) => l.trans > 0).map((l) => {
            const sel = selection?.track === 'transition' && selection.id === l.clip.id;
            const def = TRANSITIONS.find((t) => t.id === l.clip.transition.type);
            return (
              <button key={'tr' + l.clip.id} className={`tr-pill ${sel ? 'on' : ''}`}
                style={{ left: l.start * pps, width: Math.max(22, l.trans * pps) }}
                title={`Transition: ${def?.name || l.clip.transition.type} · ${l.trans.toFixed(1)}s\nClick to edit it`}
                aria-label={`Transition: ${def?.name || l.clip.transition.type}`} aria-pressed={sel}
                onPointerDown={(e) => { e.stopPropagation(); onSelect({ track: 'transition', id: l.clip.id }); }}>
                <ArrowLeftRight size={11} />
                {l.trans * pps >= 74 && <span className="tr-pill-name">{def?.name || l.clip.transition.type}</span>}
              </button>
            );
          })}
          {drop && (drop.lane === 'video' || drop.lane === 'files') && (
            <div className="insert-line" style={{ left: drop.at * pps }} />
          )}
        </>
      );
    }
    return project.audioClips.map((c) => {
      const m = mediaById[c.mediaId];
      const bg = m?.wave ? {
        backgroundImage: `url("${toFileUrl(m.wave)}")`, backgroundRepeat: 'no-repeat',
        backgroundSize: `${(m.duration / (c.speed || 1)) * pps}px 70%`, backgroundPosition: `${(-c.in / (c.speed || 1)) * pps}px center`,
      } : null;
      return (
        <Clip {...common} key={c.id} track="audio" clip={c} start={c.start} length={freeLen('audio', c)} bg={bg} row={stacks.audio.rows[c.id]} rowH={rowOf('audio')}
          icon={<Music size={12} />} label={m?.name ?? '?'} onDown={(e, mode) => startFreeDrag(e, 'audio', c, mode)} />
      );
    });
  };

  // Toolbar availability mirrors App's shortcut handlers exactly — same target resolution
  // (selection first, then the main-track clip under the playhead) and the same trimActions
  // builder — so a button is enabled only when its shortcut would actually do something.
  const trimTargets = [];
  if (selection) trimTargets.push(selection);
  const underPlayhead = videoClipAt(project, time);
  if (underPlayhead && !(selection && selection.id === underPlayhead.clip.id)) trimTargets.push({ track: 'video', id: underPlayhead.clip.id });
  const canTrim = (side) => trimTargets.some((tgt) => trimActions(project, { track: tgt.track, id: tgt.id, t: time, side, newId: tgt.id }).length > 0);
  const canSplit = !!(selection || underPlayhead);

  return (
    <section className="timeline" aria-label="Timeline">
      <div className="tl-main">
      {overlay}
      <div className="tl-toolbar">
        <div className="tool-group">
          <div className="seg-icons" role="group" aria-label="Timeline tool">
            <IconBtn label="Select (V)" active={tool === 'select'} onClick={() => setTool('select')}><MousePointer2 size={16} /></IconBtn>
            <IconBtn label="Razor: click a clip to cut it (B)" active={tool === 'razor'} onClick={() => setTool('razor')}><Slice size={16} /></IconBtn>
          </div>
          <div className="tool-cluster" role="group" aria-label="History">
            <IconBtn label="Undo (Ctrl+Z)" onClick={() => dispatch({ type: 'undo' })} disabled={!canUndo}><Undo2 size={16} /></IconBtn>
            <IconBtn label="Redo (Ctrl+Y)" onClick={() => dispatch({ type: 'redo' })} disabled={!canRedo}><Redo2 size={16} /></IconBtn>
          </div>
          <div className="tool-cluster" role="group" aria-label="Edit">
            <IconBtn label="Split at playhead (S / Ctrl+B)" onClick={onSplit} disabled={!canSplit}><Scissors size={16} /></IconBtn>
            <IconBtn label="Delete left of playhead (Q)" onClick={() => onTrimSide('left')} disabled={!canTrim('left')}><ArrowLeftToLine size={16} /></IconBtn>
            <IconBtn label="Delete right of playhead (W)" onClick={() => onTrimSide('right')} disabled={!canTrim('right')}><ArrowRightToLine size={16} /></IconBtn>
            <IconBtn label="Duplicate (Ctrl+D)" onClick={onDuplicate} disabled={!selection}><Copy size={16} /></IconBtn>
            <IconBtn label="Delete (Del)" onClick={onDelete} disabled={!selection}><Trash2 size={16} /></IconBtn>
          </div>
          {(detachOk || linkMode) && (
            <div className="tool-cluster" role="group" aria-label="Clip sound and link">
              {detachOk && <IconBtn label="Detach audio: put the clip's sound on the Audio track, linked" onClick={onDetach}><AudioLines size={16} /></IconBtn>}
              {linkMode === 'unlink' && <IconBtn label="Unlink audio and video" onClick={onLinkToggle}><Unlink size={16} /></IconBtn>}
              {linkMode === 'link' && <IconBtn label="Link the selected video and audio clips" onClick={onLinkToggle}><Link2 size={16} /></IconBtn>}
            </div>
          )}
          <div className="tool-cluster" role="group" aria-label="Mark">
            <IconBtn label="Marker at playhead (M). Press again on a marker to remove it" onClick={onMarker}><Flag size={16} /></IconBtn>
          </div>
        </div>
        <div className="tool-group">
          <div className="tool-cluster" role="group" aria-label="Record and snap">
          {recorder.recording ? (
            <button className="rec-pill" onClick={onToggleRecord} aria-pressed="true"
              title="Stop recording and place the voice-over on the timeline">
              <span className="rec-dot" aria-hidden="true" />
              <Square size={12} fill="currentColor" aria-hidden="true" />
              <span className="rec-stop-label">Stop</span>
              <span className="rec-time">{formatTime(recorder.seconds).slice(0, 5)}</span>
              <RecMeter analyserRef={recorder.analyserRef} />
            </button>
          ) : (
            <button className="rec-btn" onClick={onToggleRecord}
              aria-pressed="false" title="Record a voice-over from the playhead">
              <Mic size={15} />
            </button>
          )}
          <IconBtn label={`Auto snapping: ${project.snapping ? 'ON' : 'OFF'}`} active={project.snapping}
            onClick={() => dispatch({ type: 'setProject', patch: { snapping: !project.snapping }, transient: true })}><Target size={16} /></IconBtn>
          </div>
          <span className="tl-time"><b>{formatTime(time)}</b> / {formatTime(duration)}</span>
          <div className="tool-cluster" role="group" aria-label="View">
            <IconBtn label="Fit the project in the timeline" onClick={fit}><StretchHorizontal size={16} /></IconBtn>
            <IconBtn label="Zoom out (Ctrl + mouse wheel)" onClick={() => zoomTo(pps / 1.4)}><ZoomOut size={16} /></IconBtn>
            <input className="zoom" type="range" min="2" max="300" value={pps} aria-label="Zoom timeline"
              title="Ctrl + mouse wheel: zoom · Shift + mouse wheel: scroll" onChange={(e) => zoomTo(Number(e.target.value))} />
            <IconBtn label="Zoom in (Ctrl + mouse wheel)" onClick={() => zoomTo(pps * 1.4)}><ZoomIn size={16} /></IconBtn>
          </div>
        </div>
      </div>
      <div className={`tl-scroll ${tool === 'razor' ? 'razor' : ''}`} ref={scrollRef}
        onPointerMove={(e) => { if (tool === 'razor') { const t = timeFromEvent(e); setRazorAt(project.snapping ? snapPoint(t) : t); } }}
        onPointerLeave={() => setRazorAt(null)}
        onDragOver={onDragOver} onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) setDrop(null);
      }} onDrop={onDrop}>
        <div className="tl-content" ref={contentRef} style={{ width: width + HEADER }}>
          {box && <div className="select-box" style={{ left: box.x, top: box.y, width: box.w, height: box.h }} />}
          <div className="tl-row ruler" onPointerDown={scrub}>
            <div className="tl-head" />
            <div className="tl-ruler">
              {markerEls}
              {ticks.map((t) => (
                <div key={t} className="tick" style={{ left: t * pps }}><span>{formatTime(t).slice(0, 5)}</span></div>
              ))}
            </div>
          </div>

          {LANES.filter((l) => l.id !== 'effect' || fxObjects.length || activeDrag()?.kind === 'effect').map((l) => {
            const Icon = l.icon;
            return (
              <div key={l.id} className={`tl-row ${l.main ? 'main' : ''}`} style={{ height: rowHeight(l.id) }}>
                <div className="tl-head" data-lane={l.id}
                  onContextMenu={(LAYERED[l.id] || l.id === 'video' || l.id === 'effect') ? (e) => openLayerMenu(e, l.id) : undefined}>
                  <div className="tl-title-row">
                    <Icon size={14} aria-hidden="true" className="tl-icon" /> <span className="tl-name" title={l.name}>{renaming && renaming.track === l.id && l.id === 'video' ? layerRenameInput(l.id, 0) : l.name}</span>
                    {/* The title row shares the layer rows' control grid: cell 1 = add,
                        cell 2 (the eye column) = magnet, the rest stay empty slots. */}
                    {LAYERED[l.id] ? (l.id === 'text' && onAddText ? (
                      <button className="layer-add" title="Add text at the playhead" aria-label="Add text at the playhead"
                        onClick={() => onAddText({ text: 'Add text' })}><Plus size={13} /></button>
                    ) : (
                      <button className="layer-add" title={`Add a ${l.name.toLowerCase()} layer`} aria-label={`Add a ${l.name} layer`}
                        onClick={() => dispatch({ type: 'addLayer', track: l.id })}><Plus size={13} /></button>
                    )) : (
                      <span className="tl-ctl-slot" aria-hidden="true" />
                    )}
                    {!l.noMagnet ? <button className={`magnet-btn ${magnet[l.id] ? 'on' : ''}`} aria-pressed={!!magnet[l.id]}
                      aria-label={`${l.name} magnet ${magnet[l.id] ? 'on' : 'off'}`}
                      title={`${l.name} magnet: ${magnet[l.id] ? 'ON' : 'OFF'}\n${l.id === 'video'
                        ? (magnet[l.id] ? 'Clips close up after a delete or trim' : 'Deleting or trimming leaves a gap')
                        : (magnet[l.id] ? 'Delete and trim close the gap' : 'Free placement, nothing moves')}`}
                      onClick={() => dispatch({ type: 'setMagnet', track: l.id, on: !magnet[l.id] })}>
                      <Magnet size={13} />
                    </button> : (
                      <span className="tl-ctl-slot" aria-hidden="true" />
                    )}
                    <span className="tl-ctl-slot" aria-hidden="true" />
                    <span className="tl-ctl-slot" aria-hidden="true" />
                    <span className="tl-ctl-slot" aria-hidden="true" />
                  </div>
                  <div className="tl-layer-stack">
                    {layerCtlRows(l.id)}
                  </div>
                </div>
                <div className={laneClass(l.id)} data-lane={l.id} onPointerDown={startBox}>
                  {layerBands(l.id)}
                  {renderLane(l.id)}
                  {l.main && empty && (
                    <div className="lane-empty"><Film size={16} /> Drag media here to start editing</div>
                  )}
                </div>
              </div>
            );
          })}

          {markers.map((m) => <div key={m.id} className="marker-line" style={{ left: HEADER + m.time * pps }} />)}
          {tool === 'razor' && razorAt != null && <div className="razor-line" style={{ left: HEADER + razorAt * pps }} />}
          {tool === 'razor' && razorAt != null && <div className="razor-time" style={{ left: HEADER + razorAt * pps }}>{formatTime(razorAt)}</div>}
          {snapAt != null && <div className="snap-line" style={{ left: HEADER + snapAt * pps }} />}
          {trimHud && <div className="trim-hud" style={{ left: trimHud.x }}>{trimHud.text}</div>}
          <div className="playhead" ref={playheadRef} />
          {drop && drop.time != null && drop.lane !== 'clip' && (
            <div className="drop-time" style={{ left: HEADER + (drop.at ?? drop.time) * pps }}>{formatTime(drop.at ?? drop.time)}</div>
          )}
        </div>
      </div>
      </div>
      <AudioMeter active={playing} />
      {layerMenu && <ContextMenu x={layerMenu.x} y={layerMenu.y} items={layerMenuItems(layerMenu)}
        onClose={() => setLayerMenu(null)} label="Layer menu" />}
    </section>
  );
}

function IconBtn({ label, children, active, ...rest }) {
  return <button className={`icon-btn ${active ? 'active' : ''}`} aria-label={label} aria-pressed={active === undefined ? undefined : !!active} title={label} {...rest}>{children}</button>;
}

// Live microphone level for the recording pill: an AnalyserNode tapped off the recorder's
// own stream, read on rAF and painted straight to the fill element (no React state churn).
function RecMeter({ analyserRef }) {
  const fillRef = useRef(null);
  useEffect(() => {
    let raf = 0;
    const data = new Uint8Array(256);
    const loop = () => {
      raf = requestAnimationFrame(loop);
      const an = analyserRef?.current;
      const el = fillRef.current;
      if (!an || !el) return;
      an.getByteTimeDomainData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i++) { const v = (data[i] - 128) / 128; sum += v * v; }
      const rms = Math.sqrt(sum / data.length);
      el.style.width = `${Math.min(100, Math.round(rms * 280))}%`;
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [analyserRef]);
  return <span className="rec-meter" aria-hidden="true"><span className="rec-meter-fill" ref={fillRef} /></span>;
}

function Clip({ pps, selection, track, selTrack, clip, start, length, label, icon, bg, dropHere, onDown, row, rowH = ROW, children, onMenu, onToggle, tags, onKeyDrag, layerStateFor }) {
  const st = selTrack || track;
  const selected = isSelected(selection, st, clip.id);
  const lst = layerStateFor ? layerStateFor(st, clip) : null;
  const stacked = row !== undefined ? { top: HEAD_TITLE_H + row * rowH, bottom: 'auto', height: rowH - 4 } : null;
  return (
    <div className={`clip ${track} ${selected ? 'selected' : ''} ${dropHere ? 'drop-here' : ''} ${clip.disabled ? 'off' : ''} ${clip.slot && !clip.gap ? 'replaceable' : ''} ${lst?.locked ? 'locked' : ''} ${lst?.hidden ? 'layer-hidden' : ''}`}
      style={{ left: start * pps, width: Math.max(6, length * pps), ...stacked }}
      data-sel-track={st} data-sel-id={clip.id}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        // Ctrl / Shift + click adds the clip to the selection (or takes it out).
        if ((e.ctrlKey || e.shiftKey || e.metaKey) && onToggle) { e.stopPropagation(); onToggle(st, clip.id); return; }
        onDown(e, 'move');
      }} title={clip.disabled ? `${label} (deactivated)` : label}
      onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); onMenu?.(e, st, clip); }}>
      {bg && <div className="clip-bg" style={bg} />}
      {children}
      <div className="handle left" onPointerDown={(e) => e.button === 0 && onDown(e, 'left')} />
      <span className="clip-label">{clip.slot && !clip.gap && <span className="rep-badge" title="Replaceable: people put their own video here when they use the template">⇄</span>}{icon}<bdi>{label}</bdi>
      {tags?.length > 0 && (
        <span className="clip-tags">
          {tags.map((t) => (
            <span key={t.key} className="clip-tag" title={t.title}>
              {t.label}
              <button type="button" aria-label={`Remove ${t.label}`} title={`Remove ${t.label}`}
                onPointerDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); t.onRemove(); }}>×</button>
            </span>
          ))}
        </span>
      )}
      </span>
      {(track === 'video' || track === 'overlay') && (clip.anim || clip.keyframes) && <ClipMotion clip={clip} length={length} pps={pps} selected={selected} onKeyDrag={onKeyDrag} />}
      <div className="handle right" onPointerDown={(e) => e.button === 0 && onDown(e, 'right')} />
    </div>
  );
}

// Animations as bands at the clip's start / end (or along it for a Combo), and the keyframes of the selected
// clip as diamonds.
function ClipMotion({ clip, length, pps, selected, onKeyDrag }) {
  const a = animOf(clip, length);
  const times = selected ? keyTimes(clip).filter((t) => t >= -1e-6 && t <= length + 1e-6) : [];
  return (
    <>
      {a.in && <div className="anim-band in" style={{ width: a.in.duration * pps }} title={`In: ${animById('in', a.in.type).name}`} />}
      {a.out && <div className="anim-band out" style={{ width: a.out.duration * pps }} title={`Out: ${animById('out', a.out.type).name}`} />}
      {a.combo && <div className="anim-band combo" title={`Combo: ${animById('combo', a.combo.type).name}`} />}
      {times.map((t) => (
        <span key={t} className="kf-dot" style={{ left: t * pps }} title="Keyframe · drag to move it, click to go to it"
          onPointerDown={(e) => { e.stopPropagation(); onKeyDrag?.(e, t); }} />
      ))}
    </>
  );
}

const THUMB_H = 50; // filmstrip height inside a main-track clip
const MAX_TILES = 400;

// Filmstrip: thumbnails at their real aspect ratio, each showing the frame at its
// position on the timeline (follows trim, speed and zoom). Uses the sprite from makeVisuals.
function Filmstrip({ m, clip, width, pps }) {
  if (!m) return null;
  const look = { filter: clipCss(clip) || undefined, transform: clip.effects?.includes('mirror') && !clip.fxRegions?.mirror && !(clip.fxStrength?.mirror != null && clip.fxStrength.mirror < 1) ? 'scaleX(-1)' : undefined };
  if (m.type === 'image') {
    return <div className="filmstrip" style={{ ...look, backgroundImage: `url("${toFileUrl(m.path)}")`, backgroundSize: `auto ${THUMB_H}px`, backgroundRepeat: 'repeat-x' }} />;
  }
  if (!m.thumb || !m.thumbCount) return <div className="filmstrip loading" />;
  const tileW = (THUMB_H * m.thumbW) / m.thumbH;
  const n = Math.min(MAX_TILES, Math.ceil(width / tileW));
  const sp = clip.speed || 1;
  const url = `url("${toFileUrl(m.thumb)}")`;
  const tiles = [];
  for (let k = 0; k < n; k++) {
    const x = k * tileW;
    const t = clip.in + ((x + tileW / 2) / pps) * sp;
    const idx = Math.max(0, Math.min(m.thumbCount - 1, Math.floor(t / m.thumbInterval)));
    tiles.push(
      <div key={k} className="tile-frame" style={{
        left: x, width: tileW, backgroundImage: url,
        backgroundSize: `${m.thumbCount * tileW}px ${THUMB_H}px`, backgroundPosition: `${-idx * tileW}px 0`,
      }} />
    );
  }
  return <div className="filmstrip" style={look}>{tiles}</div>;
}

// Audio waveform strip under a video clip (follows trim and speed).
function ClipWave({ m, clip, pps }) {
  const sp = clip.speed || 1;
  return (
    <div className="clip-wave" style={{
      backgroundImage: `url("${toFileUrl(m.wave)}")`, backgroundRepeat: 'no-repeat',
      backgroundSize: `${(m.duration / sp) * pps}px 100%`, backgroundPosition: `${(-clip.in / sp) * pps}px 0`,
    }} />
  );
}

function videoLabel(clip, m) {
  const tags = [];
  if ((clip.speed || 1) !== 1) tags.push(`${clip.speed}×`);
  if (clip.effects?.length) tags.push(`${clip.effects.length} effect${clip.effects.length > 1 ? 's' : ''}`);
  if (clip.muted) tags.push('muted');
  return [m?.name ?? '?', ...tags].join(' · ');
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

// Selection helpers: one clip { track, id }, several { track, id, items: [{ track, id }] }.
export function isSelected(selection, track, id) {
  if (!selection) return false;
  if (selection.items) return selection.items.some((x) => x.track === track && x.id === id);
  return selection.track === track && selection.id === id;
}
export function makeSelection(items) {
  if (!items.length) return null;
  if (items.length === 1) return { ...items[0] };
  return { ...items[0], items };
}
