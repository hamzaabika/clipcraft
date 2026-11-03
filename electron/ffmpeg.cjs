// Builds FFmpeg arguments for exporting a project to MP4.
// Pure module (no Electron imports) so it can be tested from plain Node.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const ffmpegPath = require('ffmpeg-static').replace('app.asar', 'app.asar.unpacked');
const ffprobePath = require('ffprobe-static').path.replace('app.asar', 'app.asar.unpacked');

const layers = require('./layers.cjs');
const { audioFxFilters } = require('./audiofx.cjs');

const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif'];

const num = (n) => Number(n).toFixed(3);
const hex = (c, def = '#ffffff') => (c || def).replace('#', '0x');

function probe(file) {
  const ext = path.extname(file).slice(1).toLowerCase();
  return new Promise((resolve, reject) => {
    const args = ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file];
    const p = spawn(ffprobePath, args, { windowsHide: true });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => {
      if (code !== 0) return reject(new Error(err || `ffprobe exited with ${code}`));
      const info = JSON.parse(out);
      const streams = info.streams || [];
      const v = streams.find((s) => s.codec_type === 'video' && !(s.disposition && s.disposition.attached_pic));
      const a = streams.find((s) => s.codec_type === 'audio');
      const isImage = IMAGE_EXT.includes(ext) && !a;
      // Phones store portrait videos as landscape frames plus a rotation (display matrix): FFmpeg and the player
      // show them turned, so the size we use is the turned one.
      const rotation = v ? Math.round(Number((v.side_data_list || []).find((d) => d.rotation !== undefined)?.rotation ?? (v.tags && v.tags.rotate) ?? 0)) : 0;
      const turned = Math.abs(rotation) % 180 === 90;
      // HDR video (iPhone HLG / Dolby Vision, PQ): converted to normal (SDR) colors wherever we decode it.
      const hdr = !!v && ['arib-std-b67', 'smpte2084'].includes(v.color_transfer);
      resolve({
        type: isImage ? 'image' : v ? 'video' : 'audio',
        duration: isImage ? 0 : parseFloat(info.format && info.format.duration) || 0,
        hasVideo: !!v,
        hasAudio: !!a,
        // Frame rate from the stream's average (or nominal) rate, rounded (29.97 -> 30).
        fps: v ? Math.round((() => { const r = String(v.avg_frame_rate || v.r_frame_rate || '0/1').split('/'); return (parseFloat(r[0]) || 0) / (parseFloat(r[1]) || 1); })()) : 0,
        width: v ? (turned ? v.height : v.width) : 0,
        height: v ? (turned ? v.width : v.height) : 0,
        rotation,
        hdr,
        // What the player needs to know to decide on a preview proxy.
        vcodec: v ? v.codec_name : '',
        acodec: a ? a.codec_name : '',
        pixFmt: v ? v.pix_fmt : '',
        profile: v ? v.profile || '' : '',
        // Audio channel count: mono sources get a unity dual-mono pan in the export chains
        // (see monoUp below); media probed before this field existed reads as undefined and
        // simply keeps the old upmix behaviour.
        channels: a ? a.channels || 0 : 0,
      });
    });
  });
}

const clipLen = (c) => (c.out - c.in) / (c.speed || 1);

// HDR (HLG or PQ, BT.2020) to normal BT.709 colors: to linear light, BT.709 primaries, Hable tone curve. Without it
// the picture comes out pale and yellowish, because every later step reads the HDR values as normal ones.
const TONEMAP = 'zscale=t=linear:npl=203,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p';
const toSdr = (m) => (m && m.hdr ? `,${TONEMAP}` : '');

function transitionDur(clips, i) {
  const t = clips[i] && clips[i].transition;
  if (!t || i === 0 || t.type === 'none') return 0;
  return Math.max(0, Math.min(t.duration, clipLen(clips[i]) / 2, clipLen(clips[i - 1]) / 2));
}

function atempo(speed) {
  const out = [];
  let s = speed;
  while (s > 2) { out.push('atempo=2'); s /= 2; }
  while (s < 0.5) { out.push('atempo=0.5'); s /= 0.5; }
  if (Math.abs(s - 1) > 1e-3) out.push(`atempo=${s.toFixed(4)}`);
  return out;
}

// Filters for the look of a clip (flip, color filter, adjustments, effects) on a picture of size W x H.
function lookFilters(clip, W, H) {
  const f = [];
  const fx = clip.effects || [];
  // A classic effect carrying a region, or a strength below 1, is baked by the effects
  // pass through its shader form instead (src/fx/apply.js classicViaShader) — the flat
  // look filters here must not paint it a second time.
  const viaShader = (id) => !!(clip.fxRegions?.[id] || (clip.fxStrength?.[id] != null && clip.fxStrength[id] < 1));
  if (fx.includes('mirror') && !viaShader('mirror')) f.push('hflip');
  if (fx.includes('flipv') && !viaShader('flipv')) f.push('vflip');
  // clip.filter is drawn by the effects pass (GPU, src/fx/filters.js), like in the player.
  const a = { brightness: 0, contrast: 1, saturation: 1, hue: 0, blur: 0, ...(clip.adjust || {}) };
  if (a.brightness || a.contrast !== 1 || a.saturation !== 1) {
    f.push(`eq=brightness=${num(a.brightness * 0.5)}:contrast=${num(a.contrast)}:saturation=${num(a.saturation)}`);
  }
  if (a.hue) f.push(`hue=h=${num(a.hue)}`);
  const blur = Math.round((a.blur + (fx.includes('blur') && !viaShader('blur') ? 6 : 0)) * (W / 640));
  if (blur > 0) f.push(`boxblur=${Math.min(blur, Math.floor(Math.min(W, H) / 2) - 1)}`);
  if (fx.includes('vignette') && !viaShader('vignette')) f.push('vignette=PI/4');
  if (fx.includes('grain') && !viaShader('grain')) f.push('noise=alls=18:allf=t');
  if (fx.includes('pixel') && !viaShader('pixel')) f.push(`scale=iw/24:ih/24,scale=${W}:${H}:flags=neighbor`);
  return f;
}

// The plain picture path: fit in the frame over the background color, look, constant frame rate.
function clipVideoFilters(clip, W, H, fps, background) {
  return [
    `scale=${W}:${H}:force_original_aspect_ratio=decrease`,
    `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=${hex(background, '#000000')}`,
    'setsar=1',
    ...lookFilters(clip, W, H),
    `fps=${fps}`,
    'format=yuv420p',
  ].join(',');
}


// The Voice Enhancer's cached file for a clip, when it is on AND was rendered for the clip's
// current range (a re-trim makes the stored render stale: it is ignored until re-run, exactly
// like the preview). The file covers [clip.in, clip.out], so chains read it from 0.
function enhancePathOf(clip) {
  const e = clip && clip.enhance;
  if (!e || !e.on || !e.path) return null;
  if (Math.abs((e.from ?? -1) - (clip.in || 0)) > 0.02 || Math.abs((e.to ?? -1) - (clip.out ?? -1)) > 0.02) return null;
  return fs.existsSync(e.path) ? e.path : null;
}

// Audio stream [a<i>] for main-track clip i (silence for photos, muted or silent clips).
// enhIdx: input index of the clip's enhanced file, when the Voice Enhancer replaces its sound.
// swresample's default mono->stereo upmix renders a mono source 3.01 dB down per channel,
// while the browser plays (and the level meter reads) the same clip at its true level on both
// channels — measured on the app's own mix render (a -1.00 dBFS mono voice rendered at
// -4.01 dBFS). Pan mono sources to dual-mono at unity so the export carries the level the
// preview presented. Only for the media file itself: enhanced renders are always stereo
// (electron/enhance.cjs writes -ac 2), so the enhanced path never takes the pan.
const monoUp = (m, enhanced) => (!enhanced && m && m.channels === 1 ? 'pan=stereo|c0=c0|c1=c0' : null);

