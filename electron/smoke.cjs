// Automated UI smoke test: FVE_SMOKE=<dir> electron .
// Loads <dir>/project.json, drives the UI through the test hook, takes screenshots and
// exports the edited project to <dir>/ui-export.mp4.
const fs = require('fs');
const path = require('path');
const { runExport, probe } = require('./ffmpeg.cjs');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = async function smoke(win, app, dir) {
  const wc = win.webContents;
  const shot = async (name) => fs.writeFileSync(path.join(dir, name), (await win.capturePage()).toPNG());
  const run = (js) => wc.executeJavaScript(js);
  const errors = [];
  wc.on('console-message', (_e, level, msg) => level >= 2 && errors.push(msg));
  const result = { errors };
  if (process.env.FVE_SMOKE_MODE === 'templates-pack' || process.env.FVE_SMOKE_MODE === 'templates-use') {
    // Templates. "pack": build a small project from generated clips, mark two clips replaceable and write the
    // package (plus preview.mp4) into <dir>/packages. "use": with FVE_TEMPLATES_URL pointing at a local copy of the
    // site that publishes it, open it from the Templates tab and replace a clip (the file dialog is answered here).
    const q = run;
    const until = async (js, ms = 20000) => { for (let t = 0; t < ms; t += 250) { if (await q(js)) return true; await wait(250); } return false; };
    const { execFileSync } = require('child_process');
    const ff = require('./ffmpeg.cjs').ffmpegPath;
    const media = path.join(dir, 'media');
    fs.mkdirSync(media, { recursive: true });
    const clipA = path.join(media, 'clip-a.mp4');
    const clipB = path.join(media, 'clip-b.mp4');
    const photo = path.join(media, 'mine.png');
    if (!fs.existsSync(clipA)) {
      execFileSync(ff, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=360x640:rate=30:duration=3', '-pix_fmt', 'yuv420p', clipA]);
      execFileSync(ff, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'smptebars=size=360x640:rate=30:duration=3', '-pix_fmt', 'yuv420p', clipB]);
      execFileSync(ff, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=0xff3d8b:size=360x640', '-frames:v', '1', photo]);
    }
    try {
      await wait(800);
      if (process.env.FVE_SMOKE_MODE === 'templates-pack') {
        const items = await q(`window.api.probePaths(${JSON.stringify([clipA, clipB])})`);
        const p = {
          name: 'Smoke trip', ratio: '9:16', resolution: 720, width: 720, height: 1280, fps: 30, background: '#000000',
          media: items.map((m, i) => ({ ...m, id: `m${i}` })),
          videoClips: [
            { id: 'v1', mediaId: 'm0', in: 0, out: 1.5, speed: 1, volume: 1, filter: 'none', adjust: {}, effects: [], transition: null },
            { id: 'v2', mediaId: 'm1', in: 0, out: 1, speed: 1, volume: 1, filter: 'none', adjust: {}, effects: [], transition: null },
            { id: 'v3', mediaId: 'm0', in: 1, out: 2, speed: 1, volume: 1, filter: 'none', adjust: {}, effects: [], transition: null },
          ],
          overlayClips: [], textClips: [{ id: 't1', text: 'Summer', start: 0, duration: 3.5, y: 0.5 }], audioClips: [], stickerClips: [], effectClips: [],
        };
        result.at='load';
      await q(`window.__fve.load(${JSON.stringify(p)})`);
        await wait(300);
        await q(`window.__fve.dispatch({ type: 'updateMany', updates: [{ track: 'video', id: 'v1', patch: { slot: true } }, { track: 'video', id: 'v3', patch: { slot: true } }] })`);
        await wait(300);
        result.badges = await q(`document.querySelectorAll('.clip.replaceable .rep-badge').length`);
        result.strip = await q(`document.querySelectorAll('.ts-strip .ts-slot').length`);
        await shot('tpl-1-marked.png');
        await q(`document.querySelector('.export-split .caret').click()`);
        await wait(200);
        // W1 (2026-11-01): the Export menu no longer offers "Template package…" (Hamza's
        // order) — assert its absence, then exercise the retained package writer through
        // its IPC directly, exactly as the removed menu entry did.
        result.menuHasTemplate = await q(`[...document.querySelectorAll('.ctx-menu button, [role=menu] button, .context-menu button')].some((b) => /Template package/.test(b.textContent))`);
        await q(`document.body.click()`);
        const packRes = await q(`(async () => { const p = window.__fve.exportData().project; const meta = { ratio: p.ratio, width: p.width, height: p.height, duration: 3.5, slots: 2 }; return window.api.templatesPack(JSON.stringify(p), meta); })()`);
        result.ready = !!(packRes && !packRes.error && packRes.dir);
        const parent = path.join(dir, 'packages');
        const pkg = path.join(parent, fs.readdirSync(parent)[0]);
        fs.copyFileSync(clipA, path.join(pkg, 'preview.mp4'));
        result.package = fs.readdirSync(pkg).sort();
        result.meta = JSON.parse(fs.readFileSync(path.join(pkg, 'template.json'), 'utf8')).meta;
        await shot('tpl-2-package.png');
      } else {
        const { dialog } = require('electron');
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [photo] });
        await q(`window.__fve.tab('templates')`);
        result.cards = await until(`document.querySelectorAll('.tst-grid .tst-card').length > 0`);
        result.thumb = await until(`!!document.querySelector('.tst-grid .tst-card img')`);
        result.categories = await q(`[...document.querySelectorAll('.side-nav .side-btn')].map((b) => b.textContent.trim())`);
        if (!result.cards) result.panel = await q(`document.querySelector('.library').innerText.slice(0, 400)`);
        await shot('tpl-3-store.png');
        await q(`document.querySelector('.tst-grid .tst-card').click()`);
        result.preview = await until(`(document.querySelector('.tst-player video')?.readyState || 0) >= 2`);
        result.detail = await q(`document.querySelector('.tst-info')?.innerText`);
        await shot('tpl-4-detail.png');
        await q(`[...document.querySelectorAll('.tst-info .btn')].find((b) => /Use template/.test(b.textContent)).click()`);
        result.loaded = await until(`window.__fve.exportData().project.videoClips.length === 3 && document.querySelectorAll('.ts-strip .ts-slot').length === 2`, 30000);
        const before = await q(`window.__fve.exportData().project.videoClips.map((c) => (c.out - c.in) / (c.speed || 1))`);
        await q(`document.querySelector('.ts-strip .ts-replace').click()`);
        result.replaced = await until(`window.__fve.exportData().project.videoClips[0].filled === true`);
        const after = await q(`window.__fve.exportData().project`);
        result.newMedia = after.media.find((m) => m.id === after.videoClips[0].mediaId)?.name;
        result.lengthKept = Math.abs((after.videoClips[0].out - after.videoClips[0].in) / (after.videoClips[0].speed || 1) - before[0]) < 1e-6;
        result.mediaFromCache = after.media.filter((m) => m.path.includes('templates-test')).length;
        result.textKept = after.textClips[0]?.text;
        result.saveState = await q(`document.querySelector('.save-state')?.textContent || ''`);
        await wait(2500);
        await shot('tpl-5-replaced.png');
      }
    } catch (e) {
      result.error = e.message;
    }
    fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(result, null, 2));
    return app.quit();
  }
  if (process.env.FVE_SMOKE_MODE === 'restore') {
    // A session that ended without saving: the next start offers the project back.
    try {
      const q = run;
      await wait(800);
      const p = JSON.parse(fs.readFileSync(path.join(dir, 'project.json'), 'utf8'));
      await q(`localStorage.setItem('clipcraft.recovery', ${JSON.stringify(JSON.stringify({ savedAt: Date.now() - 60000, project: { ...p, name: 'Lost trip' }, file: null, unsaved: true }))})`);
      await new Promise((r) => { wc.once('did-finish-load', r); wc.reload(); });
      await wait(1500);
      result.banner = await q(`document.querySelector('.recovered-note')?.innerText || null`);
      await shot('restore-1-banner.png');
      await q(`[...document.querySelectorAll('.recovered-note .btn')].find((b) => b.textContent === 'Restore').click()`);
      await wait(400);
      result.restoredName = await q(`window.__fve.exportData().project.name`);
      result.bannerGone = await q(`!document.querySelector('.recovered-note')`);
    } catch (e) {
      result.error = e.message;
    }
    fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(result, null, 2));
    return app.quit();
  }
  if (process.env.FVE_SMOKE_MODE === 'overlay') {
    // Overlay (PIP) preview picture (2026-11-05 bug: overlay video shows black in the
    // Preview while sound works). Fixture: colourful main clip 0..12 s + a SOLID RED
    // overlay clip at start 3, length 6 (in 0..6), centred half-size — any decoded
    // overlay frame is unmistakably red, a missing frame is black. Evidence is read
    // off the overlay <video> element itself: drawImage into a canvas and sample the
    // pixels (a video element only paints its current decoded frame), plus
    // readyState / currentTime / src for the mechanism.
    const q = run;
    const until = async (js, ms = 20000) => { for (let t = 0; t < ms; t += 250) { if (await q(js)) return true; await wait(250); } return false; };
    const { execFileSync } = require('child_process');
    const ff = require('./ffmpeg.cjs').ffmpegPath;
    const probe = require('./ffmpeg.cjs').probe;
    const sampleJs = (sel) => `(() => {
      const v = document.querySelector('${sel}');
      if (!v) return { found: false };
      const out = { found: true, src: (v.getAttribute('src') || '').split('/').pop(),
        readyState: v.readyState, videoWidth: v.videoWidth, videoHeight: v.videoHeight,
        currentTime: +v.currentTime.toFixed(3), paused: v.paused,
        display: getComputedStyle(v).display,
        slotVis: v.closest('.slot') ? getComputedStyle(v.closest('.slot')).visibility : null };
      try {
        const cv = document.createElement('canvas'); cv.width = 32; cv.height = 32;
        const ctx = cv.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(v, 0, 0, 32, 32);
        const all = ctx.getImageData(0, 0, 32, 32).data;
        let r = 0, g = 0, b = 0;
        for (let i = 0; i < all.length; i += 4) { r += all[i]; g += all[i + 1]; b += all[i + 2]; }
        const n = 32 * 32;
        out.mean = [+((r / n)).toFixed(1), +((g / n)).toFixed(1), +((b / n)).toFixed(1)];
      } catch (e) { out.sampleError = e.message; }
      return out;
    })()`;
    try {
      const mediaDir = path.join(dir, 'media');
      fs.mkdirSync(mediaDir, { recursive: true });
      const mainSrc = path.join(mediaDir, 'main.mp4');
      const ovSrc = path.join(mediaDir, 'overlay-red.mp4');
      if (!fs.existsSync(mainSrc)) {
        execFileSync(ff, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=360x640:rate=30:duration=12',
          '-f', 'lavfi', '-i', 'sine=frequency=440:duration=12', '-shortest', '-pix_fmt', 'yuv420p', mainSrc]);
      }
      if (!fs.existsSync(ovSrc)) {
        execFileSync(ff, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=0xff0000:size=360x640:rate=30:duration=6',
          '-f', 'lavfi', '-i', 'sine=frequency=880:duration=6', '-shortest', '-pix_fmt', 'yuv420p', ovSrc]);
      }
      await wait(800);
      // Enter the editor (fresh profiles start on Home; the tour must be dismissed first).
      await q(`(() => { const b = document.querySelector('button[aria-label="New 16:9 project"]'); if (b) b.click(); return !!b; })()`).catch(() => {});
      result.editorReady = await until(`!!document.querySelector('.play-btn')`, 15000);
      await q(`(() => { const b = document.querySelector('button[aria-label="Skip tour"]') || [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Start creating'); if (b) b.click(); return !!b; })()`).catch(() => {});
      await wait(600);
      const mMain = await probe(mainSrc);
      const mOv = await probe(ovSrc);
      const p = {
        name: 'Overlay smoke', ratio: '9:16', resolution: 720, width: 360, height: 640, fps: 30, background: '#000000',
        media: [
          { id: 'm0', path: mainSrc, name: 'main.mp4', ...mMain },
          { id: 'm1', path: ovSrc, name: 'overlay-red.mp4', ...mOv },
        ],
        videoClips: [{ id: 'v1', mediaId: 'm0', in: 0, out: 12, speed: 1, volume: 1, muted: false, filter: 'none', adjust: {}, effects: [], transition: null }],
        overlayClips: [{ id: 'ov1', mediaId: 'm1', in: 0, out: 6, start: 3, speed: 1, volume: 1, muted: false, filter: 'none', adjust: {}, effects: [], transition: null, transform: { scale: 0.5, x: 0, y: 0 } }],
        audioClips: [], stickerClips: [], effectClips: [], textClips: [],
      };
      await q(`window.__fve.load(${JSON.stringify(p)})`);
      await wait(500);
      // A. Paused seek INSIDE the overlay range (t=5 -> overlay local 2.0).
      await q(`window.__fve.seek(5)`);
      result.ovReadyA = await until(`(() => { const v = document.querySelector('.slot.ov video'); return v && v.readyState >= 2 && Math.abs(v.currentTime - 2) < 0.3; })()`, 12000);
      await wait(600);
      result.seek5 = await q(sampleJs('.slot.ov video'));
      result.main5 = await q(sampleJs('.stage .slot:not(.ov) video'));
      await shot('ov-1-seek5.png');
      // B. Paused seek OUTSIDE the overlay range (t=1): slot must hide.
      await q(`window.__fve.seek(1)`);
      await wait(600);
      result.seek1 = await q(sampleJs('.slot.ov video'));
      // C. Paused seek near the overlay end (t=8.5 -> local 5.5).
      await q(`window.__fve.seek(8.5)`);
      result.ovReadyC = await until(`(() => { const v = document.querySelector('.slot.ov video'); return v && v.readyState >= 2 && Math.abs(v.currentTime - 5.5) < 0.3; })()`, 12000);
      await wait(600);
      result.seek85 = await q(sampleJs('.slot.ov video'));
      await shot('ov-2-seek85.png');
      // D. Play from inside the range, let it actually advance, then pause and sample.
      await q(`window.__fve.seek(4); window.__fve.play()`);
      result.playAdvanced = await until(`(() => { const v = document.querySelector('.slot.ov video'); return v && !v.paused && v.currentTime > 1.6; })()`, 15000);
      await q(`window.__fve.pause()`);
      await wait(500);
      result.afterPlay = await q(sampleJs('.slot.ov video'));
      await shot('ov-3-after-play.png');
      if (process.env.FVE_SMOKE_OV_VARIANT === 'stale') {
        // Stale-proxy variant: the overlay's OWN media (distinct from main) carries a
        // saved proxies.medium path whose file does NOT exist on disk (cache cleared /
        // moved). Quality is medium (seeded by the runner). Question: does the overlay
        // element sit on the dead URL forever while the main track plays fine?
        const bigSrc = path.join(mediaDir, 'big.mp4');
        if (!fs.existsSync(bigSrc)) {
          execFileSync(ff, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=30:duration=12',
            '-f', 'lavfi', '-i', 'sine=frequency=440:duration=12', '-shortest', '-pix_fmt', 'yuv420p', bigSrc]);
        }
        const bigItem = { id: 'm1', path: bigSrc, name: 'big.mp4', ...(await probe(bigSrc)),
          proxies: { medium: path.join(dir, 'media-cache-test', 'deadbeefdeadbeef-qmedium.mp4') } };
        const p = {
          name: 'Stale proxy overlay', ratio: '9:16', resolution: 720, width: 360, height: 640, fps: 30, background: '#000000',
          media: [{ id: 'm0', path: mainSrc, name: 'main.mp4', ...mMain }, bigItem],
          videoClips: [{ id: 'v1', mediaId: 'm0', in: 0, out: 12, speed: 1, volume: 1, muted: false, filter: 'none', adjust: {}, effects: [], transition: null }],
          overlayClips: [{ id: 'ov1', mediaId: 'm1', in: 0, out: 12, start: 3, speed: 1, volume: 1, muted: false, filter: 'none', adjust: {}, effects: [], transition: null, transform: { scale: 0.5, x: 0, y: 0 } }],
          audioClips: [], stickerClips: [], effectClips: [], textClips: [],
        };
        await q(`window.__fve.load(${JSON.stringify(p)})`);
        await wait(400);
        await q(`window.__fve.seek(5)`);
        await wait(2000);
        result.staleEarly = await q(sampleJs('.slot.ov video'));
        result.staleEarlyErr = await q(`(() => { const v = document.querySelector('.slot.ov video'); return v ? { error: v.error ? v.error.code : null, networkState: v.networkState } : null; })()`);
        // Give the background pipeline every chance to heal it.
        await wait(15000);
        await q(`window.__fve.seek(6)`);
        await wait(1500);
        result.staleLate = await q(sampleJs('.slot.ov video'));
        result.staleLateErr = await q(`(() => { const v = document.querySelector('.slot.ov video'); return v ? { error: v.error ? v.error.code : null, networkState: v.networkState } : null; })()`);
        result.staleMediaLate = await q(`window.__fve.exportData().project.media.find((m) => m.id === 'm1')?.proxies`);
        result.staleMain = await q(sampleJs('.stage .slot:not(.ov) video'));
        await shot('ov-14-stale.png');
      }
      if (process.env.FVE_SMOKE_OV_VARIANT === 'exact') {
        // Exact variant: Hamza's Untitled.clipcraft.json configuration verbatim (only
        // durations scaled to a local 42 s 1920x1080 file): same media on both tracks,
        // main with blur + scale keyframes + x offset, overlay full-length with his
        // crop and 2.61 scale, project 1080x1920, quality medium (seeded by runner).
        // Seeks sweep the whole range; every sample is 1.5 s after the seek.
        const bigSrc = path.join(mediaDir, 'big42.mp4');
        if (!fs.existsSync(bigSrc)) {
          execFileSync(ff, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=30:duration=42',
            '-f', 'lavfi', '-i', 'sine=frequency=440:duration=42', '-shortest', '-pix_fmt', 'yuv420p', bigSrc]);
        }
        const mBig = await probe(bigSrc);
        const sampleCanvas = `(() => {
          const cv = document.querySelector('.slot.ov canvas.keyed');
          if (!cv) return { found: false };
          const out = { found: true, display: getComputedStyle(cv).display, w: cv.width, h: cv.height };
          try {
            const c2 = document.createElement('canvas'); c2.width = 32; c2.height = 32;
            const ctx = c2.getContext('2d', { willReadFrequently: true });
            ctx.drawImage(cv, 0, 0, 32, 32);
            const all = ctx.getImageData(0, 0, 32, 32).data;
            let r = 0, g = 0, b = 0, a = 0;
            for (let i = 0; i < all.length; i += 4) { r += all[i]; g += all[i + 1]; b += all[i + 2]; a += all[i + 3]; }
            const n = 32 * 32;
            out.mean = [+((r / n)).toFixed(1), +((g / n)).toFixed(1), +((b / n)).toFixed(1), +((a / n)).toFixed(1)];
          } catch (e) { out.sampleError = e.message; }
          return out;
        })()`;
        const p = {
          name: 'Untitled', ratio: '9:16', resolution: 1080, width: 1080, height: 1920, fps: 30, background: '#000000',
          media: [{ id: 'mB', path: bigSrc, name: 'big42.mp4', ...mBig }],
          videoClips: [{ id: 'tdcrjt4u', mediaId: 'mB', in: 0, out: 42, speed: 1, volume: 1, muted: false, filter: 'none', adjust: {}, effects: ['blur'], transition: null,
            keyframes: { scale: [{ t: 0, v: 3.66, e: 'smooth' }] },
            transform: { scale: 1, scaleX: 1, scaleY: 1, uniform: true, x: 0.048309178743961324, y: 0, rot: 0 }, layer: 0, fxRegions: {} }],
          overlayClips: [{ id: 'byztdhhf', mediaId: 'mB', in: 0, out: 42, speed: 1, volume: 1, muted: false, filter: 'none', adjust: {}, effects: [], transition: null, start: 0,
            transform: { scale: 2.61, scaleX: 1, scaleY: 1, uniform: true, x: 0, y: 0, rot: 0 }, layer: 0,
            crop: { l: 0, t: 0.16234715289817364, r: 0, b: 0.14005925706556877 }, cropAspect: 'free', keyframes: {} }],
          audioClips: [], stickerClips: [], effectClips: [], textClips: [],
        };
        await q(`window.__fve.load(${JSON.stringify(p)})`);
        await wait(400);
        result.proxyLanded = await until(`(() => { const m = window.__fve.exportData().project.media[0]; return typeof m.proxies?.medium === 'string'; })()`, 120000);
        await wait(1000);
        result.sweep = {};
        for (const t of [0.5, 5, 13, 21, 30, 41]) {
          await q(`window.__fve.seek(${t})`);
          await wait(1500);
          result.sweep[t] = { video: await q(sampleJs('.slot.ov video')), canvas: await q(sampleCanvas) };
        }
        await shot('ov-12-exact.png');
        // Play for a while from 20 s, pause, sample.
        await q(`window.__fve.seek(20); window.__fve.play()`);
        result.playAdvanced = await until(`(() => { const v = document.querySelector('.slot.ov video'); return v && !v.paused && v.currentTime > 22; })()`, 20000);
        await q(`window.__fve.pause()`);
        await wait(600);
        result.exactAfterPlay = { video: await q(sampleJs('.slot.ov video')), canvas: await q(sampleCanvas) };
        await shot('ov-13-exact-play.png');
      }
      if (process.env.FVE_SMOKE_OV_VARIANT === 'medium') {
        // Medium variant — Hamza's Untitled project end to end: playback quality is
        // 'medium' (seeded via settings-test/settings.json by the runner), the SAME
        // 1080p file sits on main (blur effect + scale keyframes) and on the overlay
        // (cropped top/bottom, scale 2.61). Samples before and after the medium
        // quality proxy lands and the elements swap files.
        const bigSrc = path.join(mediaDir, 'big.mp4');
        if (!fs.existsSync(bigSrc)) {
          execFileSync(ff, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=30:duration=12',
            '-f', 'lavfi', '-i', 'sine=frequency=440:duration=12', '-shortest', '-pix_fmt', 'yuv420p', bigSrc]);
        }
        const mBig = await probe(bigSrc);
        const sampleCanvas = `(() => {
          const cv = document.querySelector('.slot.ov canvas.keyed');
          if (!cv) return { found: false };
          const out = { found: true, display: getComputedStyle(cv).display, w: cv.width, h: cv.height };
          try {
            const c2 = document.createElement('canvas'); c2.width = 32; c2.height = 32;
            const ctx = c2.getContext('2d', { willReadFrequently: true });
            ctx.drawImage(cv, 0, 0, 32, 32);
            const all = ctx.getImageData(0, 0, 32, 32).data;
            let r = 0, g = 0, b = 0, a = 0;
            for (let i = 0; i < all.length; i += 4) { r += all[i]; g += all[i + 1]; b += all[i + 2]; a += all[i + 3]; }
            const n = 32 * 32;
            out.mean = [+((r / n)).toFixed(1), +((g / n)).toFixed(1), +((b / n)).toFixed(1), +((a / n)).toFixed(1)];
          } catch (e) { out.sampleError = e.message; }
          return out;
        })()`;
        const p = {
          name: 'Medium overlay', ratio: '9:16', resolution: 1080, width: 1080, height: 1920, fps: 30, background: '#000000',
          media: [{ id: 'mB', path: bigSrc, name: 'big.mp4', ...mBig }],
          videoClips: [{ id: 'v1', mediaId: 'mB', in: 0, out: 12, speed: 1, volume: 1, muted: false, filter: 'none', adjust: {}, effects: ['blur'], transition: null,
            keyframes: { scale: [{ t: 0, v: 3.66, e: 'smooth' }] }, transform: { scale: 1, scaleX: 1, scaleY: 1, uniform: true, x: 0.048, y: 0, rot: 0 }, layer: 0, fxRegions: {} }],
          overlayClips: [{ id: 'ov1', mediaId: 'mB', in: 0, out: 12, start: 0, speed: 1, volume: 1, muted: false, filter: 'none', adjust: {}, effects: [], transition: null,
            transform: { scale: 2.61, scaleX: 1, scaleY: 1, uniform: true, x: 0, y: 0, rot: 0 }, layer: 0, keyframes: {},
            crop: { l: 0, t: 0.16234715289817364, r: 0, b: 0.14005925706556877 }, cropAspect: 'free' }],
          audioClips: [], stickerClips: [], effectClips: [], textClips: [],
        };
        await q(`window.__fve.load(${JSON.stringify(p)})`);
        await wait(400);
        result.qualityShown = await q(`document.querySelector('.transport')?.innerText?.slice(0, 200) || ''`);
        await q(`window.__fve.seek(5)`);
        await wait(1200);
        result.medEarlyVideo = await q(sampleJs('.slot.ov video'));
        result.medEarlyCanvas = await q(sampleCanvas);
        // Wait for the medium proxy to land on the media item (background generation).
        result.proxyLanded = await until(`(() => { const m = window.__fve.exportData().project.media[0]; return typeof m.proxies?.medium === 'string'; })()`, 90000);
        await wait(800);
        await q(`window.__fve.seek(5)`);
        await wait(1200);
        result.medLateVideo = await q(sampleJs('.slot.ov video'));
        result.medLateCanvas = await q(sampleCanvas);
        result.medLateMain = await q(sampleJs('.stage .slot:not(.ov) video'));
        await shot('ov-10-medium.png');
        // Seek again after the swap, to a different position.
        await q(`window.__fve.seek(9)`);
        await wait(1200);
        result.medSeek9Video = await q(sampleJs('.slot.ov video'));
        result.medSeek9Canvas = await q(sampleCanvas);
        await shot('ov-11-medium9.png');
      }
      if (process.env.FVE_SMOKE_OV_VARIANT === 'crop') {
        // Crop variant — Hamza's real project shape (Untitled.clipcraft.json): the SAME
        // 1080p file on main + overlay, the overlay clip CROPPED (top/bottom) and scaled
        // 2.61x. A cropped overlay takes the keyed-canvas path (video element hidden,
        // canvas shows the frame). Evidence samples BOTH the video element and the
        // canvas that is actually on screen.
        const bigSrc = path.join(mediaDir, 'big.mp4');
        if (!fs.existsSync(bigSrc)) {
          execFileSync(ff, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=30:duration=12',
            '-f', 'lavfi', '-i', 'sine=frequency=440:duration=12', '-shortest', '-pix_fmt', 'yuv420p', bigSrc]);
        }
        const mBig = await probe(bigSrc);
        const item = { id: 'mB', path: bigSrc, name: 'big.mp4', ...mBig };
        const sampleCanvas = `(() => {
          const cv = document.querySelector('.slot.ov canvas.keyed');
          if (!cv) return { found: false };
          const out = { found: true, display: getComputedStyle(cv).display, w: cv.width, h: cv.height };
          try {
            const c2 = document.createElement('canvas'); c2.width = 32; c2.height = 32;
            const ctx = c2.getContext('2d', { willReadFrequently: true });
            ctx.drawImage(cv, 0, 0, 32, 32);
            const all = ctx.getImageData(0, 0, 32, 32).data;
            let r = 0, g = 0, b = 0, a = 0;
            for (let i = 0; i < all.length; i += 4) { r += all[i]; g += all[i + 1]; b += all[i + 2]; a += all[i + 3]; }
            const n = 32 * 32;
            out.mean = [+((r / n)).toFixed(1), +((g / n)).toFixed(1), +((b / n)).toFixed(1), +((a / n)).toFixed(1)];
          } catch (e) { out.sampleError = e.message; }
          return out;
        })()`;
        const mkProj = (crop, extra = {}) => ({
          name: 'Crop overlay', ratio: '9:16', resolution: 720, width: 1080, height: 1920, fps: 30, background: '#000000',
          media: [item],
          videoClips: [{ id: 'v1', mediaId: 'mB', in: 0, out: 12, speed: 1, volume: 1, muted: false, filter: 'none', adjust: {}, effects: [], transition: null }],
          overlayClips: [{ id: 'ov1', mediaId: 'mB', in: 0, out: 12, start: 0, speed: 1, volume: 1, muted: false, filter: 'none', adjust: {}, effects: [], transition: null,
            transform: { scale: 2.61, scaleX: 1, scaleY: 1, uniform: true, x: 0, y: 0, rot: 0 }, ...(crop ? { crop } : {}), ...extra }],
          audioClips: [], stickerClips: [], effectClips: [], textClips: [],
        });
        // 1) Hamza's crop (top/bottom cut).
        await q(`window.__fve.load(${JSON.stringify(mkProj({ l: 0, t: 0.16234715289817364, r: 0, b: 0.14005925706556877 }))})`);
        await wait(400);
        await q(`window.__fve.seek(5)`);
        await until(`(() => { const v = document.querySelector('.slot.ov video'); return v && v.readyState >= 2; })()`, 15000);
        await wait(800);
        result.cropVideoEl = await q(sampleJs('.slot.ov video'));
        result.cropCanvas = await q(sampleCanvas);
        await shot('ov-7-crop.png');
        // 2) Control: same everything, NO crop (plain element path).
        await q(`window.__fve.load(${JSON.stringify(mkProj(null))})`);
        await wait(400);
        await q(`window.__fve.seek(5)`);
        await wait(800);
        result.noCropVideoEl = await q(sampleJs('.slot.ov video'));
        result.noCropCanvas = await q(sampleCanvas);
        await shot('ov-8-nocrop.png');
        // 3) Crop + seek to a second position (canvas redraw on seek?).
        await q(`window.__fve.load(${JSON.stringify(mkProj({ l: 0, t: 0.16234715289817364, r: 0, b: 0.14005925706556877 }))})`);
        await wait(400);
        await q(`window.__fve.seek(2)`);
        await wait(800);
        result.crop2VideoEl = await q(sampleJs('.slot.ov video'));
        result.crop2Canvas = await q(sampleCanvas);
        await q(`window.__fve.seek(9)`);
        await wait(800);
        result.crop9VideoEl = await q(sampleJs('.slot.ov video'));
        result.crop9Canvas = await q(sampleCanvas);
        await shot('ov-9-crop9.png');
      }
      if (process.env.FVE_SMOKE_OV_VARIANT === 'codec') {
        // Codec variant: overlay (and, swapped, main) sources Chromium cannot decode
        // (HEVC, 10-bit H.264) with NO preview proxy on the media item yet — the state
        // between import and the background proxy landing, or forever if it failed.
        const codecDir = '/tmp/cc-codec';
        const mHevc = await probe(path.join(codecDir, 'hevc.mp4'));
        const mHi10 = await probe(path.join(codecDir, 'hi10.mp4'));
        const base = { ratio: '9:16', resolution: 720, width: 360, height: 640, fps: 30, background: '#000000', audioClips: [], stickerClips: [], effectClips: [], textClips: [] };
        const ovClip = (mediaId) => ({ id: 'ov1', mediaId, in: 0, out: 6, start: 3, speed: 1, volume: 1, muted: false, filter: 'none', adjust: {}, effects: [], transition: null, transform: { scale: 0.5, x: 0, y: 0 } });
        const mainClip = (mediaId, out) => ({ id: 'v1', mediaId, in: 0, out, speed: 1, volume: 1, muted: false, filter: 'none', adjust: {}, effects: [], transition: null });
        const mainItem = { id: 'm0', path: mainSrc, name: 'main.mp4', ...mMain };
        // 1) HEVC as the overlay.
        await q(`window.__fve.load(${JSON.stringify({ ...base, name: 'HEVC overlay',
          media: [mainItem, { id: 'mH', path: path.join(codecDir, 'hevc.mp4'), name: 'hevc.mp4', ...mHevc }],
          videoClips: [mainClip('m0', 12)], overlayClips: [ovClip('mH')] })})`);
        await wait(400);
        await q(`window.__fve.seek(5)`);
        await wait(1500);
        result.hevcOverlayEarly = await q(sampleJs('.slot.ov video'));
        await shot('ov-5-hevc-early.png');
        await wait(15000);
        result.hevcOverlayLate = await q(sampleJs('.slot.ov video'));
        result.hevcMediaLate = await q(`window.__fve.exportData().project.media.find((m) => m.id === 'mH')`);
        await shot('ov-6-hevc-late.png');
        // 2) HEVC as the MAIN clip, red overlay above it.
        const mRed = await probe(ovSrc);
        await q(`window.__fve.load(${JSON.stringify({ ...base, name: 'HEVC main',
          media: [{ id: 'mH', path: path.join(codecDir, 'hevc.mp4'), name: 'hevc.mp4', ...mHevc }, { id: 'm1', path: ovSrc, name: 'overlay-red.mp4', ...mRed }],
          videoClips: [mainClip('mH', 6)], overlayClips: [{ ...ovClip('m1'), start: 1, out: 5 }] })})`);
        await wait(400);
        await q(`window.__fve.seek(2)`);
        await wait(1500);
        result.hevcMainEarly = await q(sampleJs('.stage .slot:not(.ov) video'));
        await wait(12000);
        result.hevcMainLate = await q(sampleJs('.stage .slot:not(.ov) video'));
        // 3) 10-bit H.264 as the overlay.
        await q(`window.__fve.load(${JSON.stringify({ ...base, name: 'Hi10 overlay',
          media: [mainItem, { id: 'mT', path: path.join(codecDir, 'hi10.mp4'), name: 'hi10.mp4', ...mHi10 }],
          videoClips: [mainClip('m0', 12)], overlayClips: [ovClip('mT')] })})`);
        await wait(400);
        await q(`window.__fve.seek(5)`);
        await wait(1500);
        result.hi10OverlayEarly = await q(sampleJs('.slot.ov video'));
        await wait(15000);
        result.hi10OverlayLate = await q(sampleJs('.slot.ov video'));
        result.hi10MediaLate = await q(`window.__fve.exportData().project.media.find((m) => m.id === 'mT')`);
      }
      // E. Seek BACK to the range start after having left it (element re-entry).
      await q(`window.__fve.seek(0.5)`);
      await wait(400);
      await q(`window.__fve.seek(3.4)`);
      result.ovReadyE = await until(`(() => { const v = document.querySelector('.slot.ov video'); return v && v.readyState >= 2 && Math.abs(v.currentTime - 0.4) < 0.3; })()`, 12000);
      await wait(600);
      result.seek34 = await q(sampleJs('.slot.ov video'));
      await shot('ov-4-seek34.png');
    } catch (e) {
      result.error = e.message;
    }
    fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(result, null, 2));
    return app.quit();
  }
  if (process.env.FVE_SMOKE_MODE === 'subtitles') {
    // Subtitles panel + user caption templates + export progress (2026-11-05):
    // builds its own fixture (14 s vertical clip, two SRT cues with a 5.5 s gap
    // and a long static cue), drives the Captions tab, then exports twice —
    // once with the static-frame skip disabled (__ccNoStaticSkip) and once
    // with it on — sampling the encoding view's % and comparing frame hashes.
    const q = run;
    const until = async (js, ms = 30000) => { for (let t = 0; t < ms; t += 250) { if (await q(js)) return true; await wait(250); } return false; };
    const { execFileSync } = require('child_process');
    const ff = require('./ffmpeg.cjs').ffmpegPath;
    try {
      const mediaDir = path.join(dir, 'media');
      fs.mkdirSync(mediaDir, { recursive: true });
      const src = path.join(mediaDir, 'clip.mp4');
      if (!fs.existsSync(src)) {
        execFileSync(ff, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=360x640:rate=30:duration=14',
          '-f', 'lavfi', '-i', 'sine=frequency=440:duration=14', '-shortest', '-pix_fmt', 'yuv420p', src]);
      }
      await wait(800);
      const probed = await require('./ffmpeg.cjs').probe(src);
      const items = [{ id: 'm0', path: src, name: 'clip.mp4', kind: 'video', ...probed }];
      const style = {
        font: 'cairo', size: 64, bold: true, color: '#ffffff', y: 0.8, caption: true, source: 'srt', template: 'cap-classic',
        stroke: { width: 5, color: '#000000' }, highlight: { mode: 'none' },
        animIn: { id: 'none', dur: 0 }, animOut: { id: 'none', dur: 0 }, animLoop: { id: 'none', speed: 1 },
      };
      const p = {
        name: 'Subtitles smoke', ratio: '9:16', resolution: 720, width: 360, height: 640, fps: 30, background: '#000000',
        media: items.map((m, i) => ({ ...m, id: `m${i}` })),
        videoClips: [{ id: 'v1', mediaId: 'm0', in: 0, out: 14, speed: 1, volume: 1, muted: false, filter: 'none', adjust: {}, effects: [], transition: null }],
        overlayClips: [], audioClips: [], stickerClips: [], effectClips: [],
        textClips: [
          { ...style, id: 's1', text: 'أهلا بالعالم', start: 0.5, duration: 2 },
          { ...style, id: 's2', text: 'Second cue stays', start: 8, duration: 4.5 },
        ],
      };
      // Enter the editor first (fresh profiles start on Home; dismiss the tour).
      await q(`(() => { const b = document.querySelector('button[aria-label="New 16:9 project"]'); if (b) b.click(); return !!b; })()`).catch(() => {});
      result.editorReady = await until(`!!document.querySelector('.play-btn')`, 15000);
      await q(`(() => { const b = document.querySelector('button[aria-label="Skip tour"]') || [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Start creating'); if (b) b.click(); return !!b; })()`).catch(() => {});
      await wait(600);
      result.at='load';
      await q(`window.__fve.load(${JSON.stringify(p)})`);
      await wait(400);
      result.at='tab';
      await q(`window.__fve.tab('captions')`);
      result.at='panel';
      result.panelRows = await until(`document.querySelectorAll('.sub-panel .sub-row').length === 2`, 10000)
        ? await q(`document.querySelectorAll('.sub-panel .sub-row').length`) : 0;
      result.panelHead = await q(`document.querySelector('.sub-panel-head')?.innerText || ''`);
      await shot('sub-1-panel.png');
      // Edit the second cue's text in the panel; the store clip must change.
      await q(`(() => { const ta = document.querySelectorAll('.sub-panel .sub-text')[1];
        const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
        setter.call(ta, 'Edited in the panel'); ta.dispatchEvent(new Event('input', { bubbles: true })); })()`);
      await wait(300);
      result.editedText = await q(`window.__fve.exportData().project.textClips.find((c) => c.id === 's2')?.text`);
      // Clicking the first cue seeks the playhead to its start (0.5 s).
      await q(`document.querySelectorAll('.sub-panel .sub-row')[0].click()`);
      await wait(400);
      result.timeAfterCueClick = await q(`document.querySelector('.tc')?.textContent || ''`);
      // Save the current SRT style as a user template.
      await q(`(() => { const inp = document.querySelector('input[aria-label="Caption template name"]');
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(inp, 'Smoke Style'); inp.dispatchEvent(new Event('input', { bubbles: true })); })()`);
      await wait(200);
      await q(`[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Save current style').click()`);
      await wait(300);
      result.savedTemplates = await q(`JSON.parse(localStorage.getItem('clipcraft.captionTemplates') || '[]').map((t) => t.name)`);
      result.tplRowShown = await q(`!!document.querySelector('.user-tpl-row')`);
      // Restyle all SRT captions, then re-apply the saved template: style returns.
      await q(`window.__fve.dispatch({ type: 'styleSrtCaptions', patch: { color: '#ff0000', font: 'poppins' } })`);
      await wait(200);
      result.restyled = await q(`window.__fve.exportData().project.textClips.find((c) => c.id === 's1')?.color`);
      await q(`[...document.querySelectorAll('.user-tpl-row button')].find((b) => b.textContent.trim() === 'Apply').click()`);
      await wait(300);
      const back = await q(`window.__fve.exportData().project.textClips.find((c) => c.id === 's1')`);
      result.reapplied = back && { color: back.color, font: back.font };
      await shot('sub-2-template.png');
      // Two real exports: A with the static skip off, B with it on.
      const exportOnce = async (label) => {
        await q(`window.__samples = []; window.__timer = setInterval(() => {
          const pct = document.querySelector('.x-enc-pct')?.textContent;
          const stage = document.querySelector('.x-enc-stage')?.textContent;
          const time = document.querySelector('.x-enc-time')?.textContent;
          if (pct) window.__samples.push([Date.now(), stage, pct, time]);
        }, 50)`);
        const t0 = Date.now();
        await q(`window.__fve.exportNow()`);
        const wall = Date.now() - t0;
        await q(`clearInterval(window.__timer)`);
        const samples = await q(`window.__samples`);
        const file = await q(`document.querySelector('.export-file-path')?.textContent || ''`);
        await q(`[...document.querySelectorAll('.modal .btn')].find((b) => b.textContent.trim() === 'OK')?.click()`);
        await wait(300);
        return { label, wall, file, samples };
      };
      await q(`window.__ccNoStaticSkip = true`);
      result.exportA = await exportOnce('no-static-skip');
      if (result.exportA.file) fs.copyFileSync(result.exportA.file, path.join(dir, 'exportA.mp4'));
      await q(`delete window.__ccNoStaticSkip`);
      result.exportB = await exportOnce('static-skip');
      if (result.exportB.file) fs.copyFileSync(result.exportB.file, path.join(dir, 'exportB.mp4'));
      // Frame hashes of both outputs must agree (the skip changes no pixels).
      const framemd5 = (file) => execFileSync(ff, ['-hide_banner', '-loglevel', 'error', '-i', file, '-map', '0:v', '-f', 'framemd5', '-'])
        .toString().split('\n').filter((l) => l && !l.startsWith('#')).map((l) => l.trim().split(/\s+/).pop());
      if (result.exportA.file && result.exportB.file) {
        const ha = framemd5(path.join(dir, 'exportA.mp4'));
        const hb = framemd5(path.join(dir, 'exportB.mp4'));
        result.frameHash = { framesA: ha.length, framesB: hb.length, identical: JSON.stringify(ha) === JSON.stringify(hb) };
        result.sizes = { a: fs.statSync(path.join(dir, 'exportA.mp4')).size, b: fs.statSync(path.join(dir, 'exportB.mp4')).size };
      }
      await shot('sub-3-done.png');
    } catch (e) {
      result.error = e.message;
    }
    fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(result, null, 2));
    return app.quit();
  }
  if (process.env.FVE_SMOKE_MODE === 'autosave') {
    // Save / auto save / close. The Save dialog is answered here instead of by a person.
    const { dialog } = require('electron');
    const file = path.join(dir, 'saved.clipcraft.json');
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: file });
    const q = run;
    const until = async (js, ms = 10000) => { for (let t = 0; t < ms; t += 200) { if (await q(js)) return true; await wait(200); } return false; };
    const readName = () => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')).name : null);
    try {
      await wait(800);
      await q(`window.__fve.load(${fs.readFileSync(path.join(dir, 'project.json'), 'utf8')})`);
      await wait(400);
      result.stateBefore = await q(`document.querySelector('.save-state')?.textContent || ''`);
      // A never-saved project: closing asks in ClipCraft's own dialog; Cancel keeps the window open, even after the
      // 5 s fallback would have closed it.
      win.close();
      result.askedOnClose = await until(`!!document.querySelector('.close-modal')`) && await q(`document.querySelector('.close-modal h3').textContent`);
      await shot('autosave-0-close-dialog.png');
      await q(`[...document.querySelectorAll('.close-modal .btn')].find((b) => b.textContent.trim() === 'Cancel').click()`);
      await wait(6000);
      result.openAfterCancel = !win.isDestroyed() && await q(`!document.querySelector('.close-modal')`);
      // Save once (the Save dialog picks the file), then changes are written by themselves.
      await q(`[...document.querySelectorAll('.top-actions .btn')].find((b) => b.textContent.trim() === 'Save').click()`);
      result.savedFile = await until(`/Saved/.test(document.querySelector('.save-state')?.textContent || '')`);
      result.nameAfterSave = readName();
      await q(`window.__fve.dispatch({ type: 'setProject', patch: { name: 'Auto saved' } })`);
      await wait(2500);
      result.nameAfterAutosave = readName();
      await shot('autosave-1-saved.png');
      // Closing right after a change still writes it, without asking.
      await q(`window.__fve.dispatch({ type: 'setProject', patch: { name: 'Written on close' } })`);
      win.once('closed', () => {
        result.nameAfterClose = readName();
        fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(result, null, 2));
        app.quit();
      });
      win.close();
      setTimeout(() => {
        result.error = 'the window did not close';
        fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(result, null, 2));
        app.exit(1);
      }, 8000);
      return;
    } catch (e) {
      result.error = e.message;
    }
    fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(result, null, 2));
    return app.exit(0);
  }
  if (process.env.FVE_SMOKE_MODE === 'generate') {
    // Generate tab: without a key it asks for one; with FVE_SMOKE_ELEVEN_KEY (saved only in the test settings) a
    // lower plan shows the Pro card and disables Generate.
    try {
      const q = run;
      const until = async (js, ms = 20000) => { for (let t = 0; t < ms; t += 250) { if (await q(js)) return true; await wait(250); } return false; };
      const text = () => q(`document.querySelector('.library').innerText`);
      await wait(800);
      await q(`window.__fve.tab('generate')`);
      result.noKeyCard = await until(`/ElevenLabs key needed/.test(document.querySelector('.library').innerText)`);
      result.nav = await q(`[...document.querySelectorAll('.side-nav .side-btn')].map((b) => b.textContent.trim())`);
      await shot('gen-1-nokey.png');
      if (process.env.FVE_SMOKE_ELEVEN_KEY) {
        require('./settings.cjs').saveServiceKey('elevenlabs', process.env.FVE_SMOKE_ELEVEN_KEY);
        await q(`window.__fve.tab('audio')`);
        await wait(200);
        await q(`window.__fve.tab('generate')`);
        result.proCard = await until(`/Upgrade to ElevenLabs Pro/.test(document.querySelector('.library').innerText)`);
        result.proText = (await text()).match(/Generating videos[^\n]*/)?.[0] || null;
        result.generateDisabled = await q(`[...document.querySelectorAll('.library button')].find((b) => /Needs ElevenLabs Pro/.test(b.textContent))?.disabled === true`);
        await shot('gen-2-pro.png');
        // Video: the References mode lists reference photos (with a role for Veo).
        await q(`[...document.querySelectorAll('.library .seg-tabs button')].find((b) => b.textContent === 'References').click()`);
        await wait(200);
        await q(`[...document.querySelectorAll('.library button')].find((b) => /Add a reference photo/.test(b.textContent)).click()`);
        await wait(200);
        result.veoRole = /Person \/ object/.test(await text());
        result.videoModels = await q(`[...document.querySelectorAll('.library select[aria-label="Model"] option')].map((o) => o.textContent)`);
        await shot('gen-3-video-refs.png');
        await q(`document.querySelector('.library .tab-content').scrollTop = 400`);
        await wait(150);
        await shot('gen-3-video-refs-form.png');
        await q(`[...document.querySelectorAll('.side-btn')].find((b) => b.textContent.trim() === 'Photo').click()`);
        await wait(300);
        result.photoView = /Generate a photo/.test(await text());
        result.imageModels = await q(`document.querySelectorAll('.library select[aria-label="Model"] option').length`);
        await shot('gen-4-photo.png');
        await q(`document.querySelector('.library .tab-content').scrollTop = 400`);
        await wait(150);
        await shot('gen-4-photo-form.png');
        // My avatars (the app logo stands in for a person) and the talking avatar form.
        require('./gen.cjs').avatarAdd(path.join(dir, 'avatars-test'), path.join(__dirname, '..', 'public', 'logo.png'), 'Sample');
        await q(`[...document.querySelectorAll('.side-btn')].find((b) => b.textContent.trim() === 'My avatars').click()`);
        result.avatarCard = await until(`document.querySelectorAll('.gen-avatar').length === 1`);
        await shot('gen-5-avatars.png');
        await q(`document.querySelector('.gen-avatar .btn').click()`);
        await wait(400);
        result.talkView = /Talking avatar/.test(await text()) && await q(`!!document.querySelector('.gen-pick img')`);
        await shot('gen-6-talk.png');
        await q(`document.querySelector('.library .tab-content').scrollTop = 400`);
        await wait(150);
        await shot('gen-6-talk-form.png');
      }
    } catch (e) {
      result.error = e.message;
    }
    fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(result, null, 2));
    return app.quit();
  }
  if (process.env.FVE_SMOKE_MODE === 'mediadel') {
    // Media cards: the remove button does not sit under the star; Delete removes the focused card only.
    try {
      const q = run;
      await wait(800);
      await q(`window.__fve.load(${fs.readFileSync(path.join(dir, 'project.json'), 'utf8')})`);
      await wait(600);
      await q(`(() => { const p = window.__fve.exportData().project; window.__fve.dispatch({ type: 'addMedia', items: [{ ...p.media[0], id: 'spare', name: 'spare.mp4' }] }); })()`);
      await q(`window.__fve.select({ track: 'video', id: 'v2' }); window.__fve.tab('media')`);
      await wait(500);
      const card = (name) => `[...document.querySelectorAll('.asset')].find((a) => a.querySelector('.asset-name').textContent === ${JSON.stringify(name)})`;
      result.overlap = await q(`(() => { const a = ${card('spare.mp4')}; const s = a.querySelector('.asset-star').getBoundingClientRect(); const r = a.querySelector('.asset-remove').getBoundingClientRect();
        return !(r.right <= s.left || r.left >= s.right || r.bottom <= s.top || r.top >= s.bottom); })()`);
      await q(`${card('spare.mp4')}.focus()`);
      await q(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }))`);
      await wait(300);
      let p = await q('window.__fve.exportData().project');
      result.spareGone = !p.media.some((m) => m.id === 'spare');
      result.clipKept = p.videoClips.some((c) => c.id === 'v2');
      // A used media item asks first: No keeps it, Yes removes it and its clips.
      await q(`window.confirm = () => false; ${card('city.mp4')}.focus()`);
      await q(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }))`);
      await wait(300);
      p = await q('window.__fve.exportData().project');
      result.keptOnNo = p.media.some((m) => m.name === 'city.mp4');
      await q(`window.confirm = () => true; ${card('city.mp4')}.querySelector('.asset-remove').click()`);
      await wait(300);
      p = await q('window.__fve.exportData().project');
      result.removedOnYes = !p.media.some((m) => m.name === 'city.mp4') && !p.videoClips.some((c) => c.id === 'v1');
      await q(`window.__fve.dispatch({ type: 'undo' })`);
      await wait(300);
      p = await q('window.__fve.exportData().project');
      result.undo = p.media.some((m) => m.name === 'city.mp4') && p.videoClips.some((c) => c.id === 'v1');
      await q(`${card('bridge.mp4')}.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }))`);
      await shot('mediadel.png');
    } catch (e) {
      result.error = e.message;
    }
    fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(result, null, 2));
    return app.quit();
  }
  if (process.env.FVE_SMOKE_MODE === 'portraitexport') {
    // A saved project with iPhone (rotated) videos, opened like with Open: its first clips, one with a filter and
    // one with a LUT filter, exported; the picture must fill the 9:16 frame (no sideways / letterboxed video).
    try {
      const pf = require('./projectfile.cjs');
      const { execFileSync } = require('child_process');
      const { ffmpegPath, probe: pr } = require('./ffmpeg.cjs');
      const q = run;
      win.show();
      await wait(800);
      let json = pf.checkGenerated(fs.readFileSync(path.join(dir, 'project.json'), 'utf8'), path.join(app.getPath('userData'), 'media-cache'));
      json = await pf.refreshSizes(json, pr);
      const p = JSON.parse(json);
      result.sizes = p.media.filter((m) => m.type === 'video').slice(0, 2).map((m) => [m.width, m.height, m.rotation]);
      const main = p.videoClips.filter((c) => !c.gap).slice(0, 3);
      main[0] = { ...main[0], filter: 'vivid' };
      main[1] = { ...main[1], filter: 'lut:slay-04-film.cube' };
      Object.assign(p, { videoClips: main, overlayClips: [], audioClips: [], textClips: [], stickerClips: [], effectClips: [] });
      result.at='load';
      await q(`window.__fve.load(${JSON.stringify(p)})`);
      await wait(2500);
      const out = path.join(dir, 'ui-export.mp4');
      fs.rmSync(out, { force: true });
      await q('window.__fve.exportNow()');
      for (let t = 0; t < 400000; t += 1000) { if (await q(`!!document.querySelector('.modal-icon.ok, .modal-icon.error')`)) break; await wait(1000); }
      result.exportResult = await q(`document.querySelector('#export-title')?.textContent + ' ' + (document.querySelector('.error-log')?.textContent || '').slice(-400)`);
      const info = await pr(out);
      result.export = [info.width, info.height, Math.round(info.duration * 10) / 10];
      // Share of near-black rows (letterbox bars) in frames of each clip.
      const lens = main.map((c) => (c.out - c.in) / (c.speed || 1));
      let at = 0;
      result.blackRows = [];
      for (const len of lens) {
        const t = at + len / 2;
        at += len;
        const buf = execFileSync(ffmpegPath, ['-v', 'error', '-ss', String(t), '-i', out, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], { maxBuffer: 1e8 });
        let black = 0;
        for (let y = 0; y < info.height; y++) {
          let s = 0;
          for (let x = 0; x < info.width; x += 8) s += buf[y * info.width + x];
          if (s / (info.width / 8) < 12) black++;
        }
        result.blackRows.push(Math.round((black / info.height) * 100));
        execFileSync(ffmpegPath, ['-y', '-v', 'error', '-ss', String(t), '-i', out, '-frames:v', '1', '-vf', 'scale=180:-2', path.join(dir, `frame-${result.blackRows.length}.png`)]);
      }
    } catch (e) {
      result.error = e.message;
    }
    fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(result, null, 2));
    return app.quit();
  }
  if (process.env.FVE_SMOKE_MODE === 'filterswitch') {
    // Switching filters on a clip of a saved project: each new filter replaces the old one, None removes it.
    try {
      const { checkGenerated } = require('./projectfile.cjs');
      const q = run;
      win.show();
      win.moveTop();
      await wait(800);
      const json = checkGenerated(fs.readFileSync(path.join(dir, 'project.json'), 'utf8'), path.join(app.getPath('userData'), 'media-cache'));
      await q(`window.__fve.load(${json})`);
      await wait(2500);
      const mean = async () => {
        const r = await q(`(() => { const b = document.querySelector('.stage').getBoundingClientRect(); return { x: Math.round(b.left + b.width * 0.3), y: Math.round(b.top + b.height * 0.3), width: Math.round(b.width * 0.4), height: Math.round(b.height * 0.4) }; })()`);
        const bmp = (await win.capturePage(r)).toBitmap();
        const s2 = [0, 0, 0];
        for (let i = 0; i < bmp.length; i += 4) { s2[0] += bmp[i + 2]; s2[1] += bmp[i + 1]; s2[2] += bmp[i]; }
        return s2.map((v) => Math.round(v / (bmp.length / 4)));
      };
      const p0 = JSON.parse(json);
      const clip = p0.videoClips.find((c) => !c.gap);
      await q(`window.__fve.seek(2); window.__fve.select({ track: 'video', id: '${clip.id}' }); window.__fve.tab('filters')`);
      await wait(2000);
      result.steps = [];
      const state = async (label) => {
        await wait(1500);
        const c = await q(`(() => { const c = window.__fve.exportData().project.videoClips.find((x) => x.id === '${clip.id}'); return { filter: c.filter, grade: c.grade || null, adjust: c.adjust || null }; })()`);
        const slot = await q(`[...document.querySelectorAll('.slot:not(.ov)')].filter((s) => s.style.visibility === 'visible').map((s) => ({ css: s.style.filter, keyed: s.querySelector('canvas.keyed').style.display, video: s.querySelector('video').style.visibility }))`);
        result.steps.push({ label, ...c, color: await mean(), slot });
      };
      await state('start');
      for (const name of ['Vivid', 'Noir', 'Sunset', 'None']) {
        await q(`[...document.querySelectorAll('.left .tile')].find((t) => t.querySelector('.tile-label').textContent === '${name}').click()`);
        await state(name);
      }
      await shot('filterswitch.png');
    } catch (e) {
      result.error = e.message;
    }
    fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(result, null, 2));
    return app.quit();
  }
  if (process.env.FVE_SMOKE_MODE === 'filters') {
    try {
      await require('./smoke-filters.cjs')(win, dir, result);
    } catch (e) {
      result.error = e.message;
    }
    fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(result, null, 2));
    return app.quit();
  }
  if (process.env.FVE_SMOKE_MODE === 'lut') {
    try {
      await require('./smoke-lut.cjs')(win, dir, result);
    } catch (e) {
      result.error = e.message;
    }
    fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(result, null, 2));
    return app.quit();
  }
  if (process.env.FVE_SMOKE_MODE === 'grade') {
    try {
      await require('./smoke-grade.cjs')(win, dir, result);
    } catch (e) {
      result.error = e.message;
    }
    fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(result, null, 2));
    return app.quit();
  }
  if (process.env.FVE_SMOKE_MODE === 'gpuinfo') {
    try {
      const info = await app.getGPUInfo('complete');
      result.gpus = (info.gpuDevice || []).map((g) => ({ vendor: g.vendorString || g.vendorId, device: g.deviceString || g.deviceId, driver: g.driverVersion, active: g.active }));
      result.decode = (info.videoDecoding || info.auxAttributes?.videoDecoding || []).length;
    } catch (e) {
      result.error = e.message;
    }
    fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(result, null, 2));
    return app.quit();
  }
  if (process.env.FVE_SMOKE_MODE === 'seekprobe') {
    // Opens a saved project and, at many times, measures how long the player takes to show a picture.
    try {
      const { checkGenerated } = require('./projectfile.cjs');
      const q = run;
      await wait(800);
      const json = checkGenerated(fs.readFileSync(path.join(dir, 'project.json'), 'utf8'), path.join(app.getPath('userData'), 'media-cache'));
      await q(`window.__fve.load(${json})`);
      await wait(3000);
      const state = () => q(`[...document.querySelectorAll('.slot')].filter((s) => !s.classList.contains('ov') && s.style.visibility === 'visible')
        .map((s) => { const v = s.querySelector('video'); return { ready: v.readyState, w: v.videoWidth, err: v.error && v.error.code, src: decodeURIComponent(v.src).slice(-24), shown: getComputedStyle(v).visibility, t: Math.round(v.currentTime * 100) / 100 }; })`);
      const dur = await q('window.__fve.duration()');
      result.samples = [];
      for (let t = 0.5; t < dur; t += dur / 24) {
        await q(`window.__fve.seek(${t})`);
        const t0 = Date.now();
        let st = await state();
        while (Date.now() - t0 < 4000 && !(st.length && st.every((x) => x.ready >= 2 && x.w > 0))) { await wait(50); st = await state(); }
        result.samples.push({ t: Math.round(t * 10) / 10, ms: Date.now() - t0, st });
      }
      await q(`window.__fve.seek(5)`);
      await wait(1500);
      result.dom = await q(`(() => {
        const st = document.querySelector('.stage').getBoundingClientRect();
        const at = document.elementFromPoint(st.left + st.width / 2, st.top + st.height / 2);
        const desc = (el) => el ? { tag: el.tagName, cls: el.className, op: getComputedStyle(el).opacity, vis: getComputedStyle(el).visibility, disp: getComputedStyle(el).display,
          tr: el.style.transform, filter: el.style.filter, w: Math.round(el.getBoundingClientRect().width), h: Math.round(el.getBoundingClientRect().height) } : null;
        const slots = [...document.querySelectorAll('.slot:not(.ov)')].map((s) => ({ slot: desc(s), layer: desc(s.querySelector('.layer')), video: desc(s.querySelector('video')), keyed: desc(s.querySelector('canvas.keyed')) }));
        return { at: desc(at), stage: [Math.round(st.width), Math.round(st.height)], fxTr: desc(document.querySelector('.fx-transition')), slots,
          media: window.__fve.exportData().project.media.filter((m) => m.type === 'video').slice(0, 2).map((m) => ({ w: m.width, h: m.height, rot: m.rotation, proxy: !!m.proxy })) };
      })()`);
      // Mean brightness of the picture actually on screen, with the clips' filters and without them.
      const bright = async () => {
        const r = await q(`(() => { const b = document.querySelector('.stage').getBoundingClientRect(); return { x: Math.round(b.left + 4), y: Math.round(b.top + 4), width: Math.round(b.width - 8), height: Math.round(b.height - 8) }; })()`);
        const img = await win.capturePage(r);
        const bmp = img.toBitmap();
        let sum = 0;
        for (let i = 0; i < bmp.length; i += 4) sum += bmp[i] + bmp[i + 1] + bmp[i + 2];
        return Math.round(sum / (bmp.length / 4) / 3);
      };
      // Playback: the picture must keep moving (frames decoded on the CPU).
      await q('window.__fve.seek(3)');
      await wait(800);
      const vis = () => q(`(() => { const s = [...document.querySelectorAll('.slot:not(.ov)')].find((x) => x.style.visibility === 'visible'); const v = s && s.querySelector('video');
        return v ? { t: v.currentTime, paused: v.paused, ready: v.readyState, dropped: v.getVideoPlaybackQuality().droppedVideoFrames, total: v.getVideoPlaybackQuality().totalVideoFrames, clock: document.querySelector('.tc b').textContent, page: document.visibilityState } : null; })()`);
      const before = await vis();
      win.show();
      win.moveTop();
      win.focus();
      await wait(300);
      await q(`document.querySelector('.play-btn').click()`);
      await wait(3000);
      const during = await vis();
      await q(`document.querySelector('.play-btn').click()`);
      result.play = { before, during };
      result.byTime = [];
      for (const t of [0, 0.3, 1, 2, 3.5, 5, 9.41, 20, 40]) {
        await q(`window.__fve.seek(${t})`);
        await wait(1500);
        result.byTime.push([t, await q(`document.querySelector('.tc b').textContent`), await bright()]);
      }
      await q('window.__fve.seek(0)');
      await wait(1500);
      result.brightWithFilter = await bright();
      await q(`(() => { const p = window.__fve.exportData().project; window.__fve.dispatch({ type: 'updateMany', updates: p.videoClips.map((c) => ({ track: 'video', id: c.id, patch: { filter: 'none' } })) }); })()`);
      await wait(1200);
      result.brightNoFilter = await bright();
      result.gpu = app.getGPUFeatureStatus();
      const log = path.join(dir, 'logs', 'crash.log');
      result.crashLog = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').slice(-1500) : '';
      await shot('seekprobe.png');
    } catch (e) {
      result.error = e.message;
    }
    fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(result, null, 2));
    return app.quit();
  }
  if (process.env.FVE_SMOKE_MODE === 'multilook') {
    // Several clips selected: a filter tile and an Adjust slider change all of them, each keeps its other
    // settings, and one Ctrl+Z undoes it.
    try {
      const q = run;
      await wait(800);
      await q(`window.__fve.load(${fs.readFileSync(path.join(dir, 'project.json'), 'utf8')})`);
      await wait(600);
      const looks = () => q(`window.__fve.exportData().project.videoClips.map((c) => [c.id, c.filter || 'none', JSON.stringify(c.adjust || {})].join(' '))
        .concat(window.__fve.exportData().project.overlayClips.map((c) => [c.id, c.filter || 'none', JSON.stringify(c.adjust || {})].join(' ')))`);
      // v3 already has saturation 2: a brightness change must keep it.
      await q(`window.__fve.dispatch({ type: 'update', track: 'video', id: 'v3', patch: { adjust: { saturation: 2 } } })`);
      await q(`window.__fve.select({ track: 'video', id: 'v1', items: [{ track: 'video', id: 'v1' }, { track: 'video', id: 'v3' }, { track: 'overlay', id: 'o1' }] })`);
      await q(`window.__fve.tab('filters')`);
      await wait(400);
      result.note = await q(`document.querySelector('.hint.many')?.textContent || ''`);
      await q(`[...document.querySelectorAll('.tile')].find((t) => t.querySelector('.tile-label')?.textContent === 'Black & White').click()`);
      await wait(200);
      result.afterFilter = await looks();
      await q(`window.__fve.tab('adjust')`);
      await wait(400);
      await q(`(() => { const el = [...document.querySelectorAll('.left .field')].find((f) => f.textContent.includes('Brightness')).querySelector('input');
        el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, '0.3'); el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true })); })()`);
      await wait(200);
      result.afterAdjust = await looks();
      await q(`window.__fve.dispatch({ type: 'undo' })`);
      await q(`window.__fve.dispatch({ type: 'undo' })`);
      await wait(200);
      result.afterTwoUndos = await looks();
      await shot('multilook.png');
    } catch (e) {
      result.error = e.message;
    }
    fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(result, null, 2));
    return app.quit();
  }
  if (process.env.FVE_SMOKE_MODE === 'crash') {
    // The interface crashes while editing: the window comes back by itself with the project as it was, says so,
    // and the crash is in the log.
    try {
      const q = run;
      await wait(800);
      await q(`window.__fve.load(${fs.readFileSync(path.join(dir, 'project.json'), 'utf8')})`);
      await wait(400);
      await q(`window.__fve.dispatch({ type: 'update', track: 'video', id: 'v1', patch: { filter: 'bw' } })`);
      await wait(1600); // autosave
      result.before = await q('window.__fve.exportData().project.videoClips.length');
      result.savedBefore = await q(`(() => { const r = localStorage.getItem('clipcraft.recovery'); return r ? JSON.parse(r).project.videoClips.length : 'none'; })()`);
      fs.rmSync(path.join(dir, 'logs'), { recursive: true, force: true });
      win.webContents.forcefullyCrashRenderer();
      let back = false;
      for (let t = 0; t < 20000 && !back; t += 500) {
        await wait(500);
        // A call into a crashed page never answers: give each try one second.
        back = await Promise.race([q(`!!(window.__fve && window.__fve.exportData().project.videoClips.length)`).catch(() => false), wait(1000).then(() => false)]);
      }
      await wait(800);
      result.back = back;
      result.saved = await q(`(() => { const r = localStorage.getItem('clipcraft.recovery'); return r ? JSON.parse(r).project.videoClips.length : 'none'; })()`).catch((e) => e.message);
      result.after = await q('window.__fve.exportData().project.videoClips.length');
      result.editKept = await q(`window.__fve.exportData().project.videoClips.find((c) => c.id === 'v1').filter`);
      result.note = await q(`document.querySelector('.recovered-note')?.textContent.slice(0, 40) || ''`);
      const log = path.join(dir, 'logs', 'crash.log');
      result.log = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => l.replace(/^\S+ /, '').slice(0, 90)) : null;
    } catch (e) {
      result.error = e.message;
    }
    fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(result, null, 2));
    return app.quit();
  }
  if (process.env.FVE_SMOKE_MODE === 'perf') {
    // Performance: one 1080p minute with a title and karaoke captions all along. Measures the app's CPU while
    // paused and while playing (percent of one core, per process type), then times each export stage from the
    // export dialog's title. FVE_PERF_SECONDS changes the length.
    try {
      const { execFileSync } = require('child_process');
      const { ffmpegPath } = require('./ffmpeg.cjs');
      const secs = Number(process.env.FVE_PERF_SECONDS) || 60;
      const src = path.join(dir, `perf-1080-${secs}s.mp4`);
      if (!fs.existsSync(src)) {
        execFileSync(ffmpegPath, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', `testsrc2=size=1920x1080:rate=30:duration=${secs}`,
          '-f', 'lavfi', '-i', `sine=frequency=440:duration=${secs}`, '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
          '-c:a', 'aac', '-shortest', src]);
      }
      win.show();
      await wait(1500);
      const [m] = await run(`window.api.probePaths(${JSON.stringify([src])})`);
      const captions = [];
      for (let t = 0; t < secs; t += 5) {
        captions.push({ id: `c${t}`, caption: true, text: 'make it pop with captions', start: t, duration: Math.min(5, secs - t), y: 0.82, highlight: { mode: 'karaoke', color: '#ffd400', bg: '#7c3aed' } });
      }
      const p = {
        name: 'Perf', ratio: '16:9', ratioLocked: true, resolution: 1080, width: 1920, height: 1080, fps: 30, background: '#000000',
        media: [{ ...m, id: 'm1' }], videoClips: [], overlayClips: [], audioClips: [], stickerClips: [], effectClips: [], markers: [],
        textClips: [{ id: 't1', text: 'My title', start: 0, duration: secs, y: 0.2 }, ...captions],
      };
      await run(`window.__fve.load(${JSON.stringify(p)})`);
      await run(`window.__fve.dispatch({ type: 'addToTimeline', mediaId: 'm1', clipId: 'v1' })`);
      await wait(4000); // thumbnails, waveform and proxy work started by the import settle first
      const cpu = async (label, ms) => {
        app.getAppMetrics();
        await wait(ms);
        const by = {};
        app.getAppMetrics().forEach((x) => { by[x.type] = Math.round(((by[x.type] || 0) + x.cpu.percentCPUUsage) * 10) / 10; });
        result[label] = by;
      };
      await cpu('cpuPaused', 5000);
      await run('window.__fve.play()');
      await cpu('cpuPlaying', 5000);
      await run('window.__fve.pause()');
      await run('window.__fve.seek(0)');

      const out = path.join(dir, 'ui-export.mp4');
      fs.rmSync(out, { force: true });
      const t0 = Date.now();
      run('window.__fve.exportNow()');
      const stages = [];
      for (let t = 0; t < 900000; t += 100) {
        const title = await run(`document.querySelector('.modal-icon.ok, .modal-icon.error') ? 'done' : (document.querySelector('#export-title')?.textContent || '')`);
        const name = title.replace(/…$/, '');
        if (name && (!stages.length || stages[stages.length - 1].name !== name)) stages.push({ name, at: (Date.now() - t0) / 1000 });
        if (title === 'done') break;
        await wait(100);
      }
      result.exportStages = stages.map((s, i) => ({ name: s.name, seconds: Math.round(((stages[i + 1]?.at ?? s.at) - s.at) * 10) / 10 }));
      result.exportTotal = Math.round(((Date.now() - t0) / 1000) * 10) / 10;
      result.exportOk = fs.existsSync(out) && fs.statSync(out).size > 0;
    } catch (e) {
      result.error = e.message;
    }
    fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(result, null, 2));
    return app.quit();
  }
  if (process.env.FVE_SMOKE_MODE === 'startup') {
    // Plain start: the interface must render (not a blank window) and log no errors.
    await wait(4000);
    result.rootChildren = await run(`document.getElementById('root')?.children.length || 0`);
    result.topbar = await run(`!!document.querySelector('.topbar, header')`);
    await shot('startup.png');
    fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(result, null, 2));
    return app.quit();
  }
  if (process.env.FVE_SMOKE_MODE === 'stats') {
    // Anonymous statistics: asked once; "No thanks" is saved and the question never comes back.
    await wait(4000);
    result.promptShown = await run(`!!document.querySelector('.stats-note')`);
    await shot('stats-prompt.png');
    await run(`[...document.querySelectorAll('.stats-note button')].find((b) => b.textContent === 'No thanks').click()`);
    await wait(500);
    result.promptGone = await run(`!document.querySelector('.stats-note')`);
    const file = path.join(dir, 'settings-test', 'telemetry.json');
    const saved = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
    result.savedConsent = saved.consent;
    result.noId = !saved.installId;
    wc.reload();
    await wait(4000);
    result.notAskedAgain = await run(`!document.querySelector('.stats-note')`);
    fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(result, null, 2));
    return app.quit();
  }
  if (process.env.FVE_SMOKE_MODE === 'filterchip') {
    // A clip's filter shows as a chip on the timeline; its × removes the filter (one undo step), the clip stays
    // selected as it was; the right-click menu can remove it too.
    try {
      const q = run;
      await wait(800);
      await q(`window.__fve.load(${fs.readFileSync(path.join(dir, 'project.json'), 'utf8')})`);
      await wait(800);
      const filterOf = (id) => q(`window.__fve.exportData().project.videoClips.find((c) => c.id === '${id}').filter`);
      result.chips = await q(`[...document.querySelectorAll('.clip-tag')].map((t) => t.closest('[data-sel-id]').dataset.selId + ':' + t.textContent)`);
      await q(`window.__fve.select({ track: 'video', id: 'v2' })`);
      await wait(200);
      const chip = await q(`(() => { const b = document.querySelector('[data-sel-id="v4"] .clip-tag button').getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()`);
      await q(`document.querySelector('[data-sel-id="v4"]').scrollIntoView({ block: 'center' })`);
      await wait(200);
      const r4 = await q(`(() => { const r = document.querySelector('[data-sel-id="v4"]').getBoundingClientRect(); return { x: Math.round(r.left - 20), y: Math.round(r.top - 10), width: Math.round(r.width + 40), height: Math.round(r.height + 20) }; })()`);
      fs.writeFileSync(path.join(dir, 'filterchip-clip.png'), (await win.capturePage(r4)).toPNG());
      await shot('filterchip-before.png');
      await q(`(() => { const b = document.querySelector('[data-sel-id="v4"] .clip-tag button');
        b.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: ${chip.x}, clientY: ${chip.y} })); b.click(); })()`);
      await wait(300);
      result.afterX = await filterOf('v4');
      result.stillSelected = await q(`document.querySelector('.clip.selected')?.dataset.selId`);
      result.chipsAfter = await q(`document.querySelectorAll('.clip-tag').length`);
      await q(`window.__fve.dispatch({ type: 'undo' })`);
      await wait(200);
      result.undo = await filterOf('v4');
      // Right-click menu: Remove filter.
      await q(`(() => { const el = document.querySelector('[data-sel-id="v4"]'); const r = el.getBoundingClientRect();
        el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 30, clientY: r.top + 30 })); })()`);
      await wait(300);
      await q(`[...document.querySelectorAll('[role="menuitem"], .ctx-menu button, .context-menu button')].find((b) => b.textContent.includes('Remove filter')).click()`);
      await wait(300);
      result.afterMenu = await filterOf('v4');
    } catch (e) {
      result.error = e.message;
    }
    fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(result, null, 2));
    return app.quit();
  }
  if (process.env.FVE_SMOKE_MODE === 'fullscreen') {
    // Full screen player: the button and F enter it, the video fills the screen, Esc / the button leave it.
    try {
      const q = run;
      await wait(800);
      await q(`window.__fve.load(${fs.readFileSync(path.join(dir, 'project.json'), 'utf8')})`);
      await wait(800);
      await q('window.__fve.seek(2.6)');
      const state = () => q(`(() => { const s = document.querySelector('.stage').getBoundingClientRect();
        return { full: document.fullscreenElement === document.querySelector('.player'), stageW: Math.round(s.width), stageH: Math.round(s.height), screenW: window.innerWidth, screenH: window.innerHeight }; })()`);
      // Entering / leaving full screen takes a moment (window animation): wait for it.
      const settle = async (want) => { for (let t = 0; t < 5000; t += 200) { const st = await state(); if (st.full === want) { await wait(400); return state(); } await wait(200); } return state(); };
      result.before = await state();
      await q(`document.querySelector('[aria-label="Full screen (F)"]').click()`);
      result.button = await settle(true);
      await shot('fullscreen.png');
      await q(`document.querySelector('[aria-label="Exit full screen (Esc)"]').click()`);
      result.exited = await settle(false);
      // A real key press (a synthetic event is not a user gesture, so it could not open full screen).
      win.focus();
      await q(`document.activeElement && document.activeElement.blur()`);
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'F' });
      win.webContents.sendInputEvent({ type: 'char', keyCode: 'f' });
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'F' });
      result.key = await settle(true);
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
      result.after = await settle(false);
    } catch (e) {
      result.error = e.message;
    }
    fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(result, null, 2));
    return app.quit();
  }
  if (process.env.FVE_SMOKE_MODE === 'multisel') {
    // Box selection on the timeline, Ctrl + click, moving the selection together, deleting it in one undo step.
    try {
      const q = run;
      await wait(800);
      await q(`window.__fve.load(${fs.readFileSync(path.join(dir, 'project.json'), 'utf8')})`);
      await wait(800);
      const P = () => q('window.__fve.exportData().project');
      const sel = () => q(`[...document.querySelectorAll('.clip.selected')].map((c) => c.dataset.selTrack + ':' + c.dataset.selId).sort()`);
      // Pixels of a time on a lane.
      const at = (lane, t) => q(`(() => { const l = document.querySelector('[data-lane="${lane}"]').getBoundingClientRect();
        const r = document.querySelectorAll('.tick'); const pps = r[1].getBoundingClientRect().left - r[0].getBoundingClientRect().left;
        return { x: l.left + ${t} * pps / 2, y: l.top + 4 }; })()`);
      const pointer = (type, p, target, extra = {}) => q(`(${target ? `document.querySelector(${JSON.stringify(target)})` : 'window'}).dispatchEvent(new PointerEvent(${JSON.stringify(type)}, { bubbles: true, cancelable: true, button: 0, clientX: ${p.x}, clientY: ${p.y}, ...${JSON.stringify(extra)} }))`);
      result.tickSeconds = await q(`document.querySelectorAll('.tick')[1].textContent`);
      // Box from 0.2 s on the Effects lane down to 7 s on the Overlay lane.
      const a = await at('effect', 0.2);
      const b0 = await at('overlay', 7);
      const b = { x: b0.x, y: b0.y + 20 };
      await pointer('pointerdown', a, '[data-lane="effect"]');
      await pointer('pointermove', { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
      result.boxShown = await q(`!!document.querySelector('.select-box')`);
      await pointer('pointermove', b);
      await pointer('pointerup', b);
      result.boxed = await sel();
      result.note = await q(`document.querySelector('.multi-note')?.textContent.slice(0, 20) || ''`);
      await shot('multisel.png');
      // Ctrl + click takes the effect clip out of the selection. (R1: this leg used a sticker
      // clip before the Stickers feature was removed.)
      const st = await q(`(() => { const r = document.querySelector('[data-sel-id="e2"]').getBoundingClientRect(); return { x: r.left + 10, y: r.top + 10 }; })()`);
      await pointer('pointerdown', st, '[data-sel-id="e2"]', { ctrlKey: true });
      await wait(200);
      result.afterCtrl = await sel();
      // Drag the overlay clip 1 s right: the free clips of the selection move together.
      const before = await P();
      const o1 = await q(`(() => { const r = document.querySelector('[data-sel-id="o1"]').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + 10 }; })()`);
      const pps = await q(`(() => { const r = document.querySelectorAll('.tick'); return (r[1].getBoundingClientRect().left - r[0].getBoundingClientRect().left) / 2; })()`);
      await pointer('pointerdown', o1, '[data-sel-id="o1"]');
      await pointer('pointermove', { x: o1.x + pps, y: o1.y });
      await pointer('pointerup', { x: o1.x + pps, y: o1.y });
      await wait(200);
      const after = await P();
      const start = (p, track, id) => (p[{ overlay: 'overlayClips', effect: 'effectClips' }[track]].find((c) => c.id === id) || {}).start;
      result.moved = ['overlay:o1'].map((k) => { const [t, id] = k.split(':'); return [k, start(before, t, id), start(after, t, id)]; });
      // Delete removes every selected clip; one Ctrl+Z brings them all back.
      await q(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }))`);
      await wait(200);
      let p = await P();
      result.deleted = { o1: !p.overlayClips.some((c) => c.id === 'o1'), e2: p.effectClips.some((c) => c.id === 'e2') };
      await q(`window.__fve.dispatch({ type: 'undo' })`);
      await wait(200);
      p = await P();
      result.undone = p.overlayClips.some((c) => c.id === 'o1') && p.effectClips.some((c) => c.id === 'e2');
      // A plain click on an empty lane clears the selection and moves the playhead.
      const c = await at('effect', 12);
      await pointer('pointerdown', c, '[data-lane="effect"]');
      await pointer('pointerup', c);
      await wait(200);
      result.cleared = (await sel()).length === 0;
      result.playhead = await q(`document.querySelector('.tl-time b').textContent`);
    } catch (e) {
      result.error = e.message;
    }
    fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(result, null, 2));
    return app.quit();
  }
  if (process.env.FVE_SMOKE_MODE === 'barcapture') {
    // Real screen capture, no camera: the floating Stop bar must not be in the video. Only the bar's area of one
    // frame is read (red pixels of its Stop button), then the recording is deleted.
    try {
      const { BrowserWindow, screen } = require('electron');
      const { execFileSync } = require('child_process');
      const { ffmpegPath } = require('./ffmpeg.cjs');
      const q = run;
      const until = async (fn, ms = 30000) => { for (let t = 0; t < ms; t += 250) { if (await fn()) return true; await wait(250); } return false; };
      await wait(800);
      await q(`window.__fve.load(${fs.readFileSync(path.join(dir, 'project.json'), 'utf8')})`);
      await wait(500);
      await q(`window.__fve.tab('media')`);
      await q(`[...document.querySelectorAll('.lib-head button')].find((b) => b.textContent.trim() === 'Record').click()`);
      await until(() => q(`document.querySelectorAll('.rec-source').length > 0`));
      await q(`(() => { const l = [...document.querySelectorAll('.rec-pick label')].find((x) => x.textContent.includes('Computer sound')); const i = l.querySelector('input'); if (i.checked) i.click(); })()`);
      const before = (await q('window.__fve.exportData().project')).media.length;
      await q(`[...document.querySelectorAll('.rec-pick button')].find((b) => b.textContent.includes('Start recording')).click()`);
      await until(() => BrowserWindow.getAllWindows().some((w) => w !== win && w.webContents.getURL().endsWith('recbar.html')), 15000);
      await wait(2500);
      const bar = BrowserWindow.getAllWindows().find((w) => w !== win && w.webContents.getURL().endsWith('recbar.html'));
      const bb = bar.getBounds();
      result.barVisible = bar.isVisible();
      await bar.webContents.executeJavaScript(`document.getElementById('stop').click()`);
      result.saved = await until(async () => (await q('window.__fve.exportData().project')).media.length > before, 60000);
      const p = await q('window.__fve.exportData().project');
      const shot = p.media[p.media.length - 1];
      const D = screen.getPrimaryDisplay().bounds;
      const k = shot.width / D.width;
      const crop = `crop=${Math.round(bb.width * k)}:${Math.round(bb.height * k)}:${Math.round((bb.x - D.x) * k)}:${Math.round((bb.y - D.y) * k)}`;
      const px = execFileSync(ffmpegPath, ['-v', 'error', '-ss', '1.5', '-i', shot.path, '-frames:v', '1', '-vf', crop, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1e8 });
      let red = 0;
      for (let i = 0; i < px.length; i += 3) if (px[i] > 200 && px[i + 1] < 110 && px[i + 2] < 110) red++;
      result.redPixelsWhereTheBarIs = red;
      result.barArea = px.length / 3;
      await q(`window.__fve.load(${fs.readFileSync(path.join(dir, 'project.json'), 'utf8')})`);
      await wait(1500);
      fs.rmSync(path.join(dir, 'recordings'), { recursive: true, force: true });
    } catch (e) {
      result.error = e.message;
    }
    fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(result, null, 2));
    return app.quit();
  }
  if (process.env.FVE_SMOKE_MODE === 'screenrec') {
    try {
      await require('./smoke-screenrec.cjs')(win, dir, result);
    } catch (e) {
      result.error = e.message;
    }
    fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(result, null, 2));
    return app.quit();
  }
  if (process.env.FVE_SMOKE_MODE === 'wheel') {
    // Ctrl + wheel zooms the timeline around the mouse; Shift + wheel scrolls it sideways; the window never zooms.
    try {
      const q = run;
      await wait(800);
      await q(`window.__fve.load(${fs.readFileSync(path.join(dir, 'project.json'), 'utf8')})`);
      await wait(800);
      const state = () => q(`(() => { const el = document.querySelector('.tl-scroll'); const z = document.querySelector('input.zoom');
        return { pps: Number(z.value), left: el.scrollLeft, zoom: window.devicePixelRatio }; })()`);
      // Time under a point of the timeline (x pixels right of the track headers).
      const under = (x, s) => (x + s.left) / s.pps;
      const wheel = (opts) => q(`(() => { const el = document.querySelector('.tl-scroll'); const r = el.getBoundingClientRect();
        el.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, clientX: r.left + 96 + 400, clientY: r.top + 80, ...${JSON.stringify(opts)} })); })()`);
      const s0 = await state();
      for (let i = 0; i < 4; i++) { await wheel({ deltaY: -120, ctrlKey: true }); await wait(80); }
      const s1 = await state();
      result.zoomIn = { before: s0, after: s1, timeUnderMouse: [under(400, s0), under(400, s1)] };
      await wheel({ deltaY: 300, shiftKey: true });
      await wait(150);
      const s2 = await state();
      result.shiftScroll = s2.left - s1.left;
      for (let i = 0; i < 6; i++) { await wheel({ deltaY: 120, ctrlKey: true }); await wait(80); }
      const s3 = await state();
      result.zoomOut = { after: s3, timeUnderMouse: [under(400, s2), under(400, s3)] };
      result.windowZoom = await q('window.devicePixelRatio');
      await shot('wheel.png');
    } catch (e) {
      result.error = e.message;
    }
    fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(result, null, 2));
    return app.quit();
  }
  if (process.env.FVE_SMOKE_MODE === 'reopen') {
    // A saved project whose thumbnails and proxies were deleted: opening it makes them again and the player plays.
    try {
      const { checkGenerated } = require('./projectfile.cjs');
      const q = run;
      const until = async (js, ms) => { for (let t = 0; t < ms; t += 1000) { if (await q(js)) return true; await wait(1000); } return false; };
      await wait(800);
      const json = checkGenerated(fs.readFileSync(path.join(dir, 'project.json'), 'utf8'), path.join(app.getPath('userData'), 'media-cache'));
      result.cleared = JSON.parse(json).media.filter((m) => m.optimizing).length;
      await q(`window.__fve.load(${json})`);
      const t0 = Date.now();
      result.ready = await until(`window.__fve.exportData().project.media.filter((m) => m.type === 'video').every((m) => m.thumbCount && !m.optimizing && (!m.vcodec || m.vcodec === 'h264' || m.proxy))`, 20 * 60000);
      result.seconds = Math.round((Date.now() - t0) / 1000);
      result.media = await q(`window.__fve.exportData().project.media.filter((m) => m.type === 'video').map((m) => [m.name, !!m.thumbCount, !!m.proxy, m.proxy && m.proxy.includes('media-cache')])`);
      await q('window.__fve.seek(5)');
      await wait(2500);
      result.player = await q(`[...document.querySelectorAll('.slot video')].filter((v) => v.closest('.slot').style.visibility === 'visible').map((v) => ({ src: decodeURIComponent(v.src).slice(-40), ready: v.readyState, w: v.videoWidth, err: v.error && v.error.code }))`);
      await shot('reopen.png');
    } catch (e) {
      result.error = e.message;
    }
    fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(result, null, 2));
    return app.quit();
  }
  if (process.env.FVE_SMOKE_MODE === 'anim') {
    try {
      await require('./smoke-anim.cjs')(win, dir, result);
    } catch (e) {
      result.error = e.message;
    }
    fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(result, null, 2));
    return app.quit();
  }
  if (process.env.FVE_SMOKE_MODE === 'textanim') {
    try {
      await require('./smoke-textanim.cjs')(win, dir, result);
    } catch (e) {
      result.error = e.message;
    }
    fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(result, null, 2));
    return app.quit();
  }
  if (process.env.FVE_SMOKE_MODE === 'tplmotion') {
    try {
      await require('./smoke-tplmotion.cjs')(win, dir, result);
    } catch (e) {
      result.error = e.message;
    }
    fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(result, null, 2));
    return app.quit();
  }
  if (process.env.FVE_SMOKE_MODE === 'textsmooth') {
    try {
      await require('./smoke-textsmooth.cjs')(win, dir, result);
    } catch (e) {
      result.error = e.message;
    }
    fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(result, null, 2));
    return app.quit();
  }
  if (process.env.FVE_SMOKE_MODE === 'tracking') {
    try {
      await require('./smoke-tracking.cjs')(win, dir, result);
    } catch (e) {
      result.error = e.message;
    }
    fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(result, null, 2));
    return app.quit();
  }
  if (process.env.FVE_SMOKE_MODE === 'textanimword') {
    try {
      await require('./smoke-textanimword.cjs')(win, dir, result);
    } catch (e) {
      result.error = e.message;
    }
    fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(result, null, 2));
    return app.quit();
  }
  if (process.env.FVE_SMOKE_MODE === 'readme') {
    try {
      await require('./smoke-readme.cjs')(win, dir, result);
    } catch (e) {
      result.error = e.message;
    }
    fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(result, null, 2));
    return app.quit();
  }
  if (process.env.FVE_SMOKE_MODE === 'tts') {
    // Text to speech with the free voice (downloads Piper and the voice the first time), and the ElevenLabs key card.
    try {
      await wait(800);
      await run(`window.__fve.load(${fs.readFileSync(path.join(dir, 'project.json'), 'utf8')})`);
      await wait(400);
      const q = (js) => run(js);
      const until = async (js, ms = 30000) => { for (let t = 0; t < ms; t += 300) { if (await q(js)) return true; await wait(300); } return false; };
      await q(`window.__fve.tab('audio')`);
      await wait(300);
      await q(`[...document.querySelectorAll('.side-btn')].find((b) => b.textContent.trim() === 'Text to speech').click()`);
      await until(`document.querySelectorAll('.tts select option').length > 3`);
      result.voices = await q(`[...document.querySelectorAll('.tts select option')].map((o) => o.textContent)`);
      await q(`(() => { const t = document.querySelector('.tts textarea'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(t, 'Welcome to ClipCraft, the free video editor.'); t.dispatchEvent(new Event('input', { bubbles: true })); })()`);
      await q('window.__fve.seek(1.5)');
      const a0 = (await q('window.__fve.exportData().project')).audioClips.length;
      await q(`[...document.querySelectorAll('.tts button')].find((b) => b.textContent.includes('Add to timeline')).click()`);
      result.added = await until(`window.__fve.exportData().project.audioClips.length > ${a0}`, 400000);
      const p = await q('window.__fve.exportData().project');
      const c = p.audioClips[p.audioClips.length - 1];
      const m = p.media.find((x) => x.id === c.mediaId);
      result.clip = { start: c.start, len: +(c.out - c.in).toFixed(2), name: m.name, credit: m.credit && m.credit.line };
      result.error2 = await q(`document.querySelector('.tts .error-text')?.textContent || null`);
      await shot('tts-1.png');
      await q(`[...document.querySelectorAll('.tts .seg-tabs button')].find((b) => b.textContent === 'ElevenLabs').click()`);
      await wait(400);
      result.elevenCard = await q(`document.querySelector('.tts .stock-key b')?.textContent || null`);
    } catch (e) {
      result.error = e.message;
    }
    fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(result, null, 2));
    return app.quit();
  }
  if (process.env.FVE_SMOKE_MODE === 'trpanel') {
    // Click a transition on the timeline, change it in its panel, apply to all, delete it.
    try {
      await wait(800);
      await run(`window.__fve.load(${fs.readFileSync(path.join(dir, 'project.json'), 'utf8')})`);
      await wait(500);
      const q = (js) => run(js);
      const trs = () => q(`window.__fve.exportData().project.videoClips.map((c) => c.transition ? c.transition.type + '/' + c.transition.duration : '-')`);
      const setVal = (sel, v) => q(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); const proto = el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(v)}); el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true })); })()`);
      result.before = await trs();
      await q(`document.querySelectorAll('.tr-marker')[0].dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))`);
      await wait(300);
      result.panel = await q(`document.querySelector('.inspector .panel-title').textContent + ' / ' + document.querySelector('.fx-head b').textContent`);
      result.span = await q(`!!document.querySelector('.tr-span')`);
      await setVal('.inspector select', 'fx_comic');
      await wait(200);
      await setVal('.inspector input[type=range]', '0.35');
      await wait(200);
      result.changed = await trs();
      await shot('trpanel-1.png');
      await q(`[...document.querySelectorAll('.inspector button')].find((b) => b.textContent === 'Apply to all').click()`);
      await wait(200);
      result.applied = await trs();
      await q(`[...document.querySelectorAll('.inspector button')].find((b) => b.textContent.includes('Reset')).click()`);
      await wait(200);
      result.reset = await trs();
      await q(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete' }))`);
      await wait(200);
      result.deleted = await trs();
      await q(`window.__fve.dispatch({ type: 'undo' })`);
      await wait(200);
      result.undone = await trs();
    } catch (e) {
      result.error = e.message;
    }
    fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(result, null, 2));
    return app.quit();
  }
  if (process.env.FVE_SMOKE_MODE === 'freefx') {
    // Free effects on the Effects track: add from the panel, stretch, move, see it in the player, export.
    try {
      await wait(800);
      await run(`window.__fve.load(${fs.readFileSync(path.join(dir, 'project.json'), 'utf8')})`);
      await wait(500);
      const q = (js) => run(js);
      const P = () => q('window.__fve.exportData().project');
      const until = async (js, ms = 30000) => { for (let t = 0; t < ms; t += 250) { if (await q(js)) return true; await wait(250); } return false; };
      await q(`window.__fve.select(null); window.__fve.seek(1); window.__fve.tab('effects')`);
      await wait(600);
      result.hint = await q(`document.querySelector('.fx-mode')?.textContent.slice(0, 22)`);
      await q(`[...document.querySelectorAll('.tile')].find((t) => t.textContent.includes('VHS Noise')).click()`);
      await wait(300);
      let p = await P();
      result.added = p.effectClips.map((e) => [e.fx, e.start, e.duration]);
      const drag = (sel, dx) => q(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); const r = el.getBoundingClientRect();
        const x = r.left + r.width / 2, y = r.top + r.height / 2;
        el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y }));
        window.dispatchEvent(new PointerEvent('pointermove', { clientX: x + ${dx}, clientY: y }));
        window.dispatchEvent(new PointerEvent('pointerup', { clientX: x + ${dx}, clientY: y })); })()`);
      const pps = await q(`(() => { const r = document.querySelectorAll('.tick'); return r[1].getBoundingClientRect().left - r[0].getBoundingClientRect().left; })()`);
      const step = await q(`(() => { const r = document.querySelectorAll('.tick span'); return parseFloat(r[1].textContent.split(':')[1]) - parseFloat(r[0].textContent.split(':')[1]); })()`);
      const sec = pps / step;
      await drag('.clip.effect.free .handle.right', Math.round(sec * 1.5));
      await wait(250);
      await drag('.clip.effect.free', Math.round(sec * 0.5));
      await wait(250);
      p = await P();
      result.afterEdit = p.effectClips.map((e) => [e.fx, +e.start.toFixed(2), +e.duration.toFixed(2)]);
      result.panel = await q(`document.querySelector('.inspector .panel-title').textContent + ' / ' + (document.querySelector('.fx-head .dim')?.textContent || '')`);
      // In the player the effect acts on the clip under it.
      await q(`window.__fve.select(null); window.__fve.seek(3)`);
      await wait(800);
      result.playerFx = await q(`[...document.querySelectorAll('.slot canvas.keyed')].some((c) => c.style.display === 'block')`);
      await shot('freefx-1.png');
      await q(`window.__fve.seek(6.3)`);
      await wait(500);
      result.playerOutside = await q(`[...document.querySelectorAll('.stage > .slot:not(.ov)')].some((s) => s.style.visibility === 'visible' && s.querySelector('canvas.keyed').style.display === 'block')`);
      // Particle effect on the track too, then export.
      await q(`window.__fve.dispatch({ type: 'addEffectClip', clipId: 'snow1', fx: 'fx_snow', at: 0, duration: 2 })`);
      await wait(200);
      const out = path.join(dir, 'ui-export.mp4');
      fs.rmSync(out, { force: true });
      await q('window.__fve.exportNow()');
      result.exportDone = await until(`!!document.querySelector('.modal-icon.ok, .modal-icon.error')`, 240000);
      result.exportResult = await q(`document.querySelector('#export-title')?.textContent + ' ' + (document.querySelector('.error-log')?.textContent || '')`);
      if (fs.existsSync(out)) result.exportInfo = await probe(out);
    } catch (e) {
      result.error = e.message;
    }
    fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(result, null, 2));
    return app.quit();
  }
  if (process.env.FVE_SMOKE_MODE === 'fxlane') {
    // Effects show as bars on the Effects lane; select one, see its panel, delete it (Del and right-click).
    try {
      await wait(800);
      await run(`window.__fve.load(${fs.readFileSync(path.join(dir, 'project.json'), 'utf8')})`);
      await wait(500);
      const q = (js) => run(js);
      const fxOf = () => q(`window.__fve.exportData().project.videoClips.find((c) => c.id === 'c2').effects`);
      await q(`window.__fve.dispatch({ type: 'update', track: 'video', id: 'c2', patch: { effects: ['vignette', 'mirror', 'fx_vhs'] } })`);
      await wait(300);
      result.bars = await q(`[...document.querySelectorAll('[data-lane="effect"] .clip.effect')].map((b) => b.textContent.trim())`);
      await q(`(() => { const b = [...document.querySelectorAll('[data-lane="effect"] .clip.effect')].find((x) => x.textContent.includes('VHS')); b.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 })); })()`);
      await wait(300);
      result.panel = await q(`document.querySelector('.inspector .panel-title').textContent + ' / ' + document.querySelector('.fx-head b')?.textContent`);
      await shot('fxlane-1.png');
      await q(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete' }))`);
      await wait(300);
      result.afterDelete = await fxOf();
      await q(`(() => { const b = [...document.querySelectorAll('[data-lane="effect"] .clip.effect')].find((x) => x.textContent.includes('Mirror')); const r = b.getBoundingClientRect();
        b.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 5, clientY: r.top + 5 })); })()`);
      await wait(250);
      result.menu = await q(`[...document.querySelectorAll('.ctx-menu [role=menuitem]')].map((b) => b.textContent)`);
      await q(`[...document.querySelectorAll('.ctx-menu button')].find((b) => b.textContent.startsWith('Delete effect')).click()`);
      await wait(300);
      result.afterMenu = await fxOf();
      await q(`window.__fve.dispatch({ type: 'undo' })`);
      await wait(200);
      result.afterUndo = await fxOf();
    } catch (e) {
      result.error = e.message;
    }
    fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(result, null, 2));
    return app.quit();
  }
  if (process.env.FVE_SMOKE_MODE === 'thumbs') {
    // Effect, transition and filter tiles show the sample pictures, and play on hover.
    try {
      await wait(800);
      const q = (js) => run(js);
      const painted = (sel) => q(`(() => [...document.querySelectorAll(${JSON.stringify(sel)})].filter((c) => {
        const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let s = 0; for (let i = 0; i < d.length; i += 400) s += d[i] + d[i + 1] + d[i + 2]; return s > 0; }).length)()`);
      for (const tab of ['transitions', 'effects']) {
        await q(`window.__fve.tab('${tab}')`);
        await wait(700);
        result[tab] = { tiles: await q(`document.querySelectorAll('.fx-thumb').length`), painted: await painted('.fx-thumb') };
        const before = await q(`document.querySelectorAll('.fx-thumb')[${tab === 'transitions' ? 12 : 8}].toDataURL()`);
        await q(`document.querySelectorAll('.fx-thumb')[${tab === 'transitions' ? 12 : 8}].closest('.tile').dispatchEvent(new PointerEvent('pointerenter'))`);
        await wait(600);
        result[tab].animates = before !== await q(`document.querySelectorAll('.fx-thumb')[${tab === 'transitions' ? 12 : 8}].toDataURL()`);
        await shot(`thumbs-${tab}.png`);
        await q(`document.querySelectorAll('.fx-thumb')[${tab === 'transitions' ? 12 : 8}].closest('.tile').dispatchEvent(new PointerEvent('pointerleave'))`);
      }
      await q(`window.__fve.tab('filters')`);
      await wait(500);
      result.filterSamples = await q(`[...document.querySelectorAll('.filter-thumb img')].filter((i) => i.naturalWidth > 0).length`);
      await shot('thumbs-filters.png');
    } catch (e) {
      result.error = e.message;
    }
    fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(result, null, 2));
    return app.quit();
  }
  if (process.env.FVE_SMOKE_MODE === 'stab') {
    // Stabilize: the first clip of <dir>/project.json (shaky) is stabilized from its panel, then turned off (the
    // original comes back) and on again (from the cache, at once).
    const q = run;
    const until = async (js, ms) => { for (let t = 0; t < ms; t += 250) { if (await q(js)) return true; await wait(250); } return false; };
    const clip = async () => (await q('window.__fve.exportData()')).project.videoClips[0];
    const pick = (name) => q(`[...document.querySelectorAll('.stab-levels button')].find((b) => b.textContent === ${JSON.stringify(name)}).click()`);
    try {
      await wait(800);
      const p = JSON.parse(fs.readFileSync(path.join(dir, 'project.json'), 'utf8'));
      result.at='load';
      await q(`window.__fve.load(${JSON.stringify(p)})`);
      await wait(1000);
      await q(`document.querySelector('.stats-note .icon-btn')?.click(); window.__fve.select({ track: 'video', id: ${JSON.stringify(p.videoClips[0].id)} })`);
      await wait(800);
      result.panel = await q(`!!document.querySelector('.stab-levels')`);
      await pick('Recommended');
      await wait(1500);
      result.progress = await q(`document.querySelector('.progress-block span')?.textContent || ''`);
      await shot('stab-working.png');
      const t0 = Date.now();
      result.done = await until(`!!window.__fve.exportData().project.videoClips[0].stabilize`, 180000);
      result.seconds = Math.round((Date.now() - t0) / 1000);
      const c = await clip();
      const m = (await q('window.__fve.exportData()')).project.media.find((x) => x.id === c.mediaId);
      result.on = { level: c.stabilize?.level, in: c.in, out: c.out, media: m?.name, orig: c.stabilize && [c.stabilize.in, c.stabilize.out] };
      await q('window.__fve.seek(1)');
      await q(`document.querySelector('.stab-levels').scrollIntoView({ block: 'center' })`);
      await wait(1500);
      await shot('stab-done.png');
      await pick('Off');
      await wait(500);
      const off = await clip();
      result.off = { mediaId: off.mediaId, in: off.in, out: off.out, stabilize: off.stabilize ?? null };
      const t1 = Date.now();
      await pick('Recommended');
      await until(`!!window.__fve.exportData().project.videoClips[0].stabilize`, 30000);
      result.cachedMs = Date.now() - t1;
      result.mediaCount = (await q('window.__fve.exportData()')).project.media.length;
    } catch (e) {
      result.error = e.message;
    }
    fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(result, null, 2));
    return app.quit();
  }
  if (process.env.FVE_SMOKE_MODE === 'deco') {
    // Mask outline / glow: <dir>/project.json with a round camera-like overlay that has a stroke and a glow. The
    // overlay is selected so the Mask tab shows its controls; the player and an exported frame are saved.
    const q = run;
    try {
      await wait(800);
      const p = JSON.parse(fs.readFileSync(path.join(dir, 'project.json'), 'utf8'));
      result.at='load';
      await q(`window.__fve.load(${JSON.stringify(p)})`);
      await wait(1200);
      const ov = p.overlayClips[0];
      await q(`document.querySelector('.stats-note .icon-btn')?.click(); window.__fve.seek(1.5); window.__fve.select({ track: 'overlay', id: ${JSON.stringify(ov.id)} })`);
      await wait(800);
      await q(`[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Mask')?.click()`);
      await wait(600);
      await q(`[...document.querySelectorAll('.section, section')].find((x) => x.textContent.includes('Outline and glow'))?.scrollIntoView()`);
      await wait(1000);
      result.decoShown = await q(`[...document.querySelectorAll('.slot.ov .layer.deco')].map((d) => d.style.display + ' ' + (d.style.backgroundImage || '').slice(0, 30))`);
      result.controls = await q(`!!document.querySelector('[aria-label="Stroke color"]') && !!document.querySelector('[aria-label="Glow color"]')`);
      await shot('deco-editor.png');
      const out = path.join(dir, 'deco-export.mp4');
      await runExport((await q('window.__fve.exportData()')).project, out, () => {}).promise;
      const { execFileSync } = require('child_process');
      const { ffmpegPath } = require('./ffmpeg.cjs');
      execFileSync(ffmpegPath, ['-y', '-v', 'error', '-ss', '1.5', '-i', out, '-frames:v', '1', path.join(dir, 'deco-export.png')]);
    } catch (e) {
      result.error = e.message;
    }
    fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(result, null, 2));
    return app.quit();
  }
  if (process.env.FVE_SMOKE_MODE === 'autocolor') {
    // Adjust > Auto color on <dir>/project.json's first clip (a video with a color cast): the sliders it sets, and
    // the player before / after.
    const q = run;
    const until = async (js, ms) => { for (let t = 0; t < ms; t += 250) { if (await q(js)) return true; await wait(250); } return false; };
    try {
      await wait(800);
      const p = JSON.parse(fs.readFileSync(path.join(dir, 'project.json'), 'utf8'));
      result.at='load';
      await q(`window.__fve.load(${JSON.stringify(p)})`);
      await wait(1200);
      await q(`document.querySelector('.stats-note .icon-btn')?.click(); window.__fve.seek(2); window.__fve.tab('adjust')`);
      await wait(1200);
      await shot('autocolor-before.png');
      const m0 = p.media[0];
      result.sample = await q(`window.api.colorSample(${JSON.stringify({ path: m0.path, type: m0.type, duration: m0.duration })}, 0, ${m0.duration}).then((r) => r.frames.map((f) => [f.width, f.height, f.data.length, f.data.constructor.name, f.data[0], f.data[1], f.data[2]]))`);
      await q(`[...document.querySelectorAll('button')].find((b) => b.textContent.includes('Auto color')).click()`);
      result.done = await until(`!!window.__fve.exportData().project.videoClips[0].grade`, 20000);
      result.grade = (await q('window.__fve.exportData().project')).videoClips[0].grade;
      result.error = await q(`document.querySelector('.grade-auto .error-text')?.textContent || ''`);
      await wait(1500);
      await shot('autocolor-after.png');
    } catch (e) {
      result.error = e.message;
    }
    fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(result, null, 2));
    return app.quit();
  }
  if (process.env.FVE_SMOKE_MODE === 'proxy') {
    // Proxy setting: turned on in Settings, every video gets a light copy that the player plays (badge "Proxy"),
    // while the export reads the original file at full size. <dir>/project.json: one video on the main track.
    const q = run;
    const until = async (js, ms) => { for (let t = 0; t < ms; t += 250) { if (await q(js)) return true; await wait(250); } return false; };
    try {
      await wait(800);
      const p = JSON.parse(fs.readFileSync(path.join(dir, 'project.json'), 'utf8'));
      result.at='load';
      await q(`window.__fve.load(${JSON.stringify(p)})`);
      await wait(1000);
      await q(`document.querySelector('.stats-note .icon-btn')?.click(); document.querySelector('[aria-label="Settings"]').click()`);
      await wait(600);
      await q(`[...document.querySelectorAll('.settings-section')].find((s) => s.textContent.includes('Proxy')).scrollIntoView()`);
      await q(`[...document.querySelectorAll('.settings-section')].find((s) => s.textContent.includes('Proxy')).querySelector('input[type=checkbox]').click()`);
      await wait(500);
      result.switchText = await q(`[...document.querySelectorAll('.settings-section')].find((s) => s.textContent.includes('Proxy')).querySelector('.stats-switch span').textContent`);
      await shot('proxy-settings.png');
      await q(`document.querySelector('[aria-label="Close settings"]').click()`);
      // The player's Proxy button shows the same setting (and turns it off / on again).
      await wait(600);
      result.playerBtn = await q(`document.querySelector('.proxy-btn')?.getAttribute('aria-pressed')`);
      await q(`document.querySelector('.proxy-btn').click()`);
      await wait(400);
      result.playerBtnOff = await q(`document.querySelector('.proxy-btn').getAttribute('aria-pressed')`);
      await q(`document.querySelector('.proxy-btn').click()`);
      result.made = await until(`!!window.__fve.exportData().project.media[0].lightProxy`, 60000);
      await wait(1500);
      result.badge = await q(`document.querySelector('.asset-opt.proxy')?.textContent || ''`);
      await q('window.__fve.seek(1)');
      await wait(1200);
      result.playerSrc = await q(`(document.querySelector('.stage > .slot video')?.dataset.src || '').split('/').pop()`);
      await shot('proxy-editor.png');
      const out = path.join(dir, 'proxy-export.mp4');
      await runExport((await q('window.__fve.exportData()')).project, out, () => {}).promise;
      const info = await probe(out);
      result.export = `${info.width}x${info.height}`;
      const { execFileSync } = require('child_process');
      const { ffmpegPath } = require('./ffmpeg.cjs');
      // The export's first-pass input must be the original, never a proxy.
      const exp = (await q('window.__fve.exportData()')).project;
      const args = JSON.stringify(require('./ffmpeg.cjs').buildExportArgs(exp, out));
      result.exportUsesOriginal = args.includes(JSON.stringify(exp.media[0].path).slice(1, -1)) && !/-l?proxy\.mp4/.test(args);
      execFileSync(ffmpegPath, ['-y', '-v', 'error', '-ss', '1', '-i', out, '-frames:v', '1', path.join(dir, 'proxy-export.png')]);
      // Off again, then the light copies can be deleted from Settings.
      await q(`document.querySelector('[aria-label="Settings"]').click()`);
      await wait(600);
      await q(`[...document.querySelectorAll('.settings-section')].find((s) => s.textContent.includes('Proxy')).querySelector('input[type=checkbox]').click()`);
      await wait(400);
      await q(`[...document.querySelectorAll('.settings-section')].find((s) => s.textContent.includes('Proxy')).querySelector('.proxy-store button')?.click()`);
      await wait(800);
      result.afterClear = await q(`[...document.querySelectorAll('.settings-section')].find((s) => s.textContent.includes('Proxy')).querySelector('.proxy-store span').textContent`);
      await q(`document.querySelector('[aria-label="Close settings"]').click()`);
      await wait(800);
      result.lightProxyAfter = (await q('window.__fve.exportData().project')).media[0].lightProxy ?? null;
      result.playerSrcAfter = await q(`(document.querySelector('.stage > .slot video')?.dataset.src || '').split('/').pop()`);
    } catch (e) {
      result.error = e.message;
    }
    fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(result, null, 2));
    return app.quit();
  }
  if (process.env.FVE_SMOKE_MODE === 'tracks') {
    // Timeline layers: <dir>/project.json with several audio and overlay clips at the same time; one more audio
    // layer added with its + button; screenshot of the timeline.
    try {
      await wait(800);
      await run(`window.__fve.load(${fs.readFileSync(path.join(dir, 'project.json'), 'utf8')})`);
      await wait(1500);
      await run(`document.querySelector('[aria-label="Add a Audio layer"]').click()`);
      await wait(400);
      result.rows = await run(`[...document.querySelectorAll('.tl-lane')].map((l) => l.dataset.lane + ':' + l.querySelectorAll('.layer-band').length)`);
      result.audioTops = await run(`[...document.querySelectorAll('.clip.audio')].map((c) => c.style.top)`);
      await run(`document.querySelector('.stats-note .icon-btn')?.click(); window.__fve.seek(2)`);
      await wait(800);
      await shot('tracks.png');
      await run(`(() => { const s = document.querySelector('.tl-scroll'); s.scrollTop = s.scrollHeight; })()`);
      await wait(300);
      await shot('tracks-audio.png');
    } catch (e) {
      result.error = e.message;
    }
    fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(result, null, 2));
    return app.quit();
  }
  if (process.env.FVE_SMOKE_MODE === 'about') {
    // About and updates, with FVE_UPDATE_URL on a local server that announces a newer version: the startup notice,
    // the dot on the About button, then the About dialog and its "Check for updates".
    const q = run;
    const until = async (js, ms) => { for (let t = 0; t < ms; t += 250) { if (await q(js)) return true; await wait(250); } return false; };
    try {
      result.notice = await until(`!!document.querySelector('.update-note')`, 15000);
      result.noticeText = await q(`document.querySelector('.update-note b')?.textContent || ''`);
      result.dot = await q(`!!document.querySelector('.about-btn .update-dot')`);
      await shot('about-notice.png');
      await q(`document.querySelector('.about-btn').click()`);
      await wait(500);
      result.version = await q(`document.querySelector('.about-version')?.textContent || ''`);
      await q(`[...document.querySelectorAll('.modal.about button')].find((b) => b.textContent.includes('Check for updates')).click()`);
      result.checked = await until(`!!document.querySelector('.about-update, .about-status.ok, .about-status.error')`, 15000);
      result.status = await q(`(document.querySelector('.about-update b, .about-status') || {}).textContent || ''`);
      await shot('about-dialog.png');
    } catch (e) {
      result.error = e.message;
    }
    fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(result, null, 2));
    return app.quit();
  }
  if (process.env.FVE_SMOKE_MODE === 'autoremoval') {
    // Auto removal from the clip panel: tick the box on <dir>/project.json's first clip (the model may be put in
    // <dir>/matting-test beforehand to skip the download), wait for the matte, then the preview without background.
    const q = run;
    const until = async (js, ms) => { for (let t = 0; t < ms; t += 250) { if (await q(js)) return true; await wait(250); } return false; };
    try {
      await wait(800);
      const p = JSON.parse(fs.readFileSync(path.join(dir, 'project.json'), 'utf8'));
      result.at='load';
      await q(`window.__fve.load(${JSON.stringify(p)})`);
      await wait(1000);
      await q(`window.__fve.select({ track: 'video', id: ${JSON.stringify(p.videoClips[0].id)} })`);
      await wait(500);
      await q(`[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Remove BG')?.click()`);
      await wait(400);
      await shot('autoremoval-0.png');
      await q(`document.querySelector('input[aria-label="Auto removal"]').click()`);
      await wait(1500);
      result.progress = await q(`document.querySelector('.progress-block span')?.textContent || ''`);
      await shot('autoremoval-1.png');
      result.done = await until(`!document.querySelector('.progress-block') && document.querySelector('input[aria-label="Auto removal"]').checked`, 240000);
      result.matte = (await q('window.__fve.exportData().project')).media[0].matte || null;
      result.bgRemove = !!(await q('window.__fve.exportData().project')).videoClips[0].bgRemove;
      result.errorText = await q(`document.querySelector('.error-text')?.textContent || ''`);
      await q('window.__fve.seek(1.5)');
      await wait(1500);
      await shot('autoremoval-2.png');
    } catch (e) {
      result.error = e.message;
    }
    fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(result, null, 2));
    return app.quit();
  }
  if (process.env.FVE_SMOKE_MODE === 'player') {
    // Plays across clips and records, every 250 ms, which media each player slot shows and whether it is decoding.
    try {
      await wait(800);
      await run(`window.__fve.load(${fs.readFileSync(path.join(dir, 'project.json'), 'utf8')})`);
      await wait(1500);
      const q = (js) => run(js);
      const state = () => q(`(() => [...document.querySelectorAll('.stage > .slot')].map((s) => {
        const v = s.querySelector('video');
        return { shown: getComputedStyle(v).visibility === 'visible' && v.style.display !== 'none', vis: s.style.visibility, op: s.style.opacity, src: (v.dataset.src || '').split('/').pop(), t: +v.currentTime.toFixed(2),
          ready: v.readyState, paused: v.paused, err: v.error ? v.error.code : 0, disp: v.style.display };
      }))()`);
      result.samples = [];
      await q(`window.__errs = []; window.addEventListener('error', (e) => window.__errs.push(String(e.message) + ' @ ' + String(e.error && e.error.stack).slice(0, 400))); window.addEventListener('unhandledrejection', (e) => window.__errs.push('rejection: ' + (e.reason && e.reason.message)));`);
      // Wait for preview proxies (videos the player cannot decode get one in the background).
      const t0 = Date.now();
      for (let i = 0; i < 480; i++) {
        const media = (await q('window.__fve.exportData().project')).media;
        if (!media.some((m) => m.optimizing) && i > 8) break;
        await wait(250);
      }
      result.proxyWait = Math.round((Date.now() - t0) / 1000);
      result.media = (await q('window.__fve.exportData().project')).media.map((m) => ({ name: m.name, proxy: !!m.proxy, pixFmt: m.pixFmt }));
      const from = Number(process.env.FVE_PLAYER_FROM || 4);
      await q(`window.__fve.seek(${from})`);
      await wait(800);
      result.atSeek = { tc: await q(`document.querySelector('.tc').textContent`), slots: await state() };
      await shot('player-0.png');
      await q('window.__fve.play()');
      for (let i = 0; i < 16; i++) {
        await wait(250);
        result.samples.push({ errs: await q('window.__errs.length'), tc: await q(`document.querySelector('.tc').textContent`), btn: await q(`document.querySelector('.play-btn').getAttribute('aria-label')`), slots: await state() });
        if (i === 8) await shot('player-1.png');
      }
      await q('window.__fve.pause()');
      // Then go back into the first clip, like a user checking the start again: paused, then playing.
      if (process.env.FVE_PLAYER_BACK) {
        await wait(300);
        await q(`window.__fve.seek(${Number(process.env.FVE_PLAYER_BACK)})`);
        await wait(700);
        result.back = { tc: await q(`document.querySelector('.tc').textContent`), slots: await state() };
        // Exactly one picture may be on screen, and it must be the clip under the playhead.
        result.backShown = result.back.slots.filter((x) => x.shown).map((x) => x.src);
        await shot('player-back.png');
        await q('window.__fve.play()');
        result.backPlay = [];
        for (let i = 0; i < 8; i++) {
          await wait(250);
          result.backPlay.push({ tc: await q(`document.querySelector('.tc').textContent`), slots: await state() });
        }
        await q('window.__fve.pause()');
        await shot('player-back-play.png');
      }
      result.pageErrors = await q('window.__errs.slice(0, 5)');
    } catch (e) {
      result.error = e.message;
    }
    fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(result, null, 2));
    return app.quit();
  }
  if (process.env.FVE_SMOKE_MODE === 'fx') {
    // Animated effects and transitions: GPU vs CPU reference, preview, and a full export through the effects pass.
    try {
      await wait(800);
      await run(`window.__fve.load(${fs.readFileSync(path.join(dir, 'project.json'), 'utf8')})`);
      await wait(500);
      const q = (js) => run(js);
      const until = async (js, ms = 30000) => { for (let t = 0; t < ms; t += 250) { if (await q(js)) return true; await wait(250); } return false; };
      const self = await q('window.__fve.fxSelfTest()');
      result.selfTestFailed = self.failed;
      result.selfTestWorst = Object.entries(self.res).sort((a, b) => b[1].mean - a[1].mean).slice(0, 3).map(([k, r]) => `${k} mean ${r.mean.toFixed(2)} avg ${r.avg.toFixed(2)}`);
      // c2: VHS, c3: Comic Cut in (0.5 s), c1: snow overlay; o1 (overlay): Striped Erosion.
      await q(`(() => {
        const d = window.__fve.dispatch;
        d({ type: 'update', track: 'video', id: 'c2', patch: { effects: ['fx_vhs'] } });
        d({ type: 'update', track: 'video', id: 'c3', patch: { transition: { type: 'fx_comic', duration: 0.5 } } });
        d({ type: 'update', track: 'video', id: 'c1', patch: { effects: ['fx_snow'] } });
        d({ type: 'update', track: 'overlay', id: 'o1', patch: { effects: ['fx_striped'] } });
      })()`);
      await q('window.__fve.seek(1.6)');
      await wait(800);
      result.vhsCanvas = await q(`[...document.querySelectorAll('.slot canvas.keyed')].some((c) => c.style.display === 'block')`);
      await shot('fx-1-vhs.png');
      await q('window.__fve.seek(0.5)');
      await wait(500);
      await shot('fx-2-snow.png');
      // c3 starts after c1 (1 s) + c2 (2.5 s) - transitions: find it from the layout.
      const t3 = await q(`(() => { const p = window.__fve.exportData().project; let end = 0; const out = []; p.videoClips.forEach((c, i) => {
        const len = (c.out - c.in) / (c.speed || 1); const td = i && c.transition ? Math.min(c.transition.duration, len / 2) : 0; const st = end - td; out.push([c.id, st, td]); end = st + len; });
        return out.find((x) => x[0] === 'c3'); })()`);
      await q(`window.__fve.seek(${t3[1] + t3[2] / 2})`);
      await wait(900);
      result.transitionCanvas = await q(`document.querySelector('.fx-transition').style.display === 'block'`);
      await shot('fx-3-comic.png');
      // Full export through the app (effects pass + FFmpeg).
      const out = path.join(dir, 'ui-export.mp4');
      fs.rmSync(out, { force: true });
      const t0 = Date.now();
      await q('window.__fve.exportNow()');
      result.exportDone = await until(`!!document.querySelector('.modal-icon.ok, .modal-icon.error')`, 240000);
      result.exportSeconds = Math.round((Date.now() - t0) / 1000);
      result.exportResult = await q(`document.querySelector('#export-title')?.textContent + ' ' + (document.querySelector('.error-log')?.textContent || '')`);
      if (fs.existsSync(out)) result.exportInfo = await probe(out);
    } catch (e) {
      result.error = e.message;
    }
    fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(result, null, 2));
    return app.quit();
  }
  if (process.env.FVE_SMOKE_MODE === 'favorites') {
    // Stars on a built-in sound and on imported media, then Yours > Favorites in Audio and Media.
    try {
      fs.rmSync(path.join(dir, 'favorites-test'), { recursive: true, force: true });
      await wait(800);
      await run(`window.__fve.load(${fs.readFileSync(path.join(dir, 'project.json'), 'utf8')})`);
      await wait(500);
      const q = (js) => run(js);
      const until = async (js, ms = 20000) => { for (let t = 0; t < ms; t += 200) { if (await q(js)) return true; await wait(200); } return false; };
      const side = (t) => q(`[...document.querySelectorAll('.side-btn')].find((b) => b.textContent.trim() === ${JSON.stringify(t)}).click()`);
      const P = () => q('window.__fve.exportData().project');
      // Star a built-in sound.
      await q(`window.__fve.tab('audio')`);
      await wait(300);
      await side('Built-in SFX');
      await until(`document.querySelectorAll('.lib-group .lib-row').length > 0`);
      await q(`document.querySelector('.lib-group .lib-row .fav-star').click()`);
      // Star the first imported video (Media > Yours > This project).
      await q(`window.__fve.tab('media')`);
      await wait(300);
      await q(`[...document.querySelectorAll('.asset')].find((a) => a.textContent.includes('a.mp4')).querySelector('.asset-star').click()`);
      await wait(300);
      result.saved = JSON.parse(fs.readFileSync(path.join(dir, 'favorites-test', 'favorites.json'), 'utf8')).map((e) => `${e.type}:${e.source}`);
      // Media > Favorites shows the video; add it to the main track.
      await side('Favorites');
      result.mediaFavTiles = await until(`document.querySelectorAll('.stock-grid .stock-tile').length === 1`);
      result.navAtFav = await q(`document.querySelector('.side-btn.child.on')?.textContent`);
      const v0 = (await P()).videoClips.length;
      await q(`document.querySelector('.stock-grid .stock-tile [aria-label="Add to the main track"]').click()`);
      result.mediaFavAdded = await until(`window.__fve.exportData().project.videoClips.length > ${v0}`);
      result.navAfterAdd = await q(`document.querySelector('.side-btn.child.on')?.textContent`);
      await shot('fav-1-media.png');
      // Audio > Yours > Favorites shows the sound; add it.
      await q(`window.__fve.tab('audio')`);
      await wait(300);
      await side('Yours');
      await side('Favorites');
      result.audioFavRows = await until(`document.querySelectorAll('.lib-list .lib-row').length === 1`);
      const a0 = (await P()).audioClips.length;
      await q(`document.querySelector('.lib-list .lib-row .lib-add').click()`);
      result.audioFavAdded = await until(`window.__fve.exportData().project.audioClips.length > ${a0}`);
      // Unstar from the favorites list.
      await q(`document.querySelector('.lib-list .lib-row .fav-star').click()`);
      result.afterUnstar = await until(`document.querySelectorAll('.lib-list .lib-row').length === 0`);
      await shot('fav-2-audio.png');
    } catch (e) {
      result.error = e.message;
    }
    fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(result, null, 2));
    return app.quit();
  }
  if (process.env.FVE_SMOKE_MODE === 'layout') {
    // Resizable panels: drag each border, double-click to reset. The user's saved layout is put back afterwards.
    const q = (js) => run(js);
    const saved = await q(`localStorage.getItem('clipcraft.layout')`);
    try {
      await wait(800);
      await run(`window.__fve.load(${fs.readFileSync(path.join(dir, 'project.json'), 'utf8')})`);
      await q(`localStorage.removeItem('clipcraft.layout')`);
      await wait(400);
      const sizes = () => q(`(() => { const w = (s) => Math.round(document.querySelector(s).getBoundingClientRect().width); const h = (s) => Math.round(document.querySelector(s).getBoundingClientRect().height);
        return { left: w('.left'), player: w('.player'), right: w('.inspector'), timeline: h('.timeline') }; })()`);
      const dragSplit = (sel, dx, dy) => q(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); const r = el.getBoundingClientRect();
        const x = r.left + r.width / 2, y = r.top + r.height / 2;
        el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y }));
        window.dispatchEvent(new PointerEvent('pointermove', { clientX: x + ${dx}, clientY: y + ${dy} }));
        window.dispatchEvent(new PointerEvent('pointerup', { clientX: x + ${dx}, clientY: y + ${dy} })); })()`);
      result.before = await sizes();
      await dragSplit('.splitter.col[aria-label^="Resize the left"]', 150, 0);
      await dragSplit('.splitter.col[aria-label^="Resize the properties"]', -100, 0);
      await dragSplit('.splitter.row', 0, -120);
      await wait(300);
      result.after = await sizes();
      await shot('layout-1-resized.png');
      await dragSplit('.splitter.col[aria-label^="Resize the left"]', 5000, 0);
      await wait(200);
      result.clamped = await sizes();
      await q(`document.querySelector('.splitter.col[aria-label^="Resize the left"]').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
      await wait(200);
      result.reset = await sizes();
      result.stored = await q(`localStorage.getItem('clipcraft.layout')`);
    } catch (e) {
      result.error = e.message;
    }
    await q(saved == null ? `localStorage.removeItem('clipcraft.layout')` : `localStorage.setItem('clipcraft.layout', ${JSON.stringify(saved)})`);
    fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(result, null, 2));
    return app.quit();
  }
  if (process.env.FVE_SMOKE_MODE === 'stock') {
    // Stock library against a local fake Pixabay (FVE_PIXABAY_API=http://127.0.0.1:47811/api/): key in Settings,
    // search, thumbnails, add to main track and overlay.
    const http = require('http');
    const base = 'http://127.0.0.1:47811';
    const files = { '/files/clip.mp4': path.join(dir, 'a.mp4'), '/files/photo.png': path.join(dir, 'photo.png'), '/files/thumb.jpg': path.join(dir, 'photo.png') };
    const seen = [];
    const server = http.createServer((req, res) => {
      const u = new URL(req.url, base);
      seen.push(u.pathname);
      if (files[u.pathname]) {
        const b = fs.readFileSync(files[u.pathname]);
        res.writeHead(200, { 'Content-Type': u.pathname.endsWith('.mp4') ? 'video/mp4' : 'image/png', 'Content-Length': b.length });
        return res.end(b);
      }
      if (u.searchParams.get('key') !== 'fake-pixabay-key') { res.writeHead(400); return res.end('[ERROR 400] "key" is wrong or missing.'); }
      const video = u.pathname.endsWith('/videos/');
      const hits = Array.from({ length: 6 }, (_, i) => (video
        ? { id: 100 + i, pageURL: `https://pixabay.com/videos/id-${100 + i}/`, duration: 5, user: 'Tester', tags: 'sea, wave',
          videos: { medium: { url: `${base}/files/clip.mp4`, width: 1920, height: 1080, size: 1, thumbnail: `${base}/files/thumb.jpg` }, small: { url: `${base}/files/clip.mp4`, thumbnail: `${base}/files/thumb.jpg` } } }
        : { id: 200 + i, pageURL: `https://pixabay.com/photos/id-${200 + i}/`, user: 'Tester', tags: 'mountain, lake', webformatURL: `${base}/files/thumb.jpg`, largeImageURL: `${base}/files/photo.png`, imageWidth: 800, imageHeight: 800 }));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ totalHits: 6, hits }));
    });
    await new Promise((r) => server.listen(47811, '127.0.0.1', r));
    try {
      fs.rmSync(path.join(dir, 'settings-test'), { recursive: true, force: true });
      await wait(800);
      await run(`window.__fve.load(${fs.readFileSync(path.join(dir, 'project.json'), 'utf8')})`);
      await wait(500);
      const q = (js) => run(js);
      const until = async (js, ms = 20000) => { for (let t = 0; t < ms; t += 200) { if (await q(js)) return true; await wait(200); } return false; };
      const clickText = (sel, text) => q(`(() => { const b = [...document.querySelectorAll(${JSON.stringify(sel)})].find((x) => x.textContent.trim() === ${JSON.stringify(text)}); if (!b) throw new Error('missing ' + ${JSON.stringify(text)}); b.click(); })()`);
      await q(`window.__fve.tab('media')`);
      await wait(200);
      await clickText('.side-btn', 'Stock videos');
      await wait(300);
      result.keyCard = await q(`!!document.querySelector('.stock-key')`);
      await clickText('.stock-key button', 'Open Settings');
      await until(`!!document.querySelector('[aria-label="Pixabay API key"]')`);
      await q(`(() => { const i = document.querySelector('[aria-label="Pixabay API key"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, 'fake-pixabay-key'); i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
      await wait(100);
      await clickText('.settings-section button', 'Test key');
      await until(`[...document.querySelectorAll('.settings-section .result')].some((r) => /Pixabay/.test(r.textContent))`);
      result.testKey = await q(`[...document.querySelectorAll('.settings-section .result')].map((r) => r.textContent).pop()`);
      await clickText('.settings-section button', 'Save key');
      await until(`/saved/.test(document.querySelectorAll('.settings-section')[1].textContent)`);
      result.savedHint = await q(`document.querySelectorAll('.settings-section')[1].querySelector('.key-ok')?.textContent`);
      result.keyInSettingsFile = fs.readFileSync(path.join(dir, 'settings-test', 'settings.json'), 'utf8').includes('fake-pixabay-key');
      await q(`document.querySelector('[aria-label="Close settings"]').click()`);
      result.videoTiles = await until(`document.querySelectorAll('.stock-tile').length === 6`);
      result.thumbs = await until(`[...document.querySelectorAll('.stock-tile img')].length === 6 && [...document.querySelectorAll('.stock-tile img')].every((i) => i.src.startsWith('file:') && i.naturalWidth > 0)`);
      await shot('stock-1-videos.png');
      const P = () => q('window.__fve.exportData().project');
      const before = await P();
      await q(`window.__fve.seek(0.5)`);
      await q(`document.querySelectorAll('.stock-tile [aria-label="Add to the main track"]')[0].click()`);
      result.mainAdded = await until(`window.__fve.exportData().project.videoClips.length > ${before.videoClips.length}`);
      await q(`document.querySelectorAll('.stock-tile [aria-label="Add as overlay"]')[1].click()`);
      result.overlayAdded = await until(`window.__fve.exportData().project.overlayClips.length > ${before.overlayClips.length}`);
      await clickText('.side-btn', 'Stock photos');
      await until(`document.querySelectorAll('.stock-tile').length === 6 && !document.querySelector('.stock-tile .asset-dur')`);
      await q(`document.querySelectorAll('.stock-tile [aria-label="Add to the main track"]')[0].click()`);
      result.photoAdded = await until(`window.__fve.exportData().project.videoClips.length > ${before.videoClips.length + 1}`);
      const after = await P();
      result.newMedia = after.media.slice(before.media.length).map((m) => ({ name: m.name, type: m.type, credit: m.credit?.line }));
      result.requests = [...new Set(seen)];
      await shot('stock-2-photos.png');
    } catch (e) {
      result.error = e.message;
    }
    server.close();
    fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(result, null, 2));
    return app.quit();
  }
  if (process.env.FVE_SMOKE_MODE === 'library') {
    // Audio library: online music search, add with credit, sound effects (built-ins removed).
    try {
      await wait(800);
      await run(`window.__fve.load(${fs.readFileSync(path.join(dir, 'project.json'), 'utf8')})`);
      await wait(500);
      const q = (js) => run(js);
      const until = async (js, ms = 30000) => { for (let t = 0; t < ms; t += 250) { if (await q(js)) return true; await wait(250); } return false; };
      const clips = async () => (await q('window.__fve.exportData().project')).audioClips.length;
      await q(`window.__fve.tab('audio')`);
      await until(`document.querySelectorAll('.lib-row').length > 0`);
      result.musicResults = await q(`document.querySelectorAll('.lib-row').length`);
      result.firstMusic = await q(`document.querySelector('.lib-row .lib-meta')?.textContent`);
      await shot('lib-1-music.png');
      // Add the first track: downloaded, added at the playhead with its credit.
      const before = await clips();
      await q(`window.__fve.seek(1)`);
      await q(`document.querySelector('.lib-row .lib-add').click()`);
      result.musicAdded = await until(`window.__fve.exportData().project.audioClips.length > ${before}`, 90000);
      const p = await q('window.__fve.exportData().project');
      const added = p.audioClips[p.audioClips.length - 1];
      result.musicClip = { start: added.start, media: p.media.find((m) => m.id === added.mediaId)?.name, credit: p.media.find((m) => m.id === added.mediaId)?.credit?.line };
      await wait(300);
      result.creditsCard = await q(`document.querySelector('.lib-credits pre')?.textContent || null`);
      // Sound effects: the synthesized built-ins were removed from the app (Hamza: poor
      // quality, sounded AI-generated). Assert they are gone, then preview + add online ones.
      result.nav = await q(`[...document.querySelectorAll('.chips.src-chips .chip')].map((b) => b.textContent.trim())`);
      await q(`[...document.querySelectorAll('.chips.src-chips .chip')].find((b) => b.textContent.trim() === 'Sound FX').click()`);
      await wait(200);
      result.builtin = await q(`document.querySelectorAll('.lib-group .lib-row').length`);
      result.offlineChip = await q(`[...document.querySelectorAll('.chip')].some((b) => b.textContent.trim() === 'Offline')`);
      await q(`[...document.querySelectorAll('.chip.cat')].find((b) => b.textContent.trim() === 'Whoosh').click()`);
      result.onlineSfx = await until(`document.querySelectorAll('.lib-list .lib-row').length > 0`, 30000);
      await q(`document.querySelector('.lib-list .lib-row .lib-play').click()`);
      result.previewPlaying = await until(`!!document.querySelector('.lib-list .lib-row.on') && !document.querySelector('.lib-list .lib-row.on .spin')`, 20000);
      result.sfxSource = await q(`document.querySelector('.tab-title')?.textContent`);
      result.sfxmintFirst = await q(`document.querySelector('.lib-list .lib-row .lib-meta')?.textContent`);
      const b3 = await clips();
      await q(`document.querySelector('.lib-list .lib-row .lib-add').click()`);
      result.sfxmintAdded = await until(`window.__fve.exportData().project.audioClips.length > ${b3}`, 30000);
      const pm = await q('window.__fve.exportData().project');
      result.sfxmintMedia = pm.media.find((m) => m.id === pm.audioClips[pm.audioClips.length - 1].mediaId)?.credit;
      await wait(300);
      await shot('lib-2-sfx.png');
      // A category lists the online effects; no source names anywhere.
      await q(`[...document.querySelectorAll('.chip.cat')].find((b) => b.textContent.trim() === 'Transition').click()`);
      result.transition = await until(`/Transition/.test(document.querySelector('.tab-title')?.textContent) && document.querySelectorAll('.lib-list .lib-row').length > 4`, 30000);
      result.transitionFirst = await q(`document.querySelector('.lib-list .lib-row .lib-meta')?.textContent`);
      result.sourceNames = await q(`/SFXMint|Freesound|Jamendo|Openverse/.test(document.querySelector('.left-panel, .panel, body').innerText)`);
      await shot('lib-3-transition.png');
    } catch (e) {
      result.error = e.message;
    }
    fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(result, null, 2));
    return app.quit();
  }
  if (process.env.FVE_SMOKE_MODE === 'clipmenu') {
    // Right-click menu, copy/paste, extract audio, deactivate, drag between tracks, player box, audio export.
    try {
      await wait(800);
      await run(`window.__fve.load(${fs.readFileSync(path.join(dir, 'project.json'), 'utf8')})`);
      await wait(700);
      const q = (js) => run(js);
      const P = () => q('window.__fve.exportData().project');
      const key = (k, mods = {}) => q(`window.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(k)}, ...${JSON.stringify(mods)} }))`);
      const clipEl = (id) => `[...document.querySelectorAll('.clip')].find((c) => c.__id === ${JSON.stringify(id)})`;
      // Clips are found by their label order on the main lane.
      const rightClick = (sel, i) => q(`(() => { const el = document.querySelectorAll(${JSON.stringify(sel)})[${i}]; const r = el.getBoundingClientRect();
        el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 10, clientY: r.top + 10 })); })()`);
      const menuClick = (label) => q(`(() => { const b = [...document.querySelectorAll('.ctx-menu button')].find((x) => x.textContent.startsWith(${JSON.stringify(label)})); if (!b) throw new Error('no menu item ' + ${JSON.stringify(label)}); b.click(); })()`);

      // Menu on the last main clip (c4: a.mp4 at 1x with sound).
      await rightClick('[data-lane="video"] .clip.video:not(.gap)', 3);
      await wait(250);
      result.menu = await q(`[...document.querySelectorAll('.ctx-menu [role=menuitem]')].map((b) => b.textContent.replace(/Ctrl.*|Del$/, '').trim() + (b.disabled ? ' (off)' : ''))`);
      await shot('menu-1.png');
      await menuClick('Extract audio');
      await wait(300);
      let p = await P();
      result.extract = { audioClips: p.audioClips.length, c4muted: p.videoClips.find((c) => c.id === 'c4').muted };
      // Extract is off for c1 (2x speed).
      await rightClick('[data-lane="video"] .clip.video:not(.gap)', 0);
      await wait(200);
      result.extractOffAt2x = await q(`[...document.querySelectorAll('.ctx-menu button')].find((b) => b.textContent.startsWith('Extract audio')).disabled`);
      await key('Escape');
      await wait(150);
      result.menuClosed = await q(`!document.querySelector('.ctx-menu')`);

      // Copy / paste with the keyboard.
      const before = (await P()).videoClips.length;
      await q(`window.__fve.select({ track: 'video', id: 'c4' }); window.__fve.seek(0.2)`);
      await wait(150);
      await key('c', { ctrlKey: true });
      await key('v', { ctrlKey: true });
      await wait(250);
      result.paste = [before, (await P()).videoClips.length];

      // Deactivate c3 from the menu: dimmed on the timeline, a gap in what exports.
      await rightClick('[data-lane="video"] .clip.video:not(.gap)', 3);
      await wait(200);
      await menuClick('Deactivate clip');
      await wait(250);
      result.deactivated = { dimmed: await q(`document.querySelectorAll('.clip.off').length`), exportGaps: (await P()).videoClips.filter((c) => c.gap).length };

      // Drag the first main clip up onto the Overlay lane.
      await q(`(() => {
        const el = document.querySelectorAll('[data-lane="video"] .clip.video:not(.gap)')[0];
        const r = el.getBoundingClientRect();
        const lane = document.querySelector('[data-lane="overlay"]').getBoundingClientRect();
        const x0 = r.left + r.width / 2, y0 = r.top + r.height / 2;
        el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, clientX: x0, clientY: y0 }));
        window.dispatchEvent(new PointerEvent('pointermove', { clientX: x0 + 40, clientY: lane.top + lane.height / 2 }));
        window.dispatchEvent(new PointerEvent('pointerup', { clientX: x0 + 40, clientY: lane.top + lane.height / 2 }));
      })()`);
      await wait(400);
      p = await P();
      result.dragToOverlay = { overlays: p.overlayClips.map((c) => c.id), main: p.videoClips.map((c) => c.id) };

      // Player box: select the overlay o1 at 3 s, move it, scale it, rotate it.
      await q(`window.__fve.select({ track: 'overlay', id: 'o1' }); window.__fve.seek(3)`);
      await wait(500);
      result.box = await q(`!!document.querySelector('.tbox')`);
      const t0 = (await P()).overlayClips.find((c) => c.id === 'o1').transform;
      const dragEl = (sel, dx, dy) => q(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); const r = el.getBoundingClientRect();
        const x = r.left + r.width / 2, y = r.top + r.height / 2;
        el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y }));
        window.dispatchEvent(new PointerEvent('pointermove', { clientX: x + ${dx}, clientY: y + ${dy} }));
        window.dispatchEvent(new PointerEvent('pointerup', { clientX: x + ${dx}, clientY: y + ${dy} })); })()`);
      await dragEl('.tbox', 60, 20);
      await wait(200);
      await dragEl('.tbox-handle.se', 40, 25);
      await wait(200);
      await dragEl('.tbox-rotate', 50, 0);
      await wait(300);
      const t1 = (await P()).overlayClips.find((c) => c.id === 'o1').transform;
      result.boxEdit = { before: t0, after: t1 };
      await shot('menu-2-box.png');
      // One undo per drag.
      await key('z', { ctrlKey: true });
      await wait(200);
      result.undoRot = (await P()).overlayClips.find((c) => c.id === 'o1').transform.rot;

      // Audio-only export from the Export menu.
      await q(`document.querySelector('[aria-label="More export options"]').click()`);
      await wait(200);
      await menuClick('Audio only (MP3)');
      for (let i = 0; i < 60 && !(await q(`!!document.querySelector('.modal-icon.ok, .modal-icon.error')`)); i++) await wait(250);
      result.audioExport = await q(`document.querySelector('#export-title')?.textContent + ' ' + (document.querySelector('.path, .error-log')?.textContent || '')`);
      const file = path.join(dir, 'ui-audio.mp3');
      if (fs.existsSync(file)) result.audioInfo = await probe(file);
      const { project: ep, pngs } = await q(`window.__fve.exportData()`);
      const assets = Object.fromEntries(Object.entries(pngs).map(([id, u]) => [id, Buffer.from(u.split(',')[1], 'base64')]));
      await runExport(ep, path.join(dir, 'ui-menu.mp4'), null, assets).promise;
      result.exported = true;
    } catch (e) {
      result.error = e.message;
    }
    fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(result, null, 2));
    return app.quit();
  }
  if (process.env.FVE_SMOKE_MODE === 'layers') {
    // Clip inspector tabs (transform, chroma key, mask, blend) and the overlay track, preview + export.
    try {
      await wait(800);
      await run(`window.__fve.load(${fs.readFileSync(path.join(dir, 'project.json'), 'utf8')})`);
      await wait(600);
      const q = (js) => run(js);
      const click = (sel) => q(`(() => { const el = [...document.querySelectorAll(${JSON.stringify(sel.split('|')[0])})].find((b) => !${JSON.stringify(sel.split('|')[1] || '')} || b.textContent.trim() === ${JSON.stringify(sel.split('|')[1] || '')}); if (!el) throw new Error('missing ' + ${JSON.stringify(sel)}); el.click(); })()`);
      await q(`window.__fve.select({ track: 'video', id: 'c2' }); window.__fve.seek(2.2)`);
      await wait(500);
      result.tabs = await q(`[...document.querySelectorAll('.ci-tabs button')].map((b) => b.textContent)`);
      result.subTabs = await q(`[...document.querySelectorAll('.clip-inspector .seg-tabs button')].map((b) => b.textContent)`);
      // Transform through the Position box and an align button.
      await q(`(() => { const i = document.querySelector('.numbox input'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(i, '200'); i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
      await wait(200);
      await click('[aria-label="Align top"]');
      await wait(300);
      result.transform = await q(`window.__fve.exportData().project.videoClips.find((c) => c.id === 'c2').transform`);
      result.layerTransform = await q(`document.querySelector('.slot .layer').style.transform`);
      await shot('layers-1-transform.png');
      // Mask: circle.
      await click('.clip-inspector .seg-tabs button|Mask');
      await wait(200);
      await click('.mask-tile|Circle');
      await wait(400);
      result.maskCss = await q(`[...document.querySelectorAll('.slot .layer')].some((l) => (l.style.maskImage || l.style.webkitMaskImage || '').startsWith('url("data:image/png'))`);
      await shot('layers-2-mask.png');
      // Chroma key on.
      await click('.clip-inspector .seg-tabs button|Remove BG');
      await wait(200);
      await click('[aria-label="Chroma key"]');
      await wait(600);
      result.keyedCanvas = await q(`[...document.querySelectorAll('.slot canvas.keyed')].some((c) => c.style.display === 'block' && c.width > 0)`);
      await shot('layers-3-chroma.png');
      // Overlay track: lane, clip, preview element.
      await q(`window.__fve.select({ track: 'overlay', id: 'o1' }); window.__fve.seek(3)`);
      await wait(700);
      result.overlayLane = await q(`!!document.querySelector('[data-lane="overlay"] .clip.overlay')`);
      result.overlayVisible = await q(`[...document.querySelectorAll('.slot.ov')].some((s) => s.style.visibility === 'visible')`);
      result.overlayTitle = await q(`document.querySelector('.inspector .panel-title').textContent`);
      await shot('layers-4-overlay.png');
      const { project: p, pngs } = await q(`window.__fve.exportData()`);
      result.maskImages = Object.keys(p.maskImages || {});
      const assets = Object.fromEntries(Object.entries(pngs).map(([id, u]) => [id, Buffer.from(u.split(',')[1], 'base64')]));
      await runExport(p, path.join(dir, 'ui-layers.mp4'), null, assets).promise;
      result.exported = true;
    } catch (e) {
      result.error = e.message;
    }
    fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(result, null, 2));
    return app.quit();
  }
  if (process.env.FVE_SMOKE_MODE === 'toolbar') {
    // Timeline toolbar: razor, delete left/right, markers, snapping toggle, fit, record button.
    try {
      await wait(800);
      await run(`window.__fve.load(${fs.readFileSync(path.join(dir, 'project.json'), 'utf8')})`);
      await wait(600);
      const q = (js) => run(js);
      const key = (k) => q(`window.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(k)} }))`);
      const dur = () => q('window.__fve.duration()');
      const mainClips = () => q(`document.querySelectorAll('.clip.video:not(.gap)').length`);
      result.buttons = await q(`[...document.querySelectorAll('.tl-toolbar [aria-label]')].map(b => b.getAttribute('aria-label'))`);
      await shot('toolbar-1.png');

      // Razor: switch the tool, click the middle of the second main clip.
      const clips0 = await mainClips();
      await q(`document.querySelector('[aria-label^="Razor"]').click()`);
      await wait(150);
      result.razorPressed = await q(`document.querySelector('[aria-label^="Razor"]').getAttribute('aria-pressed')`);
      await q(`(() => { const el = document.querySelectorAll('.clip.video:not(.gap)')[1]; const r = el.getBoundingClientRect(); el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 })); })()`);
      await wait(300);
      result.razorClips = [clips0, await mainClips()];
      await key('v'); // back to the select tool
      await wait(150);
      result.selectPressed = await q(`document.querySelector('[aria-label^="Select"]').getAttribute('aria-pressed')`);

      // Delete right of the playhead (W) and delete left (Q) in the main-track clip under it.
      const before = await dur();
      await q(`window.__fve.select(null); window.__fve.seek(1.0)`);
      await wait(300);
      await key('w');
      await wait(300);
      const afterW = await dur();
      result.deleteRight = { before, after: afterW };
      await q(`window.__fve.seek(0.3)`);
      await wait(300);
      result.projectBeforeQ = (await q('window.__fve.exportData().project')).videoClips.map((c) => `${c.id}[${c.in.toFixed(2)}..${c.out.toFixed(2)}]x${c.speed || 1}${c.transition ? ' T' + c.transition.duration : ''}`);
      await key('q');
      await wait(300);
      result.deleteLeft = { before: afterW, after: await dur() };
      result.projectAfterQ = (await q('window.__fve.exportData().project')).videoClips.map((c) => `${c.id}[${c.in.toFixed(2)}..${c.out.toFixed(2)}]`);
      await shot('toolbar-2-trimmed.png');

      // Markers: M adds, M on the same spot removes, a click on the toolbar flag adds again.
      await q(`window.__fve.seek(2)`);
      await wait(200);
      await key('m');
      await wait(200);
      result.markersAfterAdd = await q(`document.querySelectorAll('.tl-row.ruler .marker').length`);
      await shot('toolbar-3-marker.png');
      await key('m');
      await wait(200);
      result.markersAfterToggle = await q(`document.querySelectorAll('.tl-row.ruler .marker').length`);
      await q(`document.querySelector('[aria-label^="Marker at playhead"]').click()`);
      await wait(200);
      result.markersAfterButton = await q(`document.querySelectorAll('.tl-row.ruler .marker').length`);
      await q(`document.querySelector('.tl-row.ruler .marker').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
      await wait(200);
      result.markersAfterDblclick = await q(`document.querySelectorAll('.tl-row.ruler .marker').length`);

      // Snapping toggle and fit.
      result.snapBefore = await q(`document.querySelector('[aria-label^="Auto snapping"]').getAttribute('aria-pressed')`);
      await q(`document.querySelector('[aria-label^="Auto snapping"]').click()`);
      await wait(150);
      result.snapAfter = await q(`document.querySelector('[aria-label^="Auto snapping"]').getAttribute('aria-pressed')`);
      const w0 = await q(`document.querySelector('.tl-content').getBoundingClientRect().width`);
      await q(`document.querySelector('[aria-label^="Fit the project"]').click()`);
      await wait(250);
      const clip = await q(`(() => { const t = document.querySelector('.tl-row.main .clip'); return document.querySelector('.tl-scroll').clientWidth - 96 - 32; })()`);
      result.fit = { contentWidthBefore: Math.round(w0), contentWidthAfter: Math.round(await q(`document.querySelector('.tl-content').getBoundingClientRect().width`)), visible: clip };
      result.recordButton = await q(`!!document.querySelector('.rec-btn')`);
      await shot('toolbar-4-fit.png');
    } catch (e) {
      result.error = e.message;
    }
    fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(result, null, 2));
    return app.quit();
  }
  if (process.env.FVE_SMOKE_MODE === 'pilot') {
    return require('./smoke-pilot.cjs')(win, app, dir, shot);
  }
  if (process.env.FVE_SMOKE_MODE === 'settings') {
    // Settings dialog end to end with a fake key and a local mock server. Never touches real settings.
    const http = require('http');
    const FAKE = 'AIzaFAKE-settings-test-key-9876';
    const mock = http.createServer((req, res) => {
      let b = '';
      req.on('data', (c) => (b += c));
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'OK' }] } }] }));
      });
    });
    try {
      await new Promise((r) => mock.listen(0, '127.0.0.1', r));
      const base = `http://127.0.0.1:${mock.address().port}`;
      await wait(800);
      const setVal = (sel, v) => run(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); const proto = el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(v)}); el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true })); })()`);
      const click = (text) => run(`[...document.querySelectorAll('.settings button')].find(b => b.textContent.trim().startsWith(${JSON.stringify(text)})).click()`);
      await run(`document.querySelector('button[aria-label=Settings]').click()`);
      await wait(500);
      await shot('settings-1-open.png');
      result.providers = await run(`[...document.querySelectorAll('.settings select option')].map(o => o.textContent)`);
      // Gemini: type a key, point the address at the mock, test, save.
      await setVal('.settings input[type=password]', FAKE);
      await run(`document.querySelectorAll('.settings .field input[type=text]')[1]?.focus()`);
      // The address field is only shown for some providers, so use Ollama for the connection test below.
      await click('Save');
      await wait(500);
      result.afterSave = await run(`document.querySelector('.key-ok')?.textContent || null`);
      result.fieldCleared = await run(`document.querySelector('.settings input[type=password]').value === ''`);
      const file = path.join(dir, 'settings-test', 'settings.json');
      const raw = fs.readFileSync(file, 'utf8');
      result.keyInFile = raw.includes(FAKE) || raw.includes('FAKE-settings');
      result.fileHasEncrypted = /"enc":\s*"[A-Za-z0-9+/=]{20,}"/.test(raw);
      // Ollama against the mock: no key needed.
      await setVal('.settings select', 'ollama');
      await wait(200);
      await setVal('.settings .field input[type=text]:last-of-type', base);
      const inputs = await run(`document.querySelectorAll('.settings input[type=text]').length`);
      result.textInputs = inputs;
      await run(`(() => { const addr = [...document.querySelectorAll('.settings input[type=text]')].pop(); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(addr, ${JSON.stringify(base)}); addr.dispatchEvent(new Event('input', { bubbles: true })); })()`);
      await wait(200);
      await click('Test connection');
      await wait(1500);
      result.testResult = await run(`document.querySelector('.settings .result')?.textContent || null`);
      await shot('settings-2-tested.png');
      // Switching back keeps the saved Gemini key.
      await setVal('.settings select', 'gemini');
      await wait(200);
      result.geminiHintAfterSwitch = await run(`document.querySelector('.key-ok')?.textContent || null`);
      await click('Save');
      await wait(300);
      const raw2 = fs.readFileSync(file, 'utf8');
      result.keyStillOnlyEncrypted = !raw2.includes('FAKE-settings');
      await run(`[...document.querySelectorAll('.settings .icon-btn')].find(b => b.getAttribute('aria-label') === 'Delete saved key').click()`);
      await wait(300);
      result.afterDelete = await run(`document.querySelector('.key-ok')?.textContent || null`);
    } catch (e) {
      result.error = e.message;
    }
    mock.close();
    fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(result, null, 2));
    return app.quit();
  }
  if (process.env.FVE_SMOKE_MODE === 'magnet') {
    // Per-track magnet buttons: states, main-track gaps on delete, closing them again.
    try {
      await wait(800);
      await run(`window.__fve.load(${fs.readFileSync(path.join(dir, 'project.json'), 'utf8')})`);
      await wait(600);
      const q = (js) => run(js);
      result.initial = await q(`[...document.querySelectorAll('.magnet-btn')].map(b => b.getAttribute('aria-pressed'))`);
      result.heads = await q(`[...document.querySelectorAll('.tl-head')].map(h => h.textContent.trim())`);
      await q(`document.querySelectorAll('.magnet-btn')[2].click()`); // main track off
      await wait(200);
      await q(`window.__fve.select({ track: 'video', id: 'c2' })`);
      await q(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete' }))`);
      await wait(500);
      result.gapsAfterDelete = await q(`document.querySelectorAll('.clip.gap').length`);
      result.clipsAfterDelete = await q(`document.querySelectorAll('.clip.video:not(.gap)').length`);
      await shot('magnet-1-gap.png');
      await q(`document.querySelectorAll('.magnet-btn')[2].click()`); // main track on again
      await wait(400);
      result.gapsAfterOn = await q(`document.querySelectorAll('.clip.gap').length`);
      result.pressedAfter = await q(`[...document.querySelectorAll('.magnet-btn')].map(b => b.getAttribute('aria-pressed'))`);
      await shot('magnet-2-on.png');
    } catch (e) {
      result.error = e.message;
    }
    fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(result, null, 2));
    return app.quit();
  }
  if (process.env.FVE_SMOKE_MODE === 'audiocaps') {
    // Audio in the Media tab, and captions generated from the Audio track of a silent video.
    try {
      await wait(800);
      await run(`window.__fve.load(${fs.readFileSync(path.join(dir, 'project.json'), 'utf8')}); window.__fve.tab('media');`);
      await wait(800);
      result.mediaCards = await run(`[...document.querySelectorAll('.asset-name')].map(e => e.textContent)`);
      await shot('audiocaps-1-media.png');
      await run(`window.__fve.tab('captions')`);
      await wait(400);
      await run(`(() => { const sel = [...document.querySelectorAll('.card select')].find(s => [...s.options].some(o => o.value === 'audio')); const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set; set.call(sel, 'audio'); sel.dispatchEvent(new Event('change', { bubbles: true })); })()`);
      await run(`[...document.querySelectorAll('.card .btn-primary')].find(b => /captions|Regenerate/.test(b.textContent)).click()`);
      for (let i = 0; i < 120; i++) {
        await wait(500);
        if (await run(`/\d+ captions/.test(document.body.innerText) || !!document.querySelector('.error-box')`)) break;
      }
      result.captions = await run(`[...document.querySelectorAll('.clip.text .clip-label')].map(e => e.textContent)`);
      result.error = await run(`document.querySelector('.error-box')?.textContent || null`);
      await shot('audiocaps-2-captions.png');
    } catch (e) {
      result.error = e.message;
    }
    fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(result, null, 2));
    return app.quit();
  }
  if (process.env.FVE_SMOKE_MODE === 'visuals') {
    // A project whose media has no thumbnails yet: the app must request them and show the filmstrip.
    try {
      await wait(800);
      const p = JSON.parse(fs.readFileSync(path.join(dir, 'project.json'), 'utf8'));
      const t0 = Date.now();
      await run(`window.__fve.load(${JSON.stringify(p)}); window.__fve.seek(20);`);
      for (let i = 0; i < 60; i++) {
        await wait(250);
        const n = await run(`document.querySelectorAll('.tile-frame').length`);
        if (n > 0 && !result.firstThumbsMs) result.firstThumbsMs = Date.now() - t0;
        if (await run(`document.querySelectorAll('.clip-wave').length`)) { result.waveMs = Date.now() - t0; break; }
      }
      await wait(2500);
      result.tiles = await run(`document.querySelectorAll('.tile-frame').length`);
      await shot('visuals.png');
    } catch (e) {
      result.error = e.message;
    }
    fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(result, null, 2));
    return app.quit();
  }
  if (process.env.FVE_SMOKE_MODE === 'text') {
    // Text templates: preview screenshots, then a full UI export (text frames + FFmpeg).
    try {
      await wait(800);
      const p = JSON.parse(fs.readFileSync(path.join(dir, 'project.json'), 'utf8'));
      const words = (text, start, step) => text.split(' ').map((w, i) => ({ text: w, start: start + i * step, end: start + (i + 1) * step }));
      p.textClips = [
        { id: 'c1', text: 'This editor is completely free', start: 0, duration: 2.6, caption: true, words: words('This editor is completely free', 0, 0.5), y: 0.8, size: 54, template: 'cap-hormozi' },
        { id: 't2', text: 'NEON NIGHTS', start: 0.2, duration: 5, y: 0.25, size: 80, template: 'title-neon' },
        { id: 't3', text: 'Wow!', start: 2.7, duration: 2.5, x: 0.25, y: 0.3, size: 60, template: 'label-speech' },
        { id: 'c4', text: 'Karaoke style words', start: 2.7, duration: 2.5, caption: true, words: words('Karaoke style words', 0, 0.7), y: 0.8, size: 54, template: 'cap-karaoke' },
      ];
      await run(`window.__fve.load(${JSON.stringify(p)})`);
      // Apply each template's patch through the real catalog so the clips get their full styles.
      await run(`window.__fve.applyTemplates && window.__fve.applyTemplates()`);
      await run(`window.__fve.select({ track: 'text', id: 'c1' }); window.__fve.tab('text'); window.__fve.seek(1.2);`);
      await wait(1500);
      await shot('text-1-hormozi.png');
      await run(`[...document.querySelectorAll('.seg-tabs button')].find(b => b.textContent === 'Templates').click()`);
      await run(`window.__fve.select({ track: 'text', id: 'c4' }); window.__fve.seek(3.9);`);
      await wait(1200);
      await run(`[...document.querySelectorAll('.seg-tabs button')].find(b => b.textContent === 'Templates')?.click()`);
      await wait(800);
      await shot('text-2-karaoke.png');
      await run(`window.__fve.exportNow()`);
      for (let i = 0; i < 240; i++) {
        await wait(500);
        const st = await run(`document.querySelector('.modal h3')?.textContent || ''`);
        if (/complete|failed/i.test(st)) { result.exportStatus = st; break; }
      }
      result.exportError = await run(`document.querySelector('.error-log')?.textContent || null`);
      await shot('text-3-export.png');
    } catch (e) {
      result.error = e.message;
    }
    fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(result, null, 2));
    return app.quit();
  }
  if (process.env.FVE_SMOKE_MODE === 'dnd') {
    // Simulates HTML5 drag & drop from the asset panels onto the timeline and the player.
    try {
      await wait(800);
      const p = JSON.parse(fs.readFileSync(path.join(dir, 'project.json'), 'utf8'));
      const empty = { ...p, videoClips: [], textClips: [], audioClips: [] };
      await run(`window.__fve.load(${JSON.stringify(empty)}); window.__fve.tab('media');`);
      await wait(600);
      await shot('dnd-0-empty.png');
      const dnd = (srcSel, dstSel, xFrac) => run(`(() => {
        const src = ${srcSel};
        const dst = document.querySelector(${JSON.stringify(dstSel)});
        const r = dst.getBoundingClientRect();
        const x = r.left + r.width * ${xFrac}, y = r.top + r.height / 2;
        const dt = new DataTransfer();
        const ev = (type, el, cx, cy) => el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt, clientX: cx, clientY: cy }));
        ev('dragstart', src, 0, 0);
        ev('dragenter', dst, x, y);
        ev('dragover', dst, x, y);
        ev('drop', dst, x, y);
        ev('dragend', src, 0, 0);
        return true;
      })()`);
      const assets = `document.querySelectorAll('.asset')`;
      await dnd(`${assets}[0]`, '[data-lane=video]', 0.05);
      await wait(150);
      await dnd(`${assets}[1]`, '[data-lane=video]', 0.9);
      await wait(150);
      await dnd(`${assets}[0]`, '[data-lane=video]', 0.0);   // insert at the start
      await wait(150);
      await run(`window.__fve.tab('text')`);
      await wait(300);
      await dnd(`document.querySelectorAll('.tpl-btn')[1]`, '[data-lane=text]', 0.02);
      await run(`window.__fve.tab('filters')`);
      await wait(300);
      // Drop the B&W filter onto the second clip of the main track.
      await run(`(() => {
        const clip = document.querySelectorAll('.clip.video')[1];
        const r = clip.getBoundingClientRect();
        const x = r.left + r.width / 2, y = r.top + r.height / 2;
        const src = document.querySelectorAll('.tile')[1];
        const dt = new DataTransfer();
        const ev = (type, el, cx, cy) => el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt, clientX: cx, clientY: cy }));
        ev('dragstart', src, 0, 0); ev('dragover', clip, x, y); ev('drop', clip, x, y); ev('dragend', src, 0, 0);
      })()`);
      await run(`window.__fve.tab('audio')`);
      await wait(300);
      await run(`[...document.querySelectorAll('.side-btn')].find((b) => b.textContent.trim() === 'Yours').click()`);
      await wait(200);
      await dnd(`${assets}[0]`, '[data-lane=audio]', 0.1);
      await run(`window.__fve.tab('transitions')`);
      await wait(300);
      await run(`(() => {
        const clip = document.querySelectorAll('.clip.video')[1];
        const r = clip.getBoundingClientRect();
        const x = r.left + 20, y = r.top + r.height / 2;
        const src = document.querySelectorAll('.tile')[1];
        const dt = new DataTransfer();
        const ev = (type, el, cx, cy) => el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt, clientX: cx, clientY: cy }));
        ev('dragstart', src, 0, 0); ev('dragover', clip, x, y); ev('drop', clip, x, y); ev('dragend', src, 0, 0);
      })()`);
      await run(`window.__fve.tab('media'); window.__fve.select(null); window.__fve.seek(2.2)`);
      await wait(1200);
      await shot('dnd-1-timeline.png');
      const { project: q } = await run(`window.__fve.exportData()`);
      result.state = {
        video: q.videoClips.map((c) => `${q.media.find((m) => m.id === c.mediaId).name}|${c.filter}|${c.transition?.type || '-'}`),
        texts: q.textClips.map((c) => `${c.text}@${c.start.toFixed(2)}`),
        audio: q.audioClips.map((c) => `${q.media.find((m) => m.id === c.mediaId).name}@${c.start.toFixed(2)}`),
      };
    } catch (e) {
      result.error = e.message;
    }
    fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(result, null, 2));
    return app.quit();
  }
  if (process.env.FVE_SMOKE_MODE === 'captions') {
    // Generates auto captions through the real UI button, then screenshots the result.
    try {
      await wait(800);
      await run(`window.__fve.load(${fs.readFileSync(path.join(dir, 'project.json'), 'utf8')}); window.__fve.tab('captions');`);
      await wait(500);
      await run(`[...document.querySelectorAll('.card .btn-primary')].find(b => /captions|Regenerate/.test(b.textContent)).click()`);
      for (let i = 0; i < 120; i++) {
        await wait(500);
        if (await run(`!!document.querySelector('.card b') && /\\d+ captions/.test(document.body.innerText)`)) break;
      }
      await run(`window.__fve.seek(3)`);
      await wait(800);
      await shot('captions.png');
      result.captions = await run(`[...document.querySelectorAll('.clip.text .clip-label')].map(e => e.textContent)`);
      result.error = await run(`document.querySelector('.error-text')?.textContent || null`);
    } catch (e) {
      result.error = e.message;
    }
    fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(result, null, 2));
    return app.quit();
  }
  try {
    await wait(800);
    const project = fs.readFileSync(path.join(dir, 'project.json'), 'utf8');
    await run(`window.__fve.load(${project});`);
    await run(`window.__fve.tab('transitions'); window.__fve.select({ track: 'video', id: 'c2' }); window.__fve.seek(1.25);`);
    await wait(1500);
    await shot('ui-1-transition.png');
    await run(`window.__fve.tab('filters'); window.__fve.select({ track: 'video', id: 'c3' }); window.__fve.seek(3.4);`);
    await wait(1200);
    await shot('ui-2-filters.png');
    await run(`window.__fve.seek(0.8); window.__fve.play();`);
    await wait(2000);
    await run(`window.__fve.pause()`);
    await wait(400);
    await shot('ui-3-played.png');
    result.timecode = await run(`document.querySelector('.tc').textContent`);
    const { project: p } = await run(`window.__fve.exportData()`);
    await runExport(p, path.join(dir, 'ui-export.mp4'), null).promise;
    result.exported = true;
  } catch (e) {
    result.error = e.message;
  }
  fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(result, null, 2));
  app.quit();
};
