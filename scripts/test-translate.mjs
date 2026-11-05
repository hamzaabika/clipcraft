// Caption translation (v1.1.10), the store + renderer half: the translated
// layer lands with the source captions' exact timings and styles, originals
// untouched, one undo step, normalize keeps the translation tags; the source
// selection helpers never offer translations as a source.
// Usage: node scripts/test-translate.mjs
import { emptyProject, historyReducer, layerCount, normalizeProject } from '../src/store.js';
import { TRANSLATE_LANGS, langName, translationSources, translationStyle } from '../src/translate.js';

const assert = (ok, what) => { if (!ok) throw new Error(what); };
const state = (project) => ({ past: [], present: project, future: [] });
const cap = (id, over = {}) => ({
  id, text: `line ${id}`, start: 0, duration: 2, caption: true,
  font: 'poppins', bold: true, color: '#ffffff', y: 0.8, size: 54,
  highlight: { mode: 'karaoke', color: '#825cfb' }, words: [{ text: 'line', start: 0, end: 0.4 }],
  ...over,
});
const base = (textClips) => ({ ...emptyProject(), textClips });

// --- Source selection: auto / srt / all, translations never a source.
{
  const p = base([
    cap('a1', { start: 4 }), cap('a2', { start: 1 }),
    cap('s1', { source: 'srt', start: 2 }),
    cap('t1', { source: 'translation', lang: 'fr', start: 3 }),
    { id: 'x1', text: 'plain title', start: 0, duration: 3 },
  ]);
  const s = translationSources(p);
  assert(s.auto.map((c) => c.id).join(',') === 'a2,a1', 'auto set sorted by start');
  assert(s.srt.map((c) => c.id).join(',') === 's1', 'srt set');
  assert(s.all.map((c) => c.id).join(',') === 'a2,s1,a1', 'all = auto + srt, sorted, no translations, no plain text');
  assert(TRANSLATE_LANGS.length >= 12 && langName('fr') === 'French' && langName('xx') === 'xx', 'language list + names');
}

// --- Style copy: visuals carried, identity/timing/words not.
{
  const st = translationStyle(cap('a1', { layer: 3, source: 'srt', lang: 'en' }));
  assert(st.font === 'poppins' && st.highlight.mode === 'karaoke' && st.y === 0.8, 'style fields carried');
  assert(!('id' in st) && !('start' in st) && !('words' in st) && !('layer' in st) && !('source' in st), 'identity/timing/words/layer dropped');
}

// --- The action: new layer, exact timings, tags, one undo, originals intact.
{
  let s = state(base([cap('a1', { start: 1, duration: 2.5 }), cap('a2', { start: 5, duration: 1.5 })]));
  const layer = layerCount(s.present, 'text');
  s = historyReducer(s, {
    type: 'addTranslatedCaptions', lang: 'fr', layer,
    segments: [
      { id: 'n1', text: 'ligne un', start: 1, duration: 2.5, style: translationStyle(s.present.textClips[0]) },
      { id: 'n2', text: 'ligne deux', start: 5, duration: 1.5, style: translationStyle(s.present.textClips[1]) },
    ],
  });
  const tr = s.present.textClips.filter((c) => c.source === 'translation');
  assert(tr.length === 2, 'two translated clips added');
  assert(tr[0].start === 1 && tr[0].duration === 2.5 && tr[1].start === 5 && tr[1].duration === 1.5, 'timings identical to sources');
  assert(tr.every((c) => c.lang === 'fr' && c.caption && c.layer === layer), 'lang/caption/layer tags set');
  assert(tr[0].font === 'poppins' && !('words' in tr[0]), 'style copied, word timings dropped');
  assert(s.present.textClips.filter((c) => c.source !== 'translation').length === 2, 'originals untouched');
  assert(layerCount(s.present, 'text') === layer + 1, 'the new layer registers');
  s = historyReducer(s, { type: 'undo' });
  assert(s.present.textClips.length === 2, 'one undo removes the whole translated layer');

  // Empty segment list is a no-op (no phantom undo step content).
  const before = s.present;
  s = historyReducer(s, { type: 'addTranslatedCaptions', lang: 'fr', layer: 9, segments: [] });
  assert(s.present === before || s.present.textClips.length === 2, 'empty run adds nothing');

  // Normalize keeps translation clips with their tags.
  const kept = normalizeProject(base([cap('t1', { source: 'translation', lang: 'ar' })]));
  const kc = kept.textClips.find((c) => c.id === 't1');
  assert(kc && kc.source === 'translation' && kc.lang === 'ar' && kc.caption, 'normalize keeps translation tags');
}

console.log('TRANSLATE STORE OK');
