// Beat cuts (v1.1.9), the renderer half: what the timeline and toolbar need from the
// beat grid the main process heard in the soundtrack (electron/beats.cjs). The grid
// itself lives on the project as { bpm, times } (timeline seconds); the pure helpers
// here decide which beats fall inside a clip and which clip "Split at beats" cuts —
// the store does the cutting (splitClipAtBeats in src/store.js).
import { MIN_CLIP, videoClipAt, videoLayout } from './store.js';

export const beatsOf = (project) => (project && project.beats && Array.isArray(project.beats.times) ? project.beats.times : []);

// The beats that can actually cut a clip spanning [start, end]: strictly inside,
// with the same MIN_CLIP breathing room at both edges the split itself enforces —
// a beat a hair from an edge would leave a sliver piece and is skipped everywhere
// (button state, the cut itself) by construction, not by luck.
export function interiorBeats(times, start, end) {
  return (times || []).filter((t) => t - start >= MIN_CLIP && end - t >= MIN_CLIP);
}

// The clip "Split at beats" acts on, mirroring the toolbar's split targeting:
// the selected main-track clip first, else the main-track clip under the playhead.
// Returns { clip, start, end, times } or null when there is nothing to cut.
export function beatSplitTarget(project, time, selection) {
  let hit = null;
  if (selection && selection.track === 'video' && selection.id) {
    hit = videoLayout(project.videoClips).find((l) => l.clip.id === selection.id) || null;
  }
  if (!hit) hit = videoClipAt(project, time);
  if (!hit || hit.clip.gap) return null;
  const times = interiorBeats(beatsOf(project), hit.start, hit.end);
  return times.length ? { clip: hit.clip, start: hit.start, end: hit.end, times } : null;
}

export const formatBpm = (bpm) => (bpm ? `${Math.round(bpm)} BPM` : '');
