import React, { useRef, useState } from 'react';
import { RotateCw } from 'lucide-react';
import { clipLen, freeLen, videoLayout } from '../store.js';
import { transformOf } from '../visual.js';
import { pictureGeometry } from '../pictureGeometry.js';
import { baseAt, editAt, hasMotion, stateAt } from '../anim.js';
import { pinOffsetAt, stateAtPinned } from '../track.js';
import { resolveStyle, textBox, textVisible } from '../text/render.js';

// Direct manipulation in the player: click a picture to select it, drag to move, corners to scale,
// the round handle to rotate. Moves snap to the frame center (with guide lines), rotation to 0 / 90 degrees
// (Shift: 15 degree steps). Every drag is one undo step. An animated clip shows its box where it is now; a value
// with keyframes gets a keyframe at the playhead. Text works the same way (it is drawn above the pictures, so it is
// picked first): the corners change its size, the round handle its rotation.
const SNAP_PX = 6;

// The clip's displayed picture box comes from src/pictureGeometry.js — the same geometry
// the crop overlay and the colour sampler use. (For a cropped clip the box is the fitted
// box of the crop's surviving region, which is what the renderer shows.)

export default function TransformBox({ project, time, selection, onSelect, dispatch, sw, sh }) {
  const [guides, setGuides] = useState({ x: false, y: false });
  const layerRef = useRef(null);
  const mediaById = Object.fromEntries(project.media.map((m) => [m.id, m]));

  // Things on screen now, topmost first: text (later clips on top), overlays (later ones on top), then the main clip.
  const onScreen = [];
  for (let i = project.textClips.length - 1; i >= 0; i--) {
    const c = project.textClips[i];
    if (textVisible(c, time) && (c.text || '').trim()) onScreen.push({ track: 'text', clip: c, lt: time - c.start, text: true });
  }
  const overlays = project.overlayClips || [];
  for (let i = overlays.length - 1; i >= 0; i--) {
    const c = overlays[i];
    if (!c.disabled && time >= c.start && time < c.start + freeLen('overlay', c)) onScreen.push({ track: 'overlay', clip: c, lt: time - c.start });
  }
  videoLayout(project.videoClips).filter((l) => !l.clip.gap && !l.clip.disabled && time >= l.start && time < l.end)
    .reverse().forEach((l) => onScreen.push({ track: 'video', clip: l.clip, lt: time - l.start }));

  // Values the drags start from (keyframes applied, without the animation).
  const baseOf = (item) => {
    if (!item.text) return { ...transformOf(item.clip), ...baseAt(item.clip, item.lt) };
    const st = resolveStyle(item.clip);
    return { x: st.x, y: st.y, size: st.size, rot: st.rotation || 0 };
  };
  const geo = (item) => {
    const clip = item.clip;
    if (item.text) {
      const b = textBox(clip, project.width, project.height);
      const kx = sw / project.width;
      const ky = sh / project.height;
      // A pinned text is drawn offset from its base anchor (src/track.js); the box follows the drawing.
      const off = clip.pin ? pinOffsetAt(project, { track: 'text', clip }, time) : { dx: 0, dy: 0 };
      return { cx: (b.cx + off.dx * project.width) * kx, cy: (b.cy + off.dy * project.height) * ky, w: b.w * kx, h: b.h * ky, rot: b.rot };
    }
    const t = (hasMotion(clip) || clip.pin) ? stateAtPinned(project, { track: item.track, clip }, item.lt, clipLen(clip)).transform : transformOf(clip);
    const g2 = pictureGeometry(project, mediaById[clip.mediaId], clip, t);
    return { t, cx: g2.cx * sw, cy: g2.cy * sh, w: g2.w * sw, h: g2.h * sh, rot: g2.rot };
  };
  const hits = (g, px, py) => {
    const a = (-g.rot * Math.PI) / 180;
    const dx = px - g.cx;
    const dy = py - g.cy;
    const lx = dx * Math.cos(a) - dy * Math.sin(a);
    const ly = dx * Math.sin(a) + dy * Math.cos(a);
    return Math.abs(lx) <= g.w / 2 && Math.abs(ly) <= g.h / 2;
  };

  const sel = selection && onScreen.find((o) => o.track === selection.track && o.clip.id === selection.id);
  const local = (e) => {
    const r = layerRef.current.getBoundingClientRect();
    // The player can scale the whole stage (preview zoom): the rect is the *displayed* size, so
    // divide it out to keep pointer math in stage pixels exactly as at 100%.
    const z = layerRef.current.offsetWidth ? r.width / layerRef.current.offsetWidth : 1;
    return { x: (e.clientX - r.left) / z, y: (e.clientY - r.top) / z };
  };

  // Drags `clip`; onMove gets the pointer in stage pixels and returns the new transform patch.
  const startDrag = (e, item, onMove) => {
    e.preventDefault();
    e.stopPropagation();
    dispatch({ type: 'beginGesture' });
    const move = (ev) => {
      const patch = onMove(local(ev), ev);
      dispatch({ type: 'update', track: item.track, id: item.clip.id, patch: item.text ? patch : editAt(item.clip, patch, item.lt) });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      dispatch({ type: 'endGesture' });
      setGuides({ x: false, y: false });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const startMove = (e, item) => {
    const p0 = local(e);
    const t0 = baseOf(item);
    // Pictures are placed from the frame center (0), text by its center as a fraction of the frame (0.5).
    const c = item.text ? 0.5 : 0;
    startDrag(e, item, (p) => {
      let x = t0.x + (p.x - p0.x) / sw;
      let y = t0.y + (p.y - p0.y) / sh;
      const gx = Math.abs((x - c) * sw) < SNAP_PX;
      const gy = Math.abs((y - c) * sh) < SNAP_PX;
      if (gx) x = c;
      if (gy) y = c;
      setGuides({ x: gx, y: gy });
      return { x, y };
    });
  };

  const startScale = (e, item) => {
    const g = geo(item);
    const b = baseOf(item);
    const p0 = local(e);
    const d0 = Math.max(4, Math.hypot(p0.x - g.cx, p0.y - g.cy));
    const k = (p) => Math.hypot(p.x - g.cx, p.y - g.cy) / d0;
    if (item.text) startDrag(e, item, (p) => ({ size: Math.round(Math.min(600, Math.max(8, b.size * k(p)))) }));
    else startDrag(e, item, (p) => ({ scale: Math.min(10, Math.max(0.05, b.scale * k(p))) }));
  };

  const startRotate = (e, item) => {
    const g = geo(item);
    const b = baseOf(item);
    const p0 = local(e);
    const a0 = Math.atan2(p0.y - g.cy, p0.x - g.cx);
    startDrag(e, item, (p, ev) => {
      let rot = b.rot + ((Math.atan2(p.y - g.cy, p.x - g.cx) - a0) * 180) / Math.PI;
      rot = ((((rot + 180) % 360) + 360) % 360) - 180;
      if (ev.shiftKey) rot = Math.round(rot / 15) * 15;
      else {
        const near = Math.round(rot / 90) * 90;
        if (Math.abs(rot - near) < 3) rot = near;
      }
      rot = Math.round(rot * 10) / 10;
      return item.text ? { rotation: rot } : { rot };
    });
  };

  // Click on the picture: select what is on top there and start moving it.
  const onDown = (e) => {
    if (e.button !== 0) return;
    const p = local(e);
    const hit = onScreen.find((o) => hits(geo(o), p.x, p.y));
    if (!hit) {
      if (selection && ['video', 'overlay', 'text'].includes(selection.track)) onSelect(null);
      return;
    }
    onSelect({ track: hit.track, id: hit.clip.id });
    startMove(e, hit);
  };

  const g = sel && geo(sel);
  return (
    <div className="tbox-layer" ref={layerRef} onPointerDown={onDown}>
      {guides.x && <div className="tbox-guide v" />}
      {guides.y && <div className="tbox-guide h" />}
      {g && (
        <div className="tbox" style={{ left: g.cx, top: g.cy, width: g.w, height: g.h, transform: `translate(-50%, -50%) rotate(${g.rot}deg)` }}
          onPointerDown={(e) => e.button === 0 && startMove(e, sel)} aria-label="Selected clip on the player">
          {['nw', 'ne', 'sw', 'se'].map((k) => (
            <span key={k} className={`tbox-handle ${k}`} onPointerDown={(e) => e.button === 0 && startScale(e, sel)} title="Drag to resize" />
          ))}
          <span className="tbox-rotate" onPointerDown={(e) => e.button === 0 && startRotate(e, sel)} title="Drag to rotate (Shift: 15° steps)">
            <RotateCw size={12} />
          </span>
        </div>
      )}
    </div>
  );
}