function clipAudioFilter(clip, m, idx, i, enhIdx = -1, seeked = false) {
  const len = clipLen(clip);
  if (clip.gap || !m || m.type === 'image' || !m.hasAudio || clip.muted) {
    return `anullsrc=r=48000:cl=stereo,atrim=duration=${num(len)},aformat=sample_fmts=fltp[a${i}]`;
  }
  // Perf B1 (2026-11-01): when the caller input-seeked this clip's input (-ss before -i),
  // the stream already starts at clip.in, so the trim runs from 0 — identical samples,
  // without decoding the skipped prefix. The enhanced branch is pre-trimmed by the
  // enhance render and always reads from 0.
  const src = enhIdx >= 0
    ? [`[${enhIdx}:a]atrim=start=0:end=${num(clip.out - clip.in)}`, 'asetpts=PTS-STARTPTS']
    : seeked
      ? [`[${idx}:a]atrim=start=0:end=${num(clip.out - clip.in)}`, 'asetpts=PTS-STARTPTS']
      : [`[${idx}:a]atrim=start=${num(clip.in)}:end=${num(clip.out)}`, 'asetpts=PTS-STARTPTS'];
  const up = monoUp(m, enhIdx >= 0);
  return [...src, ...(up ? [up] : []), ...atempo(clip.speed || 1),
    `volume=${clip.volume ?? 1}`, 'aresample=48000', 'aformat=sample_fmts=fltp:channel_layouts=stereo',
    ...audioFxFilters(clip.audioFx),
    `apad=whole_dur=${num(len)}`, `atrim=duration=${num(len)}`].join(',') + `[a${i}]`;
}

// Main-track audio only (no music), as 16 kHz mono WAV — the input for auto captions.
// Audio to transcribe, as 16 kHz mono WAV. source: 'all' (video clips + audio track), 'video' or 'audio'.
// Every piece is placed at its timeline position, so caption times match the timeline.
function buildTimelineAudioArgs(project, outWav, source = 'all') {
  const mediaById = Object.fromEntries(project.media.map((m) => [m.id, m]));
  const inputs = [];
  const filters = [];
  const mix = [];
  let n = 0;

  const clips = source === 'audio' ? [] : project.videoClips.filter((c) => c.gap || mediaById[c.mediaId]);
  if (clips.length) {
    clips.forEach((clip, i) => {
      const m = mediaById[clip.mediaId];
      let idx = -1;
      if (m && m.type !== 'image' && m.hasAudio && !clip.muted) {
        inputs.push('-ss', num(clip.in), '-i', m.path); // B1: input seeking, as in exports
        idx = n++;
      }
      filters.push(clipAudioFilter(clip, m, idx, i, -1, idx >= 0));
    });
    let ca = 'a0';
    for (let i = 1; i < clips.length; i++) {
      const td = transitionDur(clips, i);
      filters.push(td > 0 ? `[${ca}][a${i}]acrossfade=d=${num(td)}[ja${i}]` : `[${ca}][a${i}]concat=n=2:v=0:a=1[ja${i}]`);
      ca = `ja${i}`;
    }
    filters.push(`[${ca}]aresample=16000,aformat=sample_fmts=fltp:channel_layouts=mono[main]`);
    mix.push('[main]');
  }

  const extra = source === 'video' ? [] : project.audioClips.filter((c) => mediaById[c.mediaId] && mediaById[c.mediaId].hasAudio);
  extra.forEach((c, j) => {
    inputs.push('-ss', num(c.in), '-i', mediaById[c.mediaId].path);
    const idx = n++;
    const ms = Math.round(c.start * 1000);
    filters.push(
      `[${idx}:a]atrim=start=0:end=${num(c.out - c.in)},asetpts=PTS-STARTPTS,${[...atempo(c.speed || 1), `volume=${c.volume ?? 1}`].join(',')},` +
        `aresample=16000,aformat=sample_fmts=fltp:channel_layouts=mono,adelay=${ms}:all=1[x${j}]`
    );
    mix.push(`[x${j}]`);
  });

  if (!mix.length) {
    throw new Error(source === 'audio'
      ? 'The Audio track is empty. Add an audio clip first.'
      : 'Nothing to transcribe: no clip with sound on the timeline.');
  }
  if (mix.length === 1) filters.push(`${mix[0]}aformat=sample_fmts=s16:channel_layouts=mono[out]`);
  else filters.push(`${mix.join('')}amix=inputs=${mix.length}:duration=longest:normalize=0,aformat=sample_fmts=s16:channel_layouts=mono[out]`);
  return ['-y', '-hide_banner', '-loglevel', 'error', ...inputs, '-filter_complex', filters.join(';'), '-map', '[out]', '-ar', '16000', outWav];
}

function renderTimelineAudio(project, outWav, source) {
  return new Promise((resolve, reject) => {
    let args;
    try {
      args = buildTimelineAudioArgs(project, outWav, source);
    } catch (e) {
      return reject(e);
    }
    const p = spawn(ffmpegPath, args, { windowsHide: true });
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve(outWav) : reject(new Error(err.slice(-3000)))));
  });
}

const renderMainAudio = (project, outWav) => renderTimelineAudio(project, outWav, 'video');

