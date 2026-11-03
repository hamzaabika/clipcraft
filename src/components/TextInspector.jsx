import React, { useMemo, useState } from 'react';
import { AlignCenter, AlignLeft, AlignRight, Bold, CaseUpper, Italic, Search, Star, Underline } from 'lucide-react';
import Slider from './Slider.jsx';
import NumBox from './NumBox.jsx';
import { dragProps } from '../dnd.js';
import TextPreview from './TextPreview.jsx';
import FontPicker from './FontPicker.jsx';
import { resolveStyle } from '../text/render.js';
import {
  ANIM_LOOP, BUBBLES, HIGHLIGHTS, TEMPLATE_CATEGORIES, TEXT_EFFECTS, TEXT_TEMPLATES,
} from '../text/catalog.js';
import TextAnimBrowser from './TextAnimBrowser.jsx';
import { PinToTrack } from './ClipInspector.jsx';

const TABS = ['Basic', 'Templates', 'Bubble', 'Effects', 'Animation'];
// Keys that describe how text looks (shared by "apply to all captions"); text and timing stay per clip.
const PER_CLIP = ['id', 'text', 'start', 'duration', 'words', 'caption'];

function stylePatch(patch) {
  const out = { ...patch };
  PER_CLIP.forEach((k) => delete out[k]);
  return out;
}

const FAV_KEY = 'clipcraft.favoriteTemplates';
function loadFavs() {
  try {
    return new Set(JSON.parse(localStorage.getItem(FAV_KEY) || '[]'));
  } catch {
    return new Set();
  }
}

export function TemplateGrid({ onPick, activeId, captionOnly, sampleText, draggable, category }) {
  const [ownCat, setCat] = useState(captionOnly ? 'Captions' : 'All');
  const cat = category || ownCat;
  const [q, setQ] = useState('');
  const [favs, setFavs] = useState(loadFavs);
  const [hover, setHover] = useState(null);
  const toggleFav = (id) => {
    const next = new Set(favs);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setFavs(next);
    try {
      localStorage.setItem(FAV_KEY, JSON.stringify([...next]));
    } catch {
      // Favorites are a convenience; ignore storage failures.
    }
  };
  const list = TEXT_TEMPLATES.filter((t) => {
    if (captionOnly && !t.caption && cat === 'Captions') return false;
    if (cat === 'Favorites') return favs.has(t.id);
    if (cat !== 'All' && !t.tags.includes(cat)) return false;
    return !q || t.name.toLowerCase().includes(q.toLowerCase());
  });
  return (
    <div className="tpl">
      <label className="search">
        <Search size={14} aria-hidden="true" />
        <input type="text" placeholder="Search text templates" value={q} onChange={(e) => setQ(e.target.value)} />
      </label>
      {!category && <div className="chips scroll-x" onWheel={(e) => { e.currentTarget.scrollLeft += e.deltaY; }}>
        {TEMPLATE_CATEGORIES.map((c) => (
          <button key={c} className={`chip ${cat === c ? 'on' : ''}`} onClick={() => setCat(c)}>{c}</button>
        ))}
      </div>}
      <div className="tpl-grid">
        {list.map((t) => (
          <div key={t.id} className={`tpl-item ${activeId === t.id ? 'on' : ''}`}
            onMouseEnter={() => setHover(t.id)} onMouseLeave={() => setHover(null)}>
            <button className="tpl-btn" onClick={() => onPick(t)} title={t.name}
              {...(draggable ? dragProps({ kind: 'text', patch: { ...t.patch, template: t.id } }) : {})}>
              <TextPreview style={t.caption ? { ...t.patch, caption: true } : t.patch} text={sampleText || t.previewText} hover={hover === t.id} width={128} height={72} />
            </button>
            <span className="tpl-name">{t.name}</span>
            <button className={`tpl-fav ${favs.has(t.id) ? 'on' : ''}`} onClick={() => toggleFav(t.id)}
              aria-label={favs.has(t.id) ? 'Remove from favorites' : 'Add to favorites'}>
              <Star size={12} fill={favs.has(t.id) ? 'currentColor' : 'none'} />
            </button>
          </div>
        ))}
        {!list.length && <p className="muted">No templates here yet.</p>}
      </div>
    </div>
  );
}

