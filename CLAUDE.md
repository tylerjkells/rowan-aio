# Notes for Claude Code sessions

## Release process

When Tyler asks to merge work to main so he can cut a release, merging alone is
not enough — the Release workflow names its draft release after the version in
`package.json`, so an unbumped version silently produces no new release.

Do all of these together:

1. Merge the feature branch into `main`.
2. Bump `"version"` in `package.json` (patch for fixes/prompt tuning, minor for
   features).
3. Add a short user-facing entry for the new version to `NOTES` in
   `src/renderer/src/WhatsNew.tsx` — it's shown once in-app after auto-update,
   and the Release workflow also copies it into the GitHub release body
   (via `scripts/whatsnew-notes.js`) above GitHub's auto-generated notes.
4. Run `npm run typecheck` (install deps first if `node_modules` is missing;
   `ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci` avoids the Electron binary download).
5. Push to `main`.
6. Tell Tyler it's ready — he triggers the release himself: Actions tab →
   Release → Run workflow, then reviews the draft release and publishes it.
   (The GitHub integration available to Claude sessions cannot dispatch
   workflows — it gets a 403 — so don't try to trigger it.)
