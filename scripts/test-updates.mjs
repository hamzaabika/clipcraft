// ClipCraft update check: semver compare + the manual feed check (updates.cjs), driven with
// stub fetch implementations so no network is involved. Run: node scripts/test-updates.mjs
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { check, compare, downloadInstaller, installCommand, installDownloaded, lastDownload } = require('../electron/updates.cjs');

let fails = 0;
const eq = (got, want, label) => { const ok = got === want; if (!ok) { fails++; console.error(`MISMATCH ${label}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`); } };

// Version ordering
eq(Math.sign(compare('1.0.1', '1.0.0')), 1, 'patch newer');
eq(Math.sign(compare('1.1.0', '1.0.9')), 1, 'minor beats patch');
eq(Math.sign(compare('2.0.0', '1.9.9')), 1, 'major beats all');
eq(Math.sign(compare('1.0.0', '1.0.0')), 0, 'equal');
eq(Math.sign(compare('v1.2.0', '1.1.9')), 1, 'v prefix');
eq(Math.sign(compare('1.1.0-beta.1', '1.1.0')), -1, 'prerelease before release');
eq(Math.sign(compare('1.1.0', '1.1.0-beta.1')), 1, 'release after prerelease');
eq(Math.sign(compare('garbage', '1.0.0')), 0, 'invalid parses to 0');

const feed = (body, status = 200) => async () => ({ ok: status >= 200 && status < 300, status, json: async () => body });

// Newer version available, links gated to allowed hosts
let r = await check(feed({ version: '1.1.0', download_url: 'https://github.com/hamzaabika/clipcraft/releases/download/v1.1.0/ClipCraft-1.1.0.deb', notes_url: 'https://github.com/x/y/releases', notes: 'New packs.', release_date: '2026-11-02', size: '180 MB' }));
eq(r.newer, true, 'newer detected');
eq(r.latest, '1.1.0', 'latest parsed');
eq(r.downloadUrl, 'https://github.com/hamzaabika/clipcraft/releases/download/v1.1.0/ClipCraft-1.1.0.deb', 'download url kept');
eq(r.notes, 'New packs.', 'notes kept');

// The feed itself is served from the ClipCraft site; its links are trusted too.
r = await check(feed({ version: '1.1.0', download_url: 'https://clipcrafts.pages.dev/ClipCraft-1.1.0.deb' }));
eq(r.downloadUrl, 'https://clipcrafts.pages.dev/ClipCraft-1.1.0.deb', 'site download url kept');

// Same version -> not newer (the ONLY road to "up to date": a 200 feed answer, not newer)
r = await check(feed({ version: '1.0.0', download_url: 'https://hamzaabika.com/x' }));
eq(r.newer, false, 'same version not newer');
eq(!!r.error, false, 'same version is not an error');

// Untrusted download host -> falls back to the ClipCraft site, never the feed's host
r = await check(feed({ version: '9.9.9', download_url: 'https://evil.example/payload.exe' }));
eq(r.downloadUrl, 'https://clipcrafts.pages.dev', 'untrusted host replaced');
eq(r.notesUrl, '', 'untrusted notes dropped');

// Honest states: a failed check is an error with its reason, NEVER "up to date".
// (The old mapping 404 -> none -> green "You're up to date" hid a live 1.1.1 behind a 404.)
r = await check(feed({}, 404));
eq(!!r.error, true, '404 surfaces as error');
eq(/404/.test(r.error || ''), true, '404 reason is named');
eq(r.none, undefined, 'no none state remains');

// A host answering 200 with an HTML page (SPA fallback) is a failed check too, not a pass.
r = await check(async () => ({ ok: true, status: 200, json: async () => { throw new Error('not json'); } }));
eq(!!r.error, true, 'non-JSON 200 surfaces as error');

// Server error and offline get honest error strings
r = await check(feed({}, 500));
eq(/answered 500/.test(r.error || ''), true, '500 surfaces as error');
r = await check(async () => { throw new Error('offline'); });
eq(/No internet connection/.test(r.error || ''), true, 'offline surfaces as error');

// Malformed feed (no valid version) -> error, never a crash
r = await check(feed({ version: 'soon' }));
eq(!!r.error, true, 'invalid version surfaces as error');

