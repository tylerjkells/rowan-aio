# Notes for Claude Code sessions

## Test builds before merging

Feature work is tested before it reaches main. Every push to a `claude/*`
branch triggers the Test Build workflow, which produces a portable test exe
as a workflow artifact (isolated data folder, no self-update, TEST badge —
see docs/TESTING.md). After pushing a feature, tell Tyler a test build is
ready in the Actions tab so he can try it; only merge to main once he's
happy with it.

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
6. Dispatch the Release workflow on `main` with the GitHub Actions tool
   (`actions_run_trigger`, `workflow_id: release.yml`). When Tyler has asked
   for the release to go out, pass the input `publish: true`: the release is
   created already published and marked Latest, so the in-app updater picks
   it up. Without that input it lands as a draft for him to review and
   publish from the Releases page. Watch the run with `actions_list` and
   report the outcome; a red run is yours to fix.
   (An older note here said dispatching got a 403; that is no longer true.)
