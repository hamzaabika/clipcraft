// Project model + reducer (with undo/redo).
//
// The main (video) track plays clips back to back, so a clip's timeline position is derived from order.
// With the track magnet OFF, deleting or trimming leaves a "gap" clip ({ gap: true }) so later clips stay put;
// with it ON the track closes up the way the main track does. Audio / text clips have a free `start`;
// their magnet snaps drags to neighbours and closes the gap after a delete or trim (ripple).
// Overlay clips (picture-in-picture) are videos / photos with a free `start` drawn above the main track.

import { RATIOS, sizeFor } from './effects.js';
import { cleanPins } from './track.js';

export const uid = () => Math.random().toString(36).slice(2, 10);
export const MIN_CLIP = 0.1;

// The project format closest to a width x height picture, or null when its size is unknown.
export function ratioFor(w, h) {
  if (!w || !h) return null;
  const d = (r) => Math.abs(Math.log(w / h) - Math.log(RATIOS[r][0] / RATIOS[r][1]));
  return Object.keys(RATIOS).reduce((best, r) => (d(r) < d(best) ? r : best));
}

export function emptyProject() {
  return {
    // A stable identity for the per-project autosave store (electron/autosave.cjs): it is
    // born with the project, survives saves/loads (normalizeProject keeps a stored id and
    // mints one for older files), and keys the project's slot on the Home switchboard.
    id: uid(),
    name: 'Untitled', ratio: '16:9', resolution: 720, width: 1280, height: 720, fps: 30, background: '#000000',
    media: [], videoClips: [], overlayClips: [], textClips: [], audioClips: [], stickerClips: [],
    effectClips: [], // effects on the Effects track: { id, fx, start, duration }
    // Text clips are time-anchored overlays (e.g. captions), so they start with the magnet off.
    magnet: { video: true, overlay: false, audio: true, text: false },
    // Per-layer state (lock / hide / mute / solo), keyed "track:layer" — see layerStateOf.
    // Only layers that differ from the defaults get an entry. NOT part of undo history:
    // toggling a lock must never be an undoable document edit (industry standard).
    layerState: {},
    markers: [], // [{ id, time, label }] timeline flags
    snapping: true, // drags snap to clip edges, the playhead and markers
  };
}

// Older project files lack the newer fields.
export function normalizeProject(p) {
  const base = emptyProject();
  return {
    ...base, ...p,
    // R1 (2026-11-01): the Stickers feature was removed. Projects saved before the removal
    // may still carry stickerClips — they are DROPPED here, so an old file loads cleanly
    // with everything else intact and no sticker lane anywhere.
    stickerClips: [],
    overlayClips: p.overlayClips || [],
    effectClips: p.effectClips || [],
    magnet: { ...base.magnet, ...(p.magnet || {}) },
    markers: p.markers || [],
    snapping: p.snapping ?? true,
  };
}

export const isGap = (c) => !!c.gap;
export const newGap = (id, len) => ({ id, gap: true, in: 0, out: len, speed: 1 });

// Merges neighbouring gaps, drops empty ones and removes a trailing gap (nothing plays after it).
function normalizeGaps(list) {
  const out = [];
  for (const c of list) {
    if (c.gap) {
      const len = c.out - c.in;
      if (len < 0.02) continue;
      const last = out[out.length - 1];
      if (last && last.gap) {
        out[out.length - 1] = { ...last, out: last.out + len };
        continue;
      }
    }
    out.push(c);
  }
  while (out.length && out[out.length - 1].gap) out.pop();
  return out;
}

// Length of a clip on a free track (overlay / audio / text). Audio clips carry a
// constant speed like picture clips do (a detached clip follows its video's speed).
export const freeLen = (track, c) => (track === 'audio' ? (c.out - c.in) / (c.speed || 1) : track === 'overlay' ? (c.out - c.in) / (c.speed || 1) : c.duration);

export const clipLen = (c) => (c.out - c.in) / (c.speed || 1);

// Layers: every clip of a free track sits on a layer, 0 being the one next to the main track.
// Clips of one layer never overlap; a clip that would is moved to the first free layer. A higher overlay, text or
// layer is drawn above a lower one. Layers stay when they become empty (project.layers counts them).
export const LAYERED = { overlay: 'overlayClips', text: 'textClips', audio: 'audioClips' };
export const layerOf = (c) => c.layer ?? 0;

export function layerCount(p, track) {
  const used = (p[LAYERED[track]] || []).reduce((n, c) => Math.max(n, layerOf(c) + 1), 1);
  return Math.max(used, p.layers?.[track] || 1);
}

// Display name of one layer: the user's rename (project.layerNames) or the lane's default.
const LANE_NAMES = { video: 'Main', overlay: 'Overlay', text: 'Text', audio: 'Audio', effect: 'Effects' };
export function layerName(p, track, layer) {
  return (p.layerNames && p.layerNames[track] && p.layerNames[track][layer]) || `${LANE_NAMES[track] || track} ${layer + 1}`;
}

// ---- Layer state: lock / hide / mute / solo, one entry per layer ("track:layer") ----
// The main track is the single layer video:0; the Effects lane (not a layered lane in the
// model) is effect:0. Lanes whose clips can carry sound — and therefore answer to mute /
// solo — are video (its clips' own sound), overlay (picture clips with sound) and audio.
export const LAYER_STATE_DEFAULTS = { locked: false, hidden: false, muted: false, solo: false };
export const layerKey = (track, layer) => `${track}:${layer}`;
export function layerStateOf(p, track, layer) {
  return { ...LAYER_STATE_DEFAULTS, ...((p.layerState || {})[layerKey(track, layer)] || {}) };
}
export const isLayerLocked = (p, track, layer) => layerStateOf(p, track, layer).locked;
export const AUDIO_LANES = { video: true, overlay: true, audio: true };
// The layer a clip sits on: layered lanes read clip.layer; every other track has layer 0.
export const clipLayer = (track, c) => (LAYERED[track] ? layerOf(c) : 0);
export const clipLocked = (p, track, c) => !!c && isLayerLocked(p, track, clipLayer(track, c));
// removeMedia deletes every clip that uses the item, so it answers to the same lock as a
// delete: the first use of the item that sits on a locked layer, or null. The library UI
// names this layer when it refuses the removal.
export function lockedMediaUse(p, mediaId) {
  const lists = [['video', p.videoClips], ['overlay', p.overlayClips || []], ['audio', p.audioClips]];
  for (const [track, list] of lists) {
    for (const c of list) {
      if (c.mediaId === mediaId && clipLocked(p, track, c)) return { track, layer: clipLayer(track, c) };
    }
  }
  return null;
}
// True when any audio-capable layer is soloed (solo then decides what sounds at all).
export function anySolo(p) {
  const ls = p.layerState || {};
  return Object.entries(ls).some(([k, s]) => s && s.solo && AUDIO_LANES[k.split(':')[0]]);
}
// Does this layer's sound reach the mix? Mute silences it; once anything is soloed,
// only soloed layers sound.
export function layerSounds(p, track, layer) {
  const st = layerStateOf(p, track, layer);
  if (st.muted) return false;
  return !anySolo(p) || st.solo;
}

// Remaps the layerState keys of one track through fn(oldLayer) -> newLayer | null (drop),
// the same permutation a layer operation applies to the clips and their names.
function remapLayerState(p, track, fn) {
  const ls = p.layerState || {};
  const prefix = `${track}:`;
  if (!Object.keys(ls).some((k) => k.startsWith(prefix))) return p.layerState;
  const out = {};
  for (const [k, v] of Object.entries(ls)) {
    if (!k.startsWith(prefix)) { out[k] = v; continue; }
    const n = fn(Number(k.slice(prefix.length)));
    if (n !== null && n !== undefined) out[layerKey(track, n)] = v;
  }
  return out;
}

// True when [start, start + len) is free on that layer (the clip `exceptId` aside).
export function layerFree(p, track, layer, start, len, exceptId) {
  return !(p[LAYERED[track]] || []).some((x) => x.id !== exceptId && layerOf(x) === layer
    && x.start < start + len - 1e-6 && start < x.start + freeLen(track, x) - 1e-6);
}

