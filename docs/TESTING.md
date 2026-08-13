# Testing changes before they ship

The app has three *channels*, each fully isolated from the others:

| Channel  | How it runs                            | Data folder                     | Self-updates | Badge |
| -------- | -------------------------------------- | ------------------------------- | ------------ | ----- |
| `stable` | The installed release                  | `%APPDATA%\meeting-scribe`      | yes          | none  |
| `test`   | `RowanAIO-Test-portable.exe`      | `%APPDATA%\meeting-scribe-test` | never        | TEST  |
| `dev`    | `npm run dev`                          | `%APPDATA%\meeting-scribe-dev`  | never        | DEV   |

A test or dev instance can run at the same time as the installed app and can
never touch the real library. Neither registers itself as a login item, and
neither will ever auto-update itself into (or get replaced by) the release
build. The sidebar badge always tells you which one you're looking at.

## Getting a test build

Every push to a `claude/*` working branch runs the **Test Build** workflow,
which builds the portable test exe on a Windows runner:

1. GitHub → Actions → Test Build → open the run for the branch you want.
2. Download the **RowanAIO-Test** artifact (a zip), unzip it.
3. Run `RowanAIO-Test-portable.exe`. No install, no admin rights.

You can also trigger it by hand (Actions → Test Build → Run workflow → pick
the branch), or build locally on a Windows machine with `npm run dist:test`
(artifact lands in `dist-installer\`).

## Giving the test app realistic data

The test channel starts empty. To rehearse with a copy of your real library,
close both apps, then copy from `%APPDATA%\meeting-scribe` into
`%APPDATA%\meeting-scribe-test`:

- `meetings\` — your library (copy is independent; deleting/editing in the
  test app never touches the original)
- `engine\` — skips the ~550 MB whisper re-download
- `settings.json` — works as-is, including the encrypted API key and
  calendar URL (DPAPI encryption is per-Windows-user, not per-app)

Or restore one of the app's backup zips into the test folder.

## Quirks worth knowing

- **Ctrl+Alt+R** is a global shortcut; whichever instance registered it last
  owns it. Turn the record hotkey off in the test app's Settings if it steals
  the shortcut from the real one.
- Two tray icons look identical; hover for the window, or check the sidebar
  badge.
- The test exe is unsigned (as is the release); SmartScreen may ask once.

## The loop

1. Work happens on a `claude/*` branch; every push produces a fresh test
   build automatically.
2. Download, run, poke at the feature with real(istic) data.
3. Found problems → more commits on the branch → new artifact.
4. Happy → merge to main and cut a release (see CLAUDE.md for the release
   checklist). The installed app updates itself as usual.
