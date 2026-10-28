# Motion Director: After Effects motion design

Motion Director adds Adobe After Effects to this project, so Claude can make motion design videos with a video editor: transcribe a talking-head clip, study references, write and check a storyboard, build it in After Effects scene by scene as editable layers, review its own work, and render.

It follows a six-step workflow (Hands, Ears, Eyes, Blueprint, Build, Boss) with an approval checkpoint after each step. Unlike setups that need a third-party After Effects plugin and account, everything here runs on the editor's Mac through the same MCP Bridge panel the Premiere tools already use.

## For editors

Send them the one-line installer (below), then `START HERE.md`, which the installer puts in their Motion Studio folder. That is all an editor needs.

## Setup (macOS)

On each editor's Mac, in Terminal:

```bash
curl -fsSL https://raw.githubusercontent.com/bloomxpradeep/videoeditorwith_after-effects-motion/main/scripts/motion/setup-editor-macos.sh | bash
```

or from a clone: `bash scripts/motion/setup-editor-macos.sh` (or `premiere-pro-mcp motion-setup`).

The installer:

1. installs Node.js, git, ffmpeg, yt-dlp and Python with Homebrew (installing Homebrew if needed);
2. clones or updates this repository into `~/.motion-director/app` and builds it;
3. creates `~/.motion-director/venv` with faster-whisper (local Whisper) and OpenCV 4, and downloads the Whisper `small` model;
4. installs the MCP Bridge (CEP) panel for **both** After Effects and Premiere Pro and enables Adobe extension loading;
5. creates `~/Motion Studio` with the `after-effects` and `premiere-pro` connections (`.mcp.json`), the motion-director skill (`.claude/skills/`), permissions (`.claude/settings.json`), `CLAUDE.md`, `START HERE.md`, `projects/` and `motion-director-skill.zip`;
6. checks everything and prints next steps.

Re-running it updates everything and keeps projects and style guides. `--check` only runs the checks. Other options: `--studio PATH`, `--repo URL`, `--branch NAME`, `--whisper-model medium`, `--skip-model`.

Telemetry and the upstream update banner are off. No usage data leaves the machine.

### Requirements

- macOS, Apple Silicon or Intel
- Adobe After Effects 2023 or newer (2024+ for `ae_find_fonts`); Premiere Pro optional
- A Claude plan that includes Claude Code; editors use the Claude app's **Code** tab
- About 3 GB free disk space (Whisper, Python packages)
- Optional: Blender for 3D (`brew install --cask blender`)

## How it works

```text
Claude app (Code tab, Motion Studio folder)
   │  MCP (stdio)
   ├── after-effects  → node dist/index.js  (PREMIERE_MCP_APP=aftereffects)
   │        │ command-*.json / response-*.json in /tmp/ae-mcp-bridge
   │        └── MCP Bridge (CEP) panel inside After Effects → ExtendScript → After Effects
   │        └── local helpers: faster-whisper, OpenCV, ffmpeg, yt-dlp
   └── premiere-pro   → node dist/index.js  (unchanged Premiere server, /tmp/premiere-mcp-bridge)
```

- **One binary, two servers.** `premiere-pro-mcp after-effects` (or `PREMIERE_MCP_APP=aftereffects`) serves the After Effects catalog; the default serves Premiere exactly as before. The Premiere catalog is unchanged (283 tools).
- **One panel, two apps.** The CEP manifest lists `AEFT` beside `PPRO`. The panel detects which app it is running in and watches that app's folder (`/tmp/ae-mcp-bridge` or `/tmp/premiere-mcp-bridge`, overridable with `AE_TEMP_DIR` / `PREMIERE_TEMP_DIR`) with its own settings file, so the two never pick up each other's commands.
- **Bridge host profiles.** `src/bridge/hosts.ts` holds what differs per app: install folder, process name, bridge folder, user-facing messages, and which verify tool to point agents at.
- **The storyboard is the blueprint.** `storyboard.json` (format: `skills/motion-director/references/storyboard-format.md`) is resolved once (`src/motion/storyboard.ts`) into exact timings: per-element entrance, the letter-by-letter reveal keyed to each spoken word from `words.json`, hold, exit. The HTML preview and the After Effects build both read those resolved timings and implement the same presets, so the approved storyboard is what gets built.
- **Rules become checks.** The resolver checks the editor's rules: text only when spoken, never on a no-go zone (face), reserved bottom area, every second covered, beats in order, hold before exit, no abrupt moves, nothing static, palette, font count, collisions, frame bounds. `ae_build_scene` refuses to build a beat with rule errors unless the editor approves an exception.

## Tools

The After Effects server advertises all 40 tools directly (no search step).

**Workflow (`motion_*`)**

