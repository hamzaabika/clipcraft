// Caption translation helpers (v1.1.10): the target-language list for the
// picker, which captions a translation run covers, and the segments handed
// to the store when the translated layer is created. The translation itself
// runs in the main process (electron/translate.cjs) through the user's AI
// provider; timings are never touched — a translated caption keeps its
// source caption's start and duration exactly.

export const TRANSLATE_LANGS = [
  { code: 'ar', name: 'Arabic' },
  { code: 'fr', name: 'French' },
  { code: 'en', name: 'English' },
  { code: 'es', name: 'Spanish' },
  { code: 'de', name: 'German' },
  { code: 'it', name: 'Italian' },
  { code: 'pt', name: 'Portuguese' },
  { code: 'tr', name: 'Turkish' },
  { code: 'ru', name: 'Russian' },
  { code: 'zh', name: 'Chinese (Simplified)' },
  { code: 'ja', name: 'Japanese' },
  { code: 'ko', name: 'Korean' },
  { code: 'hi', name: 'Hindi' },
  { code: 'ur', name: 'Urdu' },
  { code: 'fa', name: 'Persian' },
  { code: 'nl', name: 'Dutch' },
  { code: 'pl', name: 'Polish' },
  { code: 'id', name: 'Indonesian' },
  { code: 'vi', name: 'Vietnamese' },
  { code: 'sv', name: 'Swedish' },
];

const isAuto = (c) => !!c.caption && c.source !== 'srt' && c.source !== 'translation';
const isSrt = (c) => c.source === 'srt';

// The caption sets a translation run can start from. Translations themselves
// are never a source (translating a translation drifts fast).
export function translationSources(project) {
  const caps = (project.textClips || []).filter((c) => c.caption || c.source === 'srt');
  const sorted = (list) => list.slice().sort((a, b) => a.start - b.start);
  return {
    auto: sorted(caps.filter(isAuto)),
    srt: sorted(caps.filter(isSrt)),
    all: sorted(caps.filter((c) => isAuto(c) || isSrt(c))),
  };
}

// Style carried from a source caption to its translation: every field of
// the clip except identity, timing and the words themselves (font, colours,
// stroke, shadow, background, highlight, animation, position…). Word timings
// are dropped on purpose — the translated words do not line up with the
// source words, so per-word highlight has nothing true to follow.
const NOT_STYLE = new Set(['id', 'text', 'start', 'duration', 'words', 'source', 'lang', 'caption', 'layer']);

export function translationStyle(clip) {
  const style = {};
  for (const [k, v] of Object.entries(clip)) if (!NOT_STYLE.has(k)) style[k] = v;
  return style;
}

export function langName(code) {
  return TRANSLATE_LANGS.find((l) => l.code === code)?.name || code;
}
