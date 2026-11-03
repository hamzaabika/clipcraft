// "Is there a newer ClipCraft?" — the user asks, the app answers. A check happens ONLY when the
// user clicks "Check for updates" in About (nothing runs automatically at startup). The app asks
// the update feed — a small JSON file published on the ClipCraft site (clipcrafts.pages.dev) —
// and compares versions. Nothing is sent but the request. When a newer version exists, About
// offers an IN-APP download with progress (downloadInstaller below, streamed to the user's
// Downloads folder); nothing installs itself — afterwards the user explicitly clicks
// "Open installer" and their system installer applies the update. Installing replaces only the
// app's own program files: projects, recents and settings live in the app's userData folder,
// which an install-over never touches, so an update loses nothing.
// Honest states: "up to date" is reported ONLY after a 200 answer whose version is not newer.
// Any other outcome (404, 500, offline, a non-feed answer) is an error with its reason — never
// silently dressed up as "up to date".
let app, net;
try {
  ({ app, net } = require('electron'));
} catch {
  // Plain-Node fallback so the version logic can be unit-tested outside Electron.
  app = { getVersion: () => '1.0.0' };
  net = { fetch: (...args) => fetch(...args) };
}

const SITE = 'https://clipcrafts.pages.dev';
const ENDPOINT = process.env.CLIPCRAFT_UPDATE_URL || process.env.FVE_UPDATE_URL || `${SITE}/version.json`;
// Hosts a feed link may point at: the ClipCraft site, Hamza's own site, or GitHub (release
// downloads / notes). A local CLIPCRAFT_UPDATE_URL override (development/testing only) also
// trusts localhost.
const LINK_HOSTS = ['clipcrafts.pages.dev', 'hamzaabika.com', 'www.hamzaabika.com', 'github.com'];
if (process.env.CLIPCRAFT_UPDATE_URL) LINK_HOSTS.push('127.0.0.1', 'localhost');

const fs = require('node:fs');
const path = require('node:path');

let lastDownloadPath = '';

// Streams the installer at `url` into `destDir`, reporting { received, total } as it goes.
// The URL is gated to LINK_HOSTS again here (defense in depth — the feed was already gated).
// Returns { path, fileName, size } or { error }. Nothing is executed or installed: opening
// the installer afterwards is a separate, explicit user action (openInstaller).
async function downloadInstaller(url, { fetchImpl = net.fetch, destDir, onProgress } = {}) {
  const safe = safeLink(url, LINK_HOSTS);
  if (!safe) return { error: 'The download link is not on an allowed host.' };
  if (!destDir) return { error: 'No download folder available.' };
  let base = 'ClipCraft-update';
  try { base = decodeURIComponent(new URL(safe).pathname.split('/').pop() || base) || base; } catch { /* keep default */ }
  base = base.replace(/[^\w.\- ]+/g, '_');
  if (!/\.(deb|appimage|zip|tar\.gz|exe|msi|dmg)$/i.test(base)) base += '.download';
  const dest = path.join(destDir, base);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15 * 60 * 1000); // generous cap for a ~200 MB installer
  try {
    const res = await fetchImpl(safe, { signal: ctrl.signal, credentials: 'omit', cache: 'no-store' });
    if (!res.ok) return { error: `The download server answered ${res.status}.` };
    const total = Number(res.headers?.get?.('content-length') || 0) || 0;
    const out = fs.createWriteStream(dest);
    let received = 0;
    if (res.body && typeof res.body.getReader === 'function') {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        if (!out.write(Buffer.from(value))) await new Promise((r) => out.once('drain', r));
        onProgress?.({ received, total });
      }
    } else if (res.body) {
      for await (const chunk of res.body) {
        received += chunk.length;
        if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
        onProgress?.({ received, total });
      }
    } else {
      const buf = Buffer.from(await res.arrayBuffer());
      received = buf.length;
      out.write(buf);
      onProgress?.({ received, total: total || received });
    }
    await new Promise((resolve, reject) => { out.end(resolve); out.on('error', reject); });
    lastDownloadPath = dest;
    return { path: dest, fileName: base, size: received };
  } catch (err) {
    try { fs.rmSync(dest, { force: true }); } catch { /* best effort */ }
    return { error: err?.name === 'AbortError' ? 'The download timed out.' : 'The download failed — check your connection and try again.' };
  } finally {
    clearTimeout(timer);
  }
}

// MAJOR.MINOR.PATCH with an optional -suffix; a pre-release comes before its release (1.1.0-beta.1 < 1.1.0).
function parse(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(String(v || '').trim());
  return m ? { nums: [+m[1], +m[2], +m[3]], pre: m[4] || '' } : null;
}

function compare(a, b) {
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return 0;
  for (let i = 0; i < 3; i++) if (x.nums[i] !== y.nums[i]) return x.nums[i] < y.nums[i] ? -1 : 1;
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  return x.pre.localeCompare(y.pre, 'en', { numeric: true }) < 0 ? -1 : 1;
}

const safeLink = (url, hosts) => {
  try {
    const u = new URL(url);
    // https everywhere; http is tolerated only for a localhost test server.
    const protoOk = u.protocol === 'https:' || (u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost'));
    return protoOk && hosts.includes(u.hostname) ? u.toString() : '';
  } catch {
    return '';
  }
};

// { current, latest, newer, downloadUrl, notesUrl, notes, releaseDate, size } on a valid feed
// answer, or { current, error } for ANY failure to check (non-200, offline, non-feed body).
// There is deliberately no "none" state: a check that did not succeed must never be shown as
// "up to date" (that is exactly the lie the old 404 -> none mapping told).
async function check(fetchImpl = net.fetch) {
  const current = app.getVersion();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  try {
    const res = await fetchImpl(`${ENDPOINT}${ENDPOINT.includes('?') ? '&' : '?'}platform=${process.platform}`, { signal: ctrl.signal, credentials: 'omit', cache: 'no-store' });
    if (!res.ok) return { current, error: `Couldn't check for updates — the update server answered ${res.status}.` };
    let r;
    try { r = await res.json(); } catch { return { current, error: 'Couldn\'t check for updates — the update feed did not answer with a valid feed.' }; }
    const latest = parse(r.version) ? String(r.version) : '';
    if (!latest) return { current, error: 'The update feed did not contain a valid version.' };
    return {
      current,
      latest,
      newer: compare(latest, current) > 0,
      downloadUrl: safeLink(r.download_url, LINK_HOSTS) || SITE,
      notesUrl: safeLink(r.notes_url, LINK_HOSTS),
      notes: typeof r.notes === 'string' ? r.notes.slice(0, 400) : '',
      releaseDate: typeof r.release_date === 'string' ? r.release_date : '',
      size: typeof r.size === 'string' ? r.size : '',
    };
  } catch {
    return { current, error: 'Couldn\'t check for updates — No internet connection, or the update server could not be reached.' };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { check, compare, downloadInstaller, lastDownload: () => lastDownloadPath };
