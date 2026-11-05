// Transcript editing (v1.1.5) proofs: the transcript is read from the caption
// clips themselves (auto captions carry word timings; an .srt cue is one
// unit), a word selection becomes merged cut ranges, silence ranges are
// shaped with padding, and the store's cutRanges with rippleText cuts the
// picture AND keeps every later caption locked to it — in one undo step.
import { emptyProject, historyReducer, videoLayout } from '../src/store.js';
import {
  flatWords, mergeRanges, rangesSeconds, selectionCutRanges, sentenceRange,
  silenceCutRanges, transcriptSentences,
} from '../src/transcript.js';

const fails = [];
const ok = (cond, msg) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`); if (!cond) fails.push(msg); };
const near = (a, b) => Math.abs(a - b) < 1e-6;

const capStyle = { font: 'cairo', size: 64, bold: true, color: '#ffffff', y: 0.8, caption: true, stroke: { width: 5, color: '#000000' }, highlight: { mode: 'none' } };
function project() {
  const p = emptyProject();
  return {
    ...p,
    media: [{ id: 'm1', path: '/x/talk.mp4', type: 'video', duration: 30, width: 720, height: 1280, hasAudio: true }],
    videoClips: [{ id: 'v1', mediaId: 'm1', in: 0, out: 30, speed: 1, volume: 1, muted: false, filter: 'none', adjust: {}, effects: [], transition: null }],
    textClips: [
      {
        ...capStyle, id: 'c1', start: 1, duration: 4, text: 'hello brave world',
        words: [
          { text: 'hello', start: 0, end: 1 }, { text: 'brave', start: 1, end: 2 }, { text: 'world', start: 2, end: 4 },
        ],
      },
      {
        ...capStyle, id: 'c2', start: 7, duration: 3, text: 'second sentence',
        words: [{ text: 'second', start: 0, end: 1.5 }, { text: 'sentence', start: 1.5, end: 3 }],
      },
      { ...capStyle, id: 'c3', source: 'srt', start: 20, duration: 3, text: 'a later cue' },
      { ...capStyle, id: 't1', caption: false, start: 4, duration: 4, text: 'a title, not a caption' },
    ],
  };
}
const run = (p, a) => historyReducer({ past: [], present: p, future: [] }, a).present;
const totalLen = (p) => { const v = videoLayout(p.videoClips); return v.length ? v[v.length - 1].end : 0; };

// --- transcript reading ---
{
  const s = transcriptSentences(project());
  ok(s.length === 3, `sentences: only caption clips, in order (got ${s.length})`);
  ok(s[0].words.length === 3 && near(s[0].words[1].start, 2) && near(s[0].words[1].end, 3), 'word timings are absolute (clip start added)');
  ok(s[2].hasWords === false && s[2].words.length === 1 && near(s[2].words[0].start, 20) && near(s[2].words[0].end, 23), 'an .srt cue is one selectable unit spanning the cue');
  const flat = flatWords(s);
  ok(flat.length === 6 && flat[3].clipId === 'c2', 'flat word list spans sentences with clip ids');
  const r = selectionCutRanges(flat, 1, 2);
  ok(r.length === 1 && near(r[0].start, 2) && near(r[0].end, 5), 'selecting "brave world" yields one cut range 2..5');
  const r2 = selectionCutRanges(flat, 2, 4);
  ok(r2.length === 2 && near(r2[0].start, 3) && near(r2[1].start, 7), 'a selection across sentences yields one range per clip run');
  ok(near(sentenceRange(s[1]).start, 7) && near(sentenceRange(s[1]).end, 10), 'sentence range is the whole cue span');
}

// --- range math ---
{
  const m = mergeRanges([{ start: 5, end: 7 }, { start: 1, end: 3 }, { start: 2.5, end: 4 }]);
  ok(m.length === 2 && near(m[0].start, 1) && near(m[0].end, 4) && near(m[1].start, 5), 'mergeRanges sorts and merges overlaps');
  const sc = silenceCutRanges([{ start: 2, end: 5 }, { start: 9, end: 9.2 }, { start: 26, end: 40 }], 0.1, 27);
  ok(sc.length === 2 && near(sc[0].start, 2.1) && near(sc[0].end, 4.9), 'silence ranges keep the padding at both ends');
  ok(near(sc[1].start, 26.1) && near(sc[1].end, 26.9), 'a trailing silence is clamped to the project duration');
  ok(near(rangesSeconds(sc), 3.6), 'rangesSeconds totals the saved time');
}

// --- store: word cut with text ripple ---
{
  const before = project();
  const after = run(before, { type: 'cutRanges', ranges: [{ start: 2, end: 5 }], rippleText: true });
  ok(near(totalLen(after), 27), `picture closes up: 30 s -> ${totalLen(after)} s`);
  const c1 = after.textClips.find((c) => c.id === 'c1');
  ok(c1 && c1.text === 'hello' && near(c1.duration, 1) && c1.words.length === 1, 'the cut caption keeps only its surviving words, text rebuilt');
  const c2 = after.textClips.find((c) => c.id === 'c2');
  ok(c2 && near(c2.start, 4) && near(c2.duration, 3) && c2.words[0].start === 0, 'a caption after the cut shifts earlier by the cut length, words re-based');
  const c3 = after.textClips.find((c) => c.id === 'c3');
  ok(c3 && near(c3.start, 17), 'an .srt cue after the cut shifts too');
  const t1 = after.textClips.find((c) => c.id === 't1');
  ok(t1 && near(t1.start, 2) && near(t1.duration, 3), 'a text clip a cut passes through keeps its surviving piece, shifted with the picture');
}

// --- store: whole-sentence cut drops the caption, one undo step restores all ---
{
  const st = historyReducer({ past: [], present: project(), future: [] }, { type: 'cutRanges', ranges: [{ start: 7, end: 10 }], rippleText: true });
  ok(!st.present.textClips.some((c) => c.id === 'c2'), 'cutting a whole sentence removes its caption clip');
  ok(near(totalLen(st.present), 27), 'picture loses exactly the sentence length');
  ok(st.past.length === 1, 'the whole edit is a single history step');
  const undone = historyReducer(st, { type: 'undo' });
  ok(near(totalLen(undone.present), 30) && undone.present.textClips.some((c) => c.id === 'c2'), 'one undo restores picture and caption together');
}

// --- store: the assistant's cutRanges (no rippleText) leaves text on its own time ---
{
  const after = run(project(), { type: 'cutRanges', ranges: [{ start: 2, end: 5 }] });
  const c2 = after.textClips.find((c) => c.id === 'c2');
  ok(c2 && near(c2.start, 7), 'without rippleText, captions keep their own time (assistant path unchanged)');
}

console.log(fails.length ? `\n${fails.length} FAILURES` : '\nTRANSCRIPT OK');
process.exit(fails.length ? 1 : 0);
