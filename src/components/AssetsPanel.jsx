import React from 'react';
import { PackageOpen } from 'lucide-react';

// Assets tab — placeholder (Hamza, 2026-11-02). The downloadable content pack
// is not part of the public release, so instead of the pack library and its
// download offers, the tab shows a simple "Coming soon" until a library ships.
// The folder-backed library implementation (useAssets / assetsLib) is kept in
// the codebase and still powers the pack's audio views; restoring this tab is
// a render change only.
export default function AssetsTab() {
  return (
    <div className="pad-block assets-tab">
      <div className="lib-head">
        <div>
          <h2>Assets</h2>
        </div>
      </div>
      <div className="assets-empty" style={{ textAlign: 'center', paddingTop: 48 }}>
        <PackageOpen size={40} strokeWidth={1.5} style={{ opacity: 0.55 }} />
        <p style={{ marginTop: 12 }}><b>Coming soon</b></p>
        <p className="muted">A built-in library of transitions, overlays, characters and icons is on its way.</p>
      </div>
    </div>
  );
}
