// User caption templates: pure store logic (capture/save/apply/delete/persistence),
// following the test-presets.mjs pattern. Usage: node scripts/test-user-templates.mjs
import assert from 'assert/strict';
import {
  loadUserTemplates, saveUserTemplates, upsertUserTemplate, removeUserTemplate,
  userTemplatePatch, captureStylePatch, sanitizeUserTemplate,
  loadDefaultTemplateName, saveDefaultTemplateName,
} from '../src/text/userTemplates.js';

const store = { v: {}, getItem(k) { return this.v[k] ?? null; }, setItem(k, val) { this.v[k] = val; }, removeItem(k) { delete this.v[k]; } };

// Capture: only style keys survive — per-clip data (text/timing/id/source) never does.
const clip = {
  id: 'c1', text: 'مرحبا بالعالم', start: 3, duration: 2, source: 'srt', caption: true, template: 'cap-boxed',
  font: 'cairo', size: 96, bold: true, color: '#ffffff', color2: '#ffd400',
  stroke: { width: 6, color: '#000000' }, shadow: { on: true, color: '#000000', blur: 8, x: 0, y: 3, opacity: 0.8 },
  bg: { on: true, color: '#111111', opacity: 0.7, radius: 10, padding: 0.3, mode: 'line' },
  effect: 'none', bubble: 'none', highlight: { mode: 'box', color: '#111111', bg: '#ffd400' },
  animIn: { id: 'pop', dur: 0.3 }, animOut: { id: 'fade', dur: 0.25 }, animLoop: { id: 'none', speed: 1 },
  x: 0.5, y: 0.82,
};
const patch = captureStylePatch(clip);
assert.equal(patch.font, 'cairo');
assert.equal(patch.size, 96);
assert.deepEqual(patch.highlight, { mode: 'box', color: '#111111', bg: '#ffd400' });
assert.ok(!('text' in patch) && !('id' in patch) && !('start' in patch) && !('template' in patch) && !('source' in patch), 'per-clip fields are not captured');
// Deep clone: editing the source clip afterwards must not mutate the captured patch.
clip.stroke.width = 99;
assert.equal(patch.stroke.width, 6, 'capture deep-clones nested style objects');

// Save / replace-by-name / persistence round-trip.
let list = upsertUserTemplate([], clip, 'My Arabic');
assert.equal(list.length, 1);
assert.equal(list[0].name, 'My Arabic');
list = upsertUserTemplate(list, { ...clip, font: 'tajawal' }, 'my arabic'); // same name replaces
assert.equal(list.length, 1);
assert.equal(list[0].patch.font, 'tajawal');
assert.equal(upsertUserTemplate(list, clip, '   ').length, 1, 'blank names rejected');
assert.equal(upsertUserTemplate(list, { id: 'x', text: 'no style at all' }, 'Empty').length, 1, 'a clip with no style fields saves nothing');
saveUserTemplates(store, list);
const back = loadUserTemplates(store);
assert.equal(back.length, 1);
assert.deepEqual(userTemplatePatch(back[0]), back[0].patch, 'apply patch reproduces the saved style');
// Apply returns a fresh clone: mutating it does not corrupt the saved template.
const applied = userTemplatePatch(back[0]);
const savedWidth = back[0].patch.stroke.width;
applied.stroke.width = 4242;
assert.equal(back[0].patch.stroke.width, savedWidth, 'apply patch is a fresh clone');

assert.equal(removeUserTemplate(list, 'my arabic').length, 0, 'delete by exact name');
assert.equal(sanitizeUserTemplate({ name: 'x', patch: {} }), null, 'empty patch rejected');
store.v['clipcraft.captionTemplates'] = '{broken json';
assert.deepEqual(loadUserTemplates(store), [], 'corrupt storage degrades to empty');

// Persisted default-for-import name.
saveDefaultTemplateName(store, 'My Arabic');
assert.equal(loadDefaultTemplateName(store), 'My Arabic');
saveDefaultTemplateName(store, '');
assert.equal(loadDefaultTemplateName(store), '');
console.log('user-templates OK');
