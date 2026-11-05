# Third-Party Notices

ClipCraft is free and open-source software (MIT — see `LICENSE`; the
ClipCraft name and logo are the author's brand and are **not** part of the
MIT grant). It builds on the open-source components below. Their licenses
remain in force for their respective parts.

## Creative components

### Transition Studio — MIT
A subset of the transition expressions in `src/fx/catalog.js`
(`STUDIO_TRANSITIONS`) adapts WebGL shaders from **Transition Studio**
(https://github.com/Rhitottam/transition-studio), rewritten into ClipCraft's
expression language with documented changes. MIT License, Copyright (c) 2025
rhitottaM:

> Permission is hereby granted, free of charge, to any person obtaining a copy
> of this software and associated documentation files (the "Software"), to deal
> in the Software without restriction, including without limitation the rights
> to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
> copies of the Software, and to permit persons to whom the Software is
> furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in
> all copies or substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
> IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
> FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
> AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
> LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
> OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
> THE SOFTWARE.

### "slay" LUTs — CC BY 4.0
The five `.cube` colour-grading LUTs in `shared/luts/` are by **slay**
(https://www.slaycamera.com, source: https://github.com/slaycamera/luts),
licensed under the Creative Commons Attribution 4.0 International License
(full text ships beside them in `shared/luts/LICENSE-slay-CC-BY-4.0.txt`).
Files are unchanged. Credit: "LUTs: slay (CC BY 4.0)".

## Tools and libraries

### FFmpeg — GPLv3 / LGPL
ClipCraft ships the `ffmpeg` and `ffprobe` executables (via the npm packages
`ffmpeg-static` and `ffprobe-static`) as standalone programs it invokes.
FFmpeg is licensed under the GNU General Public License v3 (some builds
LGPL v2.1+); the exact license text ships with the binary inside the app
package. **Source offer:** the corresponding FFmpeg source is available from
https://ffmpeg.org/download.html, and the exact build configuration from the
`ffmpeg-static` project (https://github.com/eugeneware/ffmpeg-static). The
ClipCraft application itself is not a derivative work of FFmpeg and remains
MIT-licensed.

### Runtime and UI
- **Electron** (MIT) — https://www.electronjs.org — includes **Chromium**
  (BSD-style licenses; full notices ship inside the Electron distribution).
- **React / React-DOM** (MIT) — Meta Platforms, Inc.
- **Vite** (MIT), **electron-builder** (MIT).
- **lucide-react** icons (ISC).
- **onnxruntime-node** (MIT) — Microsoft Corporation.
- **Whisper** (whisper.cpp, MIT): not bundled — the binary and models are
  downloaded on first use, at the user's request, from the official
  whisper.cpp GitHub releases and HuggingFace.
- **Ultra-Light-Fast-Generic-Face-Detector** (MIT, © 2019 linzai) — the
  RFB-320 ONNX model used by auto-reframe's face tracking: not bundled —
  downloaded on first use, at the user's request, from the project's own
  GitHub repository, and verified by size and SHA-256 before use.

### Fonts
The bundled fonts (via Fontsource packages) are licensed under the **SIL
Open Font License 1.1** or **Apache License 2.0**, per family; each font
package in `node_modules/@fontsource*` carries its own license file.

### Dependencies overall
The full dependency set (369 packages) is licensed under permissive terms:
MIT, ISC, BSD (0/2/3-clause), Apache-2.0, OFL-1.1, BlueOak-1.0.0, CC-BY-4.0,
Python-2.0 and WTFPL — plus the GPL-3.0 item covered above (the ffmpeg-static
executable only; no GPL code is linked into the application).

---

If you believe any attribution here is incomplete, please open an issue —
corrections are welcome.
