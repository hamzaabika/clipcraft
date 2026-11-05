// Auto chapters (v1.1.11): derive chapter points from the transcript. A new
// chapter starts where the speaker pauses — a silence gap of at least
// GAP_SECONDS between one caption and the next — but never so often that
// chapters turn into noise: a gap only counts once the current chapter has
// run at least MIN_CHAPTER_SECONDS. Each chapter is titled from the first
// words of its opening line, the way a creator would skim-title it.
// Pure functions over transcriptSentences() output ([{ start, end, text }]).

export const GAP_SECONDS = 3;
export const MIN_CHAPTER_SECONDS = 20;
export const TITLE_WORDS = 6;

// "Let us begin" -> "Let us begin"; strips leading filler punctuation and
// caps at TITLE_WORDS words, first letter capitalised.
export function chapterTitle(text) {
  const words = String(text || '').replace(/^[\s.…·—-]+/, '').split(/\s+/).filter(Boolean);
  if (!words.length) return 'Chapter';
  const title = words.slice(0, TITLE_WORDS).join(' ').replace(/[\s,;:]+$/, '');
  return title.charAt(0).toUpperCase() + title.slice(1);
}

// Sentences -> [{ time, title }]. The first chapter starts at the first
// sentence (chapters describe the talk, not the silence before it).
export function autoChapters(sentences, { gap = GAP_SECONDS, minLen = MIN_CHAPTER_SECONDS } = {}) {
  const list = (sentences || []).filter((s) => s && String(s.text || '').trim());
  if (!list.length) return [];
  const chapters = [{ time: list[0].start, title: chapterTitle(list[0].text) }];
  let chapterStart = list[0].start;
  for (let i = 1; i < list.length; i++) {
    const pause = list[i].start - list[i - 1].end;
    if (pause >= gap && list[i].start - chapterStart >= minLen) {
      chapters.push({ time: list[i].start, title: chapterTitle(list[i].text) });
      chapterStart = list[i].start;
    }
  }
  return chapters;
}

// YouTube description format: "0:00 Title" lines (H:MM:SS past an hour),
// first chapter forced to 0:00 the way YouTube requires.
export function chaptersText(chapters) {
  const fmt = (t) => {
    const s = Math.max(0, Math.floor(t));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const r = s % 60;
    const p2 = (n) => String(n).padStart(2, '0');
    return h > 0 ? `${h}:${p2(m)}:${p2(r)}` : `${m}:${p2(r)}`;
  };
  return (chapters || []).map((c, i) => `${fmt(i === 0 ? 0 : c.time)} ${c.title}`).join('\n');
}