// Silent stretches of the main track's sound, as [{ start, end }] in timeline seconds.
// minDur: shortest silence to report; noiseDb: level below which sound counts as silence.
async function detectSilences(project, { minDur = 0.6, noiseDb = -35, source = 'video' } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fve-sil-'));
  try {
    const wav = await renderTimelineAudio(project, path.join(tmp, 'a.wav'), source);
    const log = await new Promise((resolve, reject) => {
      const p = spawn(ffmpegPath, ['-hide_banner', '-nostats', '-i', wav, '-af', `silencedetect=noise=${noiseDb}dB:d=${minDur}`, '-f', 'null', '-'], { windowsHide: true });
      let err = '';
      p.stderr.on('data', (d) => (err += d));
      p.on('error', reject);
      p.on('close', (code) => (code === 0 ? resolve(err) : reject(new Error(err.slice(-1500)))));
    });
    const total = (() => {
      const m = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(log);
      return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : Infinity;
    })();
    const out = [];
    let open = null;
    for (const line of log.split(/\r?\n/)) {
      const a = /silence_start:\s*(-?[\d.]+)/.exec(line);
      if (a) open = Math.max(0, Number(a[1]));
      const b = /silence_end:\s*([\d.]+)/.exec(line);
      if (b && open !== null) {
        out.push({ start: open, end: Number(b[1]) });
        open = null;
      }
    }
    if (open !== null) out.push({ start: open, end: total }); // silence that lasts until the end
    return out;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// project: { width, height, fps, background, media[], videoClips[], textClips[], audioClips[] }
// Size of a picture fitted inside the W x H frame (even numbers), as the layered path and the effects pass use.
function fitSize(m, W, H) {
  const mw = (m && m.width) || W;
  const mh = (m && m.height) || H;
  const k = Math.min(W / mw, H / mh);
  const even = (n) => Math.max(2, Math.round(n / 2) * 2);
  return { fw: even(mw * k), fh: even(mh * k) };
}

// Input options for a still picture shown for `len` seconds. "-loop 1" only exists for still image files; a GIF
// (often animated) is read by FFmpeg's GIF reader, which loops with -stream_loop instead (and plays its animation,
// like the player does).
function stillInput(file, fps, len) {
  if (/\.gif$/i.test(file)) return ['-stream_loop', '-1', '-t', num(len), '-i', file];
  return ['-loop', '1', '-framerate', String(fps), '-t', num(len), '-i', file];
}

// A copy of a clip limited to [from, to] seconds of its own timeline (for the frames of a transition).
function narrowClip(clip, m, from, to) {
  const c = { ...clip, transition: null };
  if (clip.gap) return { ...c, in: 0, out: to - from, speed: 1 };
  if (clip.videoOverride) return { ...c, videoOverride: { ...clip.videoOverride, start: clip.videoOverride.start + from, end: clip.videoOverride.start + to } };
  if (m.type === 'image') return { ...c, in: 0, out: to - from, speed: 1 };
  const sp = clip.speed || 1;
  return { ...c, in: clip.in + from * sp, out: clip.in + to * sp };
}

// Adds the picture input of a clip and returns a filter chain prefix "[n:v]trim...," that gives its frames at
// the clip's own timing. clip.videoOverride ({ file, start, end } in timeline seconds) replaces the media by a file
// the animated-effects pass rendered.
// The AI background matte of a clip (Remove BG > Auto removal), trimmed and timed like the clip's picture; the
// label of the stream, or null when the clip has none. The matte is constant frame rate from 0 s in source time.
function matteSource(clip, m, fps, addInput, tag, filters) {
  if (!clip.bgRemove || !m || m.type !== 'video' || !m.matte || !fs.existsSync(m.matte)) return null;
  const idx = addInput(['-ss', num(clip.in), '-i', m.matte]);
  filters.push(`[${idx}:v]trim=duration=${num(clip.out - clip.in)},setpts=(PTS-STARTPTS)/${clip.speed || 1},fps=${fps},` +
    `tpad=stop_mode=clone:stop_duration=1[mt${tag}]`);
  return `mt${tag}`;
}

function pictureSource(clip, m, len, fps, addInput) {
  // Perf B1: media inputs are input-seeked (-ss before -i) to the clip's first frame and
  // the trim runs from 0 — the encoder never decodes the skipped prefix (measured at
  // +48% export time for a clip starting 55 min into its source). `audioSeeked` tells
  // the caller whether THIS input also carries the clip's (already seeked) audio.
  if (clip.videoOverride) {
    const o = clip.videoOverride;
    const idx = addInput(['-ss', num(o.start), '-i', o.file]);
    return { idx, chain: `[${idx}:v]trim=duration=${num(o.end - o.start)},setpts=PTS-STARTPTS`, own: false, audioSeeked: false };
  }
  if (m.type === 'image') {
    const idx = addInput(stillInput(m.path, fps, len));
    return { idx, chain: `[${idx}:v]trim=duration=${num(len)},setpts=PTS-STARTPTS`, own: true, audioSeeked: false };
  }
  const idx = addInput(['-ss', num(clip.in), '-i', m.path]);
  return { idx, chain: `[${idx}:v]trim=duration=${num(clip.out - clip.in)},setpts=(PTS-STARTPTS)/${clip.speed || 1}${toSdr(m)}`, own: true, audioSeeked: true };
}

// opts.raw: only the main track's picture, as raw RGBA frames on stdout (frames for the effects pass).
// opts.encoder: H.264 encoder (see pickEncoder); libx264 when not given.
function buildExportArgs(project, outFile, opts = {}) {
  const { width: W, height: H, fps } = project;
  const bg = project.background || '#000000';
  const mediaById = Object.fromEntries(project.media.map((m) => [m.id, m]));
  const inputs = [];
  const filters = [];
  let nInputs = 0;
  const addInput = (args) => { inputs.push(...args); return nInputs++; };

  const clips = project.videoClips.filter((c) => c.gap || mediaById[c.mediaId]);
  if (clips.length === 0) throw new Error('The video track is empty.');

  // 1) Main track: prepare each clip (trim, speed, size, look) with a matching audio stream.
  clips.forEach((clip, i) => {
    const m = mediaById[clip.mediaId];
    const len = clipLen(clip);
    const speed = clip.speed || 1;
    if (clip.gap) {
      // A gap on the main track: the project background, in silence.
      filters.push(`color=c=${hex(bg, '#000000')}:s=${W}x${H}:r=${fps}:d=${num(len)},format=yuv420p[v${i}]`);
      if (!opts.raw) filters.push(clipAudioFilter(clip, null, -1, i));
      return;
    }
    // Clips with a transform, mask, chroma key, opacity or blend go through the layered render; the rest keep the plain path.
    const motion = project.motion && project.motion[clip.id];
    const layered = layers.isLayered(clip, motion);
    const maskFile = project.maskFiles && project.maskFiles[clip.id];
    const renderLayered = (srcLabel) => {
      const tag = `m${i}`;
      const maskIdx = maskFile ? addInput(['-loop', '1', '-framerate', String(fps), '-t', num(len), '-i', maskFile]) : null;
      const decoFile = maskFile && project.decoFiles && project.decoFiles[clip.id];
      const decoIdx = decoFile ? addInput(['-loop', '1', '-framerate', String(fps), '-t', num(len), '-i', decoFile]) : null;
      const cmFile = project.customMaskFiles && project.customMaskFiles[clip.id];
      const customMaskIdx = cmFile ? addInput(['-loop', '1', '-framerate', String(fps), '-t', num(len), '-i', cmFile]) : null;
      const matteLabel = matteSource(clip, m, fps, addInput, tag, filters);
      const layer = layers.buildLayer({ clip, media: m, W, H, fps, len, tag, srcLabel, maskIdx, decoIdx, motion, matteLabel, customMaskIdx }, { lookFilters, num, hex });
      filters.push(...layer.filters);
      filters.push(`color=c=${hex(bg, '#000000')}:s=${W}x${H}:r=${fps}:d=${num(len)},format=yuv420p[bg${tag}]`);
      filters.push(...layers.composite({ base: `bg${tag}`, layer: layer.out, blend: clip.blend, tag, out: `v${i}` }));
    };
    const src = pictureSource(clip, m, len, fps, addInput);
    if (layered) {
      filters.push(`${src.chain},fps=${fps}[s${i}]`);
      renderLayered(`s${i}`);
    } else {
      filters.push(`${src.chain},${clipVideoFilters(clip, W, H, fps, bg)}[v${i}]`);
    }
    // Sound comes from the media even when the picture was pre-rendered. A dedicated
    // audio input (picture came from an override file) is input-seeked too (B1).
    const audioIdx = src.own || m.type === 'image' || !m.hasAudio || clip.muted ? src.idx : addInput(['-ss', num(clip.in), '-i', m.path]);
    const enhP = !opts.raw && enhancePathOf(clip);
    const enhIdx = enhP ? addInput(['-i', enhP]) : -1;
    if (!opts.raw) filters.push(clipAudioFilter(clip, m, src.own ? src.idx : audioIdx, i, enhIdx, src.own ? !!src.audioSeeked : true));
  });

  // 2) Join clips: xfade/acrossfade where a transition is set, plain concat otherwise.
  let cv = 'v0';
  let ca = 'a0';
  let end = clipLen(clips[0]);
  for (let i = 1; i < clips.length; i++) {
    const td = transitionDur(clips, i);
    const start = end - td;
    const seg = td > 0 && project.fxSegments && project.fxSegments[clips[i].id];
    if (seg) {
      // Animated transition rendered by the effects pass: what came before, the transition, the rest of the clip.
      const sIdx = addInput(['-i', seg]);
      filters.push(
        `[${cv}]trim=duration=${num(start)},setpts=PTS-STARTPTS,setsar=1[jA${i}]`,
        `[${sIdx}:v]trim=duration=${num(td)},setpts=PTS-STARTPTS,fps=${fps},scale=${W}:${H},setsar=1,format=yuv420p[jT${i}]`,
        `[v${i}]trim=start=${num(td)},setpts=PTS-STARTPTS,setsar=1[jB${i}]`,
        `[jA${i}][jT${i}][jB${i}]concat=n=3:v=1:a=0[jv${i}]`,
      );
      filters.push(`[${ca}][a${i}]acrossfade=d=${num(td)}[ja${i}]`);
    } else if (td > 0) {
      // xfade needs both inputs on the same time base (after an animated transition the video so far has another one).
      filters.push(
        `[${cv}]settb=1/${fps}[xa${i}]`, `[v${i}]settb=1/${fps}[xb${i}]`,
        `[xa${i}][xb${i}]xfade=transition=${clips[i].transition.type}:duration=${num(td)}:offset=${num(start)}[jv${i}]`,
      );
      filters.push(`[${ca}][a${i}]acrossfade=d=${num(td)}[ja${i}]`);
    } else {
      filters.push(`[${cv}][v${i}]concat=n=2:v=1:a=0[jv${i}]`);
      filters.push(`[${ca}][a${i}]concat=n=2:v=0:a=1[ja${i}]`);
    }
    cv = `jv${i}`;
    ca = `ja${i}`;
    end = start + clipLen(clips[i]);
  }
  const total = end;
  if (opts.raw) {
    return {
      args: ['-y', '-hide_banner', '-loglevel', 'error', ...inputs, '-filter_complex', filters.join(';'),
        '-map', `[${cv}]`, '-t', num(total), '-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1'],
      total,
    };
  }
  const overlayAudio = [];

  // 3) Overlay clips (picture in picture): layered like main clips, padded in time to the whole video, composited in order.
  (project.overlayClips || []).filter((c) => mediaById[c.mediaId] && mediaById[c.mediaId].type !== 'audio').forEach((c, j) => {
    const m = mediaById[c.mediaId];
    const sp = c.speed || 1;
    const len = (c.out - c.in) / sp;
    const start = Math.max(0, c.start);
    if (start >= total - 0.01) return;
    const tag = `o${j}`;
    const src = pictureSource(c, m, len, fps, addInput);
    filters.push(`${src.chain},fps=${fps}[os${j}]`);
    const idx = src.own ? src.idx : m.hasAudio && !c.muted && m.type === 'video' ? addInput(['-ss', num(c.in), '-i', m.path]) : src.idx;
    const maskFile = project.maskFiles && project.maskFiles[c.id];
    const maskIdx = maskFile ? addInput(['-loop', '1', '-framerate', String(fps), '-t', num(len), '-i', maskFile]) : null;
    const decoFile = maskFile && project.decoFiles && project.decoFiles[c.id];
    const decoIdx = decoFile ? addInput(['-loop', '1', '-framerate', String(fps), '-t', num(len), '-i', decoFile]) : null;
    const cmFile = project.customMaskFiles && project.customMaskFiles[c.id];
    const customMaskIdx = cmFile ? addInput(['-loop', '1', '-framerate', String(fps), '-t', num(len), '-i', cmFile]) : null;
    const motion = project.motion && project.motion[c.id];
    const matteLabel = matteSource(c, m, fps, addInput, tag, filters);
    const layer = layers.buildLayer({ clip: c, media: m, W, H, fps, len, tag, srcLabel: `os${j}`, maskIdx, decoIdx, motion, matteLabel, customMaskIdx }, { lookFilters, num, hex });
    filters.push(...layer.filters);
    // Transparent frames before and after, so the layer lines up with the video frame for frame.
    const after = Math.max(0, total - start - len);
    filters.push(`[${layer.out}]tpad=start_duration=${num(start)}:stop_duration=${num(after)}:start_mode=add:stop_mode=add:color=black@0,trim=duration=${num(total)}[op${j}]`);
    filters.push(...layers.composite({ base: cv, layer: `op${j}`, blend: c.blend, tag, out: `ov${j}` }));
    cv = `ov${j}`;
    if (m.hasAudio && !c.muted && m.type === 'video') {
      const enhP = enhancePathOf(c);
      overlayAudio.push({ idx: enhP ? addInput(['-i', enhP]) : idx, c, len, start, sp, enh: !!enhP });
    }
  });

  // 4) Text layer: frames drawn by the UI's canvas text renderer (same code as the preview), packed in text.mov.
  if (project.textOverlay && project.textOverlay.count > 0) {
    const idx = addInput(['-i', project.textOverlay.file]);
    filters.push(`[${idx}:v]format=rgba[txt]`);
    filters.push(`[${cv}][txt]overlay=0:0:eof_action=pass:format=auto,format=yuv420p[tv]`);
    cv = 'tv';
  }

  // 5) Music track and overlay sound: trim, fade, delay to timeline position, mix with the main audio.
  const music = project.audioClips.filter((c) => mediaById[c.mediaId]);
  const mixLabels = [`[${ca}]`];
  music.forEach((c, j) => {
    const enhP = enhancePathOf(c);
    // B1: the media input is input-seeked to c.in (the enhanced render is pre-trimmed),
    // so the trim runs from 0 in both cases.
    const idx = addInput(enhP ? ['-i', enhP] : ['-ss', num(c.in), '-i', mediaById[c.mediaId].path]);
    const len = (c.out - c.in) / (c.speed || 1); // timeline length (audio clips carry a speed, e.g. detached ones)
    const delay = Math.round(c.start * 1000);
    const up = monoUp(mediaById[c.mediaId], !!enhP);
    const chain = [`atrim=start=0:end=${num(c.out - c.in)}`, 'asetpts=PTS-STARTPTS', ...(up ? [up] : []), ...atempo(c.speed || 1), `volume=${c.volume ?? 1}`];
    if (c.fadeIn > 0) chain.push(`afade=t=in:st=0:d=${num(Math.min(c.fadeIn, len))}`);
    if (c.fadeOut > 0) chain.push(`afade=t=out:st=${num(Math.max(0, len - c.fadeOut))}:d=${num(Math.min(c.fadeOut, len))}`);
    chain.push(...audioFxFilters(c.audioFx));
    chain.push('aresample=48000', 'aformat=sample_fmts=fltp:channel_layouts=stereo', `adelay=${delay}|${delay}`);
    filters.push(`[${idx}:a]${chain.join(',')}[m${j}]`);
    mixLabels.push(`[m${j}]`);
  });
  overlayAudio.forEach(({ idx, c, len, start, sp, enh }, j) => {
    const delay = Math.round(start * 1000);
    const up = monoUp(mediaById[c.mediaId], !!enh);
    // B1: idx always names an input seeked to c.in (or the pre-trimmed enhanced render),
    // so the trim runs from 0.
    const chain = [`atrim=start=0:end=${num(c.out - c.in)}`, 'asetpts=PTS-STARTPTS', ...(up ? [up] : []), ...atempo(sp), `volume=${c.volume ?? 1}`,
      'aresample=48000', 'aformat=sample_fmts=fltp:channel_layouts=stereo', ...audioFxFilters(c.audioFx), `adelay=${delay}|${delay}`];
    filters.push(`[${idx}:a]${chain.join(',')}[oa${j}]`);
    mixLabels.push(`[oa${j}]`);
  });
  if (mixLabels.length > 1) {
    filters.push(`${mixLabels.join('')}amix=inputs=${mixLabels.length}:duration=first:normalize=0[amix]`);
    ca = 'amix';
  }

  // 6) Output stage: the effective export settings' resolution cap (downscale only) and fps resample,
  // applied to the finished picture — every layer above stays at project size.
  const eff = effectiveExport(project);
  let outLabel = cv;
  const stage = [];
  if (eff.outW !== W || eff.outH !== H) stage.push(`scale=${eff.outW}:${eff.outH}:flags=lanczos`);
  if (eff.outFps !== fps) stage.push(`fps=${eff.outFps}`);
  if (stage.length) { filters.push(`[${cv}]${stage.join(',')},format=yuv420p[ovfinal]`); outLabel = 'ovfinal'; }

  const args = [
    '-y', '-hide_banner',
    ...inputs,
    '-filter_complex', filters.join(';'),
    '-map', `[${outLabel}]`, '-map', `[${ca}]`,
    ...videoCodec2(opts.encoder, eff), '-pix_fmt', 'yuv420p',
    // The pipeline works in BT.709 SDR throughout (HDR inputs are tone-mapped to BT.709 above);
    // tag it explicitly — untagged yuv420p otherwise probes as color_* "unknown".
    '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709', '-color_range', 'tv',
    '-c:a', 'aac', '-b:a', `${eff.audioKbps}k`,
    '-t', num(total),
    '-movflags', '+faststart',
    '-progress', 'pipe:1', '-nostats',
    outFile,
  ];
  return { args, total };
}

// Audio-only export: main track (with crossfades), overlay sound and the audio track, mixed like the video export.
// format: 'mp3' | 'wav' | 'm4a'.
function buildAudioExportArgs(project, outFile, format = 'mp3') {
  const mediaById = Object.fromEntries(project.media.map((m) => [m.id, m]));
  const inputs = [];
  const filters = [];
  const mix = [];
  let n = 0;
  const addInput = (args) => { inputs.push(...args); return n++; };
  const fmt = 'aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo';
  let sound = false;

  const clips = project.videoClips.filter((c) => c.gap || mediaById[c.mediaId]);
  if (clips.length) {
    clips.forEach((clip, i) => {
      const m = mediaById[clip.mediaId];
      const has = m && m.type === 'video' && m.hasAudio && !clip.muted && !clip.gap;
      if (has) sound = true;
      const enhP = has && enhancePathOf(clip);
      // B1: seek the media input to the clip start; clipAudioFilter trims from 0.
      filters.push(clipAudioFilter(clip, m, has ? addInput(['-ss', num(clip.in), '-i', m.path]) : -1, i, enhP ? addInput(['-i', enhP]) : -1, true));
    });
    let ca = 'a0';
    for (let i = 1; i < clips.length; i++) {
      const td = transitionDur(clips, i);
      filters.push(td > 0 ? `[${ca}][a${i}]acrossfade=d=${num(td)}[ja${i}]` : `[${ca}][a${i}]concat=n=2:v=0:a=1[ja${i}]`);
      ca = `ja${i}`;
    }
    mix.push(`[${ca}]`);
  }
  (project.overlayClips || []).forEach((c, j) => {
    const m = mediaById[c.mediaId];
    if (!m || m.type !== 'video' || !m.hasAudio || c.muted) return;
    sound = true;
    const delay = Math.round(Math.max(0, c.start) * 1000);
    const enhP = enhancePathOf(c);
    const upO = monoUp(m, !!enhP);
    filters.push(`[${addInput(enhP ? ['-i', enhP] : ['-ss', num(c.in), '-i', m.path])}:a]atrim=start=0:end=${num(c.out - c.in)},asetpts=PTS-STARTPTS,${[...(upO ? [upO] : []), ...atempo(c.speed || 1), `volume=${c.volume ?? 1}`, ...audioFxFilters(c.audioFx)].join(',')},${fmt},adelay=${delay}|${delay}[oa${j}]`);
    mix.push(`[oa${j}]`);
  });
  project.audioClips.filter((c) => mediaById[c.mediaId]).forEach((c, j) => {
    sound = true;
    const len = (c.out - c.in) / (c.speed || 1);
    const delay = Math.round(c.start * 1000);
    const enhP = enhancePathOf(c);
    const up = monoUp(mediaById[c.mediaId], !!enhP);
    const chain = [`atrim=start=0:end=${num(c.out - c.in)}`, 'asetpts=PTS-STARTPTS', ...(up ? [up] : []), ...atempo(c.speed || 1), `volume=${c.volume ?? 1}`];
    if (c.fadeIn > 0) chain.push(`afade=t=in:st=0:d=${num(Math.min(c.fadeIn, len))}`);
    if (c.fadeOut > 0) chain.push(`afade=t=out:st=${num(Math.max(0, len - c.fadeOut))}:d=${num(Math.min(c.fadeOut, len))}`);
    chain.push(...audioFxFilters(c.audioFx));
    filters.push(`[${addInput(enhP ? ['-i', enhP] : ['-ss', num(c.in), '-i', mediaById[c.mediaId].path])}:a]${chain.join(',')},${fmt},adelay=${delay}|${delay}[m${j}]`);
    mix.push(`[m${j}]`);
  });
  if (!sound) throw new Error('Nothing to export: no clip on the timeline has sound.');
  filters.push(mix.length === 1 ? `${mix[0]}anull[out]` : `${mix.join('')}amix=inputs=${mix.length}:duration=longest:normalize=0[out]`);
  const codec = { mp3: ['-c:a', 'libmp3lame', '-b:a', '192k'], wav: ['-c:a', 'pcm_s16le'], m4a: ['-c:a', 'aac', '-b:a', '192k'] }[format];
  if (!codec) throw new Error(`Unknown audio format: ${format}`);
  return ['-y', '-hide_banner', '-loglevel', 'error', ...inputs, '-filter_complex', filters.join(';'), '-map', '[out]', ...codec, outFile];
}

function exportAudio(project, outFile, format) {
  return new Promise((resolve, reject) => {
    let args;
    try {
      args = buildAudioExportArgs(project, outFile, format);
    } catch (e) {
      return reject(e);
    }
    const p = spawn(ffmpegPath, args, { windowsHide: true });
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve(outFile) : reject(new Error(err.slice(-3000)))));
  });
}

