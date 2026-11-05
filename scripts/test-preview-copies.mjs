// Preview copies (QA audit #2, 2026-11-05 — the main-track black-screen fixes):
// RC1: needsProxy (electron/ffmpeg.cjs) was container-blind — h264/vp9/av1 8-bit 4:2:0
// inside .mkv/.avi/.ts/... got NO preview copy, so the player was pointed at a file
// Chromium cannot demux (AVI: MEDIA_ERR_SRC_NOT_SUPPORTED forever; MKV: metadata and
// audio load, frames may never paint). The predicate now fires for hostile containers
// whatever the codec, and src/store.js needsPreviewCopy must agree with it exactly.
// RC2: an existing path at a copy location was trusted as a valid copy (a DIRECTORY at
// the copy path was handed to the player as "ready"); cache hits and pruning now
// require a usable file (regular, non-empty), and a freshly generated copy is probed —
// it must carry a video stream covering >= 85% of the source duration (ffmpeg exits 0
// on partially-decoded corrupt sources), else generation counts as failed.
// Run: node scripts/test-preview-copies.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { needsPreviewCopy } from '../src/store.js';

const require = createRequire(import.meta.url);
const { needsProxy, usableCopyFile, makeProxy, probe, ffmpegPath } = require('../electron/ffmpeg.cjs');
const { pruneDeadCopies } = require('../electron/quality.cjs');

// ---- RC1: the decodability table — main predicate and renderer mirror must agree.
const V = (over) => ({ type: 'video', path: '/media/clip.mp4', vcodec: 'h264', pixFmt: 'yuv420p', profile: 'High', width: 640, height: 360, hdr: false, duration: 6, ...over });
const table = [
  [V({}), false, 'h264 mp4 baseline'],
  [V({ path: '/media/clip.mkv' }), true, 'h264 in MKV (container)'],
  [V({ path: '/media/clip.avi' }), true, 'h264 in AVI (container)'],
  [V({ path: '/media/clip.ts' }), true, 'h264 in TS (container)'],
  [V({ path: '/media/clip.m2ts' }), true, 'h264 in M2TS (container)'],
  [V({ path: '/media/clip.flv' }), true, 'h264 in FLV (container)'],
  [V({ path: '/media/clip.wmv' }), true, 'h264 in WMV (container)'],
  [V({ path: '/media/clip.MKV' }), true, 'uppercase extension still counts'],
  [V({ vcodec: 'hevc' }), true, 'HEVC mp4'],
  [V({ path: '/media/clip.mov', vcodec: 'hevc' }), true, 'HEVC mov'],
  [V({ vcodec: 'hevc', pixFmt: 'yuv420p10le', profile: 'Main 10' }), true, 'HEVC 10-bit'],
  [V({ pixFmt: 'yuv420p10le', profile: 'High 10' }), true, 'h264 10-bit'],
  [V({ pixFmt: 'yuv422p' }), true, 'h264 4:2:2'],
  [V({ vcodec: 'prores', pixFmt: 'yuv422p10le' }), true, 'ProRes'],
  [V({ vcodec: 'av1' }), false, 'AV1 mp4 decodes in Chromium'],
  [V({ path: '/media/clip.webm', vcodec: 'vp9' }), false, 'VP9 webm'],
  [V({ vcodec: 'vp9' }), false, 'VP9 mp4'],
  [V({ vcodec: 'vp8', path: '/media/clip.webm' }), false, 'VP8 webm'],
  [V({ width: 3840, height: 2160 }), true, '4K h264 (size)'],
  [V({ hdr: true }), true, 'HDR'],
  [V({ type: 'audio', vcodec: '' }), false, 'audio never needs a video copy'],
  [V({ type: 'image', vcodec: '' }), false, 'images never need a copy'],
];
for (const [info, want, label] of table) {
  assert.equal(needsProxy(info), want, `needsProxy: ${label}`);
  assert.equal(needsPreviewCopy(info), want, `needsPreviewCopy mirror: ${label}`);
  assert.equal(needsProxy(info), needsPreviewCopy(info), `agreement: ${label}`);
}