function StyleTiles({ items, value, onPick, styleFor, sample }) {
  const [hover, setHover] = useState(null);
  return (
    <div className="tpl-grid">
      {items.map((it) => (
        <div key={it.id} className={`tpl-item ${value === it.id ? 'on' : ''}`}
          onMouseEnter={() => setHover(it.id)} onMouseLeave={() => setHover(null)}>
          <button className="tpl-btn" onClick={() => onPick(it.id)} title={it.name}>
            <TextPreview style={styleFor(it.id)} text={sample} hover={hover === it.id} width={128} height={72} />
          </button>
          <span className="tpl-name">{it.name}</span>
        </div>
      ))}
    </div>
  );
}

function Toggle({ on, onClick, label, children }) {
  return <button className={`icon-toggle ${on ? 'on' : ''}`} aria-pressed={!!on} aria-label={label} title={label} onClick={onClick}>{children}</button>;
}

function Color({ label, value, onChange }) {
  return (
    <label className="field row">
      <span>{label}</span>
      <input type="color" value={value} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}

export default function TextInspector({ clip, dispatch, project = null }) {
  const [tab, setTab] = useState('Basic');
  const [applyAll, setApplyAll] = useState(true);
  const [animTab, setAnimTab] = useState('In');
  const st = useMemo(() => resolveStyle(clip), [clip]);
  const sharedToCaptions = clip.caption && applyAll;

  // Style changes go to every caption when "Apply to all main captions" is on.
  const set = (patch) => {
    const style = stylePatch(patch);
    const own = Object.fromEntries(Object.entries(patch).filter(([k]) => PER_CLIP.includes(k)));
    if (sharedToCaptions && Object.keys(style).length) dispatch({ type: 'styleCaptions', patch: style });
    else if (Object.keys(style).length) dispatch({ type: 'update', track: 'text', id: clip.id, patch: style });
    if (Object.keys(own).length) dispatch({ type: 'update', track: 'text', id: clip.id, patch: own });
  };
  const nested = (key) => (p) => set({ [key]: { ...st[key], ...p } });
  const S = (p) => <Slider dispatch={dispatch} {...p} />;
  // The colour roles the clip's style actually paints with, derived from the resolved style
  // (so every template — captions, titles, labels — gets exactly its own roles, no more).
  // They used to be scattered: the word box colour lived only in the Animation tab, the
  // bubble colour only in the Bubble tab, the second/glow colours only in the Effects tab —
  // a user recolouring a template (e.g. the Word Box violet box) could not find them. The
  // swatches below write the very same clip fields those tabs write, through set()/nested(),
  // so the one renderer (preview + export) honours them and caption sharing still applies.
  const colorRoles = [];
  if (st.highlight.mode !== 'none') {
    colorRoles.push(<Color key="hl-color" label="Word color" value={st.highlight.color} onChange={(color) => nested('highlight')({ color })} />);
    if (st.highlight.mode === 'box' || st.highlight.mode === 'marker') {
      colorRoles.push(<Color key="hl-bg" label="Box color" value={st.highlight.bg} onChange={(bgc) => nested('highlight')({ bg: bgc })} />);
    }
  }
  if (st.bg.on) colorRoles.push(<Color key="bg" label="Background color" value={st.bg.color} onChange={(color) => nested('bg')({ color })} />);
  if (st.bubble && st.bubble !== 'none') colorRoles.push(<Color key="bubble" label="Bubble color" value={st.bubbleColor} onChange={(bubbleColor) => set({ bubbleColor })} />);
  if (['gradient', 'fire', 'ice', 'shadow3d', 'retro', 'double'].includes(st.effect)) {
    colorRoles.push(<Color key="color2" label="Second color" value={st.color2} onChange={(color2) => set({ color2 })} />);
  }
  if (['neon', 'glow', 'fire', 'ice'].includes(st.effect)) {
    colorRoles.push(<Color key="glow" label="Glow color" value={st.glowColor} onChange={(glowColor) => set({ glowColor })} />);
  }
  // Stable style objects for the tiles (style + one changed key).
  const styleWith = (key, val) => ({ ...stylePatch(st), [key]: val, caption: clip.caption });
  const animStyle = (kind) => (id) => {    const base = { ...stylePatch(st), animIn: { id: 'none', dur: 0.5 }, animOut: { id: 'none', dur: 0.4 }, animLoop: { id: 'none', speed: 1 } };
    if (kind === 'In') base.animIn = { id, dur: 0.8 };
    if (kind === 'Out') base.animOut = { id, dur: 0.8 };
    if (kind === 'Loop') base.animLoop = { id, speed: 1 };
    return base;
  };

  return (
    <div className="text-inspector">
      <div className="seg-tabs" role="tablist">
        {TABS.map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>{t}</button>
        ))}
      </div>
      {clip.caption && (
        <label className="apply-all">
          <input type="checkbox" checked={applyAll} onChange={(e) => setApplyAll(e.target.checked)} />
          Apply to all main captions
        </label>
      )}

      {tab === 'Basic' && (
        <div className="fields">
          {project && <PinToTrack clip={clip} project={project} card
            set={(patch) => dispatch({ type: 'update', track: 'text', id: clip.id, patch })} />}
          <div className="insp-card">
            <div className="insp-card-title">Type</div>
          <label className="field">
            <span>Text</span>
            <textarea rows={3} dir="auto" value={clip.text} onChange={(e) => set({ text: e.target.value })} />
          </label>
          <div className="field">
            <span>Font</span>
            <FontPicker value={st.font} onChange={(font) => set({ font })} />
          </div>
          <div className="toggle-row">
            <Toggle label="Bold" on={st.bold} onClick={() => set({ bold: !st.bold })}><Bold size={15} /></Toggle>
            <Toggle label="Italic" on={st.italic} onClick={() => set({ italic: !st.italic })}><Italic size={15} /></Toggle>
            <Toggle label="Underline" on={st.underline} onClick={() => set({ underline: !st.underline })}><Underline size={15} /></Toggle>
            <Toggle label="Uppercase" on={st.uppercase} onClick={() => set({ uppercase: !st.uppercase })}><CaseUpper size={15} /></Toggle>
            <span className="tool-sep" />
            <Toggle label="Align left" on={st.align === 'left'} onClick={() => set({ align: 'left' })}><AlignLeft size={15} /></Toggle>
            <Toggle label="Align center" on={st.align === 'center'} onClick={() => set({ align: 'center' })}><AlignCenter size={15} /></Toggle>
            <Toggle label="Align right" on={st.align === 'right'} onClick={() => set({ align: 'right' })}><AlignRight size={15} /></Toggle>
          </div>
          {S({ label: 'Size', value: st.size, min: 12, max: 260, step: 1, onChange: (size) => set({ size }) })}
          {S({ label: 'Letter spacing', value: st.letterSpacing, min: -5, max: 40, step: 1, onChange: (letterSpacing) => set({ letterSpacing }) })}
          {S({ label: 'Line height', value: st.lineHeight, min: 0.8, max: 2.5, step: 0.05, onChange: (lineHeight) => set({ lineHeight }) })}
          {S({ label: 'Max width', value: st.maxWidth, min: 0.2, max: 1, fmt: (v) => `${Math.round(v * 100)}%`, onChange: (maxWidth) => set({ maxWidth }) })}
          </div>
          <div className="insp-card">
            <div className="insp-card-title">Fill</div>
            <Color label="Color" value={st.color} onChange={(color) => set({ color })} />
            {S({ label: 'Opacity', value: st.opacity ?? 1, fmt: (v) => `${Math.round(v * 100)}%`, onChange: (opacity) => set({ opacity }) })}
          </div>
          {colorRoles.length > 0 && (
            <div className="insp-card">
              <div className="insp-card-title">Style colors</div>
              {colorRoles}
            </div>
          )}
          <div className="insp-card">
            <div className="insp-card-title">Stroke</div>
          {S({ label: 'Width', value: st.stroke.width, min: 0, max: 30, step: 1, onChange: (width) => nested('stroke')({ width }) })}
          <Color label="Stroke color" value={st.stroke.color} onChange={(color) => nested('stroke')({ color })} />

          </div>
          <div className="insp-card">
            <div className="insp-card-head"><span className="insp-card-title">Shadow</span>
              <input type="checkbox" checked={st.shadow.on} onChange={(e) => nested('shadow')({ on: e.target.checked })} aria-label="Shadow" />
            </div>
          {st.shadow.on && (
            <>
              <Color label="Shadow color" value={st.shadow.color} onChange={(color) => nested('shadow')({ color })} />
              {S({ label: 'Opacity', value: st.shadow.opacity, onChange: (opacity) => nested('shadow')({ opacity }) })}
              {S({ label: 'Blur', value: st.shadow.blur, min: 0, max: 60, step: 1, onChange: (blur) => nested('shadow')({ blur }) })}
              {S({ label: 'Distance', value: st.shadow.y, min: -30, max: 30, step: 1, onChange: (y) => nested('shadow')({ y }) })}
            </>
          )}

          </div>
          <div className="insp-card">
            <div className="insp-card-head"><span className="insp-card-title">Background</span>
              <input type="checkbox" checked={st.bg.on} onChange={(e) => nested('bg')({ on: e.target.checked })} aria-label="Background" />
            </div>
          {st.bg.on && (
            <>
              <div className="chips">
                {['block', 'line'].map((m) => (
                  <button key={m} className={`chip ${st.bg.mode === m ? 'on' : ''}`} onClick={() => nested('bg')({ mode: m })}>
                    {m === 'block' ? 'Whole text' : 'Each line'}
                  </button>
                ))}
              </div>
              <Color label="Background color" value={st.bg.color} onChange={(color) => nested('bg')({ color })} />
              {S({ label: 'Opacity', value: st.bg.opacity, onChange: (opacity) => nested('bg')({ opacity }) })}
              {S({ label: 'Corner radius', value: st.bg.radius, min: 0, max: 60, step: 1, onChange: (radius) => nested('bg')({ radius }) })}
            </>
          )}

          </div>
          <div className="insp-card">
            <div className="insp-card-title">Position & timing</div>
            <p className="dim small">Or drag the text on the player.</p>
          {S({ label: 'Position X', value: st.x, fmt: (v) => `${Math.round(v * 100)}%`, onChange: (x) => set({ x }) })}
          {S({ label: 'Position Y', value: st.y, fmt: (v) => `${Math.round(v * 100)}%`, onChange: (y) => set({ y }) })}
          {S({ label: 'Rotation', value: st.rotation || 0, min: -180, max: 180, step: 1, fmt: (v) => `${Math.round(v)}°`, onChange: (rotation) => set({ rotation }) })}
          <NumBox layout="field" label="Start (s)" step={0.1} min={0} value={clip.start}
            onChange={(v) => set({ start: Math.max(0, v) })} />
          <NumBox layout="field" label="Duration (s)" step={0.1} min={0.1} value={clip.duration}
            onChange={(v) => set({ duration: Math.max(0.1, v) })} />
          </div>
        </div>
      )}

      {tab === 'Templates' && (
        <div className="pad-block">
          <TemplateGrid activeId={clip.template} captionOnly={clip.caption} sampleText={clip.caption ? undefined : clip.text}
            onPick={(t) => set({ ...stylePatch(t.patch), template: t.id })} />
        </div>
      )}

      {tab === 'Bubble' && (
        <div className="pad-block">
          <Color label="Bubble color" value={st.bubbleColor} onChange={(bubbleColor) => set({ bubbleColor })} />
          <StyleTiles items={BUBBLES} value={st.bubble} sample={clip.text} onPick={(bubble) => set({ bubble })}
            styleFor={(id) => styleWith('bubble', id)} />
        </div>
      )}

      {tab === 'Effects' && (
        <div className="pad-block">
          <div className="color-pair">
            <Color label="Second color" value={st.color2} onChange={(color2) => set({ color2 })} />
            <Color label="Glow color" value={st.glowColor} onChange={(glowColor) => set({ glowColor })} />
          </div>
          <StyleTiles items={TEXT_EFFECTS} value={st.effect} sample={clip.text} onPick={(effect) => set({ effect })}
            styleFor={(id) => styleWith('effect', id)} />
        </div>
      )}

      {tab === 'Animation' && (
        <div className="pad-block">
          <div className="sub-head">Word highlight</div>
          <div className="chips">
            {HIGHLIGHTS.map((h) => (
              <button key={h.id} className={`chip ${st.highlight.mode === h.id ? 'on' : ''}`}
                onClick={() => nested('highlight')({ mode: h.id })}>{h.name}</button>
            ))}
          </div>
          {st.highlight.mode !== 'none' && (
            <div className="color-pair">
              <Color label="Word color" value={st.highlight.color} onChange={(color) => nested('highlight')({ color })} />
              {(st.highlight.mode === 'box' || st.highlight.mode === 'marker') && (
                <Color label="Box color" value={st.highlight.bg} onChange={(bgc) => nested('highlight')({ bg: bgc })} />
              )}
            </div>
          )}
          <div className="seg-tabs small">
            {['In', 'Out', 'Loop'].map((t) => (
              <button key={t} className={animTab === t ? 'on' : ''} onClick={() => setAnimTab(t)}>{t}</button>
            ))}
          </div>
          {animTab === 'In' && (
            <>
              {S({ label: 'Duration', value: st.animIn.dur, min: 0.1, max: 3, step: 0.05, fmt: (v) => `${v.toFixed(1)}s`, onChange: (dur) => nested('animIn')({ dur }) })}
              <TextAnimBrowser kind="in" value={st.animIn.id} unit={st.animIn.unit} sampleText={clip.text}
                baseStyle={{ ...stylePatch(st), caption: clip.caption }}
                onPick={(p) => nested('animIn')({ id: p.anim, dur: p.dur })}
                onUnit={(unit) => nested('animIn')({ unit })}
                onClear={() => nested('animIn')({ id: 'none' })} />
            </>
          )}
          {animTab === 'Out' && (
            <>
              {S({ label: 'Duration', value: st.animOut.dur, min: 0.1, max: 3, step: 0.05, fmt: (v) => `${v.toFixed(1)}s`, onChange: (dur) => nested('animOut')({ dur }) })}
              <TextAnimBrowser kind="out" value={st.animOut.id} unit={st.animOut.unit} sampleText={clip.text}
                baseStyle={{ ...stylePatch(st), caption: clip.caption }}
                onPick={(p) => nested('animOut')({ id: p.anim, dur: p.dur })}
                onUnit={(unit) => nested('animOut')({ unit })}
                onClear={() => nested('animOut')({ id: 'none' })} />
            </>
          )}
          {animTab === 'Loop' && (
            <>
              {S({ label: 'Speed', value: st.animLoop.speed, min: 0.2, max: 3, step: 0.1, fmt: (v) => `${v.toFixed(1)}×`, onChange: (speed) => nested('animLoop')({ speed }) })}
              <StyleTiles items={ANIM_LOOP} value={st.animLoop.id} sample={clip.text} onPick={(id) => nested('animLoop')({ id })} styleFor={animStyle('Loop')} />
            </>
          )}
        </div>
      )}
    </div>
  );
}
