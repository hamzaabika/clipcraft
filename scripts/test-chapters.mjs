// SRT export + auto chapters (v1.1.11): the .srt serializer round-trips
// through the app's own parser; chapter derivation follows the pause rule
// with the minimum-length guard; the YouTube list format is exact; the
// store's bulk marker add dedupes and lands as one undo step.
// Usage: node scripts/test-chapters.mjs
import { formatSrtTime, parseSRT, toSRT } from '../src/subtitles.js';
import { autoChapters, chapterTitle, chaptersText, GAP_SECONDS, MIN_CHAPTER_SECONDS } from '../src/chapters.js';
import { emptyProject, historyReducer } from '../src/store.js';

const assert = (ok, what) => { if (!ok) throw new Error(what); };
const eq = (a, b, what) => assert(JSON.stringify(a) === JSON.stringify(b), `${what}: got ${JSON.stringify(a)}, expected ${JSON.stringify(b)}`);

// --- Serializer: format + round-trip through parseSRT.
{
  assert(formatSrtTime(0) === '00:00:00,000', 'zero formats');
  assert(formatSrtTime(3661.5) === '01:01:01,500', 'h/m/s/ms format');
  assert(formatSrtTime(59.9996) === '00:01:00,000', 'rounds across the minute');
  const clips = [
    { start: 65.25, duration: 2.5, text: 'Second cue\ntwo lines' },
    { start: 0.5, duration: 2, text: 'First cue' },
    { start: 9, duration: 1, text: '   ' }, // blank: skipped
    { start: 12, end: 13.75, text: 'End-shaped input' },
  ];
  const srt = toSRT(clips);
  assert(srt.startsWith('1\n00:00:00,500 --> 00:00:02,500\nFirst cue'), 'sorted, numbered, comma ms');
  const back = parseSRT(srt);
  eq(back.map((c) => [c.start, c.end, c.text]), [
    [0.5, 2.5, 'First cue'],
    [12, 13.75, 'End-shaped input'],
    [65.25, 67.75, 'Second cue\ntwo lines'],
  ], 'round-trip preserves cues exactly');
  assert(toSRT([]) === '' && toSRT([{ start: 1, duration: 1, text: '' }]) === '', 'empty in, empty out');
}

// --- Chapters: pause rule + minimum length + titles.
{
  const s = (start, end, text) => ({ start, end, text });
  const talk = [
    s(0, 5, 'welcome everyone to the show today'),
    s(5.5, 12, 'we start with the basics of editing'),
    s(12.5, 25, 'and keep going with more detail here'),
    s(30, 38, 'now the advanced part begins now'), // 5 s pause, chapter is 30 s old -> chapter
    s(39, 44, 'a quick aside before we continue'), // 1 s pause -> no
    s(48, 55, 'wrapping up with final thoughts'), // 4 s pause but chapter only 18 s old -> no
    s(75, 80, 'one last thing to remember always'), // 20 s pause, chapter 45 s old -> chapter
  ];
  const ch = autoChapters(talk);
  eq(ch.map((c) => c.time), [0, 30, 75], 'chapters at qualifying pauses only');
  assert(ch[0].title === 'Welcome everyone to the show today', 'title from first words, capitalised');
  assert(ch[1].title === 'Now the advanced part begins now', 'second title');
  assert(autoChapters([]).length === 0 && autoChapters([s(0, 3, 'only one')]).length === 1, 'degenerate inputs');
  assert(chapterTitle('  …and then, we left') === 'And then, we left', 'title trims filler punctuation');
  assert(chapterTitle('one two three four five six seven eight') === 'One two three four five six', 'title caps at 6 words');
  assert(GAP_SECONDS === 3 && MIN_CHAPTER_SECONDS === 20, 'rule constants as documented in the UI');
}

// --- YouTube format.
{
  const txt = chaptersText([
    { time: 12.9, title: 'Intro words' },
    { time: 95, title: 'Middle part' },
    { time: 3725, title: 'Late part' },
  ]);
  eq(txt, '0:00 Intro words\n1:35 Middle part\n1:02:05 Late part', 'first at 0:00, m:ss then h:mm:ss, floored');
}

// --- Store: bulk markers, dedupe within 0.5 s, one undo.
{
  const state = (project) => ({ past: [], present: project, future: [] });
  let st = state({ ...emptyProject(), markers: [{ id: 'm0', time: 10, label: 'Old' }] });
  st = historyReducer(st, {
    type: 'addMarkers',
    markers: [
      { id: 'a', time: 10.2, label: 'Dup of old' },
      { id: 'b', time: 30, label: 'Chapter two' },
      { id: 'c', time: 30.4, label: 'Dup in batch' },
      { id: 'd', time: 75, label: 'Chapter three' },
    ],
  });
  eq(st.present.markers.map((m) => [m.time, m.label]), [[10, 'Old'], [30, 'Chapter two'], [75, 'Chapter three']], 'deduped + sorted');
  st = historyReducer(st, { type: 'undo' });
  eq(st.present.markers.map((m) => m.id), ['m0'], 'one undo removes the batch');
}

console.log('CHAPTERS OK');
