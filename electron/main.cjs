const { app, BrowserWindow, ipcMain, dialog, shell, net } = require('electron');

app.setName('ClipCraft');
// Videos are decoded on the CPU, not the graphics chip. On some PCs (seen with an Intel HD 530 and its 2022
// driver) the graphics process crashed again and again while playing, and the player went black for a moment
// each time. The player only plays H.264 / VP9 / AV1 up to 1080p (heavier files get a light preview copy), which
// any CPU decodes easily. FVE_GPU_VIDEO=1 turns hardware decoding back on.
if (process.env.FVE_GPU_VIDEO !== '1') app.commandLine.appendSwitch('disable-accelerated-video-decode');
// The screen recording UI test uses Chromium's fake camera and microphone, never the real ones.
if (process.env.FVE_SMOKE && process.env.FVE_SMOKE_MODE === 'screenrec') {
  app.commandLine.appendSwitch('use-fake-device-for-media-stream');
  app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
}
const path = require('path');
const fs = require('fs');
const os = require('os');
const { FxJobs } = require('./fxjobs.cjs');
const { probe, runExport, exportAudio, toM4a, renderTimelineAudio, detectSilences, makeVisuals, needsProxy, makeProxy, makeLightProxy, makeQualityProxy, hasLibx265 } = require('./ffmpeg.cjs');
const { qualityTargetSize } = require('./quality.cjs');
const whisper = require('./whisper.cjs');
const cloudCaptions = require('./cloudCaptions.cjs');

// Whisper lived under the old app name; move it instead of downloading ~150 MB again.
const whisperDir = () => {
  const dir = path.join(app.getPath('userData'), 'whisper');
  const old = path.join(app.getPath('appData'), 'free-video-editor', 'whisper');
  if (!fs.existsSync(dir) && fs.existsSync(old)) {
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    fs.renameSync(old, dir);
  }
  return dir;
};

const VIDEO_EXT = ['mp4', 'mov', 'mkv', 'webm', 'avi', 'm4v', 'wmv', 'flv', '3gp', 'mts', 'm2ts', 'ts', 'mpg', 'mpeg', 'ogv'];
const AUDIO_EXT = ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'flac', 'wma', 'aiff', 'aif', 'amr', 'ac3', 'mka'];
const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif'];

let win;
let currentExport = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1400,
    height: 860,
    minWidth: 1000,
    minHeight: 640,
    backgroundColor: '#0b0d12',
    title: 'ClipCraft',
    // The .ico carries 16-256 px versions, so the title bar and taskbar stay sharp on Windows.
    icon: path.join(__dirname, '..', 'assets', process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      // Dev server pages are http://localhost and must still read local media files.
      webSecurity: !process.env.VITE_DEV_SERVER_URL,
      // UI tests keep their local storage (the unsaved-project copy) in memory, away from the real one.
      ...(process.env.FVE_SMOKE ? { partition: 'fve-smoke' } : {}),
    },
  });
  if (process.env.VITE_DEV_SERVER_URL) win.loadURL(process.env.VITE_DEV_SERVER_URL);
  else win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  if (!process.env.FVE_SMOKE) win.maximize();
  win.on('close', (e) => {
    if (allowClose) return;
    e.preventDefault();
    win.webContents.send('app:closeRequest');
    clearTimeout(closeTimer);
    closeTimer = setTimeout(closeNow, 5000);
  });
  // The interface files may be missing for a moment (being rebuilt by "npm run build" / "npm start" in another
  // window) or the page may crash: load it again instead of leaving a black window.
  let reloads = 0;
  const reloadSoon = () => {
    if (reloads++ < 10) setTimeout(() => { if (win && !win.isDestroyed()) win.webContents.reload(); }, 1500);
  };
  win.webContents.on('did-fail-load', (_e, code, desc, _url, isMainFrame) => {
    if (!isMainFrame || code === -3) return;
    logCrash('page failed to load', { code, desc });
    reloadSoon();
  });
  win.webContents.on('render-process-gone', (_e, d) => {
    if (d.reason === 'clean-exit') return;
    logCrash('interface crashed', { reason: d.reason, exitCode: d.exitCode });
    recovered = true; // the interface reloads and restores the project it autosaved
    reloadSoon();
  });
  win.webContents.on('unresponsive', () => logCrash('interface not responding', {}));
  win.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    if (level >= 3) logCrash('interface error', { message: String(message).slice(0, 500), at: `${path.basename(sourceId || '')}:${line}` });
  });
  win.webContents.on('did-finish-load', () => {
    // An empty page (index.html written but the scripts not yet): check that the interface started.
    setTimeout(() => {
      if (!win || win.isDestroyed()) return;
      win.webContents.executeJavaScript("!!(document.getElementById('root') && document.getElementById('root').children.length)")
        .then((ok) => { if (ok) reloads = 0; else reloadSoon(); }).catch(() => {});
    }, 4000);
  });
  if (process.env.FVE_SMOKE) {
    win.webContents.once('did-finish-load', () => require('./smoke.cjs')(win, app, process.env.FVE_SMOKE));
  }
}

// ---- Crash log: <userData>/logs/crash.log, so a black or frozen window can be explained afterwards. ----
// Only what went wrong and the app's memory use: no project content, no keys.
let recovered = false;
const crashDir = () => (process.env.FVE_SMOKE ? path.join(process.env.FVE_SMOKE, 'logs') : path.join(app.getPath('userData'), 'logs'));
let lastLog = { key: '', at: 0 };
function logCrash(what, details) {
  try {
    const key = `${what}|${JSON.stringify(details)}`;
    if (key === lastLog.key && Date.now() - lastLog.at < 5000) return; // the same error repeating every frame
    lastLog = { key, at: Date.now() };
    const dir = crashDir();
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'crash.log');
    const mem = app.getAppMetrics().map((m) => `${m.type}:${Math.round((m.memory?.workingSetSize || 0) / 1024)}MB`).join(' ');
    const line = `${new Date().toISOString()} v${app.getVersion()} ${what} ${JSON.stringify(details)} | memory ${mem}\n`;
    if (fs.existsSync(file) && fs.statSync(file).size > 300000) fs.writeFileSync(file, fs.readFileSync(file, 'utf8').slice(-150000));
    fs.appendFileSync(file, line);
  } catch {
    // logging must never break the app
  }
}
// Graphics chip and driver, written with graphics process crashes.
let gpuName = '';
app.whenReady().then(() => app.getGPUInfo('basic')).then((info) => {
  const g = (info.gpuDevice || []).find((x) => x.active) || (info.gpuDevice || [])[0];
  if (g) gpuName = `${Number(g.vendorId).toString(16)}:${Number(g.deviceId).toString(16)} driver ${g.driverVersion || '?'}`;
}).catch(() => {});
app.on('child-process-gone', (_e, d) => {
  if (d.reason === 'clean-exit') return;
  logCrash(`${d.type} process gone`, { reason: d.reason, exitCode: d.exitCode, name: d.name || '', ...(d.type === 'GPU' ? { gpu: gpuName } : {}) });
});
ipcMain.handle('app:recovered', () => {
  const r = recovered;
  recovered = false;
  return r;
});
ipcMain.handle('app:openCrashLog', () => {
  const file = path.join(crashDir(), 'crash.log');
  if (fs.existsSync(file)) shell.showItemInFolder(file);
  return fs.existsSync(file);
});

async function probeAll(files) {
  const items = [];
  for (const file of files) {
    try {
      const info = await probe(file);
      items.push({ path: file, name: path.basename(file), ...info });
    } catch (e) {
      items.push({ path: file, name: path.basename(file), error: e.message });
    }
  }
  queueVisuals(items.filter((i) => !i.error));
  return items;
}

// Thumbnails and waveforms are generated in the background; the UI gets each result
// through 'media:visuals' so importing never waits for them. How many jobs run at once
// is the performance mode's concurrency knob (measured per mode — see PERF-REPORT).
const visualsQueue = [];
const visualsQueued = new Set();
let visualsActive = 0;
const VISUALS_CONCURRENCY = { 'low-end': 1, balanced: 2, 'high-performance': 3 };

function queueVisuals(items) {
  for (const it of items) {
    if (visualsQueued.has(it.path)) continue;
    visualsQueued.add(it.path);
    visualsQueue.push(it);
  }
  pumpVisuals();
}

