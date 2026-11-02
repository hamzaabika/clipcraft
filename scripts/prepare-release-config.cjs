// Release-build config generator (used by .github/workflows/release.yml and for local
// release verification): derives electron-builder.release.json from package.json's
// build config with the ONE release difference — the bundled content pack
// (build.extraResources → ../clipcraft-pack-merged) is REMOVED, so public release
// artifacts are light. The dev default in package.json is never touched.
// Run: node scripts/prepare-release-config.cjs   (writes ./electron-builder.release.json)
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const cfg = JSON.parse(JSON.stringify(pkg.build || {}));
delete cfg.extraResources;
// Deterministic installer names (the download links and release notes depend on them).
// The .deb keeps electron-builder's Debian-policy default (clipcraft_<version>_amd64.deb).
if (cfg.win) cfg.win.artifactName = 'ClipCraft-Setup-${version}.${ext}';
if (cfg.mac) cfg.mac.artifactName = 'ClipCraft-${version}.${ext}';
// Universal merge rule: the unpacked native binaries (ffmpeg / ffprobe /
// onnxruntime) are byte-identical in the x64 and arm64 trees — one installed
// copy serves both — so the merger must be told to take them from the x64
// tree instead of failing on the undeclared duplicate.
if (cfg.mac) cfg.mac.x64ArchFiles = [
  'Contents/Resources/app.asar.unpacked/node_modules/**',
  '**/app.asar.unpacked/node_modules/**',
];
const out = path.join(root, 'electron-builder.release.json');
fs.writeFileSync(out, JSON.stringify(cfg, null, 2) + '\n');
console.log(`wrote ${path.relative(root, out)} (extraResources removed: ${!('extraResources' in cfg)}, version ${pkg.version})`);
