import React, { useState } from 'react';
import { AudioLines, Check, ChevronDown, CircleAlert, Coffee, Download, Film, FolderOpen, Home, Info, Instagram, Save, Settings, Smartphone } from 'lucide-react';
import ContextMenu from './ContextMenu.jsx';
import { RATIOS, sizeFor } from '../effects.js';
import { SUPPORT_URL } from './HomeScreen.jsx';


// Next to Save: where the project stands (it saves itself once it has a file).
const SAVE_STATES = {
  new: ['', 'Not saved yet: click Save (Ctrl+S) once, then every change is saved automatically'],
  saving: ['Saving…', 'Saving to the project file'],
  saved: ['Saved', 'Every change is saved automatically to the project file. Ctrl+Alt+S: save as'],
  error: ['Not saved', 'The project file could not be written. Click Save to choose another place'],
};

export default function TopBar({ project, dispatch, onOpen, onSave, saveState = 'new', onExport, onExportAudio, onReframe, onSettings, onAbout, onHome, updateReady = false }) {
  const [menu, setMenu] = useState(null);
  const set = (patch) => dispatch({ type: 'setProject', patch, transient: true });
  return (
    <header className="topbar">
      <div className="brand">
        <img src="./logo.png" alt="" className="brand-logo" draggable={false} />
        <span className="brand-name">Clip<b>Craft</b></span>
      </div>

      <div className="project-meta">
        <input className="project-name" value={project.name} aria-label="Project name" spellCheck={false}
          onChange={(e) => set({ name: e.target.value })} />
        <select className="ratio-select" value={project.ratio} aria-label="Aspect ratio"
          onChange={(e) => dispatch({ type: 'setProject', patch: { ratio: e.target.value, ratioLocked: true, ...sizeFor(e.target.value, project.resolution) } })}>
          {Object.keys(RATIOS).map((r) => <option key={r} value={r}>{r}</option>)}
        </select>
      </div>

      <div className="top-actions">
        <button className="btn btn-ghost" onClick={onHome} aria-label="Projects" title="Back to projects (home)"><Home size={15} /> <span className="top-word">Projects</span></button>
        <span className="top-sep" aria-hidden="true" />
        <button className="btn btn-ghost" onClick={onOpen} aria-label="Open" title="Open a project"><FolderOpen size={15} /> <span className="top-word">Open</span></button>
        <button className="btn btn-ghost" onClick={(e) => onSave(e.altKey)} aria-label="Save" title={SAVE_STATES[saveState][1]}><Save size={15} /> <span className="top-word">Save</span></button>
        {SAVE_STATES[saveState][0] && (
          <span className={`save-state ${saveState}`} title={SAVE_STATES[saveState][1]} role="status">
            {saveState === 'saved' ? <Check size={13} /> : saveState === 'error' ? <CircleAlert size={13} /> : null} {SAVE_STATES[saveState][0]}
          </span>
        )}
        <button className="btn btn-ghost about-btn" onClick={onAbout} aria-label={updateReady ? 'About ClipCraft (an update is available)' : 'About ClipCraft'}
          title={updateReady ? 'A new version is available' : 'About ClipCraft: version and updates'}>
          <Info size={15} /> <span>About</span>{updateReady && <i className="update-dot" aria-hidden="true" />}
        </button>
        <button className="icon-btn" onClick={onSettings} aria-label="Settings" title="Settings"><Settings size={17} /></button>
        <button className="btn btn-ghost support-btn" onClick={() => window.api.openHelp(SUPPORT_URL)} aria-label="Support ClipCraft on PayPal"
          title="Support ClipCraft's development on PayPal">
          <img src="./paypal.svg" alt="" className="paypal-mark" draggable={false} /> <span className="support-word-full">Support the project</span><span className="support-word-short">Support</span>
        </button>
        <button className="btn btn-ghost" onClick={onReframe} aria-label="Make vertical copy"
          title="Auto-reframe: make a vertical 9:16 copy of this project that follows the subject (faces are tracked on this PC). This project stays untouched.">
          <Smartphone size={15} /> <span className="top-word">Vertical</span>
        </button>
        <div className="export-split">
          <button className="btn btn-export" onClick={onExport}><Download size={15} /> Export</button>
          <button className="btn btn-export caret" aria-label="More export options" aria-haspopup="menu"
            onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setMenu({ x: r.right - 220, y: r.bottom + 6 }); }}>
            <ChevronDown size={15} />
          </button>
        </div>
      </div>
      {/* Outside .top-actions: that is a size container, which would shift this fixed-position menu. */}
      {menu && (
        <ContextMenu x={menu.x} y={menu.y} label="Export" onClose={() => setMenu(null)} items={[
          { label: 'Video (MP4)', icon: Film, onClick: onExport },
          'sep',
          { label: 'Audio only (MP3)', icon: AudioLines, onClick: () => onExportAudio('mp3') },
          { label: 'Audio only (WAV)', icon: AudioLines, onClick: () => onExportAudio('wav') },
          { label: 'Audio only (M4A)', icon: AudioLines, onClick: () => onExportAudio('m4a') },
        ]} />
      )}
    </header>
  );
}
