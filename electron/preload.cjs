const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  importMedia: () => ipcRenderer.invoke('media:import'),
  wasRecovered: () => ipcRenderer.invoke('app:recovered'),
  readLut: (ref) => ipcRenderer.invoke('lut:read', ref),
  importLut: () => ipcRenderer.invoke('lut:import'),
  openCrashLog: () => ipcRenderer.invoke('app:openCrashLog'),
  probePaths: (paths) => ipcRenderer.invoke('media:probe', paths),
  favoritesList: () => ipcRenderer.invoke('favorites:list'),
  favoritesToggle: (entry) => ipcRenderer.invoke('favorites:toggle', entry),
  probeFiles: (files) => ipcRenderer.invoke('media:probe', files.map((f) => webUtils.getPathForFile(f))),
  saveRecording: (bytes) => ipcRenderer.invoke('media:saveRecording', bytes),
  screenSources: () => ipcRenderer.invoke('screen:sources'),
  screenChoose: (id, audio) => ipcRenderer.invoke('screen:choose', id, audio),
  screenBegin: (kind) => ipcRenderer.invoke('screen:begin', kind),
  screenChunk: (id, bytes) => ipcRenderer.invoke('screen:chunk', id, bytes),
  screenFinish: (id) => ipcRenderer.invoke('screen:finish', id),
  screenDiscard: (id) => ipcRenderer.invoke('screen:discard', id),
  screenBar: (show, sourceId) => ipcRenderer.invoke('screen:bar', show, sourceId),
  screenBarState: (state) => ipcRenderer.invoke('screen:barState', state),
  screenWindow: (action) => ipcRenderer.invoke('screen:window', action),
  screenCamera: (show, opts) => ipcRenderer.invoke('screen:camera', show, opts),
  screenCamGeom: (sourceId) => ipcRenderer.invoke('screen:camGeom', sourceId),
  onScreenCamConfig: (fn) => {
    const h = (_e, c) => fn(c);
    ipcRenderer.on('screen:camConfig', h);
    return () => ipcRenderer.removeListener('screen:camConfig', h);
  },
  onScreenStop: (fn) => {
    const h = () => fn();
    ipcRenderer.on('screen:stopRequested', h);
    return () => ipcRenderer.removeListener('screen:stopRequested', h);
  },
  onScreenPause: (fn) => {
    const h = () => fn();
    ipcRenderer.on('screen:pauseRequested', h);
    return () => ipcRenderer.removeListener('screen:pauseRequested', h);
  },
  fontsList: () => ipcRenderer.invoke('fonts:list'),
  // files: dropped File objects; none opens the file picker.
  fontsImport: (files) => ipcRenderer.invoke('fonts:import', files ? files.map((f) => webUtils.getPathForFile(f)) : null),
  fontData: (id) => ipcRenderer.invoke('fonts:data', id),
  fontsRemove: (id) => ipcRenderer.invoke('fonts:remove', id),
  librarySearch: (opts) => ipcRenderer.invoke('library:search', opts),
  soundzaStatus: () => ipcRenderer.invoke('soundza:status'),
  soundzaSearch: (opts) => ipcRenderer.invoke('soundza:search', opts),
  soundzaTest: (key) => ipcRenderer.invoke('soundza:test', key),
  soundzaPreview: (item) => ipcRenderer.invoke('soundza:preview', item),
  libraryFile: (item) => ipcRenderer.invoke('library:file', item),
  libraryAdd: (item) => ipcRenderer.invoke('library:add', item),
  ensureVisuals: (items) => ipcRenderer.invoke('media:ensureVisuals', items),
  colorSample: (item, from, to) => ipcRenderer.invoke('color:sample', item, from, to),
  stabilizeRun: (item, from, to, level) => ipcRenderer.invoke('stabilize:run', item, from, to, level),
  reverseRun: (item, from, to) => ipcRenderer.invoke('reverse:run', item, from, to),
  reverseCancel: () => ipcRenderer.invoke('reverse:cancel'),
  detachRun: (item, from, to) => ipcRenderer.invoke('detach:run', item, from, to),
  detachCancel: () => ipcRenderer.invoke('detach:cancel'),
  enhanceRun: (item, from, to, strength) => ipcRenderer.invoke('enhance:run', item, from, to, strength),
  enhanceCancel: () => ipcRenderer.invoke('enhance:cancel'),
  onEnhanceProgress: (handler) => {
    const h = (_e, payload) => handler(payload);
    ipcRenderer.on('enhance:progress', h);
    return () => ipcRenderer.removeListener('enhance:progress', h);
  },
  onDetachProgress: (cb) => {
    const h = (_e, p) => cb(p);
    ipcRenderer.on('detach:progress', h);
    return () => ipcRenderer.removeListener('detach:progress', h);
  },
  onReverseProgress: (cb) => {
    const h = (_e, p) => cb(p);
    ipcRenderer.on('reverse:progress', h);
    return () => ipcRenderer.removeListener('reverse:progress', h);
  },
  frameImage: (mediaPath, at) => ipcRenderer.invoke('media:frameImage', mediaPath, at),
  stabilizeCancel: () => ipcRenderer.invoke('stabilize:cancel'),
  onStabilizeProgress: (cb) => {
    const handler = (_e, p) => cb(p);
    ipcRenderer.on('stabilize:progress', handler);
    return () => ipcRenderer.removeListener('stabilize:progress', handler);
  },
  trackRun: (item, from, to, pick, box) => ipcRenderer.invoke('track:run', item, from, to, pick, box),
  trackCancel: () => ipcRenderer.invoke('track:cancel'),
  onTrackProgress: (cb) => {
    const handler = (_e, p) => cb(p);
    ipcRenderer.on('track:progress', handler);
    return () => ipcRenderer.removeListener('track:progress', handler);
  },
  proxyStatus: () => ipcRenderer.invoke('proxy:status'),
  proxySet: (on) => ipcRenderer.invoke('proxy:set', on === true),
  qualitySet: (q) => ipcRenderer.invoke('proxy:setQuality', q),
  perfGetMode: () => ipcRenderer.invoke('perf:getMode'),
  perfSetMode: (m) => ipcRenderer.invoke('perf:setMode', m),
  proxyClear: () => ipcRenderer.invoke('proxy:clear'),
  onMediaVisuals: (cb) => {
    const handler = (_e, v) => cb(v);
    ipcRenderer.on('media:visuals', handler);
    return () => ipcRenderer.removeListener('media:visuals', handler);
  },
  saveProject: (json, file, opts) => ipcRenderer.invoke('project:save', json, file, opts),
  autosaveProject: (file, json) => ipcRenderer.invoke('project:autosave', file, json),
  closeNow: () => ipcRenderer.invoke('app:closeNow'),
  closeCancel: () => ipcRenderer.invoke('app:closeCancel'),
  onCloseRequest: (fn) => {
    const h = () => fn();
    ipcRenderer.on('app:closeRequest', h);
    return () => ipcRenderer.removeListener('app:closeRequest', h);
  },
  openProject: () => ipcRenderer.invoke('project:open'),
  openProjectPath: (filePath) => ipcRenderer.invoke('project:openPath', filePath),
  slotWrite: (record) => ipcRenderer.invoke('slots:write', record),
  slotList: () => ipcRenderer.invoke('slots:list'),
  slotForFile: (filePath) => ipcRenderer.invoke('slots:forFile', filePath),
  slotRead: (id) => ipcRenderer.invoke('slots:read', id),
  slotDelete: (id) => ipcRenderer.invoke('slots:delete', id),
  exportBegin: (suggested) => ipcRenderer.invoke('export:begin', suggested),
  exportCover: (file, mediaPath, at) => ipcRenderer.invoke('export:cover', file, mediaPath, at),
  frameGrab: (mediaPath, at) => ipcRenderer.invoke('media:frame', mediaPath, at),
  exportCaps: () => ipcRenderer.invoke('export:caps'),
  // Text layer: begin, then one call per frame (pixels, or { blank: n } / { same: n }), then end (frame count).
  exportTextBegin: (dir, width, height, fps) => ipcRenderer.invoke('export:textBegin', dir, width, height, fps),
  exportTextFrame: (dir, frame) => ipcRenderer.invoke('export:textFrame', dir, frame),
  exportTextEnd: (dir) => ipcRenderer.invoke('export:textEnd', dir),
  exportAbort: (dir) => ipcRenderer.invoke('export:abort', dir),
  exportRun: (project, target, textFrames) => ipcRenderer.invoke('export:run', project, target, textFrames),
  cancelExport: () => ipcRenderer.invoke('export:cancel'),
  fxBegin: (project, spec) => ipcRenderer.invoke('fx:begin', project, spec),
  fxRead: (id) => ipcRenderer.invoke('fx:read', id),
  fxWrite: (id, bytes) => ipcRenderer.invoke('fx:write', id, bytes),
  fxEnd: (id) => ipcRenderer.invoke('fx:end', id),
  fxClear: () => ipcRenderer.invoke('fx:clear'),
  exportAudio: (project, format, name) => ipcRenderer.invoke('export:audio', project, format, name),
  showInFolder: (file) => ipcRenderer.invoke('shell:show', file),
  openFile: (file) => ipcRenderer.invoke('shell:open', file),
  openHelp: (url) => ipcRenderer.invoke('app:openHelp', url),
  agentStep: (req) => ipcRenderer.invoke('agent:step', req),
  agentSilences: (project, opts) => ipcRenderer.invoke('agent:silences', project, opts),
  settingsGet: () => ipcRenderer.invoke('settings:get'),
  settingsSetMcpServers: (list) => ipcRenderer.invoke('settings:setMcpServers', list),
  mcpTools: () => ipcRenderer.invoke('mcp:tools'),
  mcpCall: (req) => ipcRenderer.invoke('mcp:call', req),
  mcpTest: (server) => ipcRenderer.invoke('mcp:test', server),
  settingsSave: (patch) => ipcRenderer.invoke('settings:save', patch),
  settingsClearKey: (provider) => ipcRenderer.invoke('settings:clearKey', provider),
  settingsSaveServiceKey: (name, key) => ipcRenderer.invoke('settings:saveServiceKey', name, key),
  settingsClearServiceKey: (name) => ipcRenderer.invoke('settings:clearServiceKey', name),
  appVersion: () => ipcRenderer.invoke('app:version'),
  updatesCheck: (auto = false) => ipcRenderer.invoke('updates:check', auto === true),
  updatesDownload: () => ipcRenderer.invoke('updates:download'),
  updatesOpenInstaller: () => ipcRenderer.invoke('updates:openInstaller'),
  updatesInstall: () => ipcRenderer.invoke('updates:install'),
  onUpdateProgress: (cb) => { const h = (_e, p) => cb(p); ipcRenderer.on('updates:progress', h); return () => ipcRenderer.removeListener('updates:progress', h); },
  telemetryStatus: () => ipcRenderer.invoke('telemetry:status'),
  telemetrySetConsent: (on) => ipcRenderer.invoke('telemetry:setConsent', on),
  stockTest: (key) => ipcRenderer.invoke('stock:test', key),
  ttsStatus: () => ipcRenderer.invoke('tts:status'),
  ttsElevenVoices: () => ipcRenderer.invoke('tts:elevenVoices'),
  ttsElevenUsage: () => ipcRenderer.invoke('tts:elevenUsage'),
  ttsTestKey: (key) => ipcRenderer.invoke('tts:testKey', key),
  ttsSpeak: (req) => ipcRenderer.invoke('tts:speak', req),
  onTtsProgress: (fn) => {
    const h = (_e, p) => fn(p);
    ipcRenderer.on('tts:progress', h);
    return () => ipcRenderer.removeListener('tts:progress', h);
  },
  templatesList: (params) => ipcRenderer.invoke('templates:list', params),
  templatesBundledList: () => ipcRenderer.invoke('templates:bundledList'),
  templatesBundledUse: (slug) => ipcRenderer.invoke('templates:bundledUse', slug),
  templatesThumb: (t) => ipcRenderer.invoke('templates:thumb', t),
  templatesPreview: (t) => ipcRenderer.invoke('templates:preview', t),
  templatesUse: (id) => ipcRenderer.invoke('templates:use', id),
  templatesPack: (projectJson, meta) => ipcRenderer.invoke('templates:pack', projectJson, meta),
  onTemplatesProgress: (fn) => {
    const h = (_e, p) => fn(p);
    ipcRenderer.on('templates:progress', h);
    return () => ipcRenderer.removeListener('templates:progress', h);
  },
  openFolder: (dir) => ipcRenderer.invoke('shell:openFolder', dir),
  genStatus: () => ipcRenderer.invoke('gen:status'),
  genList: () => ipcRenderer.invoke('gen:list'),
  genModels: () => ipcRenderer.invoke('gen:models'),
  avatarsList: () => ipcRenderer.invoke('avatars:list'),
  avatarsAdd: (file) => ipcRenderer.invoke('avatars:add', file),
  avatarsRemove: (file) => ipcRenderer.invoke('avatars:remove', file),
  genRun: (jobId, kind, opts) => ipcRenderer.invoke('gen:run', jobId, kind, opts),
  genStop: (jobId) => ipcRenderer.invoke('gen:stop', jobId),
  onGenProgress: (fn) => {
    const h = (_e, p) => fn(p);
    ipcRenderer.on('gen:progress', h);
    return () => ipcRenderer.removeListener('gen:progress', h);
  },
  forgeStatus: () => ipcRenderer.invoke('forge:status'),
  forgeCatalog: () => ipcRenderer.invoke('forge:catalog'),
  forgeList: () => ipcRenderer.invoke('forge:list'),
  forgeStart: (opts) => ipcRenderer.invoke('forge:start', opts),
  forgeJobs: () => ipcRenderer.invoke('forge:jobs'),
  forgeCancel: (id) => ipcRenderer.invoke('forge:cancel', id),
  forgeRemove: (id) => ipcRenderer.invoke('forge:remove', id),
  forgeReveal: (id) => ipcRenderer.invoke('forge:reveal', id),
  assetsList: () => ipcRenderer.invoke('assets:list'),
  firstRunGet: () => ipcRenderer.invoke('firstrun:get'),
  firstRunSet: (patch) => ipcRenderer.invoke('firstrun:set', patch),
  stockSearch: (opts) => ipcRenderer.invoke('stock:search', opts),
  stockThumb: (url) => ipcRenderer.invoke('stock:thumb', url),
  stockAdd: (item) => ipcRenderer.invoke('stock:add', item),
  makeScene: (opts) => ipcRenderer.invoke('scene:make', opts),
  // AI background removal: run(item) -> { matte } | { canceled } | { error }; progress: { path, stage, fraction }.
  mattingStatus: () => ipcRenderer.invoke('matting:status'),
  mattingRun: (item) => ipcRenderer.invoke('matting:run', item),
  mattingCancel: () => ipcRenderer.invoke('matting:cancel'),
  onMattingProgress: (cb) => {
    const handler = (_e, p) => cb(p);
    ipcRenderer.on('matting:progress', handler);
    return () => ipcRenderer.removeListener('matting:progress', handler);
  },
  aiTest: (draft) => ipcRenderer.invoke('ai:test', draft),
  aiModels: (draft) => ipcRenderer.invoke('ai:models', draft),
  captionsStatus: () => ipcRenderer.invoke('captions:status'),
  runCaptions: (project, opts) => ipcRenderer.invoke('captions:run', project, opts),
  runCaptionsCloud: (project, opts) => ipcRenderer.invoke('captions:runCloud', project, opts),
  testCaptionsCloud: (provider, key) => ipcRenderer.invoke('captions:testCloud', provider, key),
  onCaptionsProgress: (cb) => {
    const handler = (_e, p) => cb(p);
    ipcRenderer.on('captions:progress', handler);
    return () => ipcRenderer.removeListener('captions:progress', handler);
  },
  onExportProgress: (cb) => {
    const handler = (_e, p) => cb(p);
    ipcRenderer.on('export:progress', handler);
    return () => ipcRenderer.removeListener('export:progress', handler);
  },
});
