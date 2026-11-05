// Caption translation engine (v1.1.10): the numbered-list protocol against a
// fake chat — alignment, batching, split-retry on a misaligned reply, honest
// failure on an unalignable line, cancellation, progress.
// Run: node scripts/test-translate.cjs
const assert = require('assert');
const { translateTexts, parseReply, buildPrompt, BATCH } = require('../electron/translate.cjs');

// A fake provider that "translates" by prefixing each numbered line.
function echoChat(prefix) {
  return async (_system, user) => {
    const body = user.split('\n\n')[1];
    return body.split('\n').map((l) => l.replace(/^(\d+)\. /, `$1. ${prefix}`)).join('\n');
  };
}

(async () => {
  // parseReply tolerance + strictness
  assert.deepEqual(parseReply('1. a\n2. b', 2), ['a', 'b']);
  assert.deepEqual(parseReply('```\n1) a\n2: b\n```', 2), ['a', 'b']);
  assert.equal(parseReply('1. a', 2), null, 'missing line rejected');
  assert.equal(parseReply('1. a\n1. b', 2), null, 'duplicate number rejected');
  assert.equal(parseReply('no numbers here', 2), null);
  assert.equal(parseReply('1. \n2. b', 2), null, 'empty translation rejected');
  assert.ok(buildPrompt(['x'], 'French').startsWith('Translate these subtitle lines into French'));

  // Straight run: alignment + order preserved
  const texts = ['Hello world', 'Second line', 'Third one'];
  const out = await translateTexts(texts, 'French', echoChat('FR:'));
  assert.deepEqual(out, ['FR:Hello world', 'FR:Second line', 'FR:Third one']);

  // Batching: BATCH+5 lines -> exactly 2 chat calls, progress ends at total
  let calls = 0;
  const many = Array.from({ length: BATCH + 5 }, (_, i) => `line ${i + 1}`);
  const progress = [];
  const outMany = await translateTexts(many, 'German', async (s, u) => { calls++; return echoChat('DE:')(s, u); }, { onProgress: (d, t) => progress.push([d, t]) });
  assert.equal(calls, 2);
  assert.equal(outMany.length, BATCH + 5);
  assert.equal(outMany[BATCH + 4], `DE:line ${BATCH + 5}`);
  assert.deepEqual(progress[progress.length - 1], [BATCH + 5, BATCH + 5]);

  // A misaligned batch reply is retried on halves and still lands aligned
  let flakyCalls = 0;
  const flaky = async (system, user) => {
    flakyCalls++;
    if (flakyCalls === 1) return 'Sure! Here are your translations.'; // no numbers at all
    return echoChat('ES:')(system, user);
  };
  const outFlaky = await translateTexts(['one', 'two', 'three', 'four'], 'Spanish', flaky);
  assert.deepEqual(outFlaky, ['ES:one', 'ES:two', 'ES:three', 'ES:four']);
  assert.ok(flakyCalls >= 3, 'split retry happened');

  // A single line that never aligns fails honestly (no guessing)
  await assert.rejects(
    () => translateTexts(['only line'], 'French', async () => 'Voici la ligne'),
    /could not be matched/,
  );

  // Cancellation stops between batches
  let chatCalls = 0;
  await assert.rejects(
    () => translateTexts(many, 'French', async (s, u) => { chatCalls++; return echoChat('X:')(s, u); }, { isCancelled: () => chatCalls >= 1 }),
    /cancelled/i,
  );

  // Blank lines are never sent to the model and come back blank, in place
  let blankCalls = 0;
  const outBlank = await translateTexts(['a', '', 'b'], 'French', async (s, u) => { blankCalls++; return echoChat('FR:')(s, u); });
  assert.equal(outBlank.length, 3);
  assert.equal(outBlank[0], 'FR:a');
  assert.equal(outBlank[1], '');
  assert.equal(outBlank[2], 'FR:b');
  assert.equal(blankCalls, 1);

  console.log('TRANSLATE OK');
})().catch((e) => { console.error(e); process.exit(1); });