// Gives every clip a layer where it fits, keeps the lists in drawing order (by layer) and the layer counts.
// Returns p itself when nothing changes. Old projects (no layers) get the rows they used to show.
function placeLayers(p) {
  let out = p;
  for (const [track, key] of Object.entries(LAYERED)) {
    const list = p[key] || [];
    const placed = []; // [layer][]{ start, end }
    const fits = (l, a, b) => !(placed[l] || []).some((r) => r.start < b - 1e-6 && a < r.end - 1e-6);
    const order = [...list].sort((a, b) => (a.layer === undefined) - (b.layer === undefined) || a.start - b.start);
    const layerById = {};
    for (const c of order) {
      const a = c.start;
      const b = c.start + freeLen(track, c);
      let l = layerOf(c);
      while (!fits(l, a, b)) l++;
      (placed[l] ||= []).push({ start: a, end: b });
      layerById[c.id] = l;
    }
    let changed = false;
    let next = list.map((c) => {
      if (c.layer === layerById[c.id]) return c;
      changed = true;
      return { ...c, layer: layerById[c.id] };
    });
    if (next.some((c, i) => i && layerOf(next[i - 1]) > layerOf(c))) {
      next = next.map((c, i) => [c, i]).sort((x, y) => layerOf(x[0]) - layerOf(y[0]) || x[1] - y[1]).map((x) => x[0]);
      changed = true;
    }
    const count = Math.max(placed.length, p.layers?.[track] || 1);
    if (changed) out = { ...out, [key]: next };
    if ((out.layers?.[track] || 1) !== count) out = { ...out, layers: { ...out.layers, [track]: count } };
  }
  return out;
}

// Transition length into clip i, limited to half of either neighbouring clip.
export function transitionDur(clips, i) {
  const t = clips[i]?.transition;
  if (!t || i === 0 || t.type === 'none') return 0;
  return Math.max(0, Math.min(t.duration, clipLen(clips[i]) / 2, clipLen(clips[i - 1]) / 2));
}

// Clips overlap by the length of the transition into them (FFmpeg xfade).
export function videoLayout(videoClips) {
  let end = 0;
  return videoClips.map((c, i) => {
    const td = transitionDur(videoClips, i);
    const start = Math.max(0, end - td);
    const item = { clip: c, index: i, start, end: start + clipLen(c), trans: td };
    end = item.end;
    return item;
  });
}

export function projectDuration(p) {
  const v = videoLayout(p.videoClips);
  const ends = [v.length ? v[v.length - 1].end : 0];
  p.textClips.forEach((c) => ends.push(c.start + c.duration));
  p.audioClips.forEach((c) => ends.push(c.start + freeLen('audio', c)));
  (p.overlayClips || []).forEach((c) => ends.push(c.start + freeLen('overlay', c)));
  return Math.max(0, ...ends);
}

// Total duration of what gets exported (the video track drives the output length).
// This is THE shared duration basis for everything export-facing: it mirrors, step for
// step, the total electron/ffmpeg.cjs accumulates in buildExportArgs (each clip starts
// at the previous end minus its clamped transition overlap). The text rasterizer
// (src/exportText.js) and the Export dialog's Duration + size estimate both read this
// function — never projectDuration(), which also counts text/audio/overlay ends.
export function exportDuration(p) {
  const v = videoLayout(p.videoClips);
  return v.length ? v[v.length - 1].end : 0;
}

export function videoClipAt(p, t) {
  const hits = videoLayout(p.videoClips).filter((l) => !l.clip.gap && t >= l.start && t < l.end);
  return hits[hits.length - 1] || null;
}

const TRACKS = { video: 'videoClips', overlay: 'overlayClips', text: 'textClips', audio: 'audioClips', effect: 'effectClips' };

export const IMAGE_DEFAULT = 4;

export function newVideoClip(id, m) {
  return {
    id, mediaId: m.id, in: 0, out: m.type === 'image' ? IMAGE_DEFAULT : m.duration, speed: 1, volume: 1, muted: false,
    filter: 'none', adjust: {}, effects: [], transition: null,
  };
}

// The "Original" format: the first picture on an empty main track sets the canvas shape (a tall phone
// video makes a 9:16 project), unless a format was picked by hand. The canvas fields that change, or {}.
export function canvasFor(p, m) {
  const first = !p.ratioLocked && !p.videoClips.some((c) => !c.gap);
  const ratio = first && ratioFor(m.width, m.height);
  return ratio && ratio !== p.ratio ? { ratio, ...sizeFor(ratio, p.resolution) } : {};
}

