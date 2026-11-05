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

// --- Retake assistant (v1.1.7) -------------------------------------------
// A retake is the same line said again: consecutive transcript sentences
// whose words are (nearly) the same set, where an earlier attempt is often
// a cut-off subset of the full line. Grouping is purely textual and runs on
// the same sentences the panel renders — no parallel data. The suggested
// keeper is the LAST complete take: the last member at least 85% as long
// (in words) as the group's longest member, so a trailing fragment never
// wins over a full earlier take, and a full final take always wins.

export function normalizeTakeWords(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

function wordCounts(words) {
  const m = new Map();
  words.forEach((w) => m.set(w, (m.get(w) || 0) + 1));
  return m;
}

// 0..1 similarity of two word lists: the better of the Dice coefficient on
// word multisets (same line, reordered a little) and containment (one is
// mostly a subset of the other — the classic cut-off retake).
export function takeSimilarity(a, b) {
  if (!a.length || !b.length) return 0;
  const ca = wordCounts(a);
  const cb = wordCounts(b);
  let inter = 0;
  for (const [w, n] of ca) inter += Math.min(n, cb.get(w) || 0);
  const dice = (2 * inter) / (a.length + b.length);
  const containment = inter / Math.min(a.length, b.length);
  return Math.max(dice, containment >= 0.8 ? containment : 0);
}

const TAKE_MIN_WORDS = 2; // a one-word line ("okay") repeating is not a retake
const TAKE_SIMILAR = 0.55;

// Groups of consecutive sentences that are retakes of one line.
// Returns [{ members: [sentenceIndex, ...], keep: sentenceIndex }] with
// indices into the sentences array; only groups of 2+ are returned.
export function retakeGroups(sentences) {
  const words = sentences.map((s) => normalizeTakeWords(s.text));
  const groups = [];
  let cur = null; // { members: [idx] }
  const close = () => { if (cur && cur.members.length >= 2) groups.push(cur); cur = null; };
  sentences.forEach((s, i) => {
    if (words[i].length < TAKE_MIN_WORDS) { close(); return; }
    if (cur) {
      const prev = cur.members[cur.members.length - 1];
      const first = cur.members[0];
      if (takeSimilarity(words[i], words[prev]) >= TAKE_SIMILAR || takeSimilarity(words[i], words[first]) >= TAKE_SIMILAR) {
        cur.members.push(i);
        return;
      }
      close();
    }
    cur = { members: [i] };
  });
  close();
  return groups.map((g) => {
    const counts = g.members.map((i) => words[i].length);
    const max = Math.max(...counts);
    let keep = g.members[g.members.length - 1];
    for (const i of g.members) if (words[i].length >= 0.85 * max) keep = i;
    return { members: g.members, keep };
  });
}

// Cut ranges for every member of a retake group except the kept take.
export function retakeCutRanges(sentences, group) {
  return mergeRanges(group.members.filter((i) => i !== group.keep).map((i) => sentenceRange(sentences[i])));
}
