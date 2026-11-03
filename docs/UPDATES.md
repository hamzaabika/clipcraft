# ClipCraft updates — how a release reaches users

ClipCraft never checks in the background. In **About**, the user clicks
**Check for updates**; the app fetches one small JSON file from the ClipCraft site and,
if it names a newer version, shows the release notes with a **Download & install** button.
The installer downloads inside the app (with progress); when it finishes, **Install &
restart** installs it and reopens ClipCraft in the new version. The install itself is done
by the system: on Linux the package manager applies the .deb after the standard password
prompt (pkexec), on Windows the installer runs silently, and on macOS the downloaded .dmg
is opened for the normal manual install. A dismissed password prompt or a failed install
is reported in the card, with **Open installer** as the fallback. Projects, recents and
settings live in the app's userData folder, which an install never touches.

A failed check is reported as an error with its reason — "You're up to date" appears only
after a successful check whose latest version is not newer than the installed one.

## The feed

- URL the app reads: `https://clipcrafts.pages.dev/version.json`
  (override for testing with the `CLIPCRAFT_UPDATE_URL` environment variable)
- Format: see `version.sample.json` next to this file.
  - `version` — required, `MAJOR.MINOR.PATCH` (a `-beta.1` suffix sorts before its release)
  - `download_url` — the installer link. Only links on `clipcrafts.pages.dev`,
    `hamzaabika.com` or `github.com` are accepted; anything else is replaced by the site
    root, so a compromised feed cannot send the app to an arbitrary host.
  - `notes_url`, `notes`, `release_date`, `size` — optional, shown in the dialog.

## Publishing an update

1. Bump `version` in `package.json`; the release is built by GitHub Actions from the
   `release/vX.Y.Z` branch.
2. Publish the GitHub release with the installers (.deb / .exe / .dmg).
3. Update `version.json` on the ClipCraft site (new version + installer URL).
4. Users who click **Check for updates** now see the new version, its notes, and the
   in-app download.

Verified by `scripts/test-updates.mjs` (version ordering, feed states, link gating,
in-app download, one-click install command + downloaded-path validation).