function reduceProjectInner(p, a) {
  switch (a.type) {
    case 'load':
      return normalizeProject(a.project);
    case 'setProject':
      return { ...p, ...a.patch };
    case 'addMedia':
      return { ...p, media: [...p.media, ...a.items] };
    case 'removeMedia':
      return {
        ...p,
        media: p.media.filter((m) => m.id !== a.id),
        videoClips: p.videoClips.filter((c) => c.mediaId !== a.id),
        audioClips: p.audioClips.filter((c) => c.mediaId !== a.id),
        overlayClips: p.overlayClips.filter((c) => c.mediaId !== a.id),
      };
    case 'addToTimeline': {
      const m = p.media.find((x) => x.id === a.mediaId);
      if (!m) return p;
      if (m.type === 'video' || m.type === 'image') {
        const list = [...p.videoClips];
        list.splice(a.index ?? list.length, 0, newVideoClip(a.clipId, m));
        return { ...p, videoClips: list, ...canvasFor(p, m) };
      }
      return {
        ...p,
        audioClips: [...p.audioClips, { id: a.clipId, mediaId: m.id, start: a.at, in: 0, out: m.duration, volume: 1, fadeIn: 0, fadeOut: 0, ...(a.layer != null && { layer: a.layer }) }],
      };
    }
    case 'addOverlayClip': {
      // Picture-in-picture: a video or photo above the main track, centred on the canvas at
      // half size by default (Hamza, 2026-11-03: a new overlay lands in the middle, never
      // dropped over a corner). x/y are frame fractions from the centre, so 0/0 is centred.
      const m = p.media.find((x) => x.id === a.mediaId);
      if (!m || m.type === 'audio') return p;
      const clip = { ...newVideoClip(a.clipId, m), start: Math.max(0, a.at), transform: { scale: 0.5, x: 0, y: 0 }, ...(a.layer != null && { layer: a.layer }) };
      return { ...p, overlayClips: [...p.overlayClips, clip] };
    }
    case 'addEffectClip':
      // A free effect on the Effects track (3 s by default).
      return { ...p, effectClips: [...p.effectClips, { id: a.clipId, fx: a.fx, start: Math.max(0, a.at), duration: a.duration || 3 }] };
    case 'addText':
      return {
        ...p,
        textClips: [
          ...p.textClips,
          // Unset style keys fall back to TEXT_DEFAULTS in src/text/render.js.
          { id: a.clipId, text: 'Your text', start: a.at, duration: 3, y: 0.5, ...a.patch, ...(a.layer != null && { layer: a.layer }) },
        ],
      };
    case 'update': {
      const key = TRACKS[a.track];
      return { ...p, [key]: p[key].map((c) => (c.id === a.id ? { ...c, ...a.patch } : c)) };
    }
    case 'addLayer':
      return { ...p, layers: { ...p.layers, [a.track]: layerCount(p, a.track) + 1 } };
    case 'removeLayer': {
      // Only an empty layer; the layers above it move down one — clips, names and layer
      // states all follow the same permutation.
      const key = LAYERED[a.track];
      if (!key || p[key].some((c) => layerOf(c) === a.layer) || layerCount(p, a.track) < 2) return p;
      const names = { ...((p.layerNames || {})[a.track] || {}) };
      delete names[a.layer];
      for (const k of Object.keys(names).map(Number).sort((x, y) => x - y)) {
        if (k > a.layer) { names[k - 1] = names[k]; delete names[k]; }
      }
      return {
        ...p, layers: { ...p.layers, [a.track]: layerCount(p, a.track) - 1 },
        [key]: p[key].map((c) => (layerOf(c) > a.layer ? { ...c, layer: layerOf(c) - 1 } : c)),
        layerNames: { ...(p.layerNames || {}), [a.track]: names },
        layerState: remapLayerState(p, a.track, (l) => (l === a.layer ? null : l > a.layer ? l - 1 : l)),
      };
    }
    case 'duplicateLayer': {
      // Layer context menu (item 13): deep-copy every clip of a layer onto a NEW layer placed
      // directly above it — no limit on how many times. Overlay/text draw higher layer
      // indexes above lower ones, so the copy takes layer+1 and higher layers shift up; audio
      // rows run the other way (layer 0 on top), so the copy takes the original's row and the
      // original (and everything below it) shifts down one. Layer names travel with their layer.
      // For the main track ('video', not a layered lane) the copy becomes a new TOP overlay
      // layer holding the same clips at the same times, as free-positioned overlay clips.
      if (a.track === 'video') {
        const target = layerCount(p, 'overlay');
        let i = 0;
        const copies = videoLayout(p.videoClips).filter((l) => !l.clip.gap).map((l) => {
          const copy = structuredClone(l.clip);
          copy.id = a.newIds[i++];
          copy.start = l.start;
          copy.layer = target;
          copy.transition = null;
          return copy;
        });
        if (!copies.length) return p;
        return { ...p, overlayClips: [...p.overlayClips, ...copies], layers: { ...p.layers, overlay: target + 1 } };
      }
      const key = LAYERED[a.track];
      if (!key) return p;
      const insertAt = a.track === 'audio' ? a.layer : a.layer + 1;
      let i = 0;
      const copies = p[key].filter((c) => layerOf(c) === a.layer).map((c) => {
        const copy = structuredClone(c);
        copy.id = a.newIds[i++];
        copy.layer = insertAt;
        return copy;
      });
      const shifted = p[key].map((c) => (layerOf(c) >= insertAt && !copies.some((x) => x.id === c.id) && (a.track === 'audio' || layerOf(c) !== a.layer)
        ? { ...c, layer: layerOf(c) + 1 } : c));
      const names = { ...((p.layerNames || {})[a.track] || {}) };
      for (const k of Object.keys(names).map(Number).sort((x, y) => y - x)) {
        if (k >= insertAt && (a.track === 'audio' || k !== a.layer)) { names[k + 1] = names[k]; delete names[k]; }
      }
      return {
        ...p, [key]: [...shifted, ...copies],
        layers: { ...p.layers, [a.track]: layerCount(p, a.track) + 1 },
        layerNames: { ...(p.layerNames || {}), [a.track]: names },
        // Layer states travel with their layers exactly like the names do; the fresh
        // copy layer starts from the defaults (no entry).
        layerState: remapLayerState(p, a.track, (l) => (l >= insertAt && (a.track === 'audio' || l !== a.layer) ? l + 1 : l)),
      };
    }
    case 'deleteLayer': {
      // Removes the layer AND its clips (unlike removeLayer, which only takes empty layers);
      // layers above move down one and their names follow. The last remaining layer is cleared
      // but kept, so a lane never drops below one layer. One dispatch = one undo step.
      if (a.track === 'video') return { ...p, videoClips: [] };
      const key = LAYERED[a.track];
      if (!key) return p;
      const rest = p[key].filter((c) => layerOf(c) !== a.layer)
        .map((c) => (layerOf(c) > a.layer ? { ...c, layer: layerOf(c) - 1 } : c));
      const names = { ...((p.layerNames || {})[a.track] || {}) };
      delete names[a.layer];
      for (const k of Object.keys(names).map(Number).sort((x, y) => x - y)) {
        if (k > a.layer) { names[k - 1] = names[k]; delete names[k]; }
      }
      return {
        ...p, [key]: rest,
        layers: { ...p.layers, [a.track]: Math.max(1, layerCount(p, a.track) - 1) },
        layerNames: { ...(p.layerNames || {}), [a.track]: names },
        layerState: remapLayerState(p, a.track, (l) => (l === a.layer ? null : l > a.layer ? l - 1 : l)),
      };
    }
    case 'moveLayer': {
      // Reorder (Stage C): layer `from` ends up at index `to`, the layers in between shift
      // by one. Clips, names and layer states are remapped through the one permutation, so
      // a single dispatch (one undo step) restores the exact prior order. The main track is
      // not in LAYERED and can never be reordered; overlay/text/audio reorder among
      // themselves (their layer 0 included — only 'video' is fixed).
      const key = LAYERED[a.track];
      if (!key) return p;
      const count = layerCount(p, a.track);
      const { from, to } = a;
      if (from === to || from < 0 || to < 0 || from >= count || to >= count) return p;
      const order = [...Array(count).keys()].filter((i) => i !== from);
      order.splice(to, 0, from); // order[newIndex] = oldIndex
      const perm = {};
      order.forEach((oldIdx, newIdx) => { perm[oldIdx] = newIdx; });
      const names = {};
      for (const [k, v] of Object.entries((p.layerNames || {})[a.track] || {})) {
        if (perm[Number(k)] !== undefined) names[perm[Number(k)]] = v;
      }
      return {
        ...p,
        [key]: p[key].map((c) => (perm[layerOf(c)] !== undefined && perm[layerOf(c)] !== layerOf(c) ? { ...c, layer: perm[layerOf(c)] } : c)),
        layerNames: { ...(p.layerNames || {}), [a.track]: names },
        layerState: remapLayerState(p, a.track, (l) => (perm[l] !== undefined ? perm[l] : l)),
      };
    }
    case 'insertAudioClip':
      // A fully-formed audio clip (Detach audio builds it in App: extracted file, timing, link).
      return { ...p, audioClips: [...p.audioClips, a.clip] };
    case 'renameLayer': {
      const forTrack = { ...((p.layerNames || {})[a.track] || {}) };
      if (a.name && a.name.trim()) forTrack[a.layer] = a.name.trim();
      else delete forTrack[a.layer];
      return { ...p, layerNames: { ...(p.layerNames || {}), [a.track]: forTrack } };
    }
    case 'updateMany':
      // Several clips changed together (one undo step): updates [{ track, id, patch }].
      return a.updates.reduce((q, u) => reduceProject(q, { type: 'update', ...u }), p);
    case 'setMagnet': {
      const magnet = { ...p.magnet, [a.track]: a.on };
      // Turning the main-track magnet on closes every gap.
      if (a.track === 'video' && a.on) return { ...p, magnet, videoClips: p.videoClips.filter((c) => !c.gap) };
      return { ...p, magnet };
    }
    case 'delete': {
      const key = TRACKS[a.track];
      const c = p[key].find((x) => x.id === a.id);
      if (!c) return p;
      if (a.track === 'video') {
        // Deleting a gap, or deleting with the magnet on, closes the space; otherwise leave a gap behind.
        if (c.gap || p.magnet.video) return { ...p, videoClips: p.videoClips.filter((x) => x.id !== a.id) };
        const list = p.videoClips.map((x) => (x.id === a.id ? newGap(x.id, clipLen(x)) : x));
        return { ...p, videoClips: normalizeGaps(list) };
      }
      const rest = p[key].filter((x) => x.id !== a.id);
      if (!p.magnet[a.track]) return { ...p, [key]: rest };
      const len = freeLen(a.track, c);
      const end = c.start + len;
      const same = (x) => !LAYERED[a.track] || layerOf(x) === layerOf(c);
      return { ...p, [key]: rest.map((x) => (same(x) && x.start >= end - 1e-6 ? { ...x, start: Math.max(0, x.start - len) } : x)) };
    }
    case 'moveVideo': {
      const list = [...p.videoClips];
      const from = list.findIndex((c) => c.id === a.id);
      if (from < 0) return p;
      const [c] = list.splice(from, 1);
      list.splice(Math.max(0, Math.min(a.toIndex, list.length)), 0, c);
      return { ...p, videoClips: list };
    }
    case 'setCaptions': {
      // Replaces previous auto captions with new ones (one undo step).
      // Words keep their spoken timings (relative to the caption) for highlight / karaoke styles.
      const style = { y: 0.8, size: Math.round(Math.min(p.width, p.height) * 0.075), ...a.style };
      const caps = a.segments.map((s) => ({
        ...style,
        id: s.id,
        text: s.text,
        start: s.start,
        duration: Math.max(0.2, s.end - s.start),
        words: (s.words || []).map((w) => ({ text: w.text, start: Math.max(0, w.start - s.start), end: Math.max(0, w.end - s.start) })),
        caption: true,
      }));
      // Imported .srt subtitles (source: 'srt') are the user's own files: regenerating the
      // auto captions must not delete them, so only non-srt caption clips are replaced.
      return { ...p, textClips: [...p.textClips.filter((c) => !c.caption || c.source === 'srt'), ...caps] };
    }
    case 'importSrtCaptions': {
      // Subtitles parsed from an .srt file: exact file timings and text, styled with the
      // currently chosen caption template patch (a.style). One undo step for the whole file.
      const style = { y: 0.8, size: Math.round(Math.min(p.width, p.height) * 0.075), ...a.style };
      const caps = a.segments.map((s) => ({
        ...style,
        id: s.id,
        text: s.text,
        start: s.start,
        duration: Math.max(0.2, s.end - s.start),
        caption: true,
        source: 'srt',
      }));
      return { ...p, textClips: [...p.textClips, ...caps] };
    }
    case 'removeSrtCaptions':
      return { ...p, textClips: p.textClips.filter((c) => c.source !== 'srt') };
    case 'styleSrtCaptions':
      // Style only the imported .srt subtitles (the Subtitles card's template grid).
      return { ...p, textClips: p.textClips.map((c) => (c.source === 'srt' ? { ...c, ...a.patch } : c)) };
    case 'styleCaptions':
      return { ...p, textClips: p.textClips.map((c) => (c.caption ? { ...c, ...a.patch } : c)) };
    case 'duplicate': {
      const key = TRACKS[a.track];
      const i = p[key].findIndex((c) => c.id === a.id);
      if (i < 0 || p[key][i].gap) return p;
      const c = p[key][i];
      const copy = { ...c, id: a.newId };
      if (a.track === 'video') copy.transition = null;
      else copy.start = c.start + freeLen(a.track, c);
      const list = [...p[key]];
      list.splice(i + 1, 0, copy);
      return { ...p, [key]: list };
    }
    case 'removeEffect': {
      // a.id: an effect object key (see effectObjects).
      const { track, clipId, fx } = parseEffectKey(a.id);
      const key = TRACKS[track];
      if (!key) return p;
      return { ...p, [key]: p[key].map((c) => {
        if (c.id !== clipId) return c;
        const fxRegions = { ...(c.fxRegions || {}) };
        delete fxRegions[fx]; // the region belongs to the effect instance; it goes with it
        return { ...c, effects: (c.effects || []).filter((e) => e !== fx), fxRegions };
      }) };
    }
    case 'split':
      return splitLinked(p, a.track, a.id, a.t, a.newId);
    case 'moveToOverlay': {
      // Main clip -> overlay track at time `at` (the main track closes up or keeps a gap, per its magnet).
      const c = p.videoClips.find((x) => x.id === a.id);
      if (!c || c.gap) return p;
      const rest = reduceProject(p, { type: 'delete', track: 'video', id: a.id });
      return { ...rest, overlayClips: [...rest.overlayClips, { ...c, start: Math.max(0, a.at), transition: null }] };
    }
    case 'moveToMain': {
      // Overlay clip -> main track at position `index`.
      const c = p.overlayClips.find((x) => x.id === a.id);
      if (!c) return p;
      const rest = reduceProject(p, { type: 'delete', track: 'overlay', id: a.id });
      const { start, ...clip } = c;
      const list = [...rest.videoClips];
      list.splice(Math.max(0, Math.min(a.index ?? list.length, list.length)), 0, { ...clip, transition: null });
      return { ...rest, videoClips: list };
    }
    case 'extractAudio': {
      // Extract the sound of a video clip onto the audio track as an INDEPENDENT clip
      // (same timing, same media, no linkId — unlike Detach audio, nothing stays in
      // sync afterwards) and mute the clip. The copy carries the clip's speed: audio
      // clips play at a constant rate, so (out - in) / speed matches the picture's
      // timeline length at any speed.
      const key = TRACKS[a.track];
      const c = key && p[key].find((x) => x.id === a.id);
      const m = c && p.media.find((x) => x.id === c.mediaId);
      if (!c || c.gap || !m || m.type !== 'video' || !m.hasAudio || c.muted) return p;
      const start = a.track === 'video' ? videoLayout(p.videoClips).find((l) => l.clip.id === c.id).start : c.start;
      const audio = { id: a.newId, mediaId: m.id, start, in: c.in, out: c.out, speed: c.speed || 1, volume: c.volume ?? 1, fadeIn: 0, fadeOut: 0 };
      return { ...p, [key]: p[key].map((x) => (x.id === c.id ? { ...x, muted: true } : x)), audioClips: [...p.audioClips, audio] };
    }
    case 'paste': {
      // A copied clip at time `at`: main clips are inserted where `at` falls, others start at `at`.
      const key = TRACKS[a.track];
      if (!key || !a.clip) return p;
      if (a.track === 'video') {
        const list = [...p.videoClips];
        const index = videoLayout(list).filter((l) => (l.start + l.end) / 2 < a.at).length;
        list.splice(index, 0, { ...a.clip, id: a.newId, transition: null });
        return { ...p, videoClips: list };
      }
      return { ...p, [key]: [...p[key], { ...a.clip, id: a.newId, start: Math.max(0, a.at) }] };
    }
    case 'cutRanges':
      return cutRanges(p, a.ranges);
    case 'addMarker':
      return { ...p, markers: [...p.markers, { id: a.id, time: Math.max(0, a.time), label: a.label || '' }].sort((x, y) => x.time - y.time) };
    case 'removeMarker':
      return { ...p, markers: p.markers.filter((m) => m.id !== a.id) };
    default:
      return p;
  }
}

