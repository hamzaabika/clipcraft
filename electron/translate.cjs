// Caption translation (v1.1.10): translate caption lines with the user's own AI
// provider (the same plumbing CraftAI uses), keeping every caption's timing.
// The model is asked for a strict numbered list back — one output line per
// input line, same numbers — so translations can be aligned to the original
// captions exactly. A reply that does not line up is retried on smaller
// halves; a single line that still will not align fails the job honestly
// rather than guessing which translation belongs to which caption.
//
// The chat function is injected, so the engine is testable without a network
// or a key: main passes ai.chat bound to the active provider (with fallback).

const BATCH = 30;

const SYSTEM = [
  'You are a subtitle translator. You translate each numbered line of subtitles into the requested language.',
  'Rules:',
  '- Reply with ONLY the translated lines, in the same numbered format: "1. ...", "2. ...", one line per input line, same numbers, same order.',
  '- Keep each translation to about the same length as its source line — these are on-screen captions.',
  '- Preserve names, numbers and formatting. Do not add notes, explanations or quotation marks.',
  '- If a line is just a sound or filler, translate it the way subtitles in that language normally render it.',
].join('\n');

function buildPrompt(texts, targetName) {
  const lines = texts.map((t, i) => `${i + 1}. ${String(t).replace(/\s*\n\s*/g, ' ')}`);
  return `Translate these subtitle lines into ${targetName}:\n\n${lines.join('\n')}`;
}

// Tolerant numbered-list parse: accepts "1.", "1)", "1:" and bold markers,
// ignores code fences and stray blank lines. Returns null when the reply
// does not contain exactly the expected numbers 1..count, each once.
function parseReply(text, count) {
  if (typeof text !== 'string') return null;
  const out = new Array(count).fill(null);
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/```/g, '').trim();
    if (!line) continue;
    const m = line.match(/^\*{0,2}(\d{1,4})\s*[.):\]-]\s*\*{0,2}\s*(.*)$/);
    if (!m) continue;
    const n = Number(m[1]);
    if (n < 1 || n > count) continue;
    if (out[n - 1] !== null) return null; // duplicated number: cannot align safely
    out[n - 1] = m[2].trim();
  }
  if (out.some((v) => v === null || v === '')) return null;
  return out;
}

// Translate a list of caption texts. chat(system, userText) must return the
// model's reply text. onProgress(done, total) fires after each batch.
// isCancelled() is polled between batches. Blank lines are never sent to
// the model — they come back blank, in place.
async function translateTexts(texts, targetName, chat, { onProgress, isCancelled } = {}) {
  const clean = texts.map((t) => String(t ?? ''));
  const out = new Array(clean.length).fill(null);
  clean.forEach((t, i) => { if (!t.trim()) out[i] = t; });
  const workIdx = clean.map((t, i) => (t.trim() ? i : -1)).filter((i) => i >= 0);
  const work = workIdx.map((i) => clean[i]);
  let done = clean.length - work.length; // blanks are already "done"

  const runRange = async (from, to) => {
    if (isCancelled && isCancelled()) throw new Error('Translation cancelled.');
    const slice = work.slice(from, to);
    const reply = await chat(SYSTEM, buildPrompt(slice, targetName));
    const parsed = parseReply(reply, slice.length);
    if (parsed) {
      parsed.forEach((v, i) => { out[workIdx[from + i]] = v; });
      done += slice.length;
      if (onProgress) onProgress(done, clean.length);
      return;
    }
    if (slice.length <= 1) {
      throw new Error(`The AI provider's reply could not be matched to the captions (line ${workIdx[from] + 1}). Try again, or pick a different provider or model in Settings.`);
    }
    const mid = from + Math.floor(slice.length / 2);
    await runRange(from, mid);
    await runRange(mid, to);
  };

  for (let from = 0; from < work.length; from += BATCH) {
    await runRange(from, Math.min(work.length, from + BATCH));
  }
  return out;
}

module.exports = { translateTexts, parseReply, buildPrompt, SYSTEM, BATCH };
