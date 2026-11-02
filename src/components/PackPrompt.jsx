import React, { useEffect, useState } from 'react';
import { CheckCircle2, Download, Loader2, PackageOpen, WifiOff, X } from 'lucide-react';
import { PACK_CATEGORIES, fmtMB, startPackInstall, cancelPackInstall, usePack } from '../packClient.js';
import { refreshAssets } from '../useAssets.js';

// The Creator Pack prompt — shown once, right after the onboarding tour, and never again
// (the same offer stays in the Assets and Music empty states). Hamza's three actions:
//   Start Editing        — dismiss; nothing downloads.
//   Download Creator Pack — download every category.
//   Customize Downloads  — pick categories (Music / Sound FX / Assets), each with the
//                          size read from the pack feed, then download the chosen set.
// Partial failure is reported per category; what installed stays installed.
export default function PackPrompt({ onClose }) {
  const { manifest, install } = usePack();
  const [view, setView] = useState('main'); // main | custom | working | done
  const [picked, setPicked] = useState({ music: true, sfx: true, assets: true });

  const cats = manifest?.categories || {};
  const available = PACK_CATEGORIES.filter((c) => cats[c.id]);
  const chosen = available.filter((c) => picked[c.id]).map((c) => c.id);

  useEffect(() => {
    if (install.running && view !== 'working') setView('working');
    if (!install.running && install.results && view === 'working') {
      setView('done');
      if (Object.values(install.results).some((r) => r.ok)) refreshAssets();
    }
  }, [install.running, install.results, view]);

  useEffect(() => {
    const esc = (e) => { if (e.key === 'Escape' && !install.running) onClose(); };
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [install.running, onClose]);

  const begin = (list) => { setView('working'); startPackInstall(list); };
  const pct = (c) => (c?.total ? Math.min(100, Math.round((c.received / c.total) * 100)) : 0);

  return (
    <div className="modal-backdrop pack-backdrop" role="dialog" aria-modal="true" aria-labelledby="pack-title"
      onMouseDown={(e) => { if (e.target === e.currentTarget && !install.running) onClose(); }}>
      <div className="modal pack-prompt">
        <span className="pack-icon"><PackageOpen size={22} /></span>
        <h3 id="pack-title">The free Creator Pack</h3>
        <p className="pack-sub">A free library for your projects — music, sound effects, transitions and overlays. It downloads once, only if you want it, and it is never bundled into the app.</p>

        {manifest === undefined && <p className="pack-status"><Loader2 size={14} className="spin" /> Checking what the pack offers…</p>}
        {manifest === null && (
          <p className="pack-status warn"><WifiOff size={14} /> The Creator Pack is not available right now — nothing is lost by skipping.</p>
        )}
        {install.error && view !== 'working' && <p className="pack-status warn"><WifiOff size={14} /> {install.error}</p>}

        {view === 'custom' && manifest && (
          <div className="pack-picker" role="group" aria-label="Choose what to download">
            {PACK_CATEGORIES.map((c) => {
              const spec = cats[c.id];
              return (
                <label key={c.id} className={`pack-row ${spec ? '' : 'off'}`}>
                  <input type="checkbox" checked={!!spec && picked[c.id]} disabled={!spec || install.running}
                    onChange={(e) => setPicked((p) => ({ ...p, [c.id]: e.target.checked }))} />
                  <span className="pack-row-main"><b>{c.label}</b><span>{c.note}</span></span>
                  <span className="pack-row-size">{spec ? fmtMB(spec.size) : 'Not in this pack'}</span>
                </label>
              );
            })}
          </div>
        )}

        {(view === 'working' || view === 'done') && (
          <div className="pack-progress">
            {PACK_CATEGORIES.filter((c) => install.cats[c.id] || install.results?.[c.id]).map((c) => {
              const live = install.cats[c.id];
              const res = install.results?.[c.id];
              return (
                <div key={c.id} className="pack-prow">
                  <span className="pack-prow-label">{c.label}</span>
                  {res ? (
                    res.ok
                      ? <span className="pack-prow-state ok"><CheckCircle2 size={14} /> Installed{res.added ? ` · ${res.added} new` : ''}{res.skipped ? ` · ${res.skipped} already there` : ''}</span>
                      : <span className="pack-prow-state error">{res.canceled ? 'Canceled' : res.error}</span>
                  ) : (
                    <>
                      <div className="pack-bar"><div style={{ width: `${live?.phase === 'downloading' ? pct(live) : 100}%` }} /></div>
                      <span className="pack-prow-state">
                        {live?.phase === 'downloading' ? `${fmtMB(live.received)} of ${fmtMB(live.total)}`
                          : live?.phase === 'verifying' ? 'Checking integrity…'
                          : live?.phase === 'installing' ? 'Installing…' : ''}
                      </span>
                    </>
                  )}
                </div>
              );
            })}
          </div>
        )}

        <div className="pack-actions">
          {view === 'working' ? (
            <>
              <span className="pack-status">Downloading… you can keep this open; closing waits for the download.</span>
              <button className="btn" onClick={cancelPackInstall}><X size={14} /> Cancel download</button>
            </>
          ) : view === 'done' ? (
            <button className="btn btn-primary" onClick={onClose}>Start Editing</button>
          ) : view === 'custom' ? (
            <>
              <button className="btn btn-ghost" onClick={onClose}>Start Editing</button>
              <span className="pack-actions-spacer" />
              <button className="btn" onClick={() => setView('main')}>Back</button>
              <button className="btn btn-primary" disabled={!chosen.length} onClick={() => begin(chosen)}>
                <Download size={14} /> Download selected
              </button>
            </>
          ) : (
            <>
              <button className="btn btn-ghost" onClick={onClose}>Start Editing</button>
              <span className="pack-actions-spacer" />
              <button className="btn" disabled={!available.length} onClick={() => setView('custom')}>Customize Downloads</button>
              <button className="btn btn-primary" disabled={!available.length}
                onClick={() => begin(available.map((c) => c.id))}>
                <Download size={14} /> Download Creator Pack
              </button>
            </>
          )}
        </div>
        {view === 'main' && manifest && <p className="pack-note">Skip it and it stays one click away in the Assets and Music tabs.</p>}
      </div>
    </div>
  );
}
