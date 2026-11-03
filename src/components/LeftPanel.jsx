import React, { useEffect, useRef, useState } from 'react';
import {
  Anvil, ArrowLeftRight, Blend, Captions as CaptionsIcon, Contrast, Film, FolderOpen, ImagePlus, Mic, Music, Plus, SlidersHorizontal,
  Loader2, Sparkles, Square, Trash2, Type, Upload, WandSparkles, X,
  Layers, ChevronDown, ChevronRight, ChevronUp, Sparkles as SparklesIcon, Award, FolderPlus, MonitorUp, History, UserRound, Users, LayoutTemplate,
} from 'lucide-react';
import AssetsTab from './AssetsPanel.jsx';
import PackMusic from './PackMusic.jsx';
import { useAssets } from '../useAssets.js';
import { mediaTreeCounts, mediaTreeFilter } from '../assetsLib.js';
import ForgePanel from './ForgePanel.jsx';
import GradePanel from './GradePanel.jsx';
import { LookThumb } from './FilterThumbs.jsx';
import { FILTER_CATS, filterName } from '../fx/filters.js';
import { loadPresets, savePresets, upsertPreset, removePreset, presetPatch } from '../fx/presets.js';
import { BUNDLED_LUTS } from '../fx/lut.js';
import { loadLutLibrary, saveLutLibrary, addLutEntry, removeLutEntry } from '../fx/lutlib.js';
import { formatTime, previewPath, proxyPrefOn, toFileUrl, uid } from '../store.js';
import { COLLECTIONS, PACKS, COLLECTION_ITEMS, loadFavorites, saveFavorites, toggleFavorite } from '../fx/collections.js';
import { parseSRT, regroupSegments } from '../subtitles.js';
import { DEFAULT_ADJUST, EFFECTS, EFFECT_GROUPS, FILTERS, TRANSITIONS } from '../effects.js';
import { dragProps } from '../dnd.js';
import Slider from './Slider.jsx';
import SearchBox from './SearchBox.jsx';
import AudioLibrary, { MUSIC_TAGS, SFX_TAGS, SOUNDZA_TAGS, TROLL_TAGS } from './AudioLibrary.jsx';
import StockLibrary, { CHIPS as STOCK_CHIPS } from './StockLibrary.jsx';
import { TabFrame } from './SideNav.jsx';
import { FxThumb, samplePictureUrl } from '../fx/previews.jsx';
import MediaFavorites from './MediaFavorites.jsx';
import { FavStar, favFile } from '../favorites.jsx';
import { TemplateGrid } from './TextInspector.jsx';
import { TEMPLATE_CATEGORIES, TEXT_TEMPLATES } from '../text/catalog.js';

export const TABS = [
  { id: 'media', icon: Film, name: 'Media' },
  { id: 'audio', icon: Music, name: 'Audio' },
  { id: 'assets', icon: LayoutTemplate, name: 'Assets' },
  { id: 'text', icon: Type, name: 'Text' },
  { id: 'effects', icon: WandSparkles, name: 'Effects' },
  { id: 'transitions', icon: Blend, name: 'Transitions' },
  { id: 'captions', icon: CaptionsIcon, name: 'Captions' },
  { id: 'filters', icon: Contrast, name: 'Filters' },
  { id: 'adjust', icon: SlidersHorizontal, name: 'Adjust' },
  { id: 'forge', icon: Anvil, name: 'Forge' },
];

// Default category of each tab (the side column remembers the last one per tab).
const SUB_DEFAULT = { media: 'yours', audio: 'music:Vlog', text: 'All' };

export default function LeftPanel(props) {
  const { tab, setTab } = props;
  // A stale tab id (e.g. from an older version's saved UI state) falls back to Media.
  const activeTab = TABS.some((t) => t.id === tab) ? tab : 'media';
  const [sub, setSubState] = useState(SUB_DEFAULT);
  const setSub = (id) => setSubState((s) => ({ ...s, [activeTab]: id }));
  const p = { ...props, sub: sub[activeTab], setSub };
  const dockRef = useRef(null);
  const [scroll, setScroll] = useState({ up: false, down: false });
  const measure = () => {
    const el = dockRef.current;
    if (el) setScroll({ up: el.scrollTop > 2, down: el.scrollTop + el.clientHeight < el.scrollHeight - 2 });
  };
  useEffect(() => {
    measure();
    const ro = new ResizeObserver(measure);
    if (dockRef.current) ro.observe(dockRef.current);
    return () => ro.disconnect();
  }, []);
  const scrollDock = (d) => dockRef.current.scrollBy({ top: d * 220, behavior: 'smooth' });
  return (
    <aside className="left">
      <div className="dock-wrap tabbar-wrap">
        {scroll.up && <button className="dock-arrow tabbar-arrow up" onClick={() => scrollDock(-1)} aria-label="More tabs above"><ChevronUp size={14} /></button>}
        <nav className="dock tabbar" aria-label="Library" ref={dockRef} onScroll={measure}>
          {TABS.map((t) => {
            const Icon = t.icon;
            return (
              <button key={t.id} className={`dock-btn tab-btn ${activeTab === t.id ? 'active' : ''}`} onClick={() => setTab(t.id)} aria-pressed={activeTab === t.id} title={t.name}>
                <Icon size={19} strokeWidth={1.8} aria-hidden="true" />
                <span>{t.name}</span>
              </button>
            );
          })}
        </nav>
        {scroll.down && <button className="dock-arrow tabbar-arrow down" onClick={() => scrollDock(1)} aria-label="More tabs below"><ChevronDown size={14} /></button>}
      </div>
      <div className="library">
        {activeTab === 'media' && <MediaTab {...p} />}
        {activeTab === 'audio' && <AudioTab {...p} />}
        {activeTab === 'assets' && <TabFrame><AssetsTab {...p} /></TabFrame>}
        {activeTab === 'text' && <TextTab {...p} />}
        {activeTab === 'effects' && <TabFrame><EffectsTab {...p} /></TabFrame>}
        {activeTab === 'transitions' && <TabFrame><TransitionsTab {...p} /></TabFrame>}
        {activeTab === 'captions' && <TabFrame><CaptionsTab {...p} /></TabFrame>}
        {activeTab === 'filters' && <TabFrame><FiltersTab {...p} /></TabFrame>}
        {activeTab === 'adjust' && <TabFrame><AdjustTab {...p} /></TabFrame>}
        {activeTab === 'forge' && <TabFrame><ForgePanel {...p} /></TabFrame>}
      </div>
    </aside>
  );
}

function Head({ title, hint, children }) {
  return (
    <div className="lib-head">
      <div>
        <h2>{title}</h2>
        {hint && <p>{hint}</p>}
      </div>
      {children}
    </div>
  );
}

