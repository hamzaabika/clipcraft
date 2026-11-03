import React, { useEffect, useState } from 'react';
import { CheckCircle2, Compass, Download, Globe, Instagram, RefreshCw, Sparkles, WifiOff, X } from 'lucide-react';
import { DEV_INSTAGRAM_URL } from './HomeScreen.jsx';

// About ClipCraft — version, the developer (Hamza Abika), his links, and a manual update
// check: nothing is checked automatically; the user clicks "Check for updates" and decides.
// The check asks the update feed on clipcrafts.pages.dev (see electron/updates.cjs). A failed
// check shows its reason as an error — "You're up to date" appears only after a successful
// check whose latest version is not newer than the installed one.
const DEV_SITE_URL = 'https://hamzaabika.com';

export function AboutDialog({ onClose, onWelcome }) {
  const [version, setVersion] = useState('');
  const [check, setCheck] = useState(null); // null | 'checking' | result object from updates:check
  useEffect(() => {
    window.api.appVersion?.().then(setVersion).catch(() => {});
    const esc = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [onClose]);
  const runCheck = () => {
    setCheck('checking');
    setDl(null);
    window.api.updatesCheck?.(false).then((r) => setCheck(r || { error: 'The update check did not answer.' })).catch(() => setCheck({ error: 'The update check did not answer.' }));
  };
  const [dl, setDl] = useState(null); // in-app installer download state
  useEffect(() => window.api.onUpdateProgress?.((p) => setDl((d) => (d?.phase === 'downloading' ? { phase: 'downloading', ...p } : d))), []);
  const startDownload = () => {
    setDl({ phase: 'downloading', received: 0, total: 0 });
    window.api.updatesDownload?.()
      .then((r) => setDl(r?.error ? { phase: 'error', error: r.error } : { phase: 'done', fileName: r?.fileName || '' }))
      .catch(() => setDl({ phase: 'error', error: 'The download did not answer.' }));
  };
  const openInstaller = () => window.api.updatesOpenInstaller?.().then((r) => { if (r?.error) setDl({ phase: 'error', error: r.error }); }).catch(() => {});
  const startInstall = () => {
    setDl({ phase: 'installing' });
    window.api.updatesInstall?.()
      .then((r) => {
        if (r?.error) setDl((d) => ({ phase: 'install-error', error: r.error, fileName: d?.fileName || '' }));
        else if (r?.opened) setDl((d) => ({ phase: 'opened', fileName: d?.fileName || '' }));
        else setDl((d) => ({ phase: 'restarting', fileName: d?.fileName || '' }));
      })
      .catch(() => setDl((d) => ({ phase: 'install-error', error: 'The install did not answer.', fileName: d?.fileName || '' })));
  };
  const mb = (n) => (n / 1048576).toFixed(1);
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="about-title" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal about about2${check && check.newer ? ' has-update' : ''}`}>
        <button className="icon-btn about-close" aria-label="Close" onClick={onClose}><X size={16} /></button>
        <div className="about-hero">
          <div className="about-halo"><img src="./logo.png" alt="" draggable={false} /></div>
          <h3 id="about-title">Clip<span className="grad">Craft</span></h3>
          <span className="about-vpill">Version {version || '1.0.0'}</span>
          <p className="about-tag">Cut it your way. A free video editor that works fully offline — no watermark, no account, and your videos never leave your PC.</p>
        </div>
        <div className="about-devcard">
          <span className="about-devlabel">Developed by</span>
          <b className="about-devname">Hamza Abika</b>
          <div className="about-devlinks">
            <button className="btn btn-ig" onClick={() => window.api.openHelp(DEV_INSTAGRAM_URL)}><Instagram size={14} /> @hamza_abika</button>
            <button className="btn" onClick={() => window.api.openHelp(DEV_SITE_URL)}><Globe size={14} /> hamzaabika.com</button>
          </div>
        </div>
        <div className="about-chips">
          <span>Works offline</span>
          <span>No watermark</span>
          <span>Free to use</span>
        </div>
        {onWelcome && (
          <div className="about-tour">
            <button className="btn" onClick={onWelcome}><Compass size={14} /> Welcome card</button>
            <span className="muted small">The first-run welcome, any time you want to see it again.</span>
          </div>
        )}
        <div className="about-updates">
          {check !== 'checking' && !(check && check.newer) && (
            <button className="btn" onClick={runCheck}><RefreshCw size={14} /> Check for updates</button>
          )}
          {check === 'checking' && <span className="about-status"><RefreshCw size={14} className="spin" /> Checking for updates…</span>}
          {check && check.newer && (
            <div className="about-update">
              <b>ClipCraft {check.latest} is available</b>
              {(check.releaseDate || check.size) && <span className="muted small">{[check.releaseDate, check.size].filter(Boolean).join(' · ')}</span>}
              {check.notes && <span className="about-notes">{check.notes}</span>}
              {!dl && (
                <>
                  <div className="about-devlinks">
                    <button className="btn btn-primary btn-sm" onClick={startDownload}><Download size={13} /> Download &amp; install</button>
                    {check.notesUrl && <button className="btn btn-sm" onClick={() => window.api.openHelp(check.notesUrl)}>What's new</button>}
                  </div>
                  <span className="muted small">You have {check.current}. The installer downloads inside the app — after that, one click installs it and restarts ClipCraft into the new version. <button className="linklike" onClick={() => window.api.openHelp(check.downloadUrl)}>Or open the download in your browser</button></span>
                </>
              )}
              {dl?.phase === 'downloading' && (
                <div className="about-dl">
                  <div className="about-dl-track"><div className="about-dl-fill" style={{ width: dl.total ? `${Math.min(100, Math.round((dl.received / dl.total) * 100))}%` : '30%' }} /></div>
                  <span className="muted small">{dl.total ? `${mb(dl.received)} MB of ${mb(dl.total)} MB — downloading…` : 'Downloading…'}</span>
                </div>
              )}
              {dl?.phase === 'done' && (
                <>
                  <span className="about-status ok"><CheckCircle2 size={15} /> Downloaded{dl.fileName ? `: ${dl.fileName}` : ''} (in your Downloads folder)</span>
                  <div className="about-devlinks">
                    <button className="btn btn-primary btn-sm" onClick={startInstall}><Download size={13} /> Install &amp; restart</button>
                    <button className="btn btn-sm" onClick={openInstaller}>Open installer</button>
                  </div>
                  <span className="muted small">Install &amp; restart applies the update and reopens ClipCraft — on Linux your system asks for its password once. Your projects and settings stay exactly as they are.</span>
                </>
              )}
              {dl?.phase === 'installing' && (
                <span className="about-status"><RefreshCw size={14} className="spin" /> Installing… if your system asks for a password, that's the install being approved.</span>
              )}
              {dl?.phase === 'restarting' && (
                <span className="about-status ok"><CheckCircle2 size={15} /> Installed — ClipCraft is restarting into the new version…</span>
              )}
              {dl?.phase === 'opened' && (
                <>
                  <span className="about-status ok"><CheckCircle2 size={15} /> Downloaded{dl.fileName ? `: ${dl.fileName}` : ''} (in your Downloads folder)</span>
                  <span className="muted small">The installer is open — finish the install there, then reopen ClipCraft. Your projects and settings stay exactly as they are.</span>
                </>
              )}
              {dl?.phase === 'install-error' && (
                <>
                  <span className="about-status error"><WifiOff size={15} /> {dl.error}</span>
                  <div className="about-devlinks">
                    <button className="btn btn-primary btn-sm" onClick={startInstall}><Download size={13} /> Install &amp; restart</button>
                    <button className="btn btn-sm" onClick={openInstaller}>Open installer</button>
                  </div>
                </>
              )}
              {dl?.phase === 'error' && (
                <span className="about-status error"><WifiOff size={15} /> {dl.error} <button className="btn btn-ghost btn-sm" onClick={startDownload}>Try again</button></span>
              )}
            </div>
          )}
          {check && !check.newer && !check.error && (
            <span className="about-status ok"><CheckCircle2 size={15} /> You're up to date — {check.latest} is the latest version.</span>
          )}
          {check && check.error && (
            <span className="about-status error"><WifiOff size={15} /> {check.error} <button className="btn btn-ghost btn-sm" onClick={runCheck}>Try again</button></span>
          )}
        </div>
      </div>
    </div>
  );
}

// A one-time banner shape kept for compatibility with App.jsx; the live update flow is the
// manual check inside the About dialog, which is where the download is offered.
export function UpdateNotice({ update, onDismiss, onAbout }) {
  if (!update?.newer) return null;
  return (
    <div className="stats-note update-note" role="dialog" aria-labelledby="update-note-title">
      <Sparkles size={18} />
      <div className="stats-note-body">
        <b id="update-note-title">ClipCraft {update.latest} is available</b>
        <span>You have version {update.current}. Download the new installer and run it: your projects and settings stay.</span>
        <div className="stats-note-actions">
          <button className="btn btn-sm btn-primary" onClick={() => { window.api.openHelp(update.downloadUrl); onDismiss(); }}><Download size={13} /> Download</button>
          {update.notesUrl && <button className="btn btn-sm" onClick={() => window.api.openHelp(update.notesUrl)}>What's new</button>}
          <button className="btn btn-sm btn-ghost" onClick={onDismiss}>Later</button>
        </div>
      </div>
      <button className="icon-btn" aria-label="Close" onClick={onDismiss}><X size={15} /></button>
    </div>
  );
}

// Startup is deliberately silent about updates: checking is the user's choice, from the
// "Check for updates" button in About. This hook stays as the App's update-state holder
// (kept inert) so the TopBar/notice wiring has a single home if an automatic check is
// ever wanted again.
export function useUpdateCheck() {
  const [update, setUpdate] = useState(null);
  return [update, setUpdate];
}
