// FVE_SMOKE_MODE=tracking: motion tracking end to end in the real app — the inspector's Track motion
// button opens the pick mode, a real input click picks the moving square on the player, the render-job
// pill runs the engine, the path lands on the clip; a text clip is then pinned through its inspector
// card, and the project is exported. The runner (scripts/test-tracking.cjs) measures the exported
// frames against the fixture's known path.
// Needs <dir>/project.json (video clip 'v1' without a track, text 't1' unpinned) and <dir>/pick.json
// ({ x, y } stage fractions of the target at the pick frame).
const fs = require('fs');
const path = require('path');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = async function trackingSmoke(win, dir, result) {
  const q = (js) => win.webContents.executeJavaScript(js);
  const until = async (js, tries = 60, step = 500) => {
    for (let i = 0; i < tries; i++) { if (await q(js)) return true; await wait(step); }
    return false;
  };
  const shot = async (name) => fs.writeFileSync(path.join(dir, name), (await win.capturePage()).toPNG());

  win.setContentSize(1440, 900);
  // First-run surfaces (the onboarding tour on Home, the Welcome card in the editor) must not
  // sit between the test and the editor; dismiss them whenever they are up.
  const dismissFirstRun = () => q(`(() => {
    const btns = [...document.querySelectorAll('button')];
    const skip = btns.find((b) => /skip tour/i.test(b.textContent));
    if (skip) { skip.click(); return 'tour'; }
    const start = btns.find((b) => b.textContent.trim() === 'Start creating');
    if (start) { start.click(); return 'welcome'; }
    return null;
  })()`);
  await until(`!!document.querySelector('[aria-label="New 16:9 project"]')`, 60, 500);
  await dismissFirstRun();
  await q(`document.querySelector('[aria-label="New 16:9 project"]').click()`);
  await until(`!!document.querySelector('aside.inspector')`, 60, 500);
  await dismissFirstRun();
  await q(`window.__fve.load(${fs.readFileSync(path.join(dir, 'project.json'), 'utf8')})`);
  await wait(800);
  await dismissFirstRun();

  // 1) Track: select the video clip, open the pick mode from its inspector.
  await q(`window.__fve.select({ track: 'video', id: 'v1' })`);
  result.trackButton = await until(`[...document.querySelectorAll('aside.inspector button')].some((b) => b.textContent.trim().startsWith('Track motion'))`, 30, 300);
  await q(`[...document.querySelectorAll('aside.inspector button')].find((b) => b.textContent.trim().startsWith('Track motion')).click()`);
  result.pickMode = await until(`!!document.querySelector('.track-pick')`, 20, 250);

  // The Welcome card can mount a moment after the editor settles, and its modal backdrop
  // covers the stage: keep dismissing first-run surfaces until the stage itself is the top element.
  const clearStage = async () => {
    for (let i = 0; i < 24; i++) {
      const state = await q(`(() => {
        const btns = [...document.querySelectorAll('button')];
        const b = btns.find((x) => x.textContent.trim() === 'Start creating') || btns.find((x) => /skip tour/i.test(x.textContent));
        if (b) { b.click(); return 'clicked'; }
        const el = document.querySelector('.track-pick') || document.querySelector('.stage');
        if (!el) return 'no-stage';
        const r = el.getBoundingClientRect();
        const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
        return top === el || el.contains(top) ? 'clear' : 'covered';
      })()`);
      if (state === 'clear' || state === 'no-stage') return state;
      await q(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
      await wait(400);
    }
    return 'still-covered';
  };
  result.stageClear = await clearStage();

  // 2) Click the target on the stage with a real input event at the fixture's known position.
  const pick = JSON.parse(fs.readFileSync(path.join(dir, 'pick.json'), 'utf8'));
  const rect = await q(`(() => { const r = document.querySelector('.track-pick').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`);
  const cx = Math.round(rect.x + rect.w * pick.x);
  const cy = Math.round(rect.y + rect.h * pick.y);
  win.webContents.sendInputEvent({ type: 'mouseDown', x: cx, y: cy, button: 'left', clickCount: 1 });
  win.webContents.sendInputEvent({ type: 'mouseUp', x: cx, y: cy, button: 'left', clickCount: 1 });
  await wait(400);
  result.markerShown = await q(`!!document.querySelector('.track-dot')`);
  await shot('track-pick.png');

  // 3) Confirm in the app-level bar; the engine runs as a render job.
  await q(`[...document.querySelectorAll('.render-job button')].find((b) => b.textContent.trim() === 'Track motion').click()`);
  result.tracked = await until(`(window.__fve.exportData().project.videoClips[0].track?.points?.length || 0) > 20`, 360, 500);
  const clip = await q(`window.__fve.exportData().project.videoClips[0]`);
  result.trackPoints = clip?.track?.points?.length || 0;
  result.lowConf = (clip?.track?.points || []).filter((p) => (p.c ?? 1) < 0.35).length;

  // 4) Pin the text clip through its inspector card.
  await q(`window.__fve.select({ track: 'text', id: 't1' })`);
  result.pinButton = await until(`[...document.querySelectorAll('aside.inspector button')].some((b) => b.textContent.trim().startsWith('Pin to'))`, 30, 300);
  await q(`[...document.querySelectorAll('aside.inspector button')].find((b) => b.textContent.trim().startsWith('Pin to'))?.click()`);
  await wait(300);
  const text = await q(`window.__fve.exportData().project.textClips[0]`);
  result.pinnedTo = text?.pin?.to || null;

  const data = await q(`window.__fve.exportData()`);
  result.motionHasText = !!data?.project?.motion?.v1;

  // 5) Mid-motion screenshot: the pinned text rides the target.
  await q(`window.__fve.seek(3.2)`);
  await wait(700);
  await shot('track-ui.png');

  // 6) Export through the real flow.
  await q(`window.__fve.exportNow()`);
  for (let i = 0; i < 240; i++) {
    await wait(500);
    const st = await q(`document.querySelector('.modal h3')?.textContent || ''`);
    if (/complete|failed/i.test(st)) { result.exportStatus = st; break; }
  }
  result.exportError = await q(`document.querySelector('.error-log')?.textContent || null`);
};