// Every reduction funnels through here so a motion-tracking pin can never dangle: deleting a clip (or
// a whole layer of clips) or clearing a clip's track takes the pin off every follower that used it.
function reduceProject(p, a) {
  const next = reduceProjectInner(p, a);
  if (next === p) return next;
  if (a.type === 'delete') return cleanPins(next, new Set([a.id]));
  if (a.type === 'deleteLayer' || a.type === 'load') return cleanPins(next);
  if (a.type === 'update' && 'track' in (a.patch || {}) && !a.patch.track) return cleanPins(next);
  if (a.type === 'updateMany') return cleanPins(next);
  return next;
}

// Trims one edge of a clip. `delta` is how much that edge moves INTO the clip, in timeline seconds
// (positive shortens, negative extends). Always computed from the project at gesture start, so repeated
// pointer moves never accumulate. Main track (magnet off): the removed time becomes a gap, and extending
// uses up the neighbouring gap. Free tracks (magnet on): the trimmed clip keeps its start and later clips
// shift by the length change (ripple).
export function trimClip(p, { track, id, edge, delta }) {
  const key = TRACKS[track];
  const idx = p[key].findIndex((c) => c.id === id);
  if (idx < 0) return p;
  const c = p[key][idx];

  if (track === 'video') {
    const list = [...p.videoClips];
    if (c.gap) {
      list[idx] = { ...c, out: Math.max(MIN_CLIP, c.out - delta) };
      return { ...p, videoClips: normalizeGaps(list) };
    }
    const m = p.media.find((x) => x.id === c.mediaId);
    const sp = c.speed || 1;
    const maxOut = !m || m.type === 'image' ? Infinity : m.duration;
    let d;
    if (edge === 'left') {
      const prev = list[idx - 1];
      const avail = prev && prev.gap ? clipLen(prev) : 0;
      const newIn = Math.max(0, Math.min(c.in + delta * sp, c.out - MIN_CLIP * sp));
      d = Math.max((newIn - c.in) / sp, -avail);
      list[idx] = { ...c, in: c.in + d * sp };
      if (d > 0) {
        if (prev && prev.gap) list[idx - 1] = { ...prev, out: prev.out + d };
        else list.splice(idx, 0, newGap(`${id}-gl`, d));
      } else if (d < 0 && prev && prev.gap) list[idx - 1] = { ...prev, out: prev.out + d };
    } else {
      const after = list[idx + 1];
      const avail = !after ? Infinity : after.gap ? clipLen(after) : 0;
      const newOut = Math.max(c.in + MIN_CLIP * sp, Math.min(c.out - delta * sp, maxOut));
      d = Math.max((c.out - newOut) / sp, -avail);
      list[idx] = { ...c, out: c.out - d * sp };
      if (d > 0) {
        if (after && after.gap) list[idx + 1] = { ...after, out: after.out + d };
        else if (after) list.splice(idx + 1, 0, newGap(`${id}-gr`, d));
      } else if (d < 0 && after && after.gap) list[idx + 1] = { ...after, out: after.out + d };
    }
    return { ...p, videoClips: normalizeGaps(list) };
  }

  // Free tracks.
  const len = freeLen(track, c);
  const m = c.mediaId && p.media.find((x) => x.id === c.mediaId);
  let d;
  let next;
  if (track === 'overlay') {
    // Same as audio, with speed (timeline seconds vs source seconds) and endless photos.
    const sp = c.speed || 1;
    if (edge === 'left') {
      const newIn = Math.max(0, Math.min(c.in + delta * sp, c.out - MIN_CLIP * sp));
      d = (newIn - c.in) / sp;
      next = { ...c, in: newIn };
    } else {
      const maxOut = m && m.type === 'video' ? m.duration : Infinity;
      const newOut = Math.max(c.in + MIN_CLIP * sp, Math.min(c.out - delta * sp, maxOut));
      d = (c.out - newOut) / sp;
      next = { ...c, out: newOut };
    }
  } else if (track === 'audio') {
    // delta arrives in timeline seconds; the source window moves by delta * speed, and the
    // ripple shift of later clips is the timeline difference again.
    const sp = c.speed || 1;
    if (edge === 'left') {
      const newIn = Math.max(0, Math.min(c.in + delta * sp, c.out - MIN_CLIP * sp));
      d = (newIn - c.in) / sp;
      next = { ...c, in: newIn };
    } else {
      const maxOut = m ? m.duration : Infinity;
      const newOut = Math.max(c.in + MIN_CLIP * sp, Math.min(c.out - delta * sp, maxOut));
      d = (c.out - newOut) / sp;
      next = { ...c, out: newOut };
    }
  } else {
    d = Math.min(delta, len - MIN_CLIP);
    next = { ...c, duration: len - d };
  }
  const oldEnd = c.start + len;
  const out = p[key].map((x) => {
    if (x.id === id) return next;
    if (p.magnet[track] && x.start >= oldEnd - 1e-6 && (!LAYERED[track] || layerOf(x) === layerOf(c))) return { ...x, start: Math.max(0, x.start - d) };
    return x;
  });
  return { ...p, [key]: out };
}

