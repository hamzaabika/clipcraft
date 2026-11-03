// Asset pack library: a FOLDER-BACKED library (Hamza's decision — the app stays light, the
// pack never ships inside the installer). One exception, also his call: the 2026-11-01 TEST
// build bundles the merged pack as an extraResource and reads it in place when the user's
// own folder has no library yet (see readLibraryFor). The app reads one assets folder:
//
//   <assets root>/library.json     the manifest: { items: [{ name, file, group, sub, kind,
//                                  duration, dims, size, poster? }] } — file/poster are
//                                  paths relative to the root.
//   <assets root>/<group>/<sub>/…  the media and poster files themselves.
//
// The root is <userData>/clipcraft-assets, created on first use. Tests and support can point
// the app elsewhere with CLIPCRAFT_ASSETS_DIR; the smoke harness (FVE_SMOKE) gets its own
// test folder like every other userData store. Items whose file is not on disk are reported
// with `missing: true` (shown in the panel, never silently dropped), so a half-copied pack
// is visible as such. Pure path/fs logic only — the caller passes the userData dir and env.
const fs = require('fs');
const path = require('path');

// Library groups, in panel order. Music is NOT an Assets-tab group: it is integrated into
// the Audio tab's Music place instead (see src/components/PackMusic.jsx); it is listed here
// because the manifest carries it and the counts cover the whole pack. Characters, Icons
// and 3D arrived with pack 2 (2026-11-01).
const GROUPS = ['Music', 'Sound FX', 'Transitions', 'Overlays', 'Characters', 'Icons', '3D'];

function assetsRoot(userDataDir, env = process.env) {
  if (env.CLIPCRAFT_ASSETS_DIR) return path.resolve(env.CLIPCRAFT_ASSETS_DIR);
  if (env.FVE_SMOKE) return path.join(env.FVE_SMOKE, 'clipcraft-assets-test');
  return path.join(userDataDir, 'clipcraft-assets');
}

// The BUNDLED pack (test builds only): electron-builder's extraResources carry the merged
// library to <resources>/clipcraft-pack. The public design stays download-only — this is
// purely a read source for builds that ship it. CLIPCRAFT_BUNDLED_PACK_DIR points dev and
// tests at a bundle folder explicitly; otherwise the packaged location is probed. Returns
// the bundle root only when it actually holds a library.json, else null.
function bundledRoot(resourcesPath, env = process.env) {
  if (env.CLIPCRAFT_BUNDLED_PACK_DIR) {
    const p = path.resolve(env.CLIPCRAFT_BUNDLED_PACK_DIR);
    return fs.existsSync(path.join(p, 'library.json')) ? p : null;
  }
  if (resourcesPath) {
    const p = path.join(resourcesPath, 'clipcraft-pack');
    if (fs.existsSync(path.join(p, 'library.json'))) return p;
  }
  return null;
}

function ensureRoot(root) {
  fs.mkdirSync(root, { recursive: true });
  return root;
}

// Where a pack item lands when clicked: audio files go to the audio lane at the playhead,
// video and image files become overlay clips at the playhead (the Assets behaviour Hamza
// asked for — transitions and overlays are picture-in-picture material, never main-track
// replacements). Images get the app's default image duration on the overlay lane, exactly
// like an imported photo (src/store.js IMAGE_DEFAULT).
const laneFor = (item) => (item && (item.kind === 'video' || item.kind === 'image') ? 'overlay' : 'audio');

function readLibrary(root) {
  const empty = { root, hasLibrary: false, items: [], counts: {}, total: 0 };
  let raw;
  try {
    raw = fs.readFileSync(path.join(root, 'library.json'), 'utf8');
  } catch {
    return empty;
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return { ...empty, error: 'library.json is not valid JSON.' };
  }
  const list = Array.isArray(data) ? data : (Array.isArray(data.items) ? data.items : []);
  const items = [];
  for (const it of list) {
    if (!it || typeof it.file !== 'string' || !it.file) continue;
    const abs = path.resolve(root, it.file);
    if (!abs.startsWith(path.resolve(root) + path.sep)) continue; // a manifest may not escape its folder
    const posterAbs = typeof it.poster === 'string' && it.poster ? path.resolve(root, it.poster) : null;
    items.push({
      name: String(it.name || path.basename(it.file)),
      file: it.file,
      group: String(it.group || 'Other'),
      sub: String(it.sub || ''),
      kind: it.kind === 'video' ? 'video' : it.kind === 'image' ? 'image' : 'audio',
      duration: Number(it.duration) || 0,
      dims: it.dims || null,
      size: Number(it.size) || 0,
      path: abs,
      poster: posterAbs && fs.existsSync(posterAbs) ? posterAbs : null,
      missing: !fs.existsSync(abs),
    });
  }
  const groupRank = (g) => { const i = GROUPS.indexOf(g); return i < 0 ? GROUPS.length : i; };
  items.sort((a, b) => groupRank(a.group) - groupRank(b.group)
    || a.sub.localeCompare(b.sub) || a.name.localeCompare(b.name, undefined, { numeric: true }));
  const counts = {};
  for (const it of items) counts[it.group] = (counts[it.group] || 0) + 1;
  return { root, hasLibrary: true, items, counts, total: items.length };
}

// The library the panels should show. Rule: the user's own assets folder wins — if it
// holds a library.json (hand-placed), that is the library, exactly as before. Only when
// the user folder has NO library does a bundled library (test builds) become the read
// source, read in place (never copied). Writes never go to the bundle. The result gains
// `bundled: true` in the fallback case so the UI can say where the library came from.
function readLibraryFor(userDataDir, env = process.env, resourcesPath = process.resourcesPath) {
  const root = assetsRoot(userDataDir, env);
  const lib = readLibrary(root);
  if (lib.hasLibrary) return { ...lib, bundled: false };
  const bundle = bundledRoot(resourcesPath, env);
  if (bundle && path.resolve(bundle) !== path.resolve(root)) {
    const blib = readLibrary(bundle);
    if (blib.hasLibrary) return { ...blib, bundled: true, userRoot: root };
  }
  return { ...lib, bundled: false };
}

module.exports = { GROUPS, assetsRoot, ensureRoot, readLibrary, readLibraryFor, bundledRoot, laneFor };