// Windows limits a command line to 32767 characters: a long filter graph (many animated clips) goes in a file.
function graphFile(args, dir = os.tmpdir()) {
  const i = args.indexOf('-filter_complex');
  if (i < 0 || args[i + 1].length < 20000) return args;
  const file = path.join(dir, `fve-graph-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`);
  fs.writeFileSync(file, args[i + 1]);
  return [...args.slice(0, i), '-filter_complex_script', file, ...args.slice(i + 2)];
}

// Runs the export; onProgress receives a 0..1 fraction. Returns { promise, cancel }.
// ---- Video encoder: the graphics card's H.264 encoder when one works, else libx264 on the CPU ----
// A hardware encoder is faster and leaves the processor free, at about the same quality (its quality number is a
// few steps above the CRF to match: h264_qsv at 23 measured like libx264 veryfast at CRF 20).
// ---- Export quality: the effective settings the renderer resolved (src/exportQuality.js) and stamped
// onto the project as project.export. Consumed here verbatim (validated + clamped); projects without a
// stamp (older saves, smoke fixtures) fall back to the historical behavior: CRF (project.crf || 20),
// veryfast, AAC 192k, project size and fps.
const X264_PRESETS = ['ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium', 'slow', 'slower', 'veryslow'];
function effectiveExport(project) {
  const e = project.export;
  const W = project.width || 1280;
  const H = project.height || 720;
  const fps = project.fps || 30;
  if (!e || typeof e !== 'object') {
    return { codecFamily: 'h264', mode: 'crf', crf: project.crf || 20, bitrateMbps: null, encoderPreset: 'veryfast', audioKbps: 192, outW: W, outH: H, outFps: fps };
  }
  const clampN = (v, lo, hi, dflt) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Number(v))) : dflt);
  return {
    codecFamily: e.codecFamily === 'h265' ? 'h265' : 'h264',
    mode: e.mode === 'bitrate' ? 'bitrate' : 'crf',
    crf: clampN(e.crf, 0, 51, 20),
    bitrateMbps: e.bitrateMbps == null ? null : clampN(e.bitrateMbps, 0.5, 100, 12),
    encoderPreset: X264_PRESETS.includes(e.encoderPreset) ? e.encoderPreset : 'veryfast',
    audioKbps: clampN(e.audioKbps, 32, 512, 192),
    // Never upscale, whatever a stamp claims: the cap can only shrink the project frame.
    outW: Math.max(2, Math.min(W, Math.round(e.outW || W))),
    outH: Math.max(2, Math.min(H, Math.round(e.outH || H))),
    outFps: clampN(e.outFps, 1, 240, fps),
  };
}

