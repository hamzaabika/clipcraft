import React, { useEffect, useRef, useState } from 'react';

// Range input whose whole drag becomes a single undo step.
// The readout is typeable: click the number, type, and Enter (or blur) commits through the
// very same onChange path a drag uses — wrapped in begin/endGesture so a typed value is
// also a single undo step. Esc cancels; unparseable text reverts silently; committed values
// clamp to [min, max] and snap to the step grid, exactly like the native range control.
// Arrow keys while editing nudge by one step and commit immediately.
// numScale: the readout's unit scale for the field (100 on percent readouts — the model
// holds 2, the field shows and accepts 200). Display formatting (fmt) is unchanged.
// extra: optional controls shown after the label (e.g. keyframe buttons).
export default function Slider({ label, value, onChange, dispatch, min = 0, max = 1, step = 0.01, fmt, extra, numScale }) {
  const [edit, setEdit] = useState(null); // string while typing, null when showing the value
  const settled = useRef(false); // Enter/Escape settle the edit; the blur that follows must not re-commit
  const inputRef = useRef(null);
  const show = fmt ? fmt(value) : Number(value).toFixed(step >= 1 ? 0 : 2);
  const scale = numScale || 1;
  const decimals = Math.min(4, (String(Number((step * scale).toFixed(6))).split('.')[1] || '').length);
  const editText = (v) => String(Number((v * scale).toFixed(decimals)));

  useEffect(() => {
    if (edit !== null && inputRef.current) { inputRef.current.focus(); inputRef.current.select(); }
  }, [edit !== null]); // eslint-disable-line react-hooks/exhaustive-deps

  const snapClamp = (v) => {
    if (v <= min) return min;
    if (v >= max) return max;
    const s = min + Math.round((v - min) / step) * step;
    return Number(Math.min(max, Math.max(min, s)).toFixed(6));
  };
  const commit = (raw) => {
    const n = parseFloat(String(raw).replace(',', '.'));
    if (!Number.isFinite(n)) return;
    const v = snapClamp(n / scale);
    if (v === value) return;
    dispatch?.({ type: 'beginGesture' });
    onChange(v);
    dispatch?.({ type: 'endGesture' });
  };
  const settle = (commitIt) => {
    if (commitIt) commit(edit);
    settled.current = true;
    setEdit(null);
    inputRef.current?.blur();
  };
  const onEditKey = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); settle(true); }
    else if (e.key === 'Escape') { e.preventDefault(); settle(false); }
    else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      const base = parseFloat(String(edit).replace(',', '.'));
      const cur = (Number.isFinite(base) ? base : value * scale) + (e.key === 'ArrowUp' ? 1 : -1) * step * scale;
      commit(cur);
      setEdit(editText(snapClamp(cur / scale)));
    }
  };

  return (
    <label className="field">
      <span>{label} {extra} {edit !== null ? (
        <input ref={inputRef} className="slider-value" type="text" inputMode="decimal" aria-label={`${label} value`}
          value={edit} onChange={(e) => setEdit(e.target.value)} onKeyDown={onEditKey}
          onBlur={() => { if (settled.current) { settled.current = false; return; } commit(edit); setEdit(null); }} />
      ) : (
        <b className="slider-value" title="Click to type a value"
          onClick={(e) => { e.preventDefault(); e.stopPropagation(); setEdit(editText(value)); }}>{show}</b>
      )}</span>
      <input type="range" min={min} max={max} step={step} value={value}
        onPointerDown={() => dispatch?.({ type: 'beginGesture' })}
        onPointerUp={() => dispatch?.({ type: 'endGesture' })}
        onChange={(e) => onChange(Number(e.target.value))} />
    </label>
  );
}
