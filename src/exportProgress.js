// Export progress plumbing (pure logic, no DOM): a throttled, monotonic reporter.
// The text-frame renderer calls report() for EVERY frame — visible, blank or
// unchanged — so the bar can never freeze inside a caption gap; this reporter
// decides which of those calls are worth a UI update: at most one per
// `minIntervalMs`, plus one whenever the value moved at least `minStep`, plus
// the first and the final (1) call. Emitted values never go backwards.

export function clampProgress(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
}

// The next displayed progress: never below the previous one (callers that have a
// genuine reset — the encoder CPU fallback — reset their baseline explicitly).
export function monotonicProgress(prev, next) {
  return Math.max(clampProgress(prev), clampProgress(next));
}

export function createProgressReporter(onProgress, opts = {}) {
  const minIntervalMs = opts.minIntervalMs ?? 100;
  const minStep = opts.minStep ?? 0.005;
  const now = opts.now || (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
  let lastValue = -1;
  let lastTime = -Infinity;
  const emit = (v) => {
    lastValue = v;
    lastTime = now();
    onProgress(v);
  };
  return {
    report(v, force = false) {
      const value = lastValue < 0 ? clampProgress(v) : monotonicProgress(lastValue, v);
      if (force || lastValue < 0 || value >= 1 || value - lastValue >= minStep || now() - lastTime >= minIntervalMs) {
        if (value !== lastValue) emit(value);
      }
    },
    finish() { this.report(1, true); },
    get value() { return Math.max(0, lastValue); },
  };
}