// Which encoders the bundled FFmpeg actually has (checked once, synchronously — buildExportArgs is sync).
let encoderSet = null;
function hasEncoder(name) {
  if (!encoderSet) {
    encoderSet = new Set();
    try {
      const out = execFileSync(ffmpegPath, ['-hide_banner', '-encoders'], { windowsHide: true }).toString();
      for (const line of out.split('\n')) {
        const m = line.trim().match(/^\S+\s+(\S+)\s/);
        if (m) encoderSet.add(m[1]);
      }
    } catch { /* empty set: everything falls back to libx264 */ }
  }
  return encoderSet.has(name);
}
const hasLibx265 = () => hasEncoder('libx265');

const HW_ENCODERS = {
  h264_nvenc: (crf) => ['-c:v', 'h264_nvenc', '-preset', 'p4', '-rc', 'vbr', '-cq', String(crf + 3), '-b:v', '0'],
  h264_qsv: (crf) => ['-c:v', 'h264_qsv', '-preset', 'veryfast', '-global_quality', String(crf + 3)],
  h264_amf: (crf) => ['-c:v', 'h264_amf', '-quality', 'speed', '-rc', 'cqp', '-qp_i', String(crf + 2), '-qp_p', String(crf + 2)],
};
// The full codec argument set for an effective export config. Hardware encoders get their mapped
// equivalents of the same intent: NVENC preset levels p1..p7 for the x264 speed names, QSV takes the
// names directly, AMF collapses to its three quality levels; rate control follows the mode (CQ for
// CRF intent, a plain target bitrate for bitrate intent). H.265 is software-only in this build
// (libx265, stated rule); without libx265 it falls back to the H.264 path.
const NVENC_PRESET = { ultrafast: 'p1', superfast: 'p1', veryfast: 'p2', faster: 'p2', fast: 'p3', medium: 'p4', slow: 'p5', slower: 'p6', veryslow: 'p7' };
function videoCodec2(encoder, eff) {
  if (eff.codecFamily === 'h265' && hasLibx265()) {
    const rate = eff.mode === 'bitrate' ? ['-b:v', `${eff.bitrateMbps}M`] : ['-crf', String(eff.crf)];
    return ['-c:v', 'libx265', '-preset', eff.encoderPreset, ...rate, '-tag:v', 'hvc1'];
  }
  const rate = eff.mode === 'bitrate'
    ? { hw: ['-b:v', `${eff.bitrateMbps}M`], sw: ['-b:v', `${eff.bitrateMbps}M`, '-maxrate', `${eff.bitrateMbps}M`, '-bufsize', `${eff.bitrateMbps * 2}M`] }
    : null;
  if (encoder === 'h264_nvenc') {
    return eff.mode === 'bitrate'
      ? ['-c:v', 'h264_nvenc', '-preset', NVENC_PRESET[eff.encoderPreset], '-rc', 'vbr', ...rate.hw]
      : ['-c:v', 'h264_nvenc', '-preset', NVENC_PRESET[eff.encoderPreset], '-rc', 'vbr', '-cq', String(eff.crf + 3), '-b:v', '0'];
  }
  if (encoder === 'h264_qsv') {
    return eff.mode === 'bitrate'
      ? ['-c:v', 'h264_qsv', '-preset', eff.encoderPreset, ...rate.hw]
      : ['-c:v', 'h264_qsv', '-preset', eff.encoderPreset, '-global_quality', String(eff.crf + 3)];
  }
  if (encoder === 'h264_amf') {
    const quality = ['slow', 'slower', 'veryslow'].includes(eff.encoderPreset) ? 'quality' : eff.encoderPreset === 'medium' ? 'balanced' : 'speed';
    return eff.mode === 'bitrate'
      ? ['-c:v', 'h264_amf', '-quality', quality, '-rc', 'vbr_peak', ...rate.hw]
      : ['-c:v', 'h264_amf', '-quality', quality, '-rc', 'cqp', '-qp_i', String(eff.crf + 2), '-qp_p', String(eff.crf + 2)];
  }
  return ['-c:v', 'libx264', '-preset', eff.encoderPreset, ...(eff.mode === 'bitrate' ? rate.sw : ['-crf', String(eff.crf)])];
}
function videoCodec(encoder, crf) {
  return videoCodec2(encoder, { codecFamily: 'h264', mode: 'crf', crf, bitrateMbps: null, encoderPreset: 'veryfast' });
}