// In-app download: streams to disk with progress, gated hosts, honest failures
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const payload = Buffer.alloc(100000, 7);
const streamFetch = (chunks, status = 200) => async () => ({
  ok: status >= 200 && status < 300, status,
  headers: { get: () => String(payload.length) },
  body: { getReader: () => { let i = 0; return { read: async () => (i < chunks.length ? { done: false, value: chunks[i++] } : { done: true }) }; } },
});
const destDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-dl-'));
let prog = null;
let d = await downloadInstaller('https://hamzaabika.com/clipcraft/ClipCraft-1.1.0-amd64.deb', { fetchImpl: streamFetch([payload.subarray(0, 40000), payload.subarray(40000)]), destDir, onProgress: (p) => { prog = p; } });
eq(d.fileName, 'ClipCraft-1.1.0-amd64.deb', 'download filename from URL');
eq(d.size, payload.length, 'download size matches payload');
eq(fs.readFileSync(d.path).equals(payload), true, 'downloaded bytes are exact');
eq(prog && prog.received, payload.length, 'progress reached the total');
eq(lastDownload(), d.path, 'last download recorded for open-installer');
d = await downloadInstaller('https://evil.example/payload.deb', { fetchImpl: streamFetch([]), destDir });
eq(/allowed host/.test(d.error || ''), true, 'download refuses untrusted host');
d = await downloadInstaller('http://127.0.0.1:8901/x.deb', { fetchImpl: streamFetch([]), destDir });
eq(/allowed host/.test(d.error || ''), true, 'plain-http localhost refused without the dev override');
d = await downloadInstaller('https://hamzaabika.com/x.deb', { fetchImpl: streamFetch([], 500), destDir });
eq(/answered 500/.test(d.error || ''), true, 'download surfaces server error');
// One-click install: the command is a per-platform argv array (never a shell string, so the
// path is passed exactly), and installDownloaded only ever runs against the file this app
// itself just downloaded into the downloads folder it was streamed to.
const argvEq = (got, want, label) => eq(JSON.stringify(got), JSON.stringify(want), label);
let c = installCommand('/home/u/Downloads/ClipCraft-1.1.3.deb', 'linux');
eq(c.file, 'pkexec', 'linux deb installs through pkexec');
argvEq(c.args, ['/usr/bin/apt', 'install', '-y', '/home/u/Downloads/ClipCraft-1.1.3.deb'], 'linux deb argv (apt resolves deps for a local file)');
c = installCommand('/home/u/Downloads/ClipCraft-Setup-1.1.3.exe', 'win32');
eq(c.file, '/home/u/Downloads/ClipCraft-Setup-1.1.3.exe', 'windows exe runs itself');
argvEq(c.args, ['/S'], 'windows exe is silent (NSIS /S)');
c = installCommand('/home/u/Downloads/ClipCraft-1.1.3.msi', 'win32');
eq(c.file, 'msiexec.exe', 'windows msi goes through msiexec');
argvEq(c.args, ['/i', '/home/u/Downloads/ClipCraft-1.1.3.msi', '/quiet', '/norestart'], 'windows msi argv');
eq(installCommand('/home/u/Downloads/ClipCraft-1.1.3.dmg', 'darwin'), null, 'mac dmg has no silent install (opened instead)');
eq(installCommand('/home/u/Downloads/ClipCraft-1.1.3.AppImage', 'linux'), null, 'linux non-deb has no install command');

let dl2 = await downloadInstaller('https://hamzaabika.com/clipcraft/ClipCraft-9.9.9.deb', { fetchImpl: streamFetch([payload]), destDir });
eq(!!dl2.path, true, 'second download lands for the install tests');
const spawnCalls = [];
const stubSpawn = (code, err) => (file, args) => { spawnCalls.push([file, ...args]); return { on: (ev, cb) => { if (ev === 'error' && err) cb(err); if (ev === 'close' && !err) cb(code); } }; };
let ir = await installDownloaded({ destDir, spawnImpl: stubSpawn(0), platform: 'linux' });
eq(ir.ok, true, 'install resolves ok on a clean exit');
argvEq(spawnCalls[0], ['pkexec', '/usr/bin/apt', 'install', '-y', dl2.path], 'install spawns pkexec + apt on exactly the downloaded file');
ir = await installDownloaded({ destDir, spawnImpl: stubSpawn(126), platform: 'linux' });
eq(/cancelled/.test(ir.error || ''), true, 'pkexec dismissal (126) is reported as cancelled');
ir = await installDownloaded({ destDir, spawnImpl: stubSpawn(1), platform: 'linux' });
eq(/exit 1/.test(ir.error || ''), true, 'a failed install names its exit code');
ir = await installDownloaded({ destDir, spawnImpl: stubSpawn(0, new Error('ENOENT')), platform: 'linux' });
eq(/Could not start/.test(ir.error || ''), true, 'a spawn failure is an honest error');
ir = await installDownloaded({ destDir, spawnImpl: stubSpawn(0), platform: 'darwin' });
eq(ir.unsupported, true, 'mac reports unsupported so the caller opens the file');
ir = await installDownloaded({ destDir: `${destDir}-elsewhere`, spawnImpl: stubSpawn(0), platform: 'linux' });
eq(/no longer there/.test(ir.error || ''), true, 'a file outside the downloads folder is refused');

fs.rmSync(destDir, { recursive: true, force: true });

if (fails) { console.error(`test-updates: ${fails} failure(s)`); process.exit(1); }
console.log('updates ok (compare matrix, feed states, link gating, in-app download, one-click install)');