// The marker closest to time t within `eps` seconds, or null.
export function markerNear(markers, t, eps = 0.05) {
  let best = null;
  for (const m of markers) if (Math.abs(m.time - t) <= eps && (!best || Math.abs(m.time - t) < Math.abs(best.time - t))) best = m;
  return best;
}

// Actions for "delete the part of a clip left (or right) of time t". The clip is split at t and one half is
// deleted through the normal delete, so the track magnet decides between closing the gap and leaving one.
// Returns [] when t is not inside the clip (or too close to its edge).
export function trimActions(p, { track, id, t, side, newId }) {
  const key = TRACKS[track];
  const c = key && p[key].find((x) => x.id === id);
  if (!c || c.gap) return [];
  let start;
  let end;
  if (track === 'video') {
    const l = videoLayout(p.videoClips).find((x) => x.clip.id === id);
    start = l.start;
    end = l.end;
  } else {
    start = c.start;
    end = c.start + freeLen(track, c);
  }
  if (t - start < MIN_CLIP || end - t < MIN_CLIP) return [];
  const actions = [{ type: 'split', track, id, t, newId }];
  // Delete-left on the main track: the split builds the surviving right half with
  // transition: null (correct for a plain split, whose right half starts mid-clip),
  // and the left half — the one carrying the incoming transition — is the one being
  // deleted. But after the ripple the remainder starts the clip, adjacent to the same
  // previous clip, so the transition belongs to it: hand it over, stored verbatim like
  // everywhere else. Its effective length is clamped at use time by transitionDur
  // (half of either neighbour), the same clamp the split/trim paths already rely on.
  // Delete-right keeps the original clip as the remainder, transition already in place.
  if (track === 'video' && side === 'left' && c.transition) {
    actions.push({ type: 'update', track: 'video', id: newId, patch: { transition: c.transition } });
  }
  actions.push({ type: 'delete', track, id: side === 'left' ? id : newId });
  return actions;
}

// Removes time ranges from the main track and closes the space (ripple). ranges: [{ start, end }] in timeline
// seconds. Only the main track is cut; music and text keep their own time. Cut pieces get ids
// derived from the clip id so repeated cuts never collide.
export function cutRanges(p, ranges) {
  const cuts = [...ranges].filter((r) => r.end - r.start > 0.01).sort((a, b) => a.start - b.start);
  if (!cuts.length) return p;
  const out = [];
  for (const l of videoLayout(p.videoClips)) {
    const c = l.clip;
    const sp = c.speed || 1;
    let pieces = [[l.start, l.end]];
    for (const r of cuts) {
      pieces = pieces.flatMap(([a, b]) => {
        if (r.end <= a || r.start >= b) return [[a, b]];
        const keep = [];
        if (r.start > a) keep.push([a, r.start]);
        if (r.end < b) keep.push([r.end, b]);
        return keep;
      });
    }
    pieces.filter(([a, b]) => b - a >= 0.03).forEach(([a, b], i) => {
      const id = i ? `${c.id}-c${i}` : c.id;
      if (c.gap) out.push({ ...c, id, in: 0, out: b - a });
      else out.push({ ...c, id, in: c.in + (a - l.start) * sp, out: c.in + (b - l.start) * sp, transition: i ? null : c.transition });
    });
  }
  return { ...p, videoClips: normalizeGaps(out) };
}

// After a split the In animation stays on the left part and the Out animation on the right one.
// Keyframes are in source time, so both parts keep them unchanged.
function splitAnim(anim, side) {
  if (!anim) return anim;
  const { in: a, out: b, ...rest } = anim;
  return side === 'left' ? { ...rest, ...(a ? { in: a } : {}) } : { ...rest, ...(b ? { out: b } : {}) };
}

function splitAt(p, track, id, t, newId) {
  if (track === 'video') {
    const l = videoLayout(p.videoClips).find((x) => x.clip.id === id);
    if (!l || l.clip.gap || t - l.start < MIN_CLIP || l.end - t < MIN_CLIP) return p;
    const cut = l.clip.in + (t - l.start) * (l.clip.speed || 1);
    const list = [];
    p.videoClips.forEach((c) => {
      if (c.id !== id) return list.push(c);
      list.push({ ...c, out: cut, anim: splitAnim(c.anim, 'left') }, { ...c, id: newId, in: cut, transition: null, anim: splitAnim(c.anim, 'right') });
    });
    return { ...p, videoClips: list };
  }
  if (track === 'audio') {
    const c = p.audioClips.find((x) => x.id === id);
    const len = c ? freeLen('audio', c) : 0;
    if (!c || t - c.start < MIN_CLIP || c.start + len - t < MIN_CLIP) return p;
    const cut = c.in + (t - c.start) * (c.speed || 1);
    return {
      ...p,
      audioClips: p.audioClips.flatMap((x) => (x.id !== id ? [x] : [{ ...x, out: cut }, { ...x, id: newId, start: t, in: cut }])),
    };
  }
  if (track === 'overlay') {
    const c = p.overlayClips.find((x) => x.id === id);
    const len = c ? freeLen('overlay', c) : 0;
    if (!c || t - c.start < MIN_CLIP || c.start + len - t < MIN_CLIP) return p;
    const cut = c.in + (t - c.start) * (c.speed || 1);
    return {
      ...p,
      overlayClips: p.overlayClips.flatMap((x) => (x.id !== id ? [x]
        : [{ ...x, out: cut, anim: splitAnim(x.anim, 'left') }, { ...x, id: newId, start: t, in: cut, anim: splitAnim(x.anim, 'right') }])),
    };
  }
  if (track === 'text' || track === 'effect') {
    const key = TRACKS[track];
    const c = p[key].find((x) => x.id === id);
    if (!c || t - c.start < MIN_CLIP || c.start + c.duration - t < MIN_CLIP) return p;
    return {
      ...p,
      [key]: p[key].flatMap((x) => (x.id !== id ? [x] : splitTimed(x, t, newId))),
    };
  }
  return p;
}