// The encoder exports use, picked once with a short test encode (NVIDIA, then Intel, then AMD). FVE_ENCODER forces
// one (tests). A hardware encoder that fails during an export is dropped for libx264 (see runExport).
let encoderPick = null;
function pickEncoder() {
  if (process.env.FVE_ENCODER) return Promise.resolve(process.env.FVE_ENCODER);
  encoderPick ||= (async () => {
    for (const name of Object.keys(HW_ENCODERS)) {
      try {
        await runFfmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30:duration=0.5', ...videoCodec(name, 20), '-pix_fmt', 'yuv420p', '-f', 'null', '-']);
        return name;
      } catch {
        // not on this PC
      }
    }
    return 'libx264';
  })();
  return encoderPick;
}

function runExport(project, outFile, onProgress, runOpts = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fve-'));
  const maskFiles = {};
  for (const [n, [clipId, dataUrl]] of Object.entries(project.maskImages || {}).entries()) {
    const file = path.join(tmpDir, `mask_${n}.png`);
    fs.writeFileSync(file, Buffer.from(String(dataUrl).split(',')[1], 'base64'));
    maskFiles[clipId] = file;
  }
  const decoFiles = {}; // mask outline / glow pictures
  for (const [n, [clipId, dataUrl]] of Object.entries(project.decoImages || {}).entries()) {
    const file = path.join(tmpDir, `deco_${n}.png`);
    fs.writeFileSync(file, Buffer.from(String(dataUrl).split(',')[1], 'base64'));
    decoFiles[clipId] = file;
  }
  const customMaskFiles = {}; // painted removal keep-maps (grayscale, source geometry)
  for (const [n, [clipId, dataUrl]] of Object.entries(project.customMaskImages || {}).entries()) {
    const file = path.join(tmpDir, `cmask_${n}.png`);
    fs.writeFileSync(file, Buffer.from(String(dataUrl).split(',')[1], 'base64'));
    customMaskFiles[clipId] = file;
  }
  const withAssets = {
    ...project,
    maskFiles,
    decoFiles,
    customMaskFiles,
  };
  let proc = null;
  let canceled = false;
  const once = (encoder) => new Promise((resolve, reject) => {
    const { args, total } = buildExportArgs(withAssets, outFile, { encoder });
    proc = spawn(ffmpegPath, graphFile(args, tmpDir), { windowsHide: true });
    // Perf mode (Low-End): run the encoder below normal priority so the PC stays
    // responsive during exports. Scheduling only — the graph and output are identical.
    if (runOpts.nice) { try { os.setPriority(proc.pid, runOpts.nice); } catch { /* not permitted on every platform */ } }
    let log = '';
    proc.stdout.on('data', (d) => {
      const m = /out_time_us=(\d+)/.exec(d.toString());
      if (m && total > 0) onProgress?.(Math.min(1, Number(m[1]) / 1e6 / total));
    });
    proc.stderr.on('data', (d) => {
      log += d;
      if (log.length > 20000) log = log.slice(-20000);
    });
    proc.on('error', reject);
    proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`FFmpeg failed (code ${code}):
${log.slice(-3000)}`))));
  });
  const promise = (async () => {
    try {
      const encoder = await pickEncoder();
      try {
        await once(encoder);
      } catch (e) {
        if (canceled || encoder === 'libx264') throw e;
        // The graphics card's encoder failed on this export (driver, size limit…): redo it on the CPU, and keep
        // using the CPU from now on.
        encoderPick = Promise.resolve('libx264');
        onProgress?.(0);
        await once('libx264');
      }
      onProgress?.(1);
      return outFile;
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  })();
  return { promise, cancel: () => { canceled = true; proc?.kill('SIGKILL'); } };
}

