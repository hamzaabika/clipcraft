// Retake assistant (v1.1.7) proofs: consecutive sentences saying the same
// line group together (including a cut-off first attempt that is a subset
// of the full line), unrelated neighbours never group, the suggested keeper
// is the last COMPLETE take, and keeping it dispatches ranges that cut the
// other attempts from the video — captions rippling, one undo step.
import { emptyProject, historyReducer, videoLayout } from '../src/store.js';
import {
  normalizeTakeWords, retakeCutRanges, retakeGroups, takeSimilarity, transcriptSentences,
} from '../src/transcript.js';

const fails = [];
const ok = (cond, msg) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`); if (!cond) fails.push(msg); };
const near = (a, b) => Math.abs(a - b) < 1e-6;

const capStyle = { font: 'cairo', size: 64, bold: true, color: '#ffffff', y: 0.8, caption: true, stroke: { width: 5, color: '#000000' }, highlight: { mode: 'none' } };
function cap(id, start, duration, text) {
  const words = text.split(' ').map((t, i, arr) => ({ text: t, start: (duration * i) / arr.length, end: (duration * (i + 1)) / arr.length }));
  return { ...capStyle, id, start, duration, text, words };
}
function project() {
  const p = emptyProject();
  return {
    ...p,
    media: [{ id: 'm1', path: '/x/talk.mp4', type: 'video', duration: 40, width: 720, height: 1280, hasAudio: true }],
    videoClips: [{ id: 'v1', mediaId: 'm1', in: 0, out: 40, speed: 1, volume: 1, muted: false, filter: 'none', adjust: {}, effects: [], transition: null }],
    textClips: [
      cap('c1', 1, 2, 'hey everyone great to see you'),          // an unrelated intro line
      cap('c2', 4, 1, 'welcome back to'),                        // a cut-off attempt of the next line
      cap('c3', 6, 3, 'welcome back to the show everyone'),      // the full line
      cap('c4', 10, 3, 'today we test three laptops'),           // unrelated
      cap('c5', 14, 3, 'today we test three laptops'),           // exact repeat
      cap('c6', 18, 2, 'today we test'),                         // trailing fragment — must NOT be suggested
      cap('c7', 22, 3, 'a completely different closing line'),   // unrelated
      cap('c8', 26, 1, 'okay'),                                  // one word — never a retake
      cap('c9', 28, 1, 'okay'),
    ],
  };
}
const run = (p, a) => historyReducer({ past: [], present: p, future: [] }, a).present;
const totalLen = (p) => { const v = videoLayout(p.videoClips); return v.length ? v[v.length - 1].end : 0; };

// --- similarity primitives ---
ok(normalizeTakeWords('Hello, World! 2026').join(' ') === 'hello world 2026', 'normalize strips punctuation and case');
ok(takeSimilarity(normalizeTakeWords('welcome back to'), normalizeTakeWords('welcome back to the show everyone')) >= 0.8, 'cut-off attempt is highly similar to the full line (containment)');
ok(takeSimilarity(normalizeTakeWords('today we test three laptops'), normalizeTakeWords('a completely different closing line')) < 0.55, 'unrelated lines are not similar');

// --- grouping ---
const p = project();
const s = transcriptSentences(p);
const groups = retakeGroups(s);
ok(groups.length === 2, `two retake groups found (got ${groups.length})`);
const [g1, g2] = groups;
ok(g1 && g1.members.join(',') === '1,2', 'group 1 = the cut-off + full welcome line (sentences 2–3)');
ok(g1 && g1.keep === 2, 'group 1 keeps the full line, not the cut-off attempt');
ok(g2 && g2.members.join(',') === '3,4,5', 'group 2 = the three test-laptops takes (sentences 4–6)');
ok(g2 && g2.keep === 4, 'group 2 keeps the last COMPLETE take (sentence 5), not the trailing fragment (sentence 6)');
ok(!groups.some((g) => g.members.includes(0)), 'the unrelated intro line is not grouped with the retakes that follow it');
ok(!groups.some((g) => g.members.includes(7) || g.members.includes(8)), 'one-word repeats never group');

// --- cut ranges + the store cut ---
const ranges = retakeCutRanges(s, g1);
ok(ranges.length === 1 && near(ranges[0].start, 4) && near(ranges[0].end, 5), 'keeping group 1 cuts exactly the cut-off attempt span');
const before = totalLen(p);
const after = run(p, { type: 'cutRanges', ranges: retakeCutRanges(s, g2), rippleText: true });
ok(near(totalLen(after), before - 5), `keeping group 2 removes the two unwanted takes (5 s): ${before} -> ${totalLen(after)}`);
const kept = after.textClips.find((c) => c.id === 'c5');
ok(!!kept, 'the kept take caption survives the cut');
ok(!after.textClips.some((c) => c.id === 'c4') || after.textClips.find((c) => c.id === 'c4'), 'cut runs through the store action without corrupting other captions');

console.log(fails.length ? `\n${fails.length} FAILURES` : '\nRETAKES OK');
process.exit(fails.length ? 1 : 0);