// ---- RC2: usable-file validation (real disk).
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-copies-'));
const realFile = path.join(tmp, 'real.mp4');
fs.writeFileSync(realFile, Buffer.alloc(128, 7));
const emptyFile = path.join(tmp, 'empty.mp4');
fs.writeFileSync(emptyFile, '');
const dirPath = path.join(tmp, 'dir.mp4');
fs.mkdirSync(dirPath);
assert.equal(usableCopyFile(realFile), true, 'a real non-empty file is usable');
assert.equal(usableCopyFile(emptyFile), false, 'a zero-byte stub is not a copy');
assert.equal(usableCopyFile(dirPath), false, 'a directory at the copy path is not a copy');
assert.equal(usableCopyFile(path.join(tmp, 'gone.mp4')), false, 'a missing path is not a copy');

// pruneDeadCopies with the strict "usable" predicate: the directory entry is pruned
// exactly like a missing file; a usable pointer survives.
const usable = new Set([realFile]);
const pruned = pruneDeadCopies(
  { path: '/media/a.mkv', proxy: dirPath, lightProxy: realFile, proxies: { medium: emptyFile, low: realFile } },
  (p) => usable.has(p),
);
assert.equal(pruned.item.proxy, null, 'directory pointer pruned');
assert.equal(pruned.item.lightProxy, realFile, 'usable pointer kept');
assert.equal(pruned.item.proxies.medium, null, 'empty-stub pointer pruned');
assert.equal(pruned.item.proxies.low, realFile, 'usable quality pointer kept');

// ---- RC2 end-to-end: makeProxy against a poisoned cache + a corrupt source.
const cache = path.join(tmp, 'cache');
fs.mkdirSync(cache, { recursive: true });
const hevc = path.join(tmp, 'phone.mp4');
execFileSync(ffmpegPath, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30:duration=4',
  '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4', '-shortest', '-c:v', 'libx265', '-pix_fmt', 'yuv420p', '-tag:v', 'hvc1', '-c:a', 'aac', hevc]);
const item = { path: hevc, ...(await probe(hevc)) };
assert.equal(needsProxy(item), true, 'the HEVC fixture needs a copy');
// Poison the exact cache path makeProxy will compute (same key recipe) with a directory.
const st = fs.statSync(hevc);
const key = require('crypto').createHash('sha1').update(`${hevc}|${st.size}|${st.mtimeMs}|proxy1`).digest('hex').slice(0, 16);
const copyPath = path.join(cache, `${key}-proxy.mp4`);
fs.mkdirSync(copyPath);
const made = await makeProxy(item, cache);
assert.equal(made, copyPath, 'makeProxy returns the copy path');
assert.ok(usableCopyFile(made), 'the poisoned directory was replaced by a real copy file');
const copyInfo = await probe(made);
assert.equal(copyInfo.vcodec, 'h264', 'the copy is h264 (Chromium-decodable)');
assert.ok(copyInfo.duration >= item.duration * 0.85, 'the copy covers the source duration');
assert.equal(await makeProxy(item, cache), copyPath, 'a second call is a cache hit on the validated copy');

// A copy that would come out incomplete counts as failure: corrupt the source's tail
// (moov is at the front via faststart, so probe still reads 6 s) and demand a copy.
const corrupt = path.join(tmp, 'corrupt.mp4');
execFileSync(ffmpegPath, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30:duration=6',
  '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6', '-shortest', '-c:v', 'libx265', '-pix_fmt', 'yuv420p', '-tag:v', 'hvc1', '-c:a', 'aac', '-movflags', '+faststart', corrupt]);
const data = fs.readFileSync(corrupt);
fs.writeFileSync(corrupt, data.subarray(0, Math.floor(data.length * 0.3)));
const corruptItem = { path: corrupt, ...(await probe(corrupt)) };
assert.ok(corruptItem.duration > 5, 'probe still reports the full duration');
await assert.rejects(() => makeProxy(corruptItem, cache), /incomplete|error/i, 'a partial copy is a failed generation, not a silent success');

fs.rmSync(tmp, { recursive: true, force: true });
console.log('PREVIEW COPIES OK');
