// Transcript editing (v1.1.5): the project's caption clips read as one flowing
// transcript of sentences and words, plus the range math that turns a word
// selection (or a silence list) into ripple cuts on the main track.
//
// The data source is the caption clips themselves — auto captions carry word
// timings from the transcription engine; imported .srt cues have no word
// timings, so each cue is a single selectable unit. Nothing here invents a
// parallel transcript: the panel edits the same clips the timeline shows, and
// a cut is the store's existing cutRanges action (with text ripple enabled),
// so undo, locking and link sync behave exactly like every other edit.

// Sentences of the transcript, in timeline order. Words carry ABSOLUTE
// timeline times so selection math never has to know about clip offsets.
export function transcriptSentences(project) {
  return (project.textClips || [])
    .filter((c) => c.caption)
    .slice()
    .sort((a, b) => a.start - b.start)
    .map((c) => {
      const end = c.start + c.duration;
      const words = (c.words && c.words.length)
        ? c.words.map((w) => ({ text: w.text, start: c.start + w.start, end: c.start + w.end }))
        : [{ text: c.text || '', start: c.start, end }];
      return { clipId: c.id, start: c.start, end, text: c.text || '', hasWords: !!(c.words && c.words.length), words };
    });
}

// Every word of the transcript as one flat list (selection indices refer to it).
export function flatWords(sentences) {
  const out = [];
  sentences.forEach((s, si) => s.words.forEach((w, wi) => out.push({ ...w, clipId: s.clipId, sentence: si, index: wi })));
  return out;
}

// Sort ranges and merge overlapping / touching ones.
export function mergeRanges(ranges) {
  const list = ranges
    .filter((r) => r && r.end - r.start > 0.001)
    .map((r) => ({ start: Math.max(0, r.start), end: r.end }))
    .sort((a, b) => a.start - b.start);
  const out = [];
  for (const r of list) {
    const last = out[out.length - 1];
    if (last && r.start <= last.end + 0.001) last.end = Math.max(last.end, r.end);
    else out.push({ ...r });
  }
  return out;
}

// Cut ranges for a flat word selection [from, to] (inclusive indices into
// flatWords): one range per run of selected words of the same clip, merged.
export function selectionCutRanges(words, from, to) {
  if (from == null || to == null || !words.length) return [];
  const lo = Math.max(0, Math.min(from, to));
  const hi = Math.min(words.length - 1, Math.max(from, to));
  const ranges = [];
  for (let i = lo; i <= hi; i++) {
    const w = words[i];
    const last = ranges[ranges.length - 1];
    if (last && last.clipId === w.clipId && w.start <= last.end + 0.001) last.end = Math.max(last.end, w.end);
    else ranges.push({ clipId: w.clipId, start: w.start, end: w.end });
  }
  return mergeRanges(ranges);
}

// The whole span of a sentence, as a cut range.
export const sentenceRange = (s) => ({ start: s.start, end: s.end });

// Silence list -> cut ranges, the same shaping the assistant's silence tool
// uses: keep `pad` seconds of the silence at both ends (breathing room around
// the neighbouring speech), clamp the tail to the project duration, and drop
// anything that shrinks to a sliver.
export function silenceCutRanges(silences, pad, total) {
  return mergeRanges((silences || []).map((s) => ({
    start: s.start + Math.max(0, pad),
    end: Math.min(s.end, total) - Math.max(0, pad),
  })).filter((r) => r.end - r.start > 0.05));
}

export const rangesSeconds = (ranges) => ranges.reduce((n, r) => n + (r.end - r.start), 0);
