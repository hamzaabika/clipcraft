import React, { useEffect, useRef, useState } from 'react';
import { Loader2, Pause, Play, Plus } from 'lucide-react';
import SearchBox from './SearchBox.jsx';
import { formatTime, toFileUrl } from '../store.js';
import { assetAddWhere } from '../assetsLib.js';
import { useAssets } from '../useAssets.js';

// The asset pack's AUDIO, inside the Audio tab (Hamza's IA: pack audio goes with the
// music, NOT to Assets) — the Music place serves the pack's Music collections, and the
// Sound FX place its Sound FX collections (Hamza, 2026-11-01: sound effects belong in
// Music, with the music). One collection per manifest sub ("Library" songs and
// instrumentals, "آهات" vocal tracks; the SFX subs from the pack folders). Rows preview
// from disk and add at the playhead through App's addFile, like every other file add.
export default function PackMusic({ collection, onAddFile, group = 'Music' }) {
  const lib = useAssets();
  const [q, setQ] = useState('');
  const [adding, setAdding] = useState('');
  const [err, setErr] = useState('');
  const [playing, setPlaying] = useState('');
  const audio = useRef(null);
  useEffect(() => {
    const a = new Audio();
    a.onended = () => setPlaying('');
    audio.current = a;
    return () => a.pause();
  }, []);
  useEffect(() => { audio.current?.pause(); setPlaying(''); setQ(''); }, [collection]);

  const items = (lib?.items || []).filter((i) => i.group === group && i.sub === collection);
  const query = q.trim().toLowerCase();
  const shown = items.filter((i) => !query || i.name.toLowerCase().includes(query));

  const toggle = (item) => {
    const a = audio.current;
    if (!a || item.missing) return;
    if (playing === item.path) { a.pause(); setPlaying(''); return; }
    a.src = toFileUrl(item.path);
    a.play().catch(() => {});
    setPlaying(item.path);
  };
  const add = async (item) => {
    if (item.missing || adding) return;
    setAdding(item.path);
    setErr('');
    const r = await onAddFile?.(item.path, assetAddWhere(item));
    setAdding('');
    if (r?.error) setErr(r.error);
  };
  const isMusic = group === 'Music';

  return (
    <>
      <div className="tab-title">{isMusic ? 'Music' : 'Sound effects'} · {collection}</div>
      {err && <p className="error-text">{err}</p>}
      {!lib ? (
        <p className="empty-note"><Loader2 size={14} className="spin" /> Reading the assets folder…</p>
      ) : !lib.hasLibrary || !items.length && !query ? (
        <>
          <p className="empty-note">No {collection} {isMusic ? 'tracks' : 'sounds'} in the assets folder yet.</p>
          <p className="lib-note">From your assets folder — free to use, no credits needed.</p>
        </>
      ) : (
        <>
          <div className="panel-search"><SearchBox value={q} onChange={setQ} placeholder={`Search ${collection}…`} ariaLabel={`Search pack ${collection}`} /></div>
          <div className="lib-list pack-list">
            {shown.map((item) => (
              <div key={item.path} className={`lib-row ${playing === item.path ? 'on' : ''} ${item.missing ? 'missing' : ''}`} onDoubleClick={() => add(item)}>
                <button className="lib-play" onClick={() => toggle(item)} disabled={item.missing}
                  aria-label={playing === item.path ? `Stop ${item.name}` : `Play ${item.name}`}>
                  {playing === item.path ? <Pause size={15} fill="currentColor" /> : <Play size={15} fill="currentColor" />}
                </button>
                <div className="lib-meta">
                  <b title={item.name}>{item.name}</b>
                  <span className="lib-sub"><span>{collection}{item.duration ? ` · ${formatTime(item.duration).slice(0, 5)}` : ''}</span>
                    {item.kind === 'video' && <i className="lic cc0">Video</i>}
                    {item.missing && <i className="lic by">Missing file</i>}</span>
                </div>
                <button className="lib-add" onClick={() => add(item)} disabled={item.missing || adding === item.path}
                  aria-label={`Add ${item.name} at the playhead`} title="Add at the playhead">
                  {adding === item.path ? <Loader2 size={15} className="spin" /> : <Plus size={16} />}
                </button>
              </div>
            ))}
          </div>
          {!shown.length && <p className="empty-note">{items.length ? `Nothing in ${collection} matches “${q.trim()}”.` : `No ${collection} ${isMusic ? 'tracks' : 'sounds'} in the assets folder yet.`}</p>}
          <p className="lib-note">From your assets folder — free to use, no credits needed.</p>
        </>
      )}
    </>
  );
}