// A media item. Click selects it and plays it in the player (then Delete removes it), double-click adds it to the
// timeline.
function MediaCard({ m, onAdd, onRemove, onOverlay, onPeek, peeking }) {
  const onKeyDown = (e) => {
    if (!onRemove || (e.key !== 'Delete' && e.key !== 'Backspace')) return;
    // Handled here so the timeline's Delete shortcut does not also remove the selected clip.
    e.preventDefault();
    e.stopPropagation();
    onRemove(m.id);
  };
  return (
    <div className={`asset ${peeking ? 'peeking' : ''}`} tabIndex={0} {...dragProps({ kind: 'media', id: m.id, mediaType: m.type })} onKeyDown={onKeyDown}
      onClick={(e) => { if (onPeek && !e.target.closest('button')) onPeek(m.id); }}
      onDoubleClick={() => onAdd(m.id)}
      title={`${m.name}\n${onPeek ? 'Click to watch it in the player · ' : ''}Drag to the timeline or double-click${onRemove ? '\nDelete: remove from the project' : ''}`}>
      <div className="asset-thumb">
        {m.type === 'video' && (m.poster ? (
          // W4b: the dedicated poster frame fills the card (object-fit: cover) — a portrait
          // video no longer renders as a thin strip in a wide black card.
          <img src={toFileUrl(m.poster)} alt="" draggable={false} />
        ) : m.thumb && m.thumbCount > 1 ? (
          // Sprite fallback (poster not generated yet): one frame, sized to COVER the
          // thumb box — the frame overflows on its long axis and the box crops it.
          <div className="asset-sprite" style={{
            aspectRatio: `${m.thumbW || 16} / ${m.thumbH || 9}`,
            [(m.thumbW || 16) / (m.thumbH || 9) < 4 / 3 ? 'width' : 'height']: '100%',
            backgroundImage: `url("${toFileUrl(m.thumb)}")`,
            backgroundSize: `${m.thumbCount * 100}% 100%`,
            backgroundPosition: `${(Math.min(1, m.thumbCount - 1) / (m.thumbCount - 1)) * 100}% 0`,
          }} />
        ) : <video src={toFileUrl(m.path) + '#t=0.5'} preload="metadata" muted />)}
        {m.type === 'image' && <img src={toFileUrl(m.path)} alt="" draggable={false} />}
        {m.type === 'audio' && (
          <div className="asset-audio">
            {m.wave ? <img src={toFileUrl(m.wave)} alt="" draggable={false} /> : <Music size={22} aria-hidden="true" />}
          </div>
        )}
        {m.type !== 'image' && <span className="asset-dur">{formatTime(m.duration).slice(0, 5)}</span>}
        {m.optimizing && <span className="asset-opt" title="Making a light preview copy so this video plays smoothly. Export uses the original.">Optimizing…</span>}
        {!m.optimizing && proxyPrefOn() && previewPath(m) !== (m.proxy || m.path) && (
          <span className="asset-opt proxy" title="Plays from a scaled proxy copy at the current playback quality. Export uses the original at full quality.">Proxy</span>
        )}
        <button className="asset-add" onClick={() => onAdd(m.id)} aria-label={`Add ${m.name} to the timeline`}><Plus size={14} /></button>
        {onOverlay && m.type !== 'audio' && (
          <button className="asset-add overlay" onClick={() => onOverlay(m.id)} aria-label={`Add ${m.name} as an overlay`}
            title="Add as overlay (picture in picture)"><Layers size={13} /></button>
        )}
        {m.path && <FavStar entry={favFile(m)} className="asset-star" />}
        {onRemove && (
          <button className="asset-remove" onClick={() => onRemove(m.id)} aria-label={`Remove ${m.name}`} title="Remove from the project (Delete)"><Trash2 size={12} /></button>
        )}
      </div>
      <div className="asset-name">{m.name}</div>
    </div>
  );
}

function MediaTab({ media, onImport, onAdd, onRemoveMedia, onAddAsOverlay, onStockAdd, onAddFile, onOpenSettings, stockKey, sub, setSub, onRecordScreen, onPeek, peekId }) {
  const visual = media; // videos, photos and audio
  // One source switcher replaces the old second rail: Yours / Favorites / Stock live in a
  // segmented control at the top of the panel; Stock adds a kind switch + category chips.
  const [kind, chip] = sub.split(':');
  const view = sub === 'favorites' ? 'favorites' : (kind === 'video' || kind === 'photo') ? 'stock' : 'yours';
  const [lastStock, setLastStock] = useState('video:Trending');
  const goStock = (id) => { setLastStock(id); setSub(id); };
  // The kind tree over this project's media (Hamza's reference): Media by kind, plus a
  // Generated branch — Speech (text-to-speech output) and Processed (detach / reverse /
  // stabilize renders). Counts are computed live from the registry (src/assetsLib.js);
  // picking a node filters the grid below it.
  const [treeSel, setTreeSel] = useState('all');
  const [treeOpen, setTreeOpen] = useState({ media: true, gen: true });
  const counts = mediaTreeCounts(visual);
  const shownMedia = mediaTreeFilter(visual, treeSel);
  const treeNode = (id, label, n) => (
    <button key={id} className={`mt-node ${treeSel === id ? 'on' : ''}`} aria-pressed={treeSel === id} onClick={() => setTreeSel(id)}>
      <span>{label}</span><span className="mt-count">{n}</span>
    </button>
  );
  return (
    <TabFrame>
      <Head title="Media" hint={view === 'yours' ? 'Videos, photos and audio in this project' : view === 'favorites' ? 'Your starred media, in every project' : 'Free stock from Pixabay'}>
        <div className="head-btns">
          <button className="btn btn-sm" onClick={onRecordScreen} title="Record your screen, a window, the computer sound, the microphone and the camera"><MonitorUp size={14} /> Record</button>
          <button className="btn btn-primary btn-sm" onClick={onImport}><Upload size={14} /> Import</button>
        </div>
      </Head>
      <div className="src-seg seg-tabs" role="tablist" aria-label="Media source">
        <button role="tab" aria-selected={view === 'yours'} className={view === 'yours' ? 'on' : ''} onClick={() => setSub('yours')}>This project</button>
        <button role="tab" aria-selected={view === 'favorites'} className={view === 'favorites' ? 'on' : ''} onClick={() => setSub('favorites')}>Favorites</button>
        <button role="tab" aria-selected={view === 'stock'} className={view === 'stock' ? 'on' : ''} onClick={() => goStock(lastStock)}>Stock</button>
      </div>
      {view === 'stock' && (
        <>
          <div className="src-kind seg-tabs small" role="tablist" aria-label="Stock kind">
            <button role="tab" aria-selected={kind === 'video'} className={kind === 'video' ? 'on' : ''} onClick={() => goStock('video:Trending')}>Videos</button>
            <button role="tab" aria-selected={kind === 'photo'} className={kind === 'photo' ? 'on' : ''} onClick={() => goStock('photo:Trending')}>Photos</button>
          </div>
          <div className="chips scroll-x src-chips" role="group" aria-label="Stock category">
            {STOCK_CHIPS[kind].map(([c]) => (
              <button key={c} className={`chip ${chip === c ? 'on' : ''}`} aria-pressed={chip === c} onClick={() => goStock(`${kind}:${c}`)}>{c}</button>
            ))}
          </div>
        </>
      )}
      {view === 'yours' ? (
        !visual.length ? (
          <button className="dropzone" onClick={onImport}>
            <span className="dz-icon"><ImagePlus size={26} /></span>
            <b>Import media</b>
            <span>Drag videos, photos and audio here from Explorer, or click to browse</span>
          </button>
        ) : (
          <>
            <div className="media-tree">
              <button className="mt-head" aria-expanded={treeOpen.media} onClick={() => setTreeOpen((o) => ({ ...o, media: !o.media }))}>
                {treeOpen.media ? <ChevronDown size={13} /> : <ChevronRight size={13} />}<span>Media</span>
              </button>
              {treeOpen.media && (
                <div className="mt-nodes">
                  {treeNode('all', 'All media', counts.all)}
                  {treeNode('video', 'Video', counts.video)}
                  {treeNode('audio', 'Audio', counts.audio)}
                  {treeNode('image', 'Images', counts.image)}
                </div>
              )}
              <button className="mt-head" aria-expanded={treeOpen.gen} onClick={() => setTreeOpen((o) => ({ ...o, gen: !o.gen }))}>
                {treeOpen.gen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}<span>Generated</span>
              </button>
              {treeOpen.gen && (
                <div className="mt-nodes">
                  {treeNode('speech', 'Speech', counts.speech)}
                  {treeNode('processed', 'Processed', counts.processed)}
                </div>
              )}
            </div>
            {shownMedia.length ? (
              <div className="asset-grid">
                {shownMedia.map((m) => <MediaCard key={m.id} m={m} onAdd={onAdd} onRemove={onRemoveMedia} onOverlay={onAddAsOverlay} onPeek={onPeek} peeking={peekId === m.id} />)}
              </div>
            ) : (
              <p className="empty-note">{treeSel === 'speech'
                ? 'No generated speech yet — voice-overs you make with Text to speech land here.'
                : treeSel === 'processed'
                  ? 'No processed renders yet — detached, reversed and stabilized renders land here.'
                  : 'Nothing of this kind in the project yet.'}</p>
            )}
          </>
        )
      ) : view === 'favorites' ? (
        <div className="pad-block">
          <MediaFavorites onStockAdd={onStockAdd} onAddFile={onAddFile} />
        </div>
      ) : (
        <div className="pad-block">
          <StockLibrary kind={kind} chip={chip} onStockAdd={onStockAdd} onOpenSettings={onOpenSettings} hasKey={stockKey} />
        </div>
      )}
    </TabFrame>
  );
}