// Converts any audio file (e.g. a MediaRecorder .webm voice-over) to .m4a so it has a proper duration.
function toM4a(input, output) {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpegPath, ['-y', '-hide_banner', '-loglevel', 'error', '-i', input, '-c:a', 'aac', '-b:a', '160k', output], { windowsHide: true });
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => (code === 0 ? resolve(output) : reject(new Error(err))));
  });
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpegPath, ['-y', '-hide_banner', '-loglevel', 'error', ...args], { windowsHide: true });
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(err.slice(-2000)))));
  });
}

// Timeline visuals, cached in `cacheDir` by path + size + mtime:
// - a thumbnail sprite: `thumbCount` frames side by side, frame k shows time k * thumbInterval
//   (thumbW x thumbH each). A fast keyframe-only pass is reported first, then an exact pass.
// - an audio waveform image spanning the whole file.
// onUpdate(partial) is called as each piece becomes available. Failures are non-fatal.
async function makeVisuals(item, cacheDir, onUpdate = () => {}) {
  const st = fs.statSync(item.path);
  // v3 (W4, 2026-11-01): visuals now include a dedicated full-frame poster (below) — the
  // version bump makes media cached under v2 regenerate once so posters appear everywhere.
  const key = require('crypto').createHash('sha1').update(`${item.path}|${st.size}|${st.mtimeMs}|v3`).digest('hex').slice(0, 16);
  fs.mkdirSync(cacheDir, { recursive: true });
  const metaFile = path.join(cacheDir, `${key}-visuals.json`);
  if (fs.existsSync(metaFile)) {
    const cached = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
    if ([cached.thumb, cached.wave, cached.poster].every((f) => !f || fs.existsSync(f))) {
      onUpdate(cached);
      return cached;
    }
  }
  const out = {};
  if (item.type === 'video' && item.duration > 0) {
    const count = Math.min(120, Math.max(8, Math.ceil(item.duration)));
    const interval = item.duration / count;
    const th = 90;
    const tw = Math.max(2, Math.round((th * (item.width || 16)) / (item.height || 9) / 2) * 2);
    // tpad clones the last frame so fps always produces `count` frames and the tile is complete.
    const vf = `tpad=stop_mode=clone:stop_duration=${(interval * 2).toFixed(3)},fps=1/${interval.toFixed(4)},` +
      `scale=${tw}:${th},tile=${count}x1:padding=0`;
    const meta = { thumbCount: count, thumbInterval: interval, thumbW: tw, thumbH: th };
    const fast = path.join(cacheDir, `${key}-sprite-fast.jpg`);
    await runFfmpeg(['-skip_frame', 'nokey', '-i', item.path, '-an', '-vf', vf, '-frames:v', '1', '-q:v', '6', fast]).catch(() => {});
    if (fs.existsSync(fast)) onUpdate({ ...meta, thumb: fast });
    const exact = path.join(cacheDir, `${key}-sprite.jpg`);
    await runFfmpeg(['-i', item.path, '-an', '-vf', vf, '-frames:v', '1', '-q:v', '5', exact]).catch(() => {});
    if (fs.existsSync(exact)) {
      Object.assign(out, meta, { thumb: exact });
      onUpdate({ ...meta, thumb: exact });
    } else if (fs.existsSync(fast)) Object.assign(out, meta, { thumb: fast });
    // W4: a dedicated POSTER frame for project cards. The sprite frames are only 90 px
    // tall (a portrait frame is ~52x90) — showing one at card size is the blurry smear
    // Hamza reported. The poster is one frame at 640 px on its long edge, taken a little
    // into the file (min(2 s, ~10% of duration), at least 0.4 s in) so it is a stable,
    // representative frame rather than a fade-in instant or a mid-transition blur.
    const poster = path.join(cacheDir, `${key}-poster.jpg`);
    const pt = Math.min(2, Math.max(0.4, item.duration * 0.1));
    await runFfmpeg(['-ss', pt.toFixed(3), '-i', item.path, '-an', '-frames:v', '1',
      '-vf', 'scale=640:640:force_original_aspect_ratio=decrease', '-q:v', '3', poster]).catch(() => {});
    if (fs.existsSync(poster)) {
      out.poster = poster;
      onUpdate({ poster });
    }
  }
  if (item.hasAudio && item.duration > 0) {
    const wave = path.join(cacheDir, `${key}-wave.png`);
    const w = Math.min(8000, Math.max(600, Math.round(item.duration * 60)));
    await runFfmpeg(['-i', item.path, '-vn', '-filter_complex',
      `aformat=channel_layouts=mono,compand=gain=4,showwavespic=s=${w}x96:colors=white:scale=sqrt`, '-frames:v', '1', wave]).catch(() => {});
    if (fs.existsSync(wave)) {
      out.wave = wave;
      onUpdate({ wave });
    }
  }
  fs.writeFileSync(metaFile, JSON.stringify(out), 'utf8');
  return out;
}

// The player (Chromium) only decodes 8-bit 4:2:0 H.264 / VP8 / VP9 / AV1 smoothly. 10-bit or 4:2:2 video, HEVC,
// ProRes and pictures above 1080p play with a stuck or black picture, so they get a light preview copy (proxy),
// The export always uses the original file.
function needsProxy(info) {
  if (!info || info.type !== 'video') return false;
  const okCodec = ['h264', 'vp8', 'vp9', 'av1'].includes(info.vcodec);
  const okPix = ['yuv420p', 'yuvj420p'].includes(info.pixFmt);
  const big = (info.width || 0) * (info.height || 0) > 1920 * 1088;
  return !!info.hdr || !okCodec || !okPix || big || /high 10|4:2:2|4:4:4/i.test(info.profile || '');
}

