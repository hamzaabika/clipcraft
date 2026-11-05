// Dead copy pointers (2026-11-05 overlay-black bug): a media item's saved preview-copy
// paths (proxy / lightProxy / proxies[q]) are absolute cache paths persisted in the
// project file. When the cache file is deleted (cache clear, reinstall, moved userData)
// the player used to point its <video> at the dead file forever — black picture, error
// MEDIA_ERR_SRC_NOT_SUPPORTED, levelCopyState still reporting 'ready', and regeneration
// skipping string entries. pruneDeadCopies (electron/quality.cjs) is the one validation
// mechanism: main checks the disk, clears dead pointers in the renderer, and the normal
// generation paths remake the copies. This suite drives it with a fake disk, and pins
// the renderer side: once a pointer is cleared to null, previewPathFor/levelCopyState
// treat the copy as missing (fallback chain / regeneration), never as ready.
// Run: node scripts/test-proxy-pointers.mjs
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { levelCopyState, previewPathFor } from '../src/store.js';

const require = createRequire(import.meta.url);
const { pruneDeadCopies } = require('../electron/quality.cjs');

const alive = new Set(['/cache/good-qmedium.mp4', '/cache/good-proxy.mp4', '/cache/good-lproxy.mp4']);
const exists = (p) => alive.has(p);
const DEAD_Q = '/cache/gone-qmedium.mp4';

// 1) A dead quality pointer is cleared in both the working item and the renderer patch;
//    the input item is not mutated.
const item = { path: '/media/a.mp4', type: 'video', width: 1920, height: 1080, proxies: { medium: DEAD_Q } };
const r1 = pruneDeadCopies(item, exists);
assert.equal(r1.item.proxies.medium, null, 'dead quality pointer cleared on the item');
assert.equal(r1.patch.proxies.medium, null, 'patch clears the pointer in the renderer');
assert.equal(item.proxies.medium, DEAD_Q, 'input item untouched');

// 2) After the clear, the renderer treats the copy as missing: preview falls back to the
//    original file and the level state is 'fallback' (regenerating), not 'ready'.
const healed = { ...item, proxies: r1.item.proxies };
assert.equal(previewPathFor(healed, 'medium'), '/media/a.mp4', 'cleared pointer falls back to the original');
assert.equal(levelCopyState(healed, 'medium'), 'fallback', 'cleared pointer is fallback, not ready');
assert.equal(levelCopyState(item, 'medium'), 'ready', 'pre-fix truth: a string reads ready even when dead (the bug)');

// 3) Dead decode-proxy and light-proxy pointers clear the same way.
const r2 = pruneDeadCopies({ path: '/media/b.mp4', proxy: '/cache/gone-proxy.mp4', lightProxy: '/cache/gone-lproxy.mp4' }, exists);
assert.equal(r2.patch.proxy, null);
assert.equal(r2.patch.lightProxy, null);
assert.equal(r2.item.proxy, null);
assert.equal(r2.item.lightProxy, null);

// 4) Live pointers are left completely alone (no patch, no requeue churn).
assert.equal(pruneDeadCopies({ path: '/media/c.mp4', proxy: '/cache/good-proxy.mp4', proxies: { medium: '/cache/good-qmedium.mp4' } }, exists), null, 'live pointers: no-op');

// 5) `false` entries are the generation-failure STATE, not paths: untouched.
assert.equal(pruneDeadCopies({ path: '/media/d.mp4', proxies: { medium: false } }, exists), null, 'false state untouched');

// 6) Mixed map: only the dead entries clear; live entries and other fields survive.
const r3 = pruneDeadCopies({ path: '/media/e.mp4', name: 'e', proxies: { medium: DEAD_Q, low: '/cache/good-qmedium.mp4', high: false } }, exists);
assert.deepEqual(r3.item.proxies, { medium: null, low: '/cache/good-qmedium.mp4', high: false });
assert.deepEqual(r3.patch.proxies, { medium: null, low: '/cache/good-qmedium.mp4', high: false });
assert.equal(r3.item.name, 'e');

// 7) Degenerate inputs never throw and never patch.
assert.equal(pruneDeadCopies(null, exists), null);
assert.equal(pruneDeadCopies({ path: '/media/f.mp4' }, exists), null);
assert.equal(pruneDeadCopies({ path: '/media/g.mp4', proxy: '' }, exists), null, 'empty string is not a pointer');

console.log('proxy-pointers OK: dead copy pointers pruned (quality + decode + light), live/false untouched, renderer falls back after clear');