function AudioTab(props) {
  const { sub, setSub } = props;
  // One audio surface: a source switcher (chips) on top, then the source's own category
  // chips — no second rail. Sub ids keep the exact values AudioLibrary routes on.
  const [group, subTag] = sub.includes(':') ? sub.split(':') : [sub, ''];
  const view = group === 'yours' && subTag === 'favorites' ? 'favorites' : group;
  const sources = [
    ['music', 'Music'], ['sfx', 'Sound FX'], ['soundza', 'Soundza'], ['trolls', 'Trolls'], ['yours', 'Your audio'],
    ['favorites', 'Favorites'], ['tts', 'Text to speech'], ['credits', 'Credits'],
  ];
  const firstOf = { music: 'music:Vlog', sfx: 'sfx:Transition', soundza: 'soundza:Whoosh', trolls: 'trolls:Trending', yours: 'yours', favorites: 'yours:favorites', tts: 'tts', credits: 'credits' };
  // The asset pack's music collections lead the Music chips when the pack is installed
  // (sub ids 'music:pack:<collection>', routed by AudioLibrary to PackMusic).
  const lib = useAssets();
  const packSubs = lib ? [...new Set(lib.items.filter((i) => i.group === 'Music').map((i) => i.sub))]
    .sort((a, b) => (a === 'Library' ? -1 : b === 'Library' ? 1 : a.localeCompare(b))) : [];
  // The pack's sound effects lead the Sound FX chips (sub ids 'sfx:pack:<collection>',
  // routed by AudioLibrary to the pack list) — pack audio lives in Audio, with the
  // music, not in Assets (Hamza, 2026-11-01).
  const packSfxSubs = lib ? [...new Set(lib.items.filter((i) => i.group === 'Sound FX' && i.sub).map((i) => i.sub))] : [];
  const catChips = view === 'music' ? [...packSubs.map((s) => [`music:pack:${s}`, `${s}`]), ...MUSIC_TAGS.map(([c]) => [`music:${c}`, c])]
    : view === 'sfx' ? [...packSfxSubs.map((s) => [`sfx:pack:${s}`, `${s}`]), ...SFX_TAGS.map(([c]) => [`sfx:${c}`, c])]
    : view === 'soundza' ? SOUNDZA_TAGS.map(([c]) => [`soundza:${c}`, c])
    : view === 'trolls' ? TROLL_TAGS.map(([c]) => [`trolls:${c}`, c])
    : null;
  return (
    <TabFrame>
      <Head title="Audio" hint={view === 'music' ? 'Free music for your videos' : view === 'sfx' ? 'Sound effects, ready to search' : view === 'soundza' ? 'Sound effects from Soundza' : view === 'trolls' ? 'Meme sounds from MyInstants' : view === 'tts' ? 'Turn text into a voice-over' : view === 'credits' ? 'Credit lines for sounds on the timeline' : view === 'favorites' ? 'Your starred sounds, in every project' : 'Imported audio and voice-overs'} />
      <div className="chips scroll-x src-chips" role="tablist" aria-label="Audio source">
        {sources.map(([id, label]) => (
          <button key={id} role="tab" aria-selected={view === id} className={`chip src-chip ${view === id ? 'on' : ''}`}
            onClick={() => setSub(firstOf[id])}>{label}</button>
        ))}
      </div>
      {catChips && (
        <div className="chips scroll-x src-chips" role="group" aria-label="Audio category">
          {catChips.map(([id, label]) => (
            <button key={id} className={`chip ${sub === id ? 'on' : ''}`} aria-pressed={sub === id} onClick={() => setSub(id)}>{label}</button>
          ))}
        </div>
      )}
      <div className="pad-block">
        <AudioLibrary {...props} section={sub} onAddMedia={props.onAdd} MediaCard={MediaCard} />
      </div>
    </TabFrame>
  );
}