// Thumbnails, waveforms and preview proxies. Not "cache": on Windows that is the same folder as Chromium's own
// "Cache", which Chromium cleans, deleting our files. Proxies left there by older versions are moved over once.
let mediaCacheReady = false;
function mediaCacheDir() {
  // UI tests use their own folder (they make and delete proxies).
  const dir = process.env.FVE_SMOKE ? path.join(process.env.FVE_SMOKE, 'media-cache-test') : path.join(app.getPath('userData'), 'media-cache');
  if (!mediaCacheReady) {
    mediaCacheReady = true;
    fs.mkdirSync(dir, { recursive: true });
    const old = path.join(app.getPath('userData'), 'cache');
    try {
      for (const f of fs.readdirSync(old)) {
        if (!/-proxy\.mp4$/.test(f)) continue; // thumbnails and waveforms are quick to make again
        try { fs.renameSync(path.join(old, f), path.join(dir, f)); } catch { /* in use or already there */ }
      }
    } catch { /* no old folder */ }
  }
  return dir;
}

function pumpVisuals() {
  const limit = VISUALS_CONCURRENCY[settings.getPerfMode()] || 2;
  while (visualsActive < limit && visualsQueue.length) {
    visualsActive++;
    processVisualItem(visualsQueue.shift())
      .catch(() => {})
      .finally(() => { visualsActive--; pumpVisuals(); });
  }
}

async function processVisualItem(it) {
    const send = (v) => { if (win && !win.isDestroyed()) win.webContents.send('media:visuals', { path: it.path, ...v }); };
    const cache = mediaCacheDir();
    await makeVisuals(it, cache, send).catch(() => {});
    // Preview proxy for video the player cannot decode well (projects saved earlier lack the codec details).
    try {
      const info = it.pixFmt === undefined || it.hdr === undefined ? { ...it, ...(await probe(it.path)) } : it;
      let proxyPath = it.proxy;
      if (needsProxy(info)) {
        if (!it.proxy || !fs.existsSync(it.proxy)) send({ optimizing: true });
        proxyPath = await makeProxy(info, cache);
        send({ proxy: proxyPath, optimizing: false });
      }
      // Playback quality below Full: the level's scaled copy (see quality.cjs). While it is missing the
      // player falls back to smaller copies / the original; the patch swaps it in when ready. A source
      // that already fits the level needs no copy: the level resolves to the full-quality chain itself.
      const quality = settings.getQuality();
      if (info.type === 'video' && quality !== 'full') {
        const prev = it.proxies && typeof it.proxies === 'object' ? it.proxies : {};
        if (prev[quality] == null) {
          if (!qualityTargetSize(info.width, info.height, quality)) {
            send({ proxies: { ...prev, [quality]: proxyPath && fs.existsSync(proxyPath) ? proxyPath : it.path } });
          } else {
            send({ optimizing: true });
            try {
              send({ proxies: { ...prev, [quality]: await makeQualityProxy(info, cache, quality) }, optimizing: false });
            } catch {
              send({ proxies: { ...prev, [quality]: false }, optimizing: false }); // not retried until re-import
            }
          }
        }
      }
    } catch {
      send({ optimizing: false });
    }
    visualsQueued.delete(it.path);
}

// Playback quality: the current level, the space the scaled copies take, and deleting them
// (only at Full quality, so the player is never left pointing at deleted files).
const proxyFiles = () => {
  try {
    return fs.readdirSync(mediaCacheDir()).filter((f) => /-(lproxy|qhigh|qmedium|qlow)\.mp4$/.test(f)).map((f) => path.join(mediaCacheDir(), f));
  } catch {
    return [];
  }
};
const proxyStatus = () => {
  const quality = settings.getQuality();
  const files = proxyFiles();
  return { on: quality !== 'full', quality, files: files.length, bytes: files.reduce((n, f) => n + fs.statSync(f).size, 0) };
};
ipcMain.handle('proxy:status', () => proxyStatus());
ipcMain.handle('proxy:set', (_e, on) => {
  settings.setProxy(on === true);
  return proxyStatus();
});
ipcMain.handle('proxy:setQuality', (_e, q) => {
  settings.setQuality(q);
  return proxyStatus();
});
// Performance mode: a bundle applied on selection — Low-End defaults playback to the
// Low tier, High-Performance to Full, Balanced leaves the user's tier alone. The other
// knobs (visuals concurrency, export priority) read the persisted mode where they run.
ipcMain.handle('perf:getMode', () => settings.getPerfMode());
ipcMain.handle('perf:setMode', (_e, mode) => {
  const m = settings.setPerfMode(mode);
  if (m === 'low-end') settings.setQuality('low');
  if (m === 'high-performance') settings.setQuality('full');
  pumpVisuals(); // a wider or narrower gate applies to the queue right away
  return { mode: m, ...proxyStatus() };
});
ipcMain.handle('proxy:clear', () => {
  if (settings.getQuality() !== 'full') return { ...proxyStatus(), deleted: [] };
  const deleted = [];
  for (const f of proxyFiles()) {
    try {
      fs.rmSync(f);
      deleted.push(f);
    } catch { /* still open in the player */ }
  }
  return { ...proxyStatus(), deleted };
});

// Adjust > Auto: a few small frames of the clip (the analysis itself runs in the renderer, src/fx/autocolor.js).
ipcMain.handle('color:sample', async (_e, item, from, to) => {
  try {
    if (!item || !fs.existsSync(item.path)) return { error: 'The video file was not found.' };
    const frames = await require('./ffmpeg.cjs').sampleFrames(item, from, to);
    return frames.length ? { frames } : { error: 'Could not read pictures from this clip.' };
  } catch (e) {
    return { error: e.message };
  }
});

ipcMain.handle('media:ensureVisuals', (_e, items) => queueVisuals(items.filter((i) => i && fs.existsSync(i.path))));

ipcMain.handle('media:import', async () => {
  const res = await dialog.showOpenDialog(win, {
    title: 'Import media',
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'Media', extensions: [...VIDEO_EXT, ...AUDIO_EXT, ...IMAGE_EXT] },
      { name: 'Video', extensions: VIDEO_EXT },
      { name: 'Audio', extensions: AUDIO_EXT },
      { name: 'Images', extensions: IMAGE_EXT },
    ],
  });
  return res.canceled ? [] : probeAll(res.filePaths);
});

// Files dropped from Explorer.
ipcMain.handle('media:probe', (_e, files) => {
  const ok = [...VIDEO_EXT, ...AUDIO_EXT, ...IMAGE_EXT];
  return probeAll(files.filter((f) => ok.includes(path.extname(f).slice(1).toLowerCase())));
});

// Voice-over recorded in the UI (MediaRecorder webm) -> m4a in the user data folder.
ipcMain.handle('media:saveRecording', async (_e, bytes) => {
  const dir = path.join(app.getPath('userData'), 'recordings');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const webm = path.join(dir, `voiceover-${stamp}.webm`);
  fs.writeFileSync(webm, Buffer.from(bytes));
  const m4a = await toM4a(webm, webm.replace(/\.webm$/, '.m4a'));
  fs.rmSync(webm, { force: true });
  return (await probeAll([m4a]))[0];
});

// ---- Your fonts: .ttf / .otf / .woff / .woff2 kept in <userData>/fonts for every project. ----
const userFonts = require('./fonts.cjs');
const fontDir = () => (process.env.FVE_SMOKE ? path.join(process.env.FVE_SMOKE, 'fonts-test') : path.join(app.getPath('userData'), 'fonts'));
const fontList = () => userFonts.list(fontDir()).map(({ id, name }) => ({ id, name }));
ipcMain.handle('fonts:list', () => fontList());
ipcMain.handle('fonts:import', async (_e, files) => {
  try {
    let paths = Array.isArray(files) ? files.filter((f) => typeof f === 'string') : null;
    if (!paths) {
      const res = await dialog.showOpenDialog(win, {
        title: 'Add fonts', properties: ['openFile', 'multiSelections'],
        filters: [{ name: 'Fonts', extensions: userFonts.EXT.map((x) => x.slice(1)) }],
      });
      if (res.canceled) return { added: [], skipped: [], list: fontList() };
      paths = res.filePaths;
    }
    return { ...userFonts.add(fontDir(), paths), list: fontList() };
  } catch (e) {
    return { error: e.message };
  }
});
ipcMain.handle('fonts:data', (_e, id) => {
  const file = userFonts.fileOf(fontDir(), id);
  return file ? fs.readFileSync(file) : null;
});
ipcMain.handle('fonts:remove', (_e, id) => {
  try {
    userFonts.remove(fontDir(), id);
  } catch (e) {
    return { error: e.message };
  }
  return { list: fontList() };
});

// ---- Favorites (sounds, videos, photos), kept across projects. UI tests use their own file. ----
const favorites = require('./favorites.cjs');
const favDir = () => (process.env.FVE_SMOKE ? path.join(process.env.FVE_SMOKE, 'favorites-test') : app.getPath('userData'));
ipcMain.handle('favorites:list', () => favorites.list(favDir()));
ipcMain.handle('favorites:toggle', (_e, entry) => {
  try {
    return favorites.toggle(favDir(), entry);
  } catch (e) {
    return { error: e.message };
  }
});