// Splits a clip and, when it is linked (Detach audio) to a partner on the other kind of
// track, splits the partner at the same timeline moment. The left halves keep the link;
// the right halves form a new pair whose offsets are recomputed from the halves themselves,
// so the sync invariants (see syncLinked) hold for both pairs from the start.
function splitLinked(p, track, id, t, newId) {
  const out = splitAt(p, track, id, t, newId);
  if (out === p) return out;
  const src = findClipIn(p, track, id);
  if (!src || !src.linkId) return out;
  const partner = findLinkPartner(p, src);
  if (!partner) return out;
  const partnerNewId = `${newId}~l`;
  const out2 = splitAt(out, partner.track, partner.clip.id, t, partnerNewId);
  if (out2 === out) {
    // The partner could not be split (its range differs): the right half of the first
    // split must not stay linked to a whole partner — it becomes independent.
    return mapClip(out, track, newId, (c) => ({ ...c, linkId: undefined, linkOff: undefined, linkInOff: undefined }));
  }
  const linkId = `${src.linkId}~${newId}`;
  const picTrack = track === 'audio' ? partner.track : track;
  const picRight = findClipIn(out2, picTrack, track === 'audio' ? partnerNewId : newId);
  const audRight = findClipIn(out2, 'audio', track === 'audio' ? newId : partnerNewId);
  if (!picRight || !audRight) return out2;
  let res = mapClip(out2, picTrack, picRight.id, (c) => ({ ...c, linkId }));
  res = mapClip(res, 'audio', audRight.id, (c) => ({
    ...c, linkId,
    linkOff: audRight.start - (picTrack === 'video'
      ? (videoLayout(res.videoClips).find((l) => l.clip.id === picRight.id)?.start ?? audRight.start)
      : picRight.start),
    linkInOff: audRight.in - picRight.in,
  }));
  return res;
}

const CLIP_LISTS = { video: 'videoClips', overlay: 'overlayClips', text: 'textClips', audio: 'audioClips', effect: 'effectClips' };
export function findClipIn(p, track, id) {
  const key = CLIP_LISTS[track];
  return key ? (p[key] || []).find((c) => c.id === id) : undefined;
}
// The other member of a clip's link pair (a picture clip in video/overlay <-> an audio clip).
export function findLinkPartner(p, clip) {
  if (!clip || !clip.linkId) return null;
  for (const track of ['video', 'overlay', 'audio']) {
    const c = (p[CLIP_LISTS[track]] || []).find((x) => x.id !== clip.id && x.linkId === clip.linkId);
    if (c) return { track, clip: c };
  }
  return null;
}
function mapClip(p, track, id, fn) {
  const key = CLIP_LISTS[track];
  if (!key) return p;
  return { ...p, [key]: p[key].map((c) => (c.id === id ? fn(c) : c)) };
}

// Splits a text clip at timeline time t. Caption words go to the half they are spoken in.
function splitTimed(x, t, newId) {
  const cut = t - x.start;
  const a = { ...x, duration: cut };
  const b = { ...x, id: newId, start: t, duration: x.duration - cut };
  if (x.words && x.words.length) {
    const first = x.words.filter((w) => w.start < cut);
    const second = x.words.filter((w) => w.start >= cut).map((w) => ({ ...w, start: w.start - cut, end: w.end - cut }));
    a.words = first;
    b.words = second;
    a.text = first.map((w) => w.text).join(' ');
    b.text = second.map((w) => w.text).join(' ');
  }
  return [a, b];
}

// ---- Lock enforcement (Stage B) ----
// A locked layer's clips cannot be edited at all. The guard lives HERE, at the dispatch
// layer, so every path — pointer drags, menus, shortcuts, the assistant — is blocked the
// same way, not just the visible buttons. It returns true when the action must not run.
// Undo / redo are handled before this is consulted: restoring an earlier project always
// works, locked or not.
function actionLocked(p, a) {
  const clipOf = (track, id) => findClipIn(p, track, id);
  switch (a.type) {
    case 'update': return clipLocked(p, a.track, clipOf(a.track, a.id));
    case 'updateMany': return a.updates.some((u) => clipLocked(p, u.track, clipOf(u.track, u.id)));
    case 'delete':
    case 'duplicate':
    case 'split': return clipLocked(p, a.track, clipOf(a.track, a.id));
    case 'trimClip': return clipLocked(p, a.track, clipOf(a.track, a.id));
    case 'paste': {
      if (a.track === 'video') return isLayerLocked(p, 'video', 0);
      return isLayerLocked(p, a.track, layerOf(a.clip || {}));
    }
    case 'moveVideo': return isLayerLocked(p, 'video', 0);
    case 'moveToOverlay': return isLayerLocked(p, 'video', 0);
    case 'moveToMain': return clipLocked(p, 'overlay', clipOf('overlay', a.id));
    case 'extractAudio': return clipLocked(p, a.track, clipOf(a.track, a.id));
    case 'cutRanges': return isLayerLocked(p, 'video', 0);
    case 'removeEffect': {
      const { track, clipId } = parseEffectKey(a.id);
      return clipLocked(p, track, clipOf(track, clipId));
    }
    case 'removeLayer': return isLayerLocked(p, a.track, a.layer);
    case 'deleteLayer': return a.track !== 'video' && isLayerLocked(p, a.track, a.layer);
    case 'setCaptions':
    case 'importSrtCaptions': return isLayerLocked(p, 'text', 0);
    case 'addEffectClip': return isLayerLocked(p, 'effect', 0);
    case 'insertAudioClip': return isLayerLocked(p, 'audio', layerOf(a.clip || {}));
    case 'addToTimeline': {
      const m = p.media.find((x) => x.id === a.mediaId);
      return !!m && m.type !== 'audio' && isLayerLocked(p, 'video', 0);
    }
    case 'addMedia':
      return false; // library-level operation with its own confirmation
    case 'removeMedia':
      // Deleting an item deletes every clip that uses it — refused while any of those
      // clips sits on a locked layer (the library flow names the layer to the user).
      return !!lockedMediaUse(p, a.id);
    default: return false;
  }
}

// Adds whose landing layer is only known after placeLayers has run (a clip dropped on a
// full layer is bumped to the next free one) are checked against the RESULT: if the new
// clip ended up on a locked layer, the whole action is reverted.
const PLACEMENT_CHECKED = { addToTimeline: 'clipId', addOverlayClip: 'clipId', addText: 'clipId', moveToOverlay: 'id', extractAudio: 'newId' };
function placementBlocked(before, after, a) {
  const idKey = PLACEMENT_CHECKED[a.type];
  if (!idKey || after === before) return false;
  const id = a[idKey];
  for (const track of ['video', 'overlay', 'text', 'audio']) {
    const c = findClipIn(after, track, id);
    if (c) return clipLocked(after, track, c);
  }
  return false;
}