function TextTab({ onAddText, sub, setSub }) {
  return (
    <TabFrame>
      <Head title={sub === 'All' ? 'Text templates' : sub} hint="Click or drag a style to the timeline">
        <button className="btn btn-primary btn-sm" onClick={() => onAddText({})}><Plus size={14} /> Add text</button>
      </Head>
      <div className="chips scroll-x src-chips" role="group" aria-label="Text template category">
        {TEMPLATE_CATEGORIES.map((c) => (
          <button key={c} className={`chip ${sub === c ? 'on' : ''}`} aria-pressed={sub === c} onClick={() => setSub(c)}>{c}</button>
        ))}
      </div>
      <div className="pad-block">
        <TemplateGrid draggable category={sub} onPick={(t) => onAddText({ ...t.patch, template: t.id })} />
      </div>
    </TabFrame>
  );
}

function NeedClip({ target }) {
  if (target) return null;
  return <p className="hint">Select a picture clip (main track or overlay) in the timeline, or drag an item onto a clip.</p>;
}

function EffectsTab({ target, updateTarget, clipSelected, onAddFreeEffect, onAddTextOver }) {
  const [query, setQuery] = useState('');
  const fx = clipSelected ? target?.clip.effects || [] : [];
  const toggle = (id) => updateTarget({ effects: fx.includes(id) ? fx.filter((x) => x !== id) : [...fx, id] });
  // With a clip selected the effect goes on that clip; otherwise it goes on the Effects track at
  // the playhead, as an object you can move and stretch over several clips.
  const pick = (id) => (clipSelected && target ? toggle(id) : onAddFreeEffect(id));
  const q = query.trim().toLowerCase();
  const groups = EFFECT_GROUPS.map((g) => [g, EFFECTS.filter((e) => e.group === g && (!q || e.name.toLowerCase().includes(q)))]).filter(([, list]) => list.length);
  return (
    <>
      <Head title="Effects" hint={clipSelected ? 'Click to add to (or remove from) the selected clip' : 'Click to add on the Effects track at the playhead, or drag onto a clip'} />
      <div className="panel-search"><SearchBox value={query} onChange={setQuery} placeholder="Search effects…" ariaLabel="Search effects" /></div>
      <p className="hint fx-mode">{clipSelected
        ? 'On the selected clip: the effect lasts the whole clip. Click an empty spot of the timeline to add free effects instead.'
        : 'On the Effects track: move it and stretch it over any part of the video. Select a clip first to put the effect on that clip.'}</p>
      {clipSelected && target && onAddTextOver && (
        <div className="pad-x">
          <button className="btn btn-sm" onClick={() => onAddTextOver(target.start, Math.max(0.1, target.end - target.start))}><Type size={14} /> Add text over this clip</button>
        </div>
      )}
      {!groups.length && <p className="hint pad-x">No effects match that search.</p>}
      {groups.map(([g, list]) => (
        <div key={g} className="fx-group">
          <span className="lib-group-name pad-x">{g}</span>
          <div className="tile-grid">
            {list.map((e) => (
              <button key={e.id} className={`tile ${fx.includes(e.id) ? 'on' : ''}`} onClick={() => pick(e.id)}
                aria-pressed={fx.includes(e.id)} {...dragProps({ kind: 'effect', id: e.id })}>
                <span className="tile-preview fx-live"><FxThumb kind="effect" id={e.id} /></span>
                <span className="tile-label">{e.name}</span>
              </button>
            ))}
          </div>
        </div>
      ))}
    </>
  );
}