// ---- Audio library (Openverse / SFXMint / MyInstants + Soundza). Files live in <userData>/library. ----
const library = require('./library.cjs');
const soundza = require('./soundza.cjs');
const libraryDir = () => path.join(app.getPath('userData'), 'library');
// The Soundza key only ever comes from the encrypted settings. Local-fixture override for
// tests/development (cf. CLIPCRAFT_PACK_URL): while CLIPCRAFT_SOUNDZA_URL points the client
// at a fixture server, a key may come from the environment, because the test sandbox has no
// OS keyring to save one into. In normal runs the environment is never consulted.
const soundzaKey = () => settings.getServiceKey('soundza')
  || (process.env.CLIPCRAFT_SOUNDZA_URL ? process.env.CLIPCRAFT_SOUNDZA_KEY || '' : '');
const libraryPath = (item) => (String(item?.id || '').startsWith('soundza-')
  ? soundza.download(net.fetch, libraryDir(), item, soundzaKey())
  : library.download(net.fetch, libraryDir(), item));

ipcMain.handle('library:search', async (_e, opts) => {
  try {
    return await library.search(net.fetch, opts || {});
  } catch (e) {
    return { error: /fetch|ENOTFOUND|ERR_INTERNET|network/i.test(e.message) ? 'No internet connection.' : e.message };
  }
});
ipcMain.handle('library:file', async (_e, item) => {
  try {
    return { path: await libraryPath(item) };
  } catch (e) {
    return { error: e.message };
  }
});
// Adds a library sound as a media item; online sounds keep their license and credit line.
ipcMain.handle('library:add', async (_e, item) => {
  try {
    const file = await libraryPath(item);
    const [m] = await probeAll([file]);
    if (m.error) return { error: m.error };
    const credit = {
      title: item.title, creator: item.creator, license: item.license, licenseName: item.licenseName,
      licenseUrl: item.licenseUrl, landing: item.landing, providerName: item.providerName,
      line: item.provider === 'soundza' ? soundza.creditLine(item) : library.creditLine(item),
    };
    return { ...m, name: `${item.title}${path.extname(file) || '.mp3'}`, credit };
  } catch (e) {
    return { error: e.message };
  }
});

// ---- Sound effects (Soundza). The key stays in this process. ----
ipcMain.handle('soundza:status', () => ({ hasKey: !!soundzaKey() }));
// Tests a typed key (or the saved one) with a tiny search.
ipcMain.handle('soundza:test', async (_e, key) => {
  try {
    const k = String(key || '').trim() || soundzaKey();
    const r = await soundza.search(net.fetch, k, { q: 'whoosh' });
    return { ok: true, text: `Soundza works (a test search found ${r.results.length} sounds).` };
  } catch (e) {
    return { ok: false, text: e.message };
  }
});
ipcMain.handle('soundza:search', async (_e, opts) => {
  try {
    return await soundza.search(net.fetch, soundzaKey(), opts || {});
  } catch (e) {
    return { error: e.message };
  }
});
// Preview MP3s are fetched once into the library folder (the page may only play local media).
ipcMain.handle('soundza:preview', async (_e, item) => {
  try {
    return { path: await soundza.preview(net.fetch, libraryDir(), item) };
  } catch (e) {
    return { error: e.message };
  }
});

