// FVE_SMOKE_MODE=tplmotion (Batch 2, W2/W3): the redesigned Text Templates end to end —
// apply 'Smooth Slide' from the Motion row through the real Templates UI, fill the
// 'Impact Pop' caption through the app's own applyTemplates helper, then export through
// the real pipeline. The runner (scripts/test-tplmotion-export.cjs) pixel-checks the
// exported frames: the title's centroid must rise and settle; the caption's violet
// highlight must be present. Needs <dir>/project.json with text clip 't1' (bare) and
// caption clip 'c1' (template: 'cap-hormozi', with word timings).
const fs = require('fs');
const path = require('path');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = async function tplmotionSmoke(win, dir, result) {
  const q = async (js) => {
    try { return await win.webContents.executeJavaScript(js); }
    catch (e) { throw new Error(`step "${result.step || '?'}" failed: ${e.message}`); }
  };
  const at = (s) => { result.step = s; };
  const shot = async (name, sel) => {
    const rect = sel ? await q(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) }; })()`) : null;
    fs.writeFileSync(path.join(dir, name), (await (rect ? win.capturePage(rect) : win.capturePage())).toPNG());
  };
  const click = (sel, text) => q(`[...document.querySelectorAll(${JSON.stringify(sel)})].find((b) => b.textContent.trim() === ${JSON.stringify(text)}).click()`);
  const untilQ = async (expr, tries = 40) => { for (let i = 0; i < tries; i++) { if (await q(expr).catch(() => null)) return true; await wait(400); } return false; };
  const clip = (id) => q(`window.__fve.exportData().project.textClips.find((c) => c.id === '${id}')`);

  win.setContentSize(1440, 900);
  await wait(800);
  // Fresh smoke profile: dismiss the onboarding tour and the Welcome card if they show.
  await q(`(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Skip tour'); if (b) b.click(); return !!b; })()`).catch(() => {});
  await wait(400);
  at('enter-editor');
  await q(`document.querySelector('[aria-label="New 16:9 project"]').click()`);
  await wait(600);
  await q(`(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Start creating'); if (b) b.click(); return !!b; })()`).catch(() => {});
  await wait(400);
  at('load');
  await q(`window.__fve.load(${fs.readFileSync(path.join(dir, 'project.json'), 'utf8')})`);
  await wait(800);
  // Fill the caption's style from its template id (the app's own helper), then apply
  // Smooth Slide to the title through the Templates UI, exactly like a user.
  at('applyTemplates');
  await q(`window.__fve.applyTemplates()`);
  await wait(300);
  result.caption = await clip('c1');
  at('select');
  await q(`window.__fve.select({ track: 'text', id: 't1' }); window.__fve.seek(1.5)`);
  await wait(400);
  at('templates-tab');
  await untilQ(`[...document.querySelectorAll('.text-inspector .seg-tabs button')].some((b) => b.textContent.trim() === 'Templates')`);
  await click('.text-inspector .seg-tabs button', 'Templates');
  await untilQ(`!!document.querySelector('.tpl .chip')`);
  result.chips = await q(`[...document.querySelectorAll('.tpl .chip')].map((b) => b.textContent.trim())`);
  at('motion-chip');
  await click('.tpl .chip', 'Motion');
  await untilQ(`[...document.querySelectorAll('.tpl .tpl-name')].some((s) => s.textContent.trim() === 'Smooth Slide')`);
  result.motionNames = await q(`[...document.querySelectorAll('.tpl .tpl-name')].map((s) => s.textContent.trim())`);
  at('apply-smooth-slide');
  await q(`[...document.querySelectorAll('.tpl .tpl-btn')].find((b) => b.title === 'Smooth Slide').click()`);
  await wait(300);
  const t1 = await clip('t1');
  result.template = t1.template;
  result.animIn = t1.animIn;
  await shot('tplmotion-panel.png', '.inspector');

  at('exportNow');
  await q(`window.__fve.exportNow()`);
  for (let i = 0; i < 240; i++) {
    await wait(500);
    const st = await q(`document.querySelector('.modal h3')?.textContent || ''`);
    if (/complete|failed/i.test(st)) { result.exportStatus = st; break; }
  }
  result.exportError = await q(`document.querySelector('.error-log')?.textContent || null`);
};
