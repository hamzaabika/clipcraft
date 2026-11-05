// FFmpeg export progress parsing: multi-value chunks, chunk-split values,
// out_time_ms, monotonic output. Usage: node scripts/test-ffmpeg-progress.cjs
const assert = require('assert/strict');
const { parseProgressValues, createProgressParser } = require('../electron/ffmpeg.cjs');

// One-shot values: all matches in a chunk are read, in order (us and ms).
assert.deepEqual(parseProgressValues('out_time_us=1000000\nout_time_us=2500000\n'), [1, 2.5]);
assert.deepEqual(parseProgressValues('out_time_ms=3000000\n'), [3]);
assert.deepEqual(parseProgressValues('frame=10\nspeed=1x\n'), []);

// A chunk carrying several values reports the LAST one (the old code reported
// only the first and the bar lagged a whole chunk behind).
{
  const seen = [];
  const p = createProgressParser(10, (v) => seen.push(v));
  p.feed('out_time_us=1000000\nout_time_us=2500000\nout_time_us=4000000\n');
  assert.deepEqual(seen, [0.4]);
  assert.equal(p.value, 0.4);
}

// A value split across chunks (even inside its digits) is reassembled.
{
  const seen = [];
  const p = createProgressParser(10, (v) => seen.push(v));
  p.feed('out_time_u');
  assert.deepEqual(seen, [], 'no value yet');
  p.feed('s=5000000\n');
  assert.deepEqual(seen, [0.5]);
  p.feed('out_time_us=60'); // digits split: parses as 60us first…
  p.feed('00000\n'); // …then the retained tail completes it to 6 s
  assert.equal(p.value, 0.6);
  assert.ok(seen.every((v, i) => i === 0 || v > seen[i - 1]), 'emissions are strictly increasing');
}

// Values never go backwards, and a zero/unknown total never emits.
{
  const seen = [];
  const p = createProgressParser(10, (v) => seen.push(v));
  p.feed('out_time_us=8000000\n');
  p.feed('out_time_us=2000000\n');
  assert.deepEqual(seen, [0.8]);
  const q = createProgressParser(0, (v) => seen.push(v));
  q.feed('out_time_us=8000000\n');
  assert.deepEqual(seen, [0.8], 'total 0 emits nothing');
}
console.log('ffmpeg-progress OK');