// ---- Link sync (Detach audio pairs) ----
// A linked pair shares clip.linkId; the audio clip also carries linkOff (its start minus
// the picture clip's timeline start) and linkInOff (its source in-point minus the picture
// clip's). After ANY action, the side that did not change is rewritten from the side that
// did — so the pair selects / moves / trims / speeds together no matter which handle the
// user (or a split, or a reorder) touched. Runs inside historyReducer so every edit path
// is covered; returns the input object untouched when every invariant already holds.
function picStart(p, track, clip) {
  if (track === 'video') {
    const l = videoLayout(p.videoClips).find((x) => x.clip.id === clip.id);
    return l ? l.start : null;
  }
  return clip.start;
}
function linkPairs(p) {
  const byId = new Map();
  for (const track of ['video', 'overlay', 'audio']) {
    for (const c of p[CLIP_LISTS[track]] || []) {
      if (!c.linkId) continue;
      const pair = byId.get(c.linkId) || {};
      if (track === 'audio') pair.aud = { track, clip: c };
      else pair.pic = { track, clip: c };
      byId.set(c.linkId, pair);
    }
  }
  return byId;
}
function syncLinked(prev, next) {
  const before = linkPairs(prev);
  const after = linkPairs(next);
  if (!before.size && !after.size) return next;
  let out = next;
  const put = (track, id, patch) => { out = mapClip(out, track, id, (c) => ({ ...c, ...patch })); };
  for (const [linkId, pair] of after) {
    const was = before.get(linkId);
    if (!pair.pic || !pair.aud) {
      // A member was deleted: the survivor becomes a normal, independent clip — but only
      // when the pair was complete before (a pair being built by Detach must survive its
      // own intermediate steps).
      if (was && was.pic && was.aud) {
        const s = pair.pic || pair.aud;
        put(s.track, s.clip.id, { linkId: undefined, linkOff: undefined, linkInOff: undefined });
      }
      continue;
    }
    if (!was || !was.pic || !was.aud) continue; // a pair created by this action: already consistent
    const v = pair.pic.clip;
    const au = pair.aud.clip;
    const pv = was.pic.clip;
    const pa = was.aud.clip;
    const num = (c, f) => (f === 'speed' ? c.speed || 1 : c[f] || 0);
    const vChanged = ['in', 'out', 'speed'].some((f) => num(v, f) !== num(pv, f))
      || picStart(prev, was.pic.track, pv) !== picStart(next, pair.pic.track, v);
    const aChanged = ['in', 'out', 'speed', 'start'].some((f) => num(au, f) !== num(pa, f));
    if (vChanged) {
      const want = {
        start: picStart(next, pair.pic.track, v) + (au.linkOff || 0),
        in: v.in + (au.linkInOff || 0),
        out: v.out + (au.linkInOff || 0),
        speed: v.speed || 1,
      };
      const patch = {};
      for (const f of ['start', 'in', 'out', 'speed']) if (num(au, f) !== want[f]) patch[f] = want[f];
      if (Object.keys(patch).length && !isLayerLocked(next, 'audio', layerOf(au))) put('audio', au.id, patch);
    } else if (aChanged) {
      const patch = {};
      const wantIn = au.in - (au.linkInOff || 0);
      const wantOut = au.out - (au.linkInOff || 0);
      if ((v.in || 0) !== wantIn) patch.in = wantIn;
      if ((v.out || 0) !== wantOut) patch.out = wantOut;
      if ((v.speed || 1) !== (au.speed || 1)) patch.speed = au.speed || 1;
      // The main track's start is positional, so a start change can only flow picture-wards
      // for overlay partners; for video partners it is the picture that leads.
      if (pair.pic.track === 'overlay') {
        const wantStart = au.start - (au.linkOff || 0);
        if ((v.start || 0) !== wantStart) patch.start = wantStart;
      }
      if (Object.keys(patch).length && !clipLocked(next, pair.pic.track, v)) put(pair.pic.track, v.id, patch);
    }
  }
  return out;
}

// Layer state across undo / redo: toggles are not undoable, so the CURRENT states are
// carried over the restored project — but when the undone action was a layer permutation
// (reorder / duplicate / delete layer), the states must follow their LAYERS, not stick to
// the indices. The permutation is read off the clips themselves (each clip id's layer in
// the current project vs in the restored one); when it is consistent for a track, the
// carried keys of that track are remapped through it. (A state entry dropped by deleting
// its layer is not resurrected — toggles made after the snapshot always win.)
function followLayerState(cur, restored) {
  const ls = cur.layerState || {};
  if (!Object.keys(ls).length) return restored.layerState;
  let out = { ...ls };
  for (const track of Object.keys(LAYERED)) {
    const key = LAYERED[track];
    const curById = new Map((cur[key] || []).map((c) => [c.id, layerOf(c)]));
    const map = new Map(); // current layer -> restored layer
    let consistent = true;
    for (const c of restored[key] || []) {
      const lc = curById.get(c.id);
      if (lc === undefined) continue;
      const lr = layerOf(c);
      if (map.has(lc) && map.get(lc) !== lr) { consistent = false; break; }
      map.set(lc, lr);
    }
    if (!consistent || !map.size) continue;
    const prefix = `${track}:`;
    const next = {};
    for (const [k, v] of Object.entries(out)) {
      if (!k.startsWith(prefix)) { next[k] = v; continue; }
      const l = Number(k.slice(prefix.length));
      next[layerKey(track, map.has(l) ? map.get(l) : l)] = v;
    }
    out = next;
  }
  return out;
}

// History wrapper. Actions with `transient: true` (e.g. live drag updates) don't push undo steps;
// a 'commit' action records the state captured at drag start.
// Background thumbnails/waveforms arrive by file path; patch them into every history state so
// undo/redo never brings back a media item without its visuals.
function patchVisuals(p, a) {
  if (!p.media.some((m) => m.path === a.path)) return p;
  return { ...p, media: p.media.map((m) => (m.path === a.path ? { ...m, ...a.patch } : m)) };
}

export function historyReducer(state, a) {
  if (a.type === 'mediaVisuals') {
    return {
      ...state,
      past: state.past.map((p) => patchVisuals(p, a)),
      present: patchVisuals(state.present, a),
      future: state.future.map((p) => patchVisuals(p, a)),
      gestureStart: state.gestureStart && patchVisuals(state.gestureStart, a),
    };
  }
  if (a.type === 'setLayerState') {
    // Lock / hide / mute / solo toggles are view-and-guard state, NOT document edits: they
    // never push an undo step, and undo / redo never change them (they are carried over
    // the restored project below, like mediaVisuals patches the visuals).
    const key = layerKey(a.track, a.layer);
    const cur = { ...layerStateOf(state.present, a.track, a.layer), ...a.patch };
    const layerState = { ...(state.present.layerState || {}) };
    if (!cur.locked && !cur.hidden && !cur.muted && !cur.solo) delete layerState[key];
    else layerState[key] = cur;
    if (JSON.stringify(layerState) === JSON.stringify(state.present.layerState || {})) return state;
    return { ...state, present: { ...state.present, layerState } };
  }
  if (a.type === 'undo') {
    if (!state.past.length) return state;
    const restored = state.past[state.past.length - 1];
    return { past: state.past.slice(0, -1), present: { ...restored, layerState: followLayerState(state.present, restored) }, future: [state.present, ...state.future] };
  }
  if (a.type === 'redo') {
    if (!state.future.length) return state;
    const restored = state.future[0];
    return { past: [...state.past, state.present], present: { ...restored, layerState: followLayerState(state.present, restored) }, future: state.future.slice(1) };
  }
  // Folds every undo step created since `from` (a past.length noted earlier) into one, so a whole AI request
  // can be undone with a single Undo.
  if (a.type === 'collapseHistory') {
    if (state.past.length <= a.from) return state;
    return { ...state, past: state.past.slice(0, a.from + 1) };
  }
  if (a.type === 'beginGesture') return { ...state, gestureStart: state.present };
  if (a.type === 'endGesture') {
    const start = state.gestureStart;
    if (!start || start === state.present) return { ...state, gestureStart: null };
    return { past: [...state.past, start].slice(-100), present: state.present, future: [], gestureStart: null };
  }
  // Locked layers refuse edits before anything is computed (undo / redo returned above,
  // so history navigation is never blocked by a lock).
  if (actionLocked(state.present, a)) return state;
  let next = placeLayers(a.type === 'trimClip' ? trimClip(state.gestureStart || state.present, a) : reduceProject(state.present, a));
  if (next !== state.present && placementBlocked(state.present, next, a)) return state;
  if (next !== state.present) next = syncLinked(state.present, next);
  if (next === state.present) return state;
  if (a.type === 'load') return { past: [], present: next, future: [] };
  if (a.transient || state.gestureStart) return { ...state, present: next };
  return { past: [...state.past, state.present].slice(-100), present: next, future: [] };
}

// Playback quality: which copy of a video the player plays. 'full' is the original chain; the other
// levels play a scaled copy whose longest side is capped (electron/quality.cjs has the same math for
// the generator; the test suite asserts the two agree). The export always reads m.path.
export const PLAYBACK_QUALITIES = ['full', 'high', 'medium', 'low'];
export const QUALITY_MAX_SIDE = { high: 1280, medium: 960, low: 640 };
export const QUALITY_LABELS = { full: 'Full', high: 'High', medium: 'Medium', low: 'Low' };