// Project files the user picked in a Save or Open dialog: only these are written without asking (auto save).
const projectFiles = new Set();
// Written through a temporary file, so a crash while saving never leaves half a project.
const writeProject = (file, json) => {
  fs.writeFileSync(`${file}.part`, json, 'utf8');
  fs.renameSync(`${file}.part`, file);
};
// Saves to the project's file, or asks where the first time (and for "Save as").
ipcMain.handle('project:save', async (_e, json, file, opts = {}) => {
  try {
    if (file && projectFiles.has(file) && !opts.saveAs) {
      writeProject(file, json);
      return file;
    }
    const name = String(opts.name || 'project').replace(/[\\/:*?"<>|]+/g, '').trim() || 'project';
    const res = await dialog.showSaveDialog(win, {
      title: opts.saveAs ? 'Save project as' : 'Save project',
      defaultPath: file || `${name}.clipcraft.json`,
      filters: [{ name: 'Project', extensions: ['json'] }],
    });
    if (res.canceled) return null;
    writeProject(res.filePath, json);
    projectFiles.add(res.filePath);
    return res.filePath;
  } catch (e) {
    return { error: `Could not save the project: ${e.message}` };
  }
});
// Auto save: rewrites an already chosen project file.
ipcMain.handle('project:autosave', (_e, file, json) => {
  if (!projectFiles.has(file)) return false;
  try {
    writeProject(file, json);
    return true;
  } catch {
    return false;
  }
});

ipcMain.handle('project:open', async () => {
  const res = await dialog.showOpenDialog(win, {
    title: 'Open project',
    properties: ['openFile'],
    filters: [{ name: 'Project', extensions: ['json'] }],
  });
  if (res.canceled) return null;
  const pf = require('./projectfile.cjs');
  const file = res.filePaths[0];
  projectFiles.add(file);
  return { file, json: await pf.refreshSizes(pf.checkGenerated(fs.readFileSync(file, 'utf8'), mediaCacheDir()), probe) };
});

// Reopen a known project file by path (Home screen recents): same refresh as project:open,
// no dialog. Returns null when the file is gone or unreadable.
ipcMain.handle('project:openPath', async (_e, filePath) => {
  try {
    if (!filePath || !fs.existsSync(filePath)) return null;
    const pf = require('./projectfile.cjs');
    projectFiles.add(filePath);
    return { file: filePath, json: await pf.refreshSizes(pf.checkGenerated(fs.readFileSync(filePath, 'utf8'), mediaCacheDir()), probe) };
  } catch {
    return null;
  }
});

// ---- Per-project autosave slots (electron/autosave.cjs): one slot per project id under
// <userData>/autosave, so Home is a switchboard — leaving a project (Home, another open,
// a new project) flushes its slot, and every project the user touched is listed there.
const autosaveStore = require('./autosave.cjs');
const autosaveDir = () => (process.env.FVE_SMOKE ? path.join(process.env.FVE_SMOKE, 'autosave-test') : path.join(app.getPath('userData'), 'autosave'));
ipcMain.handle('slots:write', (_e, record) => autosaveStore.writeSlot(autosaveDir(), record));
ipcMain.handle('slots:list', () => autosaveStore.listSlots(autosaveDir()));
ipcMain.handle('slots:forFile', (_e, filePath) => autosaveStore.slotForFile(autosaveDir(), filePath));
ipcMain.handle('slots:read', (_e, id) => {
  const slot = autosaveStore.readSlot(autosaveDir(), id);
  // A slot bound to a project file adopts that file as known (same trust as project:openPath),
  // so the auto-save-to-file writes keep working for a project reopened from its slot.
  if (slot?.file && fs.existsSync(slot.file)) projectFiles.add(slot.file);
  return slot;
});
ipcMain.handle('slots:delete', (_e, id) => autosaveStore.deleteSlot(autosaveDir(), id));

// Closing the window: the interface saves the project, or asks (in its own dialog) about a project that never had
// a file. If it does not answer (frozen), the window closes anyway after a few seconds; the next start offers the
// autosaved copy.
let allowClose = !!process.env.FVE_SMOKE && process.env.FVE_SMOKE_MODE !== 'autosave';
let closeTimer = null;
const closeNow = () => {
  clearTimeout(closeTimer);
  allowClose = true;
  if (win && !win.isDestroyed()) win.close();
};
ipcMain.handle('app:closeNow', () => closeNow());
ipcMain.handle('app:closeCancel', () => clearTimeout(closeTimer));

// Export happens in two steps: the UI renders the text layer to PNG frames (export:frame / export:blanks),
// then FFmpeg composes everything (export:run). Frame folders are only accepted if created by export:begin.
const frameDirs = new Set();

ipcMain.handle('export:begin', async (_e, suggested) => {
  let file = process.env.FVE_SMOKE ? path.join(process.env.FVE_SMOKE, 'ui-export.mp4') : null;
  if (!file) {
    const base = String(suggested || 'export').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 80) || 'export';
    const res = await dialog.showSaveDialog(win, {
      title: 'Export video',
      defaultPath: `${base}.mp4`,
      filters: [{ name: 'MP4 video', extensions: ['mp4'] }],
    });
    if (res.canceled) return { canceled: true };
    file = res.filePath;
  }
  const frameDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clipcraft-text-'));
  frameDirs.add(frameDir);
  return { file, frameDir };
});

// Text layer: raw frames from the interface, packed by FFmpeg into <frameDir>/text.mov as they come (textstream.cjs).
const { TextStream } = require('./textstream.cjs');
const textStreams = new Map(); // frameDir -> TextStream
const textStream = (dir) => {
  const s = textStreams.get(dir);
  if (!s) throw new Error('Unknown text layer');
  return s;
};
ipcMain.handle('export:textBegin', (_e, dir, width, height, fps) => {
  if (!frameDirs.has(dir)) throw new Error('Unknown frame folder');
  textStreams.get(dir)?.kill();
  textStreams.set(dir, new TextStream(require('./ffmpeg.cjs').ffmpegPath, dir, width, height, fps));
});
ipcMain.handle('export:textFrame', (_e, dir, frame) => textStream(dir).add(frame));
ipcMain.handle('export:textEnd', async (_e, dir) => {
  const s = textStream(dir);
  await s.finish();
  return s.count;
});

const dropFrames = (dir) => {
  if (!frameDirs.has(dir)) return;
  frameDirs.delete(dir);
  textStreams.get(dir)?.kill();
  textStreams.delete(dir);
  fs.rmSync(dir, { recursive: true, force: true });
};

ipcMain.handle('export:abort', (_e, dir) => dropFrames(dir));

// Animated effects pass (see electron/fxjobs.cjs): frames go to the interface's WebGL shaders and back.
const fxJobs = new FxJobs();
const fxCall = (fn) => async (...args) => {
  try {
    return { ok: true, value: await fn(...args) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
};
ipcMain.handle('fx:begin', fxCall((_e, project, spec) => fxJobs.begin(project, spec)));
ipcMain.handle('fx:read', fxCall((_e, id) => fxJobs.read(id)));
ipcMain.handle('fx:write', fxCall((_e, id, bytes) => fxJobs.write(id, bytes)));
ipcMain.handle('fx:end', fxCall((_e, id) => fxJobs.end(id)));
ipcMain.handle('fx:clear', () => fxJobs.clear());
app.on('will-quit', () => fxJobs.clear());

// What the bundled FFmpeg can do, for the export-quality UI (H.265 availability drives the summary's
// stated fallback). Cached: the encoder list does not change at runtime.
let exportCapsCache = null;
ipcMain.handle('export:caps', async () => {
  exportCapsCache ||= { libx265: hasLibx265() };
  return exportCapsCache;
});

ipcMain.handle('export:run', async (_e, projectIn, target, textFrames) => {
  try {
    const project = fxJobs.resolve(projectIn);
    const textFile = path.join(target.frameDir, 'text.mov');
    const withText = textFrames > 0 && frameDirs.has(target.frameDir) && fs.existsSync(textFile)
      ? { ...project, textOverlay: { file: textFile, count: textFrames } }
      : project;
    // Low-End mode: the export yields CPU to the rest of the PC (nice +10). Other modes
    // run at normal priority. Priority never changes the encoder settings or output.
    currentExport = runExport(withText, target.file, (p) => win.webContents.send('export:progress', p), { nice: settings.getPerfMode() === 'low-end' ? 10 : 0 });
    await currentExport.promise;
    let size = 0;
    try { size = fs.statSync(target.file).size; } catch { /* the done card shows no size */ }
    return { ok: true, file: target.file, size };
  } catch (e) {
    if (currentExport?.canceled) return { canceled: true };
    return { ok: false, error: e.message };
  } finally {
    currentExport = null;
    dropFrames(target.frameDir);
    fxJobs.clear();
  }
});

// One full-resolution frame of an original media file at `at` seconds, as a JPEG in the media
// cache (never scaled — the Export dialog's cover preview shows this, not a thumbnail-sprite
// frame). Cached per file+position; the cache keeps only the newest few grabs.
ipcMain.handle('media:frame', async (_e, mediaPath, at) => {
  const { execFile } = require('child_process');
  const { ffmpegPath } = require('./ffmpeg.cjs');
  try {
    if (!mediaPath || !fs.existsSync(mediaPath)) return { ok: false, error: 'missing file' };
    const st = fs.statSync(mediaPath);
    const key = require('crypto').createHash('sha1')
      .update(`${mediaPath}|${st.size}|${st.mtimeMs}|${(Number(at) || 0).toFixed(2)}`).digest('hex').slice(0, 16);
    const out = path.join(mediaCacheDir(), `${key}-frame.jpg`);
    if (!fs.existsSync(out)) {
      await new Promise((resolve, reject) => execFile(ffmpegPath,
        ['-y', '-hide_banner', '-loglevel', 'error', '-ss', String(Math.max(0, Number(at) || 0)), '-i', mediaPath, '-frames:v', '1', '-q:v', '3', out],
        (e) => (e ? reject(e) : resolve())));
      // Prune older grabs (keep the newest 16) so scrubbing the cover chooser cannot fill the cache.
      try {
        const grabs = fs.readdirSync(mediaCacheDir()).filter((f) => f.endsWith('-frame.jpg'))
          .map((f) => path.join(mediaCacheDir(), f))
          .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
        for (const f of grabs.slice(16)) { try { fs.rmSync(f); } catch { /* in use */ } }
      } catch { /* cache dir unavailable */ }
    }
    return { ok: true, path: out };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// Embed the chosen poster frame as the MP4's attached cover picture: grab the frame from the source
// media, then a stream-copy remux adds it as attached_pic (the original file is only replaced once
// the remux succeeds, so a failure leaves the export untouched).
ipcMain.handle('export:cover', async (_e, file, mediaPath, at) => {
  const { execFile } = require('child_process');
  const { ffmpegPath } = require('./ffmpeg.cjs');
  const run = (args) => new Promise((resolve, reject) => execFile(ffmpegPath, args, (e) => (e ? reject(e) : resolve())));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clipcraft-cover-'));
  try {
    if (!fs.existsSync(file) || !fs.existsSync(mediaPath)) throw new Error('missing file');
    const cover = path.join(tmp, 'cover.jpg');
    await run(['-y', '-hide_banner', '-loglevel', 'error', '-ss', String(Math.max(0, Number(at) || 0)), '-i', mediaPath, '-frames:v', '1', '-q:v', '3', cover]);
    const out = path.join(tmp, 'with-cover.mp4');
    await run(['-y', '-hide_banner', '-loglevel', 'error', '-i', file, '-i', cover, '-map', '0', '-map', '1', '-c', 'copy', '-disposition:v:1', 'attached_pic', out]);
    fs.copyFileSync(out, file);
    let size = 0;
    try { size = fs.statSync(file).size; } catch { /* ignore */ }
    return { ok: true, size };
  } catch (e) {
    return { ok: false, error: e.message };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// Audio only: asks where to save, then mixes the timeline's sound into MP3, WAV or M4A.
const AUDIO_FORMATS = { mp3: 'MP3 audio', wav: 'WAV audio', m4a: 'M4A audio' };
ipcMain.handle('export:audio', async (_e, project, format, name) => {
  if (!AUDIO_FORMATS[format]) return { ok: false, error: 'Unknown audio format' };
  const base = String(name || 'audio').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 80) || 'audio';
  let file = process.env.FVE_SMOKE ? path.join(process.env.FVE_SMOKE, `ui-audio.${format}`) : null;
  if (!file) {
    const res = await dialog.showSaveDialog(win, {
      title: 'Export audio',
      defaultPath: `${base}.${format}`,
      filters: [{ name: AUDIO_FORMATS[format], extensions: [format] }],
    });
    if (res.canceled) return { canceled: true };
    file = res.filePath;
  }
  try {
    await exportAudio(project, file, format);
    return { ok: true, file };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('export:cancel', () => {
  if (!currentExport) return;
  currentExport.canceled = true;
  currentExport.cancel();
});
// ---- Settings and AI. API keys stay in this process; the renderer only ever sees a hint like "…abcd". ----
const settings = require('./settings.cjs');
const ai = require('./ai.cjs');

// Opens a help page in the browser. Only a short allowlist of known sites is accepted.
const HELP_HOSTS = new Set(['www.slaycamera.com', 'www.instagram.com', 'elevenlabs.io', 'try.elevenlabs.io', 'pixabay.com', 'aistudio.google.com', 'console.developers.google.com', 'console.cloud.google.com', 'ollama.com', 'console.anthropic.com', 'platform.openai.com', 'console.groq.com', 'github.com', 'hamzaabika.com', 'www.hamzaabika.com', 'paypal.me']);
ipcMain.handle('app:openHelp', (_e, url) => {
  try {
    const u = new URL(url);
    if (u.protocol === 'https:' && HELP_HOSTS.has(u.hostname)) return shell.openExternal(u.toString());
  } catch {
    // fall through
  }
  return false;
});

ipcMain.handle('settings:get', () => settings.getPublic());
// ---- MCP servers: external tool servers (stdio) whose tools CraftAI may call. ----
const mcp = require('./mcp.cjs');
const mcpRegistry = mcp.createRegistry(() => settings.getMcpServers());
ipcMain.handle('settings:setMcpServers', (_e, list) => settings.setMcpServers(list));
ipcMain.handle('mcp:tools', async () => {
  try {
    const { decls, problems } = await mcpRegistry.declarations();
    // The renderer/agent only needs the Gemini declaration shape; _mcp routing stays server-side.
    return { ok: true, tools: decls.map(({ _mcp, ...d }) => d), problems };
  } catch (e) {
    return { ok: false, error: e.message, tools: [], problems: [] };
  }
});
ipcMain.handle('mcp:call', async (_e, { name, args }) => {
  try {
    const { result } = await mcpRegistry.call(name, args || {});
    return { ok: true, result };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});
ipcMain.handle('mcp:test', async (_e, server) => mcpRegistry.test(server));
ipcMain.handle('settings:save', (_e, patch) => {
  try {
    return { ok: true, settings: settings.save(patch) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});
ipcMain.handle('settings:clearKey', (_e, provider) => settings.clearKey(provider));
ipcMain.handle('settings:saveServiceKey', (_e, name, key) => {
  try {
    return { ok: true, settings: settings.saveServiceKey(name, key) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});
ipcMain.handle('settings:clearServiceKey', (_e, name) => settings.clearServiceKey(name));

// ---- About and updates: the version, and (only when the user asks in About) whether the
// update feed on clipcrafts.pages.dev has a newer one — see updates.cjs. ----
const updates = require('./updates.cjs');
ipcMain.handle('app:version', () => app.getVersion());
// Manual checks only (the About dialog); nothing checks automatically at startup.
ipcMain.handle('updates:check', async () => { lastCheck = await updates.check(); return lastCheck; });
let lastCheck = null;
// In-app installer download (progress streamed to the requesting window). Uses ONLY the
// download URL from the last check — the renderer never supplies a URL.
ipcMain.handle('updates:download', async (e) => {
  if (!lastCheck?.newer || !lastCheck.downloadUrl) return { error: 'Check for updates first.' };
  return updates.downloadInstaller(lastCheck.downloadUrl, {
    destDir: app.getPath('downloads'),
    onProgress: (p) => { if (!e.sender.isDestroyed()) e.sender.send('updates:progress', p); },
  });
});
// Opens the installer downloaded above — and only that exact file.
ipcMain.handle('updates:openInstaller', async () => {
  const p = updates.lastDownload();
  if (!p || !fs.existsSync(p)) return { error: 'The downloaded installer is no longer there.' };
  const { shell } = require('electron');
  const err = await shell.openPath(p);
  return err ? { error: err } : { ok: true };
});

// ---- Anonymous usage statistics: opt-in, see telemetry.cjs. ----
const telemetry = require('./telemetry.cjs');
ipcMain.handle('telemetry:status', () => telemetry.getStatus());
ipcMain.handle('telemetry:setConsent', (_e, on) => telemetry.setConsent(on === true));

// ---- Text to speech: Piper (free, on this PC) and ElevenLabs (the user's key). ----
const tts = require('./tts.cjs');
const ttsDir = () => path.join(app.getPath('userData'), 'tts');
const ttsOut = () => path.join(app.getPath('userData'), 'voiceovers');
ipcMain.handle('tts:status', () => ({ ...tts.piperStatus(ttsDir()), elevenKey: !!settings.getServiceKey('elevenlabs') }));
ipcMain.handle('tts:elevenVoices', async () => {
  try {
    return { voices: await tts.elevenVoices(net.fetch, settings.getServiceKey('elevenlabs')) };
  } catch (e) {
    return { error: e.message };
  }
});
ipcMain.handle('tts:elevenUsage', async () => {
  try {
    return { usage: await tts.elevenUsage(net.fetch, settings.getServiceKey('elevenlabs')) };
  } catch (e) {
    return { error: e.message };
  }
});
ipcMain.handle('tts:testKey', async (_e, key) => {
  try {
    const k = String(key || '').trim() || settings.getServiceKey('elevenlabs');
    const v = await tts.elevenVoices(net.fetch, k);
    // A key without the "User" read permission cannot see its credits; the voices still work.
    const u = await tts.elevenUsage(net.fetch, k).catch(() => null);
    const credits = u ? ` ${u.left.toLocaleString('en-US')} of ${u.limit.toLocaleString('en-US')} credits left this month.` : '';
    return { ok: true, text: `ElevenLabs works (${v.length} voices).${credits}` };
  } catch (e) {
    return { ok: false, text: e.message };
  }
});
// Speaks the text and returns a media item (the file stays in <userData>/voiceovers).
ipcMain.handle('tts:speak', async (_e, req) => {
  try {
    const send = (stage, fraction) => { if (win && !win.isDestroyed()) win.webContents.send('tts:progress', { stage, fraction }); };
    let file;
    if (req.engine === 'eleven') {
      send('voice', 0);
      file = await tts.elevenSpeak(net.fetch, settings.getServiceKey('elevenlabs'), ttsOut(), req);
    } else {
      await tts.piperPrepare(net.fetch, ttsDir(), req.voiceId, send);
      send('voice', 1);
      file = await tts.piperSpeak(ttsDir(), ttsOut(), req);
    }
    const [m] = await probeAll([file]);
    if (m.error) return { error: m.error };
    const words = String(req.text).trim().split(/\s+/).slice(0, 5).join(' ').replace(/[\\/:*?"<>|]+/g, '');
    const credit = req.engine === 'eleven'
      ? { license: 'elevenlabs', providerName: 'ElevenLabs', creator: req.voiceName || 'ElevenLabs voice', line: 'Voice generated with ElevenLabs (elevenlabs.io)' }
      : { license: 'piper', providerName: 'Piper', creator: req.voiceName || req.voiceId, line: `Voice: Piper ${req.voiceId}` };
    return { ...m, name: `Voice - ${words || 'text'}${path.extname(file)}`, credit };
  } catch (e) {
    return { error: e.message };
  }
});

// ---- AI video and photo generation (ElevenLabs, the user's key; the API needs a Pro plan). Files stay in
// <userData>/generated with a small .json describing each one. ----
const gen = require('./gen.cjs');
const genDir = () => (process.env.FVE_SMOKE ? path.join(process.env.FVE_SMOKE, 'generated-test') : path.join(app.getPath('userData'), 'generated'));
const genJobs = new Map(); // job id -> AbortController
ipcMain.handle('gen:status', async () => {
  const key = settings.getServiceKey('elevenlabs');
  if (!key) return { hasKey: false };
  // A key without the "User" read permission cannot see its plan: generation is then simply tried.
  const u = await tts.elevenUsage(net.fetch, key).catch(() => null);
  return { hasKey: true, tier: u?.tier || '', pro: gen.isPro(u?.tier), left: u?.left ?? null, limit: u?.limit ?? null, proUrl: gen.PRO_URL };
});
ipcMain.handle('gen:models', () => gen.catalog());
ipcMain.handle('gen:list', () => gen.list(genDir()));
// Speech for a talking avatar must be MP3 or WAV: other audio (a recorded voice-over is M4A) is converted once.
const speechFile = async (file) => {
  if (gen.AUDIO_TYPES[path.extname(file).toLowerCase()]) return file;
  const out = path.join(genDir(), 'speech', `${path.basename(file, path.extname(file))}.mp3`);
  if (fs.existsSync(out)) return out;
  fs.mkdirSync(path.dirname(out), { recursive: true });
  await new Promise((resolve, reject) => require('child_process').execFile(require('./ffmpeg.cjs').ffmpegPath,
    ['-y', '-hide_banner', '-loglevel', 'error', '-i', file, '-vn', '-ac', '1', '-c:a', 'libmp3lame', '-b:a', '128k', out],
    { windowsHide: true }, (e) => (e ? reject(new Error('Could not read this audio.')) : resolve())));
  return out;
};
ipcMain.handle('gen:run', async (_e, jobId, kind, opts = {}) => {
  const ctl = new AbortController();
  genJobs.set(jobId, ctl);
  try {
    const onStatus = (stage) => { if (win && !win.isDestroyed()) win.webContents.send('gen:progress', { jobId, stage }); };
    const key = settings.getServiceKey('elevenlabs');
    let o = opts;
    if (kind === 'avatar') {
      // Typed text is spoken first with the chosen ElevenLabs voice.
      if (o.text) {
        onStatus('voicing');
        o = { ...o, audio: await tts.elevenSpeak(net.fetch, key, ttsOut(), { voiceId: o.voiceId, text: o.text }) };
      } else if (o.audio) o = { ...o, audio: await speechFile(o.audio) };
    }
    return await gen.run(net.fetch, key, genDir(), kind, o, { onStatus, signal: ctl.signal });
  } catch (e) {
    return { error: e.message, code: e.code || '' };
  } finally {
    genJobs.delete(jobId);
  }
});
ipcMain.handle('gen:stop', (_e, jobId) => genJobs.get(jobId)?.abort());

// ---- Forge: ClipCraft's own AI generation (photos + short videos). Pollinations (free, no key)
// for photos; Gemini — the AI assistant's existing key, no second key field — for Gemini photos
// and Veo videos. Jobs live in the forge module, so they survive panel switches. ----
const forge = require('./forge.cjs');
const forgeDir = () => (process.env.FVE_SMOKE ? path.join(process.env.FVE_SMOKE, 'forge-test') : path.join(app.getPath('userData'), 'forge'));
const forgeDeps = () => ({ fetchImpl: net.fetch, dir: forgeDir(), getKey: () => settings.getActive('gemini').apiKey });
ipcMain.handle('forge:status', () => ({ hasGeminiKey: !!settings.getActive('gemini').apiKey }));
ipcMain.handle('forge:catalog', () => forge.catalog());
ipcMain.handle('forge:list', () => forge.list(forgeDir()).map((e) => ({ ...e, path: path.join(forgeDir(), e.file) })));
ipcMain.handle('forge:start', (_e, opts) => { try { return forge.start(forgeDeps(), opts || {}); } catch (e) { return { error: e.message }; } });
ipcMain.handle('forge:jobs', () => forge.listJobs());
ipcMain.handle('forge:cancel', (_e, id) => forge.cancel(id));
ipcMain.handle('forge:remove', (_e, id) => forge.remove(forgeDir(), id));
ipcMain.handle('forge:reveal', (_e, id) => {
  const entry = forge.list(forgeDir()).find((e) => e.id === id);
  if (entry) shell.showItemInFolder(path.join(forgeDir(), entry.file));
  return !!entry;
});
// ---- Asset pack library: folder-backed (electron/assets.cjs). The folder is created on
// first read so the panels can name a real path in their empty state. ----
const assets = require('./assets.cjs');
ipcMain.handle('assets:list', () => {
  const root = assets.assetsRoot(app.getPath('userData'), process.env);
  assets.ensureRoot(root);
  return assets.readLibraryFor(app.getPath('userData'), process.env, process.resourcesPath);
});

// ---- First run: the Welcome card, shown once (flags in settings.json —
// electron/settings.cjs). ----
ipcMain.handle('firstrun:get', () => settings.getFirstRun());
ipcMain.handle('firstrun:set', (_e, patch) => settings.setFirstRun(patch));

// My avatars: photos of people reused in every project (<userData>/avatars).
const avatarDir = () => (process.env.FVE_SMOKE ? path.join(process.env.FVE_SMOKE, 'avatars-test') : path.join(app.getPath('userData'), 'avatars'));
ipcMain.handle('avatars:list', () => gen.avatarList(avatarDir()));
ipcMain.handle('avatars:add', async (_e, file) => {
  try {
    let files = file ? [file] : [];
    if (!file) {
      const res = await dialog.showOpenDialog(win, { title: 'Add avatar photos', properties: ['openFile', 'multiSelections'], filters: [{ name: 'Photos', extensions: ['jpg', 'jpeg', 'png', 'webp'] }] });
      if (res.canceled) return { list: gen.avatarList(avatarDir()) };
      files = res.filePaths;
    }
    const added = files.map((f) => gen.avatarAdd(avatarDir(), f));
    return { list: gen.avatarList(avatarDir()), added };
  } catch (e) {
    return { error: e.message, list: gen.avatarList(avatarDir()) };
  }
});
ipcMain.handle('avatars:remove', (_e, file) => {
  try {
    gen.avatarRemove(avatarDir(), file);
  } catch {
    // not an avatar: nothing to remove
  }
  return gen.avatarList(avatarDir());
});

// ---- Templates: the remote store, and the package flow. ----
const templates = require('./templates.cjs');
const bundledTemplates = require('./bundledTemplates.cjs');
const tplCache = () => (process.env.FVE_SMOKE ? path.join(process.env.FVE_SMOKE, 'templates-test') : path.join(app.getPath('userData'), 'templates'));
const tplCall = (fn) => async (...args) => {
  try {
    return await fn(...args);
  } catch (e) {
    return { error: e.message };
  }
};
ipcMain.handle('templates:list', tplCall((_e, params) => templates.list(net.fetch, params)));
// Bundled templates (ship with the app, fully offline): list from disk, open from disk.
ipcMain.handle('templates:bundledList', () => bundledTemplates.list(path.join(__dirname, '..')));
ipcMain.handle('templates:bundledUse', tplCall(async (_e, slug) => {
  const { json } = bundledTemplates.use(path.join(__dirname, '..'), slug);
  const pf = require('./projectfile.cjs');
  return { json: await pf.refreshSizes(pf.checkGenerated(json, mediaCacheDir()), probe) };
}));
ipcMain.handle('templates:thumb', (_e, t) => templates.thumb(net.fetch, tplCache(), t));
ipcMain.handle('templates:preview', tplCall(async (_e, t) => ({ path: await templates.preview(net.fetch, tplCache(), t) })));
// Downloads a template and returns it as a project, like project:open (it has no file until saved).
ipcMain.handle('templates:use', tplCall(async (_e, id) => {
  const send = (fraction) => { if (win && !win.isDestroyed()) win.webContents.send('templates:progress', { id, fraction }); };
  const { json } = await templates.download(net.fetch, tplCache(), id, send);
  templates.use(net.fetch, id);
  const pf = require('./projectfile.cjs');
  return { json: await pf.refreshSizes(pf.checkGenerated(json, mediaCacheDir()), probe) };
}));
// Export > Template package: asks for a folder and writes the package into a new subfolder.
ipcMain.handle('templates:pack', tplCall(async (_e, projectJson, meta) => {
  let parent = process.env.FVE_SMOKE ? path.join(process.env.FVE_SMOKE, 'packages') : null;
  if (!parent) {
    const res = await dialog.showOpenDialog(win, { title: 'Choose where to write the template package', properties: ['openDirectory', 'createDirectory'] });
    if (res.canceled) return null;
    parent = res.filePaths[0];
  }
  fs.mkdirSync(parent, { recursive: true });
  return templates.pack(JSON.parse(projectJson), meta, parent, { ffmpegPath: require('./ffmpeg.cjs').ffmpegPath });
}));
ipcMain.handle('shell:openFolder', (_e, dir) => (fs.existsSync(dir) && fs.statSync(dir).isDirectory() ? shell.openPath(dir) : false));

// ---- Stock photos and videos (Pixabay). The key stays in this process. ----
const stock = require('./stock.cjs');
// UI tests keep their (fake) downloads apart from the real library.
const stockDir = () => (process.env.FVE_SMOKE ? path.join(process.env.FVE_SMOKE, 'library-test') : path.join(app.getPath('userData'), 'library'));
// Tests a typed key (or the saved one) with a tiny search.
ipcMain.handle('stock:test', async (_e, key) => {
  try {
    const k = String(key || '').trim() || settings.getServiceKey('pixabay');
    const r = await stock.search(net.fetch, k, { kind: 'photo', q: `nature ${Date.now() % 7}` });
    return { ok: true, text: `Pixabay works (${r.total} photos for a test search).` };
  } catch (e) {
    return { ok: false, text: e.message };
  }
});
ipcMain.handle('stock:search', async (_e, opts) => {
  try {
    return await stock.search(net.fetch, settings.getServiceKey('pixabay'), opts || {});
  } catch (e) {
    return { error: e.message };
  }
});
ipcMain.handle('stock:thumb', async (_e, url) => {
  try {
    return { path: await stock.thumbnail(net.fetch, stockDir(), url) };
  } catch (e) {
    return { error: e.message };
  }
});
// AI background removal (Remove BG > Auto removal): the model is downloaded once, then each video gets a matte
// (electron/matting.cjs), one job at a time. Progress goes to the interface as matting:progress.
const matting = require('./matting.cjs');
const mattingDir = () => (process.env.FVE_SMOKE ? path.join(process.env.FVE_SMOKE, 'matting-test') : path.join(app.getPath('userData'), 'matting'));
const matteCache = () => (process.env.FVE_SMOKE ? path.join(process.env.FVE_SMOKE, 'mattes-test') : path.join(app.getPath('userData'), 'mattes'));
let mattingJob = null; // { path, canceled }
ipcMain.handle('matting:status', () => matting.status(mattingDir()));
ipcMain.handle('matting:run', async (_e, item) => {
  if (mattingJob) return { error: 'Another video is being processed. Wait for it to finish.' };
  if (!item || !item.path || !fs.existsSync(item.path)) return { error: 'The video file was not found.' };
  const job = { path: item.path, canceled: false };
  mattingJob = job;
  const send = (stage, fraction) => { if (win && !win.isDestroyed()) win.webContents.send('matting:progress', { path: item.path, stage, fraction }); };
  try {
    if (!matting.status(mattingDir()).installed) {
      send('download', 0);
      await matting.install(mattingDir(), (f) => send('download', f), net.fetch);
    }
    send('matte', 0);
    const { ffmpegPath, toSdr } = require('./ffmpeg.cjs');
    const file = await matting.makeMatte(item, {
      dir: mattingDir(), cacheDir: matteCache(), ffmpegPath, toSdr, onProgress: (f) => send('matte', f), isCanceled: () => job.canceled,
    });
    return { matte: file };
  } catch (e) {
    return e.canceled ? { canceled: true } : { error: e.message };
  } finally {
    mattingJob = null;
  }
});
ipcMain.handle('matting:cancel', () => { if (mattingJob) mattingJob.canceled = true; });

// Background pictures for scenes without footage (CraftAI's add_scene), kept with the library downloads.
ipcMain.handle('scene:make', async (_e, opts) => {
  try {
    const file = await require('./ffmpeg.cjs').makeScene(opts || {}, path.join(stockDir(), 'scenes'));
    const [m] = await probeAll([file]);
    if (m.error) return { error: m.error };
    const o = opts || {};
    return { ...m, name: `Background ${o.color}${o.color2 ? `-${o.color2}` : ''}.png` };
  } catch (e) {
    return { error: e.message };
  }
});

// Stabilization (vid.stab, electron/stabilize.cjs): one clip at a time; the stabilized copy comes back as a media item.
const { stabilize } = require('./stabilize.cjs');
let stabJob = null;
ipcMain.handle('stabilize:run', async (_e, item, from, to, level) => {
  if (stabJob) return { error: 'Another clip is being stabilized.' };
  if (!item || !fs.existsSync(item.path)) return { error: 'The video file was not found.' };
  const job = { canceled: false };
  stabJob = job;
  try {
    const out = await stabilize(item, {
      from, to, level, cacheDir: mediaCacheDir(), ffmpegPath: require('./ffmpeg.cjs').ffmpegPath, toSdr: require('./ffmpeg.cjs').toSdr,
      isCanceled: () => job.canceled,
      onProgress: (fraction) => { if (win && !win.isDestroyed()) win.webContents.send('stabilize:progress', { path: item.path, fraction }); },
    });
    const [m] = await probeAll([out]);
    if (!m || m.error) return { error: 'Could not read the stabilized video.' };
    return { ...m, name: `${path.basename(item.path).replace(/\.[^.]+$/, '')} (stabilized).mp4` };
  } catch (e) {
    return e.canceled ? { canceled: true } : { error: e.message };
  } finally {
    stabJob = null;
  }
});
ipcMain.handle('stabilize:cancel', () => { if (stabJob) stabJob.canceled = true; });

// Motion tracking (electron/track.cjs): one job at a time; the path comes back to the renderer, which
// stores it on the clip. The render is cached by file, range, pick and box, like the other derivatives.
const { trackMotion } = require('./track.cjs');
let trackJob = null;
ipcMain.handle('track:run', async (_e, item, from, to, pick, box) => {
  if (trackJob) return { error: 'Another clip is being tracked.' };
  if (!item || !fs.existsSync(item.path)) return { error: 'The video file was not found.' };
  if (!pick || !Number.isFinite(pick.x) || !Number.isFinite(pick.y)) return { error: 'No point to track.' };
  const job = { canceled: false };
  trackJob = job;
  try {
    const res = await trackMotion(item, {
      from, to, pick, box: box || { w: 0.055, h: 0.095 }, cacheDir: mediaCacheDir(), ffmpegPath: require('./ffmpeg.cjs').ffmpegPath,
      isCanceled: () => job.canceled,
      onProgress: (fraction) => { if (win && !win.isDestroyed()) win.webContents.send('track:progress', { path: item.path, fraction }); },
    });
    return { points: res.points, fps: res.fps, frames: res.raw, cached: !!res.cached };
  } catch (e) {
    return e.canceled ? { canceled: true } : { error: e.message };
  } finally {
    trackJob = null;
  }
});
ipcMain.handle('track:cancel', () => { if (trackJob) trackJob.canceled = true; });

// Reverse (context menu, item 12): same one-job-at-a-time derivative-render pattern.
const { reverse } = require('./reverse.cjs');
let revJob = null;
ipcMain.handle('reverse:run', async (_e, item, from, to) => {
  if (revJob) return { error: 'Another clip is being reversed.' };
  if (!item || !fs.existsSync(item.path)) return { error: 'The media file was not found.' };
  const job = { canceled: false };
  revJob = job;
  try {
    const out = await reverse(item, {
      from, to, hasVideo: item.type !== 'audio', cacheDir: mediaCacheDir(), ffmpegPath: require('./ffmpeg.cjs').ffmpegPath, toSdr: require('./ffmpeg.cjs').toSdr,
      isCanceled: () => job.canceled,
      onProgress: (fraction) => { if (win && !win.isDestroyed()) win.webContents.send('reverse:progress', { path: item.path, fraction }); },
    });
    const [m] = await probeAll([out]);
    if (!m || m.error) return { error: 'Could not read the reversed video.' };
    return { ...m, name: `${path.basename(item.path).replace(/\.[^.]+$/, '')} (reversed).mp4` };
  } catch (e) {
    return e.canceled ? { canceled: true } : { error: e.message };
  } finally {
    revJob = null;
  }
});
ipcMain.handle('reverse:cancel', () => { if (revJob) revJob.canceled = true; });

// Detach audio (clip menu): render a video clip's sound into its own audio file, cached
// like the reverse renders. The project then holds it as a linked audio clip.
const { detach } = require('./detach.cjs');
let detachJob = null;
ipcMain.handle('detach:run', async (_e, item, from, to) => {
  if (detachJob) return { error: 'Another clip is being detached.' };
  if (!item || !fs.existsSync(item.path)) return { error: 'The media file was not found.' };
  const job = { canceled: false };
  detachJob = job;
  try {
    const out = await detach(item, {
      from, to, cacheDir: mediaCacheDir(), ffmpegPath: require('./ffmpeg.cjs').ffmpegPath,
      isCanceled: () => job.canceled,
      onProgress: (fraction) => { if (win && !win.isDestroyed()) win.webContents.send('detach:progress', { path: item.path, fraction }); },
    });
    const [m] = await probeAll([out]);
    if (!m || m.error) return { error: 'Could not read the detached audio.' };
    return { ...m, name: `${path.basename(item.path).replace(/\.[^.]+$/, '')} (detached).wav` };
  } catch (e) {
    return e.canceled ? { canceled: true } : { error: e.message };
  } finally {
    detachJob = null;
  }
});
ipcMain.handle('detach:cancel', () => { if (detachJob) detachJob.canceled = true; });

// Voice Enhancer (clip Audio tab): render the clip's sound cleaned (electron/enhance.cjs,
// cached like the detach renders). The clip then plays / exports the enhanced file.
const { enhance } = require('./enhance.cjs');
let enhanceJob = null;
ipcMain.handle('enhance:run', async (_e, item, from, to, strength) => {
  if (enhanceJob) return { error: 'Another clip is being enhanced.' };
  if (!item || !fs.existsSync(item.path)) return { error: 'The media file was not found.' };
  const job = { canceled: false };
  enhanceJob = job;
  try {
    const res = await enhance(item, {
      from, to, strength, cacheDir: mediaCacheDir(), ffmpegPath: require('./ffmpeg.cjs').ffmpegPath,
      isCanceled: () => job.canceled,
      onProgress: (fraction) => { if (win && !win.isDestroyed()) win.webContents.send('enhance:progress', { path: item.path, fraction }); },
    });
    return { path: res.path };
  } catch (e) {
    return e.canceled ? { canceled: true } : { error: e.message };
  } finally {
    enhanceJob = null;
  }
});
ipcMain.handle('enhance:cancel', () => { if (enhanceJob) enhanceJob.canceled = true; });

// Freeze frame (context menu, item 12): grab one frame of a media file as a PNG still the
// project can hold. Cached by file + time; the file lands in the media cache like other stills.
ipcMain.handle('media:frameImage', async (_e, mediaPath, at) => {
  const { execFile } = require('child_process');
  const { ffmpegPath } = require('./ffmpeg.cjs');
  try {
    if (!fs.existsSync(mediaPath)) return { error: 'The media file was not found.' };
    const st = fs.statSync(mediaPath);
    const key = require('crypto').createHash('sha1').update(`${mediaPath}|${st.size}|${st.mtimeMs}|frame|${Number(at).toFixed(2)}`).digest('hex').slice(0, 16);
    const dir = mediaCacheDir();
    fs.mkdirSync(dir, { recursive: true });
    const out = path.join(dir, `${key}-frame.png`);
    if (!fs.existsSync(out)) {
      await new Promise((resolve, reject) => execFile(ffmpegPath, ['-y', '-hide_banner', '-loglevel', 'error', '-ss', String(Math.max(0, Number(at) || 0)), '-i', mediaPath, '-frames:v', '1', out], (e) => (e ? reject(e) : resolve())));
    }
    const [m] = await probeAll([out]);
    if (!m || m.error) return { error: 'Could not read the frozen frame.' };
    return m;
  } catch (e) {
    return { error: e.message };
  }
});

ipcMain.handle('stock:add', async (_e, item) => {
  try {
    const file = await stock.download(net.fetch, stockDir(), item);
    const [m] = await probeAll([file]);
    if (m.error) return { error: m.error };
    const name = `${(item.tags || 'pixabay').split(',')[0].trim() || 'pixabay'} ${item.id}.${path.extname(file).slice(1)}`;
    return { ...m, name, credit: { license: 'pixabay', providerName: 'Pixabay', creator: item.user, landing: item.pageURL, line: stock.creditLine(item) } };
  } catch (e) {
    return { error: e.message };
  }
});
// Tests the typed (not yet saved) values when given, otherwise the saved configuration.
const draftConfig = (draft = {}) => {
  const saved = settings.getActive(draft.provider);
  return {
    provider: saved.provider,
    model: (draft.model || '').trim() || saved.model,
    baseUrl: draft.baseUrl !== undefined ? draft.baseUrl.trim().replace(/\/+$/, '') : saved.baseUrl,
    apiKey: (draft.apiKey || '').trim() || saved.apiKey,
  };
};
ipcMain.handle('ai:test', (_e, draft) => ai.testConnection(draftConfig(draft)));
ipcMain.handle('ai:models', (_e, draft) => ai.listModels(draftConfig(draft)));

// ---- LUTs (.cube): the bundled ones in shared/luts, or a file the user picked. ----
const LUT_DIR = path.join(__dirname, '..', 'shared', 'luts');
ipcMain.handle('lut:read', (_e, ref) => {
  try {
    let file;
    if (ref && ref.bundled) {
      if (!/^[\w.-]+\.cube$/i.test(ref.bundled)) return { error: 'Unknown LUT' };
      file = path.join(LUT_DIR, ref.bundled);
    } else if (ref && ref.path) {
      if (!/\.cube$/i.test(ref.path)) return { error: 'Only .cube LUT files are supported.' };
      file = ref.path;
    } else return { error: 'No LUT' };
    if (!fs.existsSync(file)) return { error: `LUT file not found: ${path.basename(file)}` };
    if (fs.statSync(file).size > 60 * 1024 * 1024) return { error: 'This LUT file is too big.' };
    return { text: fs.readFileSync(file, 'utf8') };
  } catch (e) {
    return { error: e.message };
  }
});
ipcMain.handle('lut:import', async () => {
  const res = await dialog.showOpenDialog(win, { title: 'Import a LUT', properties: ['openFile'], filters: [{ name: '3D LUT', extensions: ['cube'] }] });
  if (res.canceled || !res.filePaths[0]) return null;
  const file = res.filePaths[0];
  return { path: file, name: path.basename(file).replace(/\.cube$/i, '') };
});

// ---- CraftAI agent: one model step per call; tools run in the interface, heavy ones call back here. ----
// If the provider fails, the step goes to the next one with a saved key (Gemini, Groq, OpenAI-compatible).
// req.provider: the provider that answered the previous step of this request, so a run stays on it.
ipcMain.handle('agent:step', async (_e, req) => {
  try {
    const fb = require('./aifallback.cjs');
    const active = settings.getActive();
    const first = fb.TOOL_PROVIDERS.includes(req.provider) ? req.provider : active.provider;
    const keys = settings.getPublic().keys || {};
    const order = fb.TOOL_PROVIDERS.includes(first) ? fb.fallbackOrder(first, (p) => p === 'ollama' || !!keys[p]) : [first];
    const { result, provider, failed } = await fb.withFallback(order, (p) => settings.getActive(p), (cfg) => ai.agentStep(cfg, req));
    return {
      ok: true, ...result, provider, model: settings.getActive(provider).model,
      fellBack: failed.map((f) => ({ provider: f.provider, name: fb.NAMES[f.provider], reason: f.reason })),
    };
  } catch (e) {
    return { ok: false, error: e.message, link: e.link, linkLabel: e.linkLabel, suggestModel: e.suggestModel };
  }
});
ipcMain.handle('agent:silences', async (_e, project, opts) => {
  try {
    return { ok: true, silences: await detectSilences(project, opts) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('captions:status', () => whisper.status(whisperDir()));

// Auto captions: install whisper.cpp on first use, mix the main-track audio, transcribe.
ipcMain.handle('captions:run', async (_e, project, opts = {}) => {
  const send = (stage, progress) => win.webContents.send('captions:progress', { stage, progress });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fve-cap-'));
  try {
    const dir = whisperDir();
    const install = () => whisper.install(dir, (what, f) => send(`Downloading ${what}`, f), opts.model);
    send('Preparing', 0);
    await install();
    send('Extracting audio', 0);
    const wav = await renderTimelineAudio(project, path.join(tmp, 'audio.wav'), opts.source || 'all');
    const run = () => whisper.transcribe(dir, wav, opts, (f) => send('Transcribing', f));
    send('Transcribing', 0);
    let segments;
    try {
      segments = await run();
    } catch (e) {
      if (e.code !== 'MODEL_DAMAGED') throw e;
      // The model was corrupt and has been removed: download it again and retry once.
      await install();
      send('Transcribing', 0);
      segments = await run();
    }
    if (!segments.length) {
      throw new Error('No speech was detected in the selected audio. Check the "Transcribe" source and the language, and make sure the clip is not muted.');
    }
    return { ok: true, segments };
  } catch (e) {
    const log = path.join(whisperDir(), 'last-run.log');
    return { ok: false, error: e.message.includes('Full log:') ? e.message : `${e.message}\n\nFull log: ${log}` };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

ipcMain.handle('shell:show', (_e, file) => shell.showItemInFolder(file));
ipcMain.handle('shell:open', (_e, file) => shell.openPath(file));

// Cloud captions (item O): the same timeline audio, transcribed by the provider the user
// picked with their own saved key. Segments come back in the local flow's exact shape.
ipcMain.handle('captions:runCloud', async (_e, project, opts = {}) => {
  const send = (stage, progress) => { if (win && !win.isDestroyed()) win.webContents.send('captions:progress', { stage, progress }); };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fve-capc-'));
  try {
    const provider = opts.provider || 'groq';
    const meta = cloudCaptions.PROVIDERS[provider];
    if (!meta) return { ok: false, error: `Unknown caption provider: ${provider}` };
    const key = settings.getServiceKey(meta.service);
    if (!key) return { ok: false, error: `No ${meta.name} API key saved. Add it in the Captions panel first.` };
    send('Extracting audio', 0);
    const wav = await renderTimelineAudio(project, path.join(tmp, 'audio.wav'), opts.source || 'all');
    send('Transcribing', 0.05);
    const segments = await cloudCaptions.transcribePrepared({
      provider, key, model: opts.model || undefined, language: opts.language,
      wavPath: wav, dir: tmp, ffmpegPath: require('./ffmpeg.cjs').ffmpegPath, probe,
      fetchImpl: net.fetch, onProgress: (f) => send('Transcribing', 0.05 + f * 0.95),
    });
    if (!segments.length) {
      throw new Error('No speech was detected in the selected audio. Check the "Transcribe" source and the language, and make sure the clip is not muted.');
    }
    return { ok: true, segments };
  } catch (e) {
    return { ok: false, error: e.message };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// Test a cloud caption key: the typed key when given, otherwise the saved one.
ipcMain.handle('captions:testCloud', async (_e, provider, keyOverride) => {
  try {
    const meta = cloudCaptions.PROVIDERS[provider];
    if (!meta) return { error: `Unknown caption provider: ${provider}` };
    const key = String(keyOverride || '').trim() || settings.getServiceKey(meta.service);
    if (!key) return { error: `No ${meta.name} key to test — paste one or save one first.` };
    await cloudCaptions.testConnection({ provider, key, fetchImpl: net.fetch });
    return { ok: true };
  } catch (e) {
    return { error: e.message };
  }
});

app.whenReady().then(() => {
  createWindow();
  telemetry.start();
  // Find the graphics card's video encoder now (a short test encode), so the first export does not wait for it.
  setTimeout(() => require('./ffmpeg.cjs').pickEncoder(), 4000);
  // Screen recording (Media > Record screen).
  require('./screenrec.cjs').install({ app, getWin: () => win, ffmpegPath: require('./ffmpeg.cjs').ffmpegPath, probeAll });
});
app.on('window-all-closed', () => app.quit());
