import React, { useEffect, useRef, useState } from 'react';
import { Eraser, Paintbrush, RotateCcw, Trash2, X } from 'lucide-react';
import { previewPath, toFileUrl } from '../store.js';
import { rasterizeCustomMask } from '../customMask.js';

// Custom removal editor: paint Erase / Restore strokes over the clip's frame. The strokes are
// stored in source-normalized coordinates (src/customMask.js) and rasterize to a static mask
// that applies to the WHOLE clip — the copy in the dialog says so. "Show result" renders the
// exact rasterizer output over the frame, so what is painted is what the export removes.
export default function CustomMaskEditor({ clip, media, onClose, onSave }) {
  const [strokes, setStrokes] = useState(() => (clip.customMask?.strokes || []).map((s) => ({ ...s, points: s.points.map((p) => [...p]) })));
  const [tool, setTool] = useState('erase');
  const [size, setSize] = useState(10); // brush diameter, % of the frame width
  const [showResult, setShowResult] = useState(false);
  const stageRef = useRef(null);
  const paintRef = useRef(null);
  const resultRef = useRef(null);
  const frameRef = useRef(null); // the <video> or <img> showing the frame
  const drawing = useRef(null);
  const isVideo = media.type === 'video';
  const aspect = media.width && media.height ? media.width / media.height : 16 / 9;

  const norm = (e) => {
    const r = stageRef.current.getBoundingClientRect();
    return [
      Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)),
      Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)),
    ];
  };

  // Painted strokes overlay: erase in red, restore in green, at the brush's real size.
  useEffect(() => {
    const cv = paintRef.current;
    if (!cv || showResult) return;
    const W = (cv.width = 960);
    const H = (cv.height = Math.max(2, Math.round(960 / aspect)));
    const ctx = cv.getContext('2d');
    ctx.clearRect(0, 0, W, H);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const s of strokes) {
      ctx.strokeStyle = s.tool === 'restore' ? 'rgba(74, 255, 140, 0.5)' : 'rgba(255, 64, 64, 0.5)';
      ctx.lineWidth = Math.max(1, (s.size / 100) * W);
      ctx.beginPath();
      s.points.forEach(([x, y], i) => (i ? ctx.lineTo(x * W, y * H) : ctx.moveTo(x * W, y * H)));
      if (s.points.length === 1) ctx.lineTo(s.points[0][0] * W + 0.01, s.points[0][1] * H);
      ctx.stroke();
    }
  }, [strokes, showResult, aspect]);

  // Result preview: the frame with the rasterized keep-map applied (the export's own numbers).
  useEffect(() => {
    if (!showResult) return;
    const cv = resultRef.current;
    const src = frameRef.current;
    if (!cv || !src) return;
    const W = (cv.width = 960);
    const H = (cv.height = Math.max(2, Math.round(960 / aspect)));
    const ctx = cv.getContext('2d');
    ctx.clearRect(0, 0, W, H);
    try { ctx.drawImage(src, 0, 0, W, H); } catch { return; }
    const keep = rasterizeCustomMask(strokes, W, H);
    const img = ctx.getImageData(0, 0, W, H);
    for (let i = 0; i < keep.length; i++) img.data[i * 4 + 3] = (img.data[i * 4 + 3] * keep[i]) / 255;
    ctx.putImageData(img, 0, 0);
  }, [showResult, strokes, aspect]);

  const down = (e) => {
    if (showResult) return;
    e.preventDefault();
    try { paintRef.current.setPointerCapture(e.pointerId); } catch { /* synthetic / stale pointer */ }
    const s = { tool, size, points: [norm(e)] };
    drawing.current = s;
    setStrokes((prev) => [...prev, s]);
  };
  const move = (e) => {
    const s = drawing.current;
    if (!s) return;
    const p = norm(e);
    s.points.push(p);
    // Snapshot NOW: the updater runs later, and by then the pointer may already be up
    // (up() nulls drawing.current) — reading the ref inside the updater crashed the app.
    const snapshot = { ...s, points: [...s.points] };
    setStrokes((prev) => [...prev.slice(0, -1), snapshot]);
  };
  const up = () => { drawing.current = null; };

  return (
    <div className="cmask-overlay" role="dialog" aria-modal="true" aria-label="Custom removal">
      <div className="cmask-modal">
        <div className="cmask-head">
          <b>Custom removal</b>
          <span className="dim small">Paint what to remove — the mask applies to the whole clip.</span>
          <button className="icon-btn sm" aria-label="Close" onClick={onClose}><X size={15} /></button>
        </div>
        <div className="cmask-stage" ref={stageRef} style={{ aspectRatio: String(aspect) }}>
          {isVideo ? (
            // The frame comes through the player's own source chain (previewPath): phone
            // footage the player needs a proxy for (HEVC, 10-bit, HDR, oversized) cannot
            // decode from the original file in Chromium at all — loading media.path here
            // directly gave those clips a permanently black paint stage (W5).
            <video ref={frameRef} src={toFileUrl(previewPath(media))} muted preload="auto" playsInline
              onLoadedMetadata={(e) => { e.currentTarget.currentTime = Math.min(clip.in || 0, (media.duration || 1) - 0.05); }} />
          ) : (
            <img ref={frameRef} src={toFileUrl(media.path)} alt="" />
          )}
          {showResult
            ? <canvas ref={resultRef} className="cmask-top" />
            : <canvas ref={paintRef} className="cmask-top" onPointerDown={down} onPointerMove={move} onPointerUp={up} />}
        </div>
        <div className="cmask-tools">
          <div className="seg-tabs small" role="radiogroup" aria-label="Brush">
            <button role="radio" aria-checked={tool === 'erase'} className={tool === 'erase' ? 'on' : ''} onClick={() => setTool('erase')}><Eraser size={13} /> Erase</button>
            <button role="radio" aria-checked={tool === 'restore'} className={tool === 'restore' ? 'on' : ''} onClick={() => setTool('restore')}><Paintbrush size={13} /> Restore</button>
          </div>
          <label className="cmask-size">Brush size
            <input type="range" min="2" max="30" step="1" value={size} aria-label="Brush size" onChange={(e) => setSize(Number(e.target.value))} />
            <span>{size}%</span>
          </label>
          <button className="btn btn-sm" onClick={() => setStrokes((p) => p.slice(0, -1))} disabled={!strokes.length}><RotateCcw size={13} /> Undo stroke</button>
          <button className="btn btn-sm" onClick={() => setStrokes([])} disabled={!strokes.length}><Trash2 size={13} /> Clear</button>
          <label className="field row">
            <span>Show result</span>
            <input type="checkbox" className="switch" checked={showResult} onChange={(e) => setShowResult(e.target.checked)} />
          </label>
        </div>
        <div className="cmask-foot">
          <span className="dim small">{strokes.length} stroke{strokes.length === 1 ? '' : 's'} · combines with Auto removal and Chroma key</span>
          <span className="cmask-actions">
            <button className="btn" onClick={onClose}>Cancel</button>
            <button className="btn btn-primary" onClick={() => onSave(strokes)}>Save mask</button>
          </span>
        </div>
      </div>
    </div>
  );
}