function TransitionsTab({ target, updateTarget }) {
  const ok = target && target.index > 0;
  const cur = target?.clip.transition;
  const [dur, setDur] = useState(0.5);
  const [view, setView] = useState('catalog'); // 'catalog' (the 135 reference library) | 'classic'
  const [query, setQuery] = useState('');
  const [collection, setCollection] = useState('All'); // 'All' | 'fav' | a COLLECTIONS id
  const [favs, setFavs] = useState(() => loadFavorites());
  const toggleFav = (slug) => { const next = toggleFavorite(favs, slug); setFavs(next); saveFavorites(localStorage, next); };
  const engineById = Object.fromEntries(TRANSITIONS.map((t) => [t.id, t]));
  const applyEngine = (engineId, fxDuration) => {
    if (!ok) return;
    // Zoom/scale transitions feel best eased: new ones start on Smooth (the curve editor can change it).
    const ease = /zoom/i.test(engineId) ? { ease: 'smooth' } : {};
    updateTarget({ transition: { type: engineId, duration: fxDuration || dur, ...ease } });
  };
  const tile = (key, engineId, label, extra) => (
    <button key={key} className={`tile ${cur?.type === engineId ? 'on' : ''}`} {...dragProps({ kind: 'transition', id: engineId, duration: engineById[engineId]?.fx ? engineById[engineId].duration : dur })}
      onClick={() => applyEngine(engineId, engineById[engineId]?.fx ? engineById[engineId].duration : null)} title={extra?.title || label}>
      <span className="tile-preview fx-live"><FxThumb kind="transition" id={engineId} pair={extra?.pair || 0} duration={engineById[engineId]?.fx ? engineById[engineId].duration : 0.8} /></span>
      <span className="tile-label">{label}</span>
      {extra?.badge && <span className="tile-badge">{extra.badge}</span>}
      {extra?.slug && (
        <span className={`tile-star ${favs.has(extra.slug) ? 'on' : ''}`} role="button" aria-label={favs.has(extra.slug) ? 'Remove from favourites' : 'Save as favourite'}
          title={favs.has(extra.slug) ? 'Remove from favourites' : 'Save as favourite'}
          onClick={(e) => { e.stopPropagation(); toggleFav(extra.slug); }}
          onPointerDown={(e) => e.stopPropagation()}>★</span>
      )}
    </button>
  );
  const q = query.trim().toLowerCase();
  const inSelection = (e) => (collection === 'All' ? true
    : collection === 'fav' ? favs.has(e.slug)
    : collection.startsWith('pack:') ? e.pack === collection.slice(5)
    : e.collection === collection);
  const catalogList = COLLECTION_ITEMS.filter((e) => inSelection(e)
    && (!q || e.name.toLowerCase().includes(q) || e.behavior.toLowerCase().includes(q) || e.family.toLowerCase().includes(q) || e.engineName.toLowerCase().includes(q)));
  return (
    <>
      <Head title="Transitions" hint="Between the previous clip and the selected one" />
      {!ok && <p className="hint">Select a clip (not the first one), or drag a transition onto a clip.</p>}
      <div className="field pad">
        <span>Duration <b>{dur.toFixed(1)}s</b></span>
        <input type="range" min="0.2" max="2" step="0.1" value={dur} onChange={(e) => {
          const d = Number(e.target.value);
          setDur(d);
          if (ok && cur) updateTarget({ transition: { ...cur, duration: d } });
        }} />
      </div>
      <div className="seg-tabs tr-view" role="group" aria-label="Transition library">
        <button className={view === 'catalog' ? 'on' : ''} aria-pressed={view === 'catalog'} onClick={() => setView('catalog')}>Catalog · 135</button>
        <button className={view === 'classic' ? 'on' : ''} aria-pressed={view === 'classic'} onClick={() => setView('classic')}>Built-in</button>
      </div>
      {view === 'classic' && (
        <div className="tile-grid">
          <button className={`tile ${ok && !cur ? 'on' : ''}`} onClick={() => ok && updateTarget({ transition: null })}>
            <span className="tile-preview"><X size={20} /></span>
            <span className="tile-label">None</span>
          </button>
          {TRANSITIONS.map((t, i) => tile(t.id, t.id, t.name, { pair: i % 6 }))}
        </div>
      )}
      {view === 'catalog' && (
        <>
          <div className="field pad">
            <SearchBox placeholder="Search 135 transitions…" value={query} onChange={setQuery} ariaLabel="Search transitions" />
          </div>
          <div className="chips pad-x" role="group" aria-label="Transition collection">
            <button className={`chip ${collection === 'All' ? 'on' : ''}`} aria-pressed={collection === 'All'} onClick={() => setCollection('All')}>All · {COLLECTION_ITEMS.length}</button>
            <button className={`chip ${collection === 'fav' ? 'on' : ''}`} aria-pressed={collection === 'fav'} onClick={() => setCollection('fav')}>★ Saved · {favs.size}</button>
            {COLLECTIONS.map((c) => (
              <button key={c.id} className={`chip ${collection === c.id ? 'on' : ''}`} aria-pressed={collection === c.id} onClick={() => setCollection(c.id)}>{c.name}</button>
            ))}
            {PACKS.map((p) => (
              <button key={p.id} className={`chip ${collection === `pack:${p.id}` ? 'on' : ''}`} aria-pressed={collection === `pack:${p.id}`} onClick={() => setCollection(`pack:${p.id}`)}>{p.name} Pack</button>
            ))}
          </div>
          <p className="hint pad-x">Tiles run the real engine transition on real photos. “Adapted” names run the closest engine transition — shown on the tile. Pack tiles are all true engine transitions. ★ saves a favourite.</p>
          {!catalogList.length && <p className="hint pad-x">{collection === 'fav' && !query ? 'No favourites yet — tap ★ on a tile to save one here.' : 'No transitions match that search.'}</p>}
          {COLLECTIONS.filter((c) => collection === 'All' || collection === 'fav' || c.id === collection).map((c, ci) => {
            const list = catalogList.filter((e) => e.collection === c.id && (collection !== 'All' || !e.pack));
            if (!list.length) return null;
            return (
              <div key={c.id} className="fx-group">
                <span className="lib-group-name pad-x">{c.name} · {list.length}</span>
                <div className="tile-grid">
                  {list.map((e, i) => tile(e.slug, e.engineId, e.name, {
                    slug: e.slug,
                    pair: (ci + i) % 6,
                    badge: e.status === 'adapted' ? 'Adapted' : null,
                    title: `${e.behavior}\nBest for: ${e.bestFor || '—'}\nUses: ${e.engineName}${e.status === 'adapted' ? ' (adapted)' : ''}`,
                  }))}
                </div>
              </div>
            );
          })}
          {PACKS.filter((p) => collection === 'All' || collection === `pack:${p.id}`).map((p, pi) => {
            const list = catalogList.filter((e) => e.pack === p.id);
            if (!list.length) return null;
            return (
              <div key={p.id} className="fx-group">
                <span className="lib-group-name pad-x">{p.name} Pack · {list.length}</span>
                <div className="tile-grid">
                  {list.map((e, i) => tile(e.slug, e.engineId, e.name, {
                    slug: e.slug,
                    pair: (pi + i + 2) % 6,
                    badge: null,
                    title: `${e.behavior}\nBest for: ${e.bestFor || '—'}\nUses: ${e.engineName}`,
                  }))}
                </div>
              </div>
            );
          })}
        </>
      )}
    </>
  );
}

const CAPTION_LANGS = [
  { id: 'auto', name: 'Auto-detect' }, { id: 'ar', name: 'Arabic (incl. Darija)' }, { id: 'fr', name: 'French' },
  { id: 'en', name: 'English' }, { id: 'es', name: 'Spanish' }, { id: 'de', name: 'German' }, { id: 'tr', name: 'Turkish' },
];

// Speech models, each downloaded on first use: base is quick; large-v3-turbo is much better at Arabic; darija is a
// Whisper medium trained on Moroccan Darija (Arabic only). Only the ones the app can download are listed.
const CAPTION_MODELS = [
  { id: 'base', name: 'Fast (base)', size: '150 MB' },
  { id: 'turbo', name: 'Accurate: Arabic (large-v3-turbo)', size: '575 MB' },
  { id: 'darija', name: 'Moroccan Darija (whisper-medium-darija)', size: '540 MB', arabicOnly: true },
];