// Background picture for a scene without footage (intro, title card, end card): one color, or a gradient from
// `color` to `color2` (direction: horizontal, vertical or diagonal). Colors are #rrggbb. Cached per look and size.
async function makeScene({ color, color2, direction = 'diagonal', width, height }, cacheDir) {
  const hex = (c) => (/^#[0-9a-f]{6}$/i.test(String(c)) ? String(c).toLowerCase() : null);
  const c0 = hex(color);
  const c1 = color2 ? hex(color2) : null;
  if (!c0 || (color2 && !c1)) throw new Error('Scene colors must be #rrggbb.');
  const w = Math.max(16, Math.min(4096, Math.round(width / 2) * 2));
  const h = Math.max(16, Math.min(4096, Math.round(height / 2) * 2));
  const dir = ['horizontal', 'vertical', 'diagonal'].includes(direction) ? direction : 'diagonal';
  fs.mkdirSync(cacheDir, { recursive: true });
  const out = path.join(cacheDir, `scene-${c0.slice(1)}${c1 ? `-${c1.slice(1)}-${dir}` : ''}-${w}x${h}.png`);
  if (fs.existsSync(out)) return out;
  let vf = `color=c=${c0.replace('#', '0x')}:s=${w}x${h}`;
  if (c1) {
    // Each channel goes from c0 to c1 along the direction (geq: X, Y, W, H are the pixel and the frame size).
    const t = { horizontal: 'X/W', vertical: 'Y/H', diagonal: '(X/W+Y/H)/2' }[dir];
    const ch = (c, i) => parseInt(c.slice(1 + i * 2, 3 + i * 2), 16);
    const lerp = (i) => `${ch(c0, i)}+(${ch(c1, i) - ch(c0, i)})*${t}`;
    vf = `color=c=black:s=${w}x${h},format=rgb24,geq=r='${lerp(0)}':g='${lerp(1)}':b='${lerp(2)}'`;
  }
  await runFfmpeg(['-f', 'lavfi', '-i', vf, '-frames:v', '1', `${out}.part.png`]);
  fs.renameSync(`${out}.part.png`, out);
  return out;
}

// 720p H.264 copy with a keyframe every half second (fast seeking), same timing and sound. Cached per file.
async function makeProxy(item, cacheDir) {
  const st = fs.statSync(item.path);
  // HDR files get a new, SDR proxy (the key changes), so the player shows the colors the export gives.
  const key = require('crypto').createHash('sha1').update(`${item.path}|${st.size}|${st.mtimeMs}|proxy1${item.hdr ? '-sdr' : ''}`).digest('hex').slice(0, 16);
  fs.mkdirSync(cacheDir, { recursive: true });
  const out = path.join(cacheDir, `${key}-proxy.mp4`);
  if (fs.existsSync(out)) return out;
  const part = path.join(cacheDir, `${key}-proxy.part.mp4`);
  // Down to 720p first: the HDR tone mapping works in floating point, so it runs on 9x fewer pixels for 4K.
  // (At 720p libx264 is as fast as a graphics card encoder here: decoding and tone mapping take the time.)
  await runFfmpeg(['-i', item.path, '-map', '0:v:0', '-map', '0:a:0?',
    '-vf', `scale=w='min(1280,iw)':h=-2${item.hdr ? `,${TONEMAP}` : ''},format=yuv420p`,
    ...(item.hdr ? ['-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709'] : []),
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '24', '-g', '15', '-keyint_min', '15', '-sc_threshold', '0',
    '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', part]);
  fs.renameSync(part, out);
  return out;
}

// Light proxy for the Proxy setting (weak PCs): every video gets one, 540 px on its shorter side, quick to make
// and to decode (fastdecode), keyframes every half second for fast seeking. Only the player uses it; the export
// always reads the original. Cached per file, next to the other proxies ("-lproxy.mp4").
async function makeLightProxy(item, cacheDir) {
  const st = fs.statSync(item.path);
  const key = require('crypto').createHash('sha1').update(`${item.path}|${st.size}|${st.mtimeMs}|lproxy1${item.hdr ? '-sdr' : ''}`).digest('hex').slice(0, 16);
  fs.mkdirSync(cacheDir, { recursive: true });
  const out = path.join(cacheDir, `${key}-lproxy.mp4`);
  if (fs.existsSync(out)) return out;
  const part = path.join(cacheDir, `${key}-lproxy.part.mp4`);
  await runFfmpeg(['-i', item.path, '-map', '0:v:0', '-map', '0:a:0?',
    '-vf', `scale=w='if(gt(iw,ih),-2,min(540,iw))':h='if(gt(iw,ih),min(540,ih),-2)'${item.hdr ? `,${TONEMAP}` : ''},format=yuv420p`,
    ...(item.hdr ? ['-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709'] : []),
    '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'fastdecode', '-crf', '27', '-g', '15', '-keyint_min', '15', '-sc_threshold', '0',
    '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart', part]);
  fs.renameSync(part, out);
  return out;
}

// Playback-quality copy for one level ('high' | 'medium' | 'low'): the picture scaled so its longest
// side is at most the level's cap (1280 / 960 / 640), never upscaled — a source that already fits
// returns null and the player keeps the full-quality chain. Same recipe family as the light proxy
// (fast seeking keyframes, fastdecode); higher levels keep more bitrate. Only the player uses these
// ("-q<level>.mp4" in the cache); the export always reads the original.
const { qualityTargetSize, qualityScaleFilter } = require('./quality.cjs');
async function makeQualityProxy(item, cacheDir, quality) {
  if (!qualityTargetSize(item.width, item.height, quality)) return null;
  const st = fs.statSync(item.path);
  const key = require('crypto').createHash('sha1').update(`${item.path}|${st.size}|${st.mtimeMs}|q${quality}1${item.hdr ? '-sdr' : ''}`).digest('hex').slice(0, 16);
  fs.mkdirSync(cacheDir, { recursive: true });
  const out = path.join(cacheDir, `${key}-q${quality}.mp4`);
  if (fs.existsSync(out)) return out;
  const part = path.join(cacheDir, `${key}-q${quality}.part.mp4`);
  const crf = { high: 23, medium: 26, low: 28 }[quality] || 26;
  await runFfmpeg(['-i', item.path, '-map', '0:v:0', '-map', '0:a:0?',
    '-vf', `${qualityScaleFilter(quality)}${item.hdr ? `,${TONEMAP}` : ''},format=yuv420p`,
    ...(item.hdr ? ['-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709'] : []),
    // ultrafast at every level: the copy is preview-only, and the build happens in the background
    // while the original keeps playing — a faster build is worth more than the last bit of
    // compression efficiency. Measured on a 60 s 1080p source in the dev sandbox: High 32.0 s ->
    // 19.0 s, Medium 18.5 s -> 16.4 s, Low 17.0 s -> 13.7 s (decode of the source is the floor).
    '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'fastdecode', '-crf', String(crf), '-g', '15', '-keyint_min', '15', '-sc_threshold', '0',
    // AAC sound is copied, not re-encoded (the common case for MP4 sources); anything else is
    // re-encoded to AAC so the copy always plays.
    ...(item.acodec === 'aac' ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', quality === 'high' ? '128k' : '96k']),
    '-movflags', '+faststart', part]);
  fs.renameSync(part, out);
  return out;
}

// Small frames of a clip for Adjust > Auto: `count` pictures spread over [from, to] (source seconds), 160 px wide,
// as raw RGB. HDR is mapped to normal colors first, like the export does. A photo gives one frame.
async function sampleFrames(item, from, to, count = 8) {
  const { spawn } = require('child_process');
  const one = (t) => new Promise((resolve) => {
    const args = ['-v', 'error', ...(t != null ? ['-ss', String(Math.max(0, t))] : []), '-i', item.path, '-frames:v', '1',
      '-vf', `scale=160:-2${toSdr(item)},format=rgb24`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'];
    const p = spawn(ffmpegPath, args, { windowsHide: true });
    const chunks = [];
    p.stdout.on('data', (d) => chunks.push(d));
    p.on('error', () => resolve(null));
    p.on('close', () => {
      const data = Buffer.concat(chunks);
      const width = 160;
      const height = Math.floor(data.length / (width * 3));
      resolve(height > 0 ? { data: new Uint8Array(data.subarray(0, width * height * 3)), width, height } : null); // its own copy for IPC
    });
  });
  if (item.type === 'image') return [await one(null)].filter(Boolean);
  const a = Math.max(0, from || 0);
  const b = Math.max(a + 0.05, Math.min(to || item.duration || a + 1, (item.duration || Infinity) - 0.05));
  const times = Array.from({ length: count }, (_, i) => a + ((i + 0.5) / count) * (b - a));
  return (await Promise.all(times.map(one))).filter(Boolean);
}

module.exports = {
  sampleFrames,
  toSdr, stillInput, graphFile, pickEncoder, hasLibx265, effectiveExport, makeScene, needsProxy, makeProxy, makeLightProxy, makeQualityProxy, ffmpegPath, ffprobePath, probe, lookFilters, fitSize, narrowClip, buildExportArgs, buildAudioExportArgs, exportAudio, runExport, toM4a, renderMainAudio, renderTimelineAudio, detectSilences, makeVisuals };