let playbackQuality = 'full';
export const setPlaybackQuality = (q) => { playbackQuality = PLAYBACK_QUALITIES.includes(q) ? q : 'full'; };
export const getPlaybackQuality = () => playbackQuality;
// Legacy shims for readers that only knew the on/off proxy setting (on meant light copies).
export const setProxyPref = (on) => setPlaybackQuality(on ? 'medium' : 'full');
export const proxyPrefOn = () => playbackQuality !== 'full';

const evenPx = (n) => Math.max(2, Math.round(n / 2) * 2);
// The pixel size a level's copy of a video gets, or null when no copy is needed (see quality.cjs).
export function qualityTargetSize(width, height, quality) {
  const max = QUALITY_MAX_SIDE[quality];
  if (!max || !width || !height) return null;
  const long = Math.max(width, height);
  if (long <= max) return null;
  const s = max / long;
  return { width: evenPx(width * s), height: evenPx(height * s) };
}

// What state a media item's copy for `quality` is in:
// 'na' (level Full, not a video, or the source already fits the level), 'ready' (the level's own
// copy exists), 'fallback' (no copy yet: a smaller copy or the original plays meanwhile), 'failed'
// (generation failed; not retried until the file is imported again).
export function levelCopyState(m, quality) {
  if (!m || m.type !== 'video' || quality === 'full') return 'na';
  const p = m.proxies && typeof m.proxies === 'object' ? m.proxies[quality] : undefined;
  if (typeof p === 'string') return 'ready';
  if (p === false) return 'failed';
  if (m.width && m.height && !qualityTargetSize(m.width, m.height, quality)) return 'na';
  return 'fallback';
}

// The file the player plays for `m` at an explicit quality level. Fallback order below Full: the
// level's own copy, then the closest smaller existing copy (a lower level's copy, or the legacy
// light copy — about medium-sized), then the preview proxy / the original.
export function previewPathFor(m, quality) {
  if (!m) return m;
  if (quality === 'full' || m.type !== 'video') return m.proxy || m.path;
  if (m.width && m.height && !qualityTargetSize(m.width, m.height, quality)) return m.proxy || m.path;
  const p = m.proxies && typeof m.proxies === 'object' ? m.proxies : {};
  if (typeof p[quality] === 'string') return p[quality];
  const smaller = quality === 'high' ? [p.medium, m.lightProxy, p.low] : quality === 'medium' ? [m.lightProxy, p.low] : [m.lightProxy];
  for (const c of smaller) if (typeof c === 'string' && c) return c;
  return m.proxy || m.path;
}
export const previewPath = (m, quality = playbackQuality) => previewPathFor(m, quality);

// Player view zoom (session-only view state; never saved to the project, never touches export).
// `z` is relative to the Fit size, (x, y) the pan in screen px, `fit` marks the Fit menu choice.
export const ZOOM_MIN = 0.25;
export const ZOOM_MAX = 4;
export const FIT_VIEW = Object.freeze({ z: 1, x: 0, y: 0, fit: true });
export const clampZoom = (z) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));
export function clampPan(view, stageW, stageH) {
  const mx = Math.max(0, ((view.z - 1) * (stageW || 0)) / 2) + 60;
  const my = Math.max(0, ((view.z - 1) * (stageH || 0)) / 2) + 60;
  return { ...view, x: Math.min(mx, Math.max(-mx, view.x)), y: Math.min(my, Math.max(-my, view.y)) };
}
export function applyZoomChoice(view, choice, stageW, stageH) {
  if (choice === 'fit') return { ...FIT_VIEW };
  const z = clampZoom(choice / 100);
  if (z <= 1) return { z, x: 0, y: 0, fit: false };
  return clampPan({ z, x: view.x || 0, y: view.y || 0, fit: false }, stageW, stageH);
}
export function zoomByFactor(view, factor, stageW, stageH) {
  const z = clampZoom(view.z * factor);
  if (z <= 1) return { ...FIT_VIEW };
  return clampPan({ z, x: view.x || 0, y: view.y || 0, fit: false }, stageW, stageH);
}
// The CSS transform for the stage element: identity (undefined) at Fit, else centre-anchored
// pan + scale. Percentages in the zoom menu are z x 100 relative to the Fit size.
export function zoomTransform(view) {
  if (!view || (view.fit && view.z === 1 && !view.x && !view.y)) return undefined;
  return `translate(${Math.round(view.x || 0)}px, ${Math.round(view.y || 0)}px) scale(${view.z})`;
}

export function toFileUrl(p) {
  const parts = p.replace(/\\/g, '/').split('/');
  return 'file:///' + parts.map((s, i) => (i === 0 && /^[a-zA-Z]:$/.test(s) ? s : encodeURIComponent(s))).join('/');
}

export function formatTime(t) {
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  const f = Math.floor((t % 1) * 100);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(f).padStart(2, '0')}`;
}

// Look and placement of a picture clip, for "Copy / paste attributes".
export const ATTRIBUTE_KEYS = ['filter', 'filterIntensity', 'adjust', 'grade', 'effects', 'transform', 'opacity', 'blend', 'chroma', 'mask', 'crop', 'customMask', 'bgRemove', 'enhance', 'speed', 'volume'];
export function pickAttributes(c) {
  return Object.fromEntries(ATTRIBUTE_KEYS.filter((k) => c[k] !== undefined).map((k) => [k, c[k]]));
}

// What plays and exports: deactivated main clips become gaps (black, silent), other deactivated clips are left out.
// Layer state applies here too — this is the one project both the preview and the export
// pipeline read, so a hidden layer vanishes from both and a muted / non-solo layer is
// silent in both: hidden picture layers are dropped (the main track leaves gaps), a
// silenced picture layer keeps its picture with clip.muted set, silenced audio clips go.
export function renderable(p) {
  const hasOff = [p.videoClips, p.overlayClips || [], p.audioClips, p.textClips, p.effectClips || []].some((l) => l.some((c) => c.disabled));
  const ls = p.layerState || {};
  const hasLayerFx = Object.values(ls).some((s) => s && (s.hidden || s.muted || s.solo));
  if (!hasOff && !hasLayerFx) return p;
  const hidden = (track, layer) => layerStateOf(p, track, layer).hidden;
  const kept = (track) => (l) => l.filter((c) => !c.disabled && !hidden(track, layerOf(c)));
  return {
    ...p,
    videoClips: p.videoClips.map((c) => (c.disabled || hidden('video', 0)
      ? { ...newGap(c.id, clipLen(c)), transition: c.transition }
      : (!layerSounds(p, 'video', 0) && !c.muted ? { ...c, muted: true } : c))),
    overlayClips: kept('overlay')(p.overlayClips || [])
      .map((c) => (!layerSounds(p, 'overlay', layerOf(c)) && !c.muted ? { ...c, muted: true } : c)),
    audioClips: (p.audioClips || []).filter((c) => !c.disabled && !hidden('audio', layerOf(c)) && layerSounds(p, 'audio', layerOf(c))),
    textClips: kept('text')(p.textClips),
    effectClips: (p.effectClips || []).filter((c) => !c.disabled && !hidden('effect', 0)),
  };
}

// Effects as timeline objects for the Effects lane: free effects (their own id, movable and trimmable) and
// effects applied to clips (key "<track>|<clipId>|<effectId>", spanning and following the clip).
export function effectObjects(p) {
  const out = (p.effectClips || []).map((e) => ({ key: e.id, free: true, fx: e.fx, start: e.start, duration: e.duration, clip: e }));
  for (const l of videoLayout(p.videoClips)) {
    if (l.clip.gap) continue;
    for (const fx of l.clip.effects || []) out.push({ key: `video|${l.clip.id}|${fx}`, track: 'video', clipId: l.clip.id, fx, start: l.start, duration: l.end - l.start });
  }
  for (const c of p.overlayClips || []) {
    for (const fx of c.effects || []) out.push({ key: `overlay|${c.id}|${fx}`, track: 'overlay', clipId: c.id, fx, start: c.start, duration: freeLen('overlay', c) });
  }
  return out;
}
export const parseEffectKey = (key) => {
  const [track, clipId, fx] = String(key).split('|');
  return { track, clipId, fx };
};