function CaptionsTab({ onAddText, captions, project, dispatch }) {
  const [lang, setLang] = useState('auto');
  const [model, setModel] = useState('base');
  // Cloud engines (item O): the user's own provider key, saved through the same encrypted
  // service-key store as the stock/voice keys; never shown again after saving.
  const [engine, setEngine] = useState('local');
  const [provider, setProvider] = useState('groq');
  const [cloudModel, setCloudModel] = useState('');
  const [keyField, setKeyField] = useState('');
  const [savedKeys, setSavedKeys] = useState({});
  const [keyNote, setKeyNote] = useState('');
  const [testNote, setTestNote] = useState(null);
  const [testing, setTesting] = useState(false);
  useEffect(() => {
    let live = true;
    window.api.settingsGet().then((st) => { if (live) setSavedKeys(st.serviceKeys || {}); });
    return () => { live = false; };
  }, []);
  const CLOUD_PROVIDERS = [
    { id: 'groq', name: 'Groq', def: 'whisper-large-v3-turbo' },
    { id: 'openai', name: 'OpenAI', def: 'whisper-1' },
    { id: 'deepgram', name: 'Deepgram', def: 'nova-3' },
    { id: 'elevenlabs', name: 'ElevenLabs', def: 'scribe_v1' },
  ];
  const cloudMeta = CLOUD_PROVIDERS.find((p) => p.id === provider);
  const keyService = `cap-${provider}`;
  const savedHint = savedKeys[keyService];
  const saveKey = async () => {
    if (!keyField.trim()) return;
    const res = await window.api.settingsSaveServiceKey(keyService, keyField.trim());
    if (!res.ok) { setKeyNote(res.error || 'The key could not be saved.'); return; }
    setSavedKeys(res.settings.serviceKeys || {});
    setKeyField('');
    setTestNote(null);
    setKeyNote('Key saved. For your security it is never shown again.');
  };
  const testKey = async () => {
    setTesting(true);
    setTestNote(null);
    const res = await window.api.testCaptionsCloud(provider, keyField.trim() || undefined);
    setTesting(false);
    setTestNote(res.ok ? { ok: true, text: `${cloudMeta.name} accepted the key.` } : { ok: false, text: res.error || 'Test failed.' });
  };
  const models = CAPTION_MODELS.filter((m) => !captions.available || captions.available.includes(m.id));
  const modelInfo = CAPTION_MODELS.find((m) => m.id === model);
  const needsDownload = !captions.models?.[model];
  const [source, setSource] = useState('all');
  const [tplId, setTplId] = useState('cap-classic');
  const tpl = TEXT_TEMPLATES.find((t) => t.id === tplId);
  const pickStyle = (t) => {
    setTplId(t.id);
    if (project.textClips.some((c) => c.caption)) dispatch({ type: 'styleCaptions', patch: { ...t.patch, template: t.id } });
  };
  const [len, setLen] = useState(42);
  // Words per caption line (0 = no limit, the historical behaviour). Applies to auto
  // captions when generating and to .srt imports below alike.
  const [wpl, setWpl] = useState(0);
  const count = project.textClips.filter((c) => c.caption).length;
  // Imported .srt subtitles: their own clips (source: 'srt'), styled separately from auto captions.
  const srtCount = project.textClips.filter((c) => c.source === 'srt').length;
  const srtFileRef = useRef(null);
  const [srtTplId, setSrtTplId] = useState('cap-classic');
  const [srtNote, setSrtNote] = useState('');
  const onSrtFile = async (e) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    const cues = regroupSegments(parseSRT(await f.text()), wpl);
    if (!cues.length) { setSrtNote('No subtitle cues were found in that file.'); return; }
    const t = TEXT_TEMPLATES.find((x) => x.id === srtTplId) || tpl;
    dispatch({ type: 'importSrtCaptions', style: { ...t.patch, template: t.id }, segments: cues.map((c) => ({ ...c, id: uid() })) });
    setSrtNote(`Imported ${cues.length} subtitle${cues.length > 1 ? 's' : ''} from ${f.name}.`);
  };
  const pickSrtStyle = (t) => {
    setSrtTplId(t.id);
    dispatch({ type: 'styleSrtCaptions', patch: { ...t.patch, template: t.id } });
  };
  const busy = !!captions.busy;
  return (
    <>
      <Head title="Captions" hint="Local Whisper, or a cloud engine with your own key" />
      <div className="card">
        <div className="card-row">
          <span className="card-icon accent"><Sparkles size={18} /></span>
          <div>
            <b>Auto captions</b>
            <p>{engine === 'local'
              ? <>Whisper runs on your computer.{needsDownload && ` First use of this model downloads ~${modelInfo.size}.`}</>
              : <>Transcribed by {cloudMeta.name} with your API key — usually much faster.</>}</p>
          </div>
        </div>
        <div className="proj-seg cap-engines" role="radiogroup" aria-label="Caption engine">
          <button type="button" role="radio" aria-checked={engine === 'local'} className={engine === 'local' ? 'on' : ''}
            disabled={busy} onClick={() => setEngine('local')}>Local — free, on this PC</button>
          <button type="button" role="radio" aria-checked={engine === 'cloud'} className={engine === 'cloud' ? 'on' : ''}
            disabled={busy} onClick={() => setEngine('cloud')}>Cloud — your API key</button>
        </div>
        <label className="field">
          <span>Language</span>
          <select value={modelInfo.arabicOnly && engine === 'local' ? 'ar' : lang} disabled={busy || (engine === 'local' && modelInfo.arabicOnly)} onChange={(e) => setLang(e.target.value)}>
            {CAPTION_LANGS.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
        </label>
        {engine === 'local' ? (
          <label className="field">
            <span>Model</span>
            <select value={model} disabled={busy} onChange={(e) => setModel(e.target.value)}>
              {models.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
          </label>
        ) : (
          <>
            <label className="field">
              <span>Provider</span>
              <select value={provider} disabled={busy} onChange={(e) => { setProvider(e.target.value); setTestNote(null); setKeyNote(''); }}>
                {CLOUD_PROVIDERS.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </label>
            <label className="field">
              <span>Model</span>
              <input type="text" value={cloudModel} disabled={busy} placeholder={cloudMeta.def} aria-label={`${cloudMeta.name} model`}
                onChange={(e) => setCloudModel(e.target.value)} />
            </label>
            <label className="field">
              <span>{cloudMeta.name} API key {savedHint && <b className="cap-saved">saved ({savedHint})</b>}</span>
              <input type="password" value={keyField} disabled={busy} autoComplete="off"
                placeholder={savedHint ? 'Paste a new key to replace the saved one' : `Paste your ${cloudMeta.name} key`}
                aria-label={`${cloudMeta.name} API key`} onChange={(e) => setKeyField(e.target.value)} />
            </label>
            <div className="cap-key-actions">
              <button className="btn btn-sm" disabled={busy || !keyField.trim()} onClick={saveKey}>Save key</button>
              <button className="btn btn-sm" disabled={busy || testing || (!savedHint && !keyField.trim())} onClick={testKey}>
                {testing ? 'Testing…' : 'Test connection'}
              </button>
              {savedHint && !keyField && (
                <button className="btn btn-sm btn-ghost" disabled={busy} onClick={async () => {
                  const st = await window.api.settingsClearServiceKey(keyService);
                  setSavedKeys(st.serviceKeys || {}); setKeyNote('Key removed.'); setTestNote(null);
                }}>Remove key</button>
              )}
            </div>
            {keyNote && <p className="muted small">{keyNote}</p>}
            {testNote && <p className={`small ${testNote.ok ? 'cap-test-ok' : 'error-text'}`}>{testNote.text}</p>}
            <p className="muted small">Cloud engines send the clip's audio to {cloudMeta.name} — only when you generate. The local engine stays free and fully offline.</p>
          </>
        )}
        {engine === 'local' && lang === 'ar' && model === 'base' && (
          <p className="muted small">For Arabic, the Accurate model gets far more words right{models.some((m) => m.id === 'darija') ? ', and the Darija one is made for Moroccan Darija' : ''} (both take longer).</p>
        )}
        <label className="field">
          <span>Transcribe</span>
          <select value={source} disabled={busy} onChange={(e) => setSource(e.target.value)}>
            <option value="all">Video + Audio track</option>
            <option value="video">Video clips only</option>
            <option value="audio">Audio track only</option>
          </select>
        </label>
        <label className="field">
          <span>Max line length <b>{len}</b></span>
          <input type="range" min="16" max="80" step="2" value={len} disabled={busy} onChange={(e) => setLen(Number(e.target.value))} />
        </label>
        <label className="field">
          <span>Words per line <b>{wpl ? wpl : 'No limit'}</b></span>
          <input type="range" min="0" max="12" step="1" value={wpl} disabled={busy} onChange={(e) => setWpl(Number(e.target.value))} aria-label="Words per caption line" />
        </label>
        <button className="btn btn-primary btn-block" disabled={busy || !(project.videoClips.length || project.audioClips.length) || (engine === 'cloud' && !savedHint)}
          onClick={() => (engine === 'cloud'
            ? captions.run({ engine: 'cloud', provider, model: cloudModel.trim() || undefined, language: lang, maxLen: len, wordsPerLine: wpl, source, style: { ...tpl.patch, template: tpl.id } })
            : captions.run({ language: modelInfo.arabicOnly ? 'ar' : lang, maxLen: len, wordsPerLine: wpl, source, model, style: { ...tpl.patch, template: tpl.id } }))}>
          {busy ? 'Working…' : count ? 'Regenerate' : 'Generate captions'}
        </button>
        {engine === 'cloud' && !savedHint && <p className="muted small">Save your {cloudMeta.name} API key to generate with the cloud engine.</p>}
        {busy && (
          <div className="progress-block" aria-live="polite">
            <span>{captions.stage} · {Math.round((captions.progress || 0) * 100)}%</span>
            <div className="progress"><div style={{ width: `${(captions.progress || 0) * 100}%` }} /></div>
          </div>
        )}
        {captions.error && <CaptionError error={captions.error} />}
        {!(project.videoClips.length || project.audioClips.length) && <p className="muted">Add a video or an audio clip to the timeline first.</p>}
      </div>
      <div className="card">
        <b>Caption style</b>
        <p className="muted">{count ? `Applies to all ${count} captions.` : 'Used when you generate captions.'}</p>
        <TemplateGrid captionOnly activeId={tplId} onPick={pickStyle} />
        {count > 0 && (
          <button className="btn btn-ghost btn-sm" onClick={() => dispatch({ type: 'setCaptions', segments: [] })}>
            <Trash2 size={14} /> Remove auto captions
          </button>
        )}
      </div>
      <div className="card">
        <b>Subtitles (.srt)</b>
        <p className="muted">{srtCount
          ? `${srtCount} imported subtitle${srtCount > 1 ? 's' : ''} on the timeline, at their exact file timings. Select one on the timeline to edit it; the inspector's “Apply to all main captions” covers bulk edits.`
          : 'Import a SubRip file: every cue becomes an editable caption clip at its exact time in the file.'}</p>
        <input ref={srtFileRef} type="file" accept=".srt" hidden onChange={onSrtFile} aria-label="Choose an .srt subtitle file" />
        <button className="btn btn-sm" onClick={() => srtFileRef.current?.click()}><Upload size={14} /> Import .srt file…</button>
        <p className="muted small">The Words per line setting above applies to imported cues too: longer cues are split into consecutive lines inside their own time span.</p>
        {srtNote && <p className="muted small">{srtNote}</p>}
        {srtCount > 0 && (
          <>
            <p className="muted small">Template for all imported subtitles:</p>
            <TemplateGrid captionOnly activeId={srtTplId} onPick={pickSrtStyle} />
            <button className="btn btn-ghost btn-sm" onClick={() => dispatch({ type: 'removeSrtCaptions' })}>
              <Trash2 size={14} /> Remove imported subtitles
            </button>
          </>
        )}
      </div>
      <div className="card">
        <b>Manual caption</b>
        <p className="muted">A caption line at the bottom of the frame, at the playhead.</p>
        <button className="btn btn-sm" onClick={() => onAddText({ size: 44, y: 0.9, box: true, boxColor: '#000000', outline: false, font: 'segoe', anim: 'none' })}>
          <Plus size={14} /> Add caption
        </button>
      </div>
    </>
  );
}

// Error box: short reason plus a button to open the full whisper log.
function CaptionError({ error }) {
  const [msg, logPath] = error.split('\n\nFull log: ');
  return (
    <div className="error-box" role="alert">
      <b>Couldn't generate captions</b>
      <p>{msg.replace('Auto captions failed.\n', '')}</p>
      {logPath && (
        <button className="btn btn-ghost btn-sm" onClick={() => window.api.showInFolder(logPath.trim())}>
          <FolderOpen size={14} /> Open log
        </button>
      )}
    </div>
  );
}

// With several clips selected in the timeline, the Filters and Adjust tabs change all of them.
function ManyNote({ count }) {
  if (count < 2) return null;
  return <p className="hint many">Applies to the {count} selected clips.</p>;
}

function FiltersTab({ target, updateTarget, media, selectedCount = 0, dispatch, project }) {
  const current = target?.clip.filter || 'none';
  const k = target?.clip.filterIntensity ?? 100;
  const [presets, setPresets] = useState(() => loadPresets(localStorage));
  const [presetName, setPresetName] = useState('');
  const [compareId, setCompareId] = useState(null); // hold a tile: show the unfiltered picture
  const storePresets = (list) => { setPresets(list); savePresets(localStorage, list); };
  const canSave = !!target && current !== 'none' && !current.startsWith('lut:');
  return (
    <>
      <Head title="Filters" hint="Click or drag onto a clip · hold a tile to compare before/after" />
      <NeedClip target={target} />
      <ManyNote count={selectedCount} />
      {target && current !== 'none' && (
        <div className="pad-block filter-k">
          <Slider dispatch={dispatch} label={`${filterName(current)} intensity`} value={k} min={0} max={100} step={1}
            fmt={(v) => `${Math.round(v)}`} onChange={(v) => updateTarget({ filterIntensity: v })} />
        </div>
      )}
      <div className="look-cat">
        <div className="look-cat-title">My presets</div>
        {target && (
          <div className="preset-save">
            <input type="text" value={presetName} placeholder="Preset name…" aria-label="Preset name" onChange={(e) => setPresetName(e.target.value)} />
            <button className="btn btn-sm" disabled={!canSave || !presetName.trim()}
              title={current.startsWith('lut:') ? 'LUT looks live in the LUT library, not in presets' : 'Save the selected clip’s filter, intensity and adjustments as a preset'}
              onClick={() => { storePresets(upsertPreset(presets, target.clip, presetName)); setPresetName(''); }}>Save current look</button>
          </div>
        )}
        {!!presets.length && (
          <div className="tile-grid">
            {presets.map((pr) => (
              <button key={pr.name} className={`tile ${target && current === pr.filter ? 'on' : ''}`} title={`${pr.name} — ${filterName(pr.filter)} at ${Math.round(pr.filterIntensity)}%`}
                onClick={() => target && updateTarget(presetPatch(pr))}>
                <span className="tile-preview filter-thumb"><LookThumb filterId={pr.filter === 'none' ? null : pr.filter} /></span>
                <span className="tile-label">{pr.name}</span>
                <span className="tile-star" role="button" aria-label={`Delete preset ${pr.name}`} title="Delete preset"
                  onClick={(e) => { e.stopPropagation(); storePresets(removePreset(presets, pr.name)); }}
                  onPointerDown={(e) => e.stopPropagation()}>×</span>
              </button>
            ))}
          </div>
        )}
        {!presets.length && <p className="hint">No saved presets yet. Pick a filter, set its intensity, name it and save — it applies with one click afterwards.</p>}
      </div>
      {FILTER_CATS.map((cat) => (
        <div key={cat} className="look-cat">
          <div className="look-cat-title">{cat}</div>
          <div className="tile-grid">
            {FILTERS.filter((f) => f.cat === cat).map((f) => (
              <button key={f.id} className={`tile ${current === f.id && target ? 'on' : ''}`}
                onClick={() => target && updateTarget({ filter: f.id })} {...dragProps({ kind: 'filter', id: f.id })}
                onPointerDown={() => setCompareId(f.id)} onPointerUp={() => setCompareId(null)} onPointerLeave={() => setCompareId(null)}>
                <span className="tile-preview filter-thumb"><LookThumb filterId={f.id === 'none' ? null : f.id} plain={compareId === f.id} /></span>
                <span className="tile-label">{f.name}</span>
              </button>
            ))}
          </div>
        </div>
      ))}
      <LutBrowser target={target} updateTarget={updateTarget} dispatch={dispatch} project={project} current={current} />
    </>
  );
}

// LUT browser: bundled LUTs by category (applied as the clip's filter, like the other looks)
// and the user's imported .cube library (applied through the grade's LUT slot, the mechanism
// that supports file paths). Imported entries persist in localStorage; invalid files surface
// the parser's error instead of failing silently.
function LutBrowser({ target, updateTarget, dispatch, project, current }) {
  const [lib, setLib] = useState(() => loadLutLibrary(localStorage));
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const storeLib = (list) => { setLib(list); saveLutLibrary(localStorage, list); };
  const clipLutPath = target?.clip.grade?.lut?.ref?.path || null;
  const applyImported = (entry) => {
    if (!target) return;
    const g = target.clip.grade || {};
    updateTarget({ grade: { ...g, lut: { ref: { path: entry.path }, name: entry.name, intensity: g.lut?.intensity ?? 100 } } });
  };
  const applyImportedToAll = (entry) => {
    if (!project) return;
    const lut = { ref: { path: entry.path }, name: entry.name, intensity: 100 };
    dispatch({ type: 'updateMany', updates: [
      ...project.videoClips.filter((c) => !c.gap).map((c) => ({ track: 'video', id: c.id, patch: { grade: { ...(c.grade || {}), lut } } })),
      ...(project.overlayClips || []).map((c) => ({ track: 'overlay', id: c.id, patch: { grade: { ...(c.grade || {}), lut } } })),
    ] });
  };
  const importCube = async () => {
    setErr(''); setBusy(true);
    try {
      const res = await window.api.importLut();
      if (!res || res.canceled) return;
      if (res.error) { setErr(res.error); return; }
      if (res.path) storeLib(addLutEntry(lib, { name: res.name, path: res.path }));
    } catch (e) { setErr(e.message || 'Import failed.'); }
    finally { setBusy(false); }
  };
  const cats = [...new Set(BUNDLED_LUTS.map((l) => l.cat))];
  return (
    <div className="look-cat">
      <div className="look-cat-title">LUT browser</div>
      {cats.map((cat) => (
        <div key={cat}>
          <div className="look-cat-title sub">{cat} <span className="dim">bundled · slay (CC BY 4.0)</span></div>
          <div className="tile-grid">
            {BUNDLED_LUTS.filter((l) => l.cat === cat).map((l) => {
              // A bundled LUT tile is a filter like the others: picking it replaces the current filter; None removes it.
              const id = `lut:${l.file}`;
              return (
                <button key={l.file} className={`tile ${target && current === id ? 'on' : ''}`} title={`LUT ${l.name}`}
                  onClick={() => target && updateTarget({ filter: id })}>
                  <span className="tile-preview filter-thumb"><LookThumb lutRef={l.ref} /></span>
                  <span className="tile-label">{l.name}</span>
                </button>
              );
            })}
          </div>
        </div>
      ))}
      <div className="look-cat-title sub">My LUTs <span className="dim">.cube, 3D or 1D</span></div>
      <div className="preset-save">
        <button className="btn btn-sm" disabled={busy} onClick={importCube}>{busy ? 'Importing…' : 'Import .cube'}</button>
        {target && clipLutPath && <span className="dim">Intensity: Adjust &gt; Basic &gt; LUT</span>}
      </div>
      {err && <p className="hint pad-x" role="alert">⚠ {err}</p>}
      {!!lib.length && (
        <div className="tile-grid">
          {lib.map((e) => (
            <button key={e.path} className={`tile ${clipLutPath === e.path ? 'on' : ''}`} title={`${e.name} — ${e.path}`}
              onClick={() => applyImported(e)}>
              <span className="tile-preview filter-thumb"><LookThumb lutRef={{ path: e.path }} /></span>
              <span className="tile-label">{e.name}</span>
              <span className="tile-star" role="button" aria-label={`Remove ${e.name} from the library`} title="Remove from library (keeps the file)"
                onClick={(ev) => { ev.stopPropagation(); storeLib(removeLutEntry(lib, e.path)); }}
                onPointerDown={(ev) => ev.stopPropagation()}>×</span>
              <span className="tile-badge clickable" role="button" title="Apply this LUT to every video clip"
                onClick={(ev) => { ev.stopPropagation(); applyImportedToAll(e); }}
                onPointerDown={(ev) => ev.stopPropagation()}>All</span>
            </button>
          ))}
        </div>
      )}
      {!lib.length && <p className="hint">Import a .cube file to keep it here. Invalid files are rejected with the reason shown.</p>}
      <p className="hint">One filter at a time: a new one replaces the current one, None removes it. Imported LUTs apply through the grade LUT slot, so their intensity lives in Adjust.</p>
    </div>
  );
}

function AdjustTab({ media: library = [], target, updateTarget, dispatch, selectedCount = 0, onApplyLookToAll }) {
  const media = target && library.find((m) => m.id === target.clip.mediaId);
  return (
    <>
      <Head title="Adjust" hint="Color and light of the clip" />
      <NeedClip target={target} />
      <ManyNote count={selectedCount} />
      {target && (
        <div className="pad-block">
          <GradePanel grade={target.clip.grade} adjust={target.clip.adjust} dispatch={dispatch}
            autoFrom={media ? { media, clip: target.clip } : undefined}
            onGrade={(grade) => updateTarget({ grade })} onAdjust={(adjust) => updateTarget({ adjust })}
            onApplyAll={onApplyLookToAll ? () => onApplyLookToAll(target.clip) : undefined} />
        </div>
      )}
    </>
  );
}
