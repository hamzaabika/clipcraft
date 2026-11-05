// User caption templates: a named style patch the user saved from their SRT
// captions, persisted in localStorage. Pure logic — storage is injected for
// testing, following src/fx/presets.js. A saved template captures exactly the
// style fields a built-in TEXT_TEMPLATES patch sets (src/text/catalog.js), so
// applying one through styleSrtCaptions reproduces the look completely.

export const USER_TEMPLATE_KEY = 'clipcraft.captionTemplates';
export const USER_TEMPLATE_DEFAULT_KEY = 'clipcraft.captionTemplateDefault';

// Every style field a caption template patch may carry (the union of the
// built-in caption template patches in src/text/catalog.js, plus the position
// and sizing fields the inspector edits). Per-clip data (id, text, start,
// duration, words, caption, source, layer) is never part of a template.
export const CAPTION_STYLE_KEYS = [
  'font', 'size', 'bold', 'italic', 'underline', 'uppercase',
  'color', 'color2', 'glowColor', 'letterSpacing', 'lineHeight', 'align',
  'maxWidth', 'x', 'y', 'rotation', 'opacity',
  'stroke', 'shadow', 'bg', 'effect', 'bubble', 'bubbleColor',
  'highlight', 'animIn', 'animOut', 'animLoop',
];

const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

// The style patch a clip (or a built-in template patch) carries: only the
// style keys, deep-cloned so later edits never mutate a saved template.
export function captureStylePatch(source) {
  if (!source || typeof source !== 'object') return null;
  const patch = {};
  for (const k of CAPTION_STYLE_KEYS) {
    if (source[k] !== undefined) patch[k] = clone(source[k]);
  }
  return Object.keys(patch).length ? patch : null;
}

export function sanitizeUserTemplate(p) {
  if (!p || typeof p !== 'object') return null;
  const name = typeof p.name === 'string' ? p.name.trim() : '';
  if (!name) return null;
  const patch = captureStylePatch(p.patch);
  if (!patch) return null;
  return { name, patch };
}

export function loadUserTemplates(storage) {
  try {
    const v = JSON.parse((storage || localStorage).getItem(USER_TEMPLATE_KEY) || '[]');
    return (Array.isArray(v) ? v : []).map(sanitizeUserTemplate).filter(Boolean);
  } catch { return []; }
}

export function saveUserTemplates(storage, list) {
  try { (storage || localStorage).setItem(USER_TEMPLATE_KEY, JSON.stringify(list)); } catch { /* storage full/blocked */ }
}

// Adds (or replaces, by name) a template captured from a clip or patch;
// returns the new list (the input list when the name/source is unusable).
export function upsertUserTemplate(list, source, name) {
  const tpl = sanitizeUserTemplate({ name, patch: source && source.patch ? source.patch : captureStylePatch(source) });
  if (!tpl) return list;
  return [...list.filter((t) => t.name.toLowerCase() !== tpl.name.toLowerCase()), tpl];
}

export function removeUserTemplate(list, name) {
  return list.filter((t) => t.name !== name);
}

// The clip patch a saved template applies (a fresh deep clone every time).
export function userTemplatePatch(tpl) {
  const patch = tpl ? captureStylePatch(tpl.patch) : null;
  return patch || {};
}

// The persisted default for SRT import: the NAME of a user template, or ''.
export function loadDefaultTemplateName(storage) {
  try {
    const v = (storage || localStorage).getItem(USER_TEMPLATE_DEFAULT_KEY);
    return typeof v === 'string' ? v : '';
  } catch { return ''; }
}

export function saveDefaultTemplateName(storage, name) {
  try {
    const s = storage || localStorage;
    if (name) s.setItem(USER_TEMPLATE_DEFAULT_KEY, String(name));
    else s.removeItem(USER_TEMPLATE_DEFAULT_KEY);
  } catch { /* storage full/blocked */ }
}