| Tool | What it does |
| --- | --- |
| `motion_new_project` | Creates `projects/<name>/` with footage, references, transcript, storyboard, ae, renders and review folders. |
| `motion_probe_media` | Duration, size, frame rate, audio (ffprobe). |
| `motion_transcribe` | Local Whisper (faster-whisper) → `words.json` (per-word times), `.srt`, `.txt`; flags likely misspellings; accepts a vocabulary of names. |
| `motion_fix_transcript` | Spelling corrections across all three files, keeping timings (multi-word names supported). |
| `motion_detect_faces` | OpenCV face tracking → padded no-go zones over time. |
| `motion_extract_frames` | Still frames from footage or references, for Claude to look at. |
| `motion_download_reference` | yt-dlp download of YouTube/Shorts/Vimeo references. |
| `motion_storyboard_template` | Starter `storyboard.json` with footage details. |
| `motion_build_storyboard` | Validates and rule-checks the storyboard; writes `storyboard.html` (cards per beat over the real footage, Play full storyboard with audio, no-go zones, checks). |
| `motion_contact_sheet` | Tiles review frames into one image (ffmpeg). |

**After Effects (`ae_*`)**

| Group | Tools |
| --- | --- |
| Connection & project | `ae_verify_connection` (launches AE, waits for the panel, enables script file access), `ae_get_project_info`, `ae_new_project`, `ae_open_project`, `ae_save_project`, `ae_import_files`, `ae_find_fonts` |
| Storyboard build | `ae_setup_from_storyboard` (comp at output size and fps, uncut locked footage at the bottom, marker per beat, project saved in `ae/`), `ae_build_scene` (one beat as `S01_<kind>_<id>` layers; rebuild replaces) |
| Review & render | `ae_save_frames` (one frame per beat + contact sheet), `ae_render` (render queue or Media Encoder; h264, ProRes, ProRes 4444, PNG sequence) |
| Comps & layers | `ae_create_comp`, `ae_get_comp_info`, `ae_set_comp_settings`, `ae_open_comp`, `ae_add_footage_layer`, `ae_add_text_layer`, `ae_add_shape_layer`, `ae_add_solid_layer`, `ae_set_layer_properties`, `ae_delete_layers` |
| Animation & effects | `ae_set_keyframes`, `ae_set_expression`, `ae_animate_layer` (entrance/exit presets, word-timed letter reveal), `ae_add_micro_motion`, `ae_apply_effect`, `ae_add_markers` |
| Escape hatch | `ae_run_script` (ExtendScript with the helper library, inside an undo group) |

Every After Effects command runs inside one undo group (Cmd+Z undoes a whole tool call) with dialogs suppressed.

### Animation presets

Entrances: `letter-reveal` (text animator, characters appear as their words are spoken), `pixel-letter-reveal` (the same, with a Mosaic that resolves from `pixelSize` blocks to full resolution), `pixel-resolve`, `fade-up`, `fade`, `pop`, `grow-x`. Exits: `fade`, `pixel-out`, `fade-down`. Beat transitions: `cut`, `fade`, `pixel`, `pixel-flash` (an adjustment layer pixelates the whole frame around the cut). Micro-motion (expressions layered over keyframes): `drift`, `breathe`, `sway`, `float`.

## Development

```bash
npm install
npm run build
npm test
```

Tests for this feature:

- `src/__tests__/motion/*`: transcript normalising and corrections, storyboard resolution and every rule check, the HTML page (including script-injection safety), the workflow tools on real files.
- `src/__tests__/aftereffects/scripts.test.ts`: every `ae_*` tool's script parses as ES3, passes the CEP panel's own safety filter, and avoids ES5-only methods ExtendScript lacks.
- `src/__tests__/aftereffects/fake-dom.test.ts`: the scripts run against a fake After Effects DOM (`src/__tests__/helpers/fake-ae.ts`) that enforces After Effects' rules (1-based collections, keyframed properties refusing setValue, ease arrays matching dimensions, locked layers, undo groups closing) and checks what gets built, end to end from storyboard to layers.
- `src/__tests__/bridge/panel-host.test.ts`: the panel watches the right folder in each app.

Test the editor installer without a Mac: `MOTION_SETUP_TEST=1 HOME=/tmp/fakehome bash scripts/motion/setup-editor-macos.sh`.

## Known limits

- **Not yet run inside real After Effects.** The scripts are verified against the fake DOM and by parsing, but the first real run may turn up a property name or behaviour that differs by After Effects version. Run one short video end to end before rolling out to the team, and report the exact error the tool returns.
- **Pixel letter reveal:** characters appear one at a time, but the pixelation is one Mosaic on the whole text layer that resolves as the letters land, not per letter. The HTML preview does the same.
- **Text size estimates** (for the face and collision checks) are approximations from the font size; the preview and review frames are the final word.
- **Face detection** is OpenCV's classic detector: good for talking heads facing the camera, weaker for profiles. Zones can be edited by hand.
- **Fonts** must be installed on the editor's Mac, and After Effects needs PostScript names (`ae_find_fonts`, AE 2024+).
- **`ae_render`** blocks After Effects until the render finishes; use `useMediaEncoder: true` to render in the background.
- **macOS only** for the editor installer. The panel and server support Windows; a Windows installer is a follow-up.
- **`ae_run_script`** runs arbitrary ExtendScript, with the same powers as any After Effects script. The panel blocks a few patterns, but treat it as full access.
