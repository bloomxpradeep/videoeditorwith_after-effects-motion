# storyboard.json format

One file is the blueprint for both the HTML storyboard the editor approves and the After Effects build. Positions are **fractions of the frame** (0 to 1, from the top-left), so the same numbers drive a preview card and a 1920×1080 comp. Times are **seconds on the source footage**. Paths are relative to the storyboard file.

Run `motion_build_storyboard` after every edit: it validates the file, checks the rules, and rewrites `storyboard.html`.

## Top level

| Field | Meaning |
| --- | --- |
| `version` | Always `1`. |
| `title` | Video title. The After Effects comp is named `<title> MAIN`. |
| `footage` | `{ "path": "../footage/interview.mp4", "duration": 48.2, "width": 1920, "height": 1080, "fps": 30 }`. Duration matters: beats must cover all of it. |
| `output` | Comp and render settings, default `{ "width": 1920, "height": 1080, "fps": 60 }`. |
| `transcript` | `"../transcript/words.json"`. Without it, text cannot be synced to speech. |
| `style` | See below. |
| `rules` | The editor's rules in plain English, shown on the storyboard page. |
| `noGoZones` | Areas text must avoid: `{ "label": "face", "start": 0, "end": 48.2, "x": 0.36, "y": 0.08, "w": 0.28, "h": 0.6 }`. `start`/`end` optional (whole video). From `motion_detect_faces`. |
| `beats` | The scenes, in order. |

## style

| Field | Default | Meaning |
| --- | --- | --- |
| `palette` | `[]` | Hex colours. Text colours outside it are flagged. |
| `fonts` | `{}` | Named fonts: `{ "primary": { "family": "Inter", "postscript": "Inter-Bold", "weight": 700 }, "accent": { "family": "Instrument Serif", "postscript": "InstrumentSerif-Italic", "style": "italic" } }`. `family` drives the preview; `postscript` is what After Effects uses (get it from `ae_find_fonts`). |
| `pixelSize` | `12` | Pixel block size (at 1080p) for pixel effects. Smaller = finer pixels. |
| `textAnimation` | `pixel-letter-reveal` | Default entrance for text. |
| `exitAnimation` | `fade` | Default exit when a beat has no `transitionOut`. |
| `microMotion` | `drift` | Default continuous motion. |
| `minHold` | `0.5` | Seconds an element must sit landed before it exits. |
| `maxFonts` | `2` | Font limit. |
| `reservedBottom` | `0` | Fraction of the frame bottom kept clear, e.g. `0.2` for captions. |
| `textOnlyWhenSpoken` | `true` | Text that is never spoken in its beat is an error. |
| `background` | none | Comp background colour. |

## beats[]

| Field | Meaning |
| --- | --- |
| `id` | `S01`, `S02`… Layers are named `S01_<kind>_<element id>`. |
| `name` | Short label, used in the marker (`S01 name card`). |
| `start`, `end` | Seconds. Beats must not overlap; gaps are flagged. |
| `say` | Optional: what is spoken, for reference. |
| `elements` | What appears (below). Elements listed later sit on top. |
| `transitionOut` | `{ "type": "cut" \| "fade" \| "pixel" \| "pixel-flash", "duration": 0.4 }`. Sets every element's exit; `pixel-flash` also pixelates the whole frame for a moment at the cut. |
| `notes` | Anything the editor should know (shown on the card). |

## elements[]

Common fields:

| Field | Meaning |
| --- | --- |
| `id` | Letters, digits, `_`, `-`. |
| `kind` | `text`, `shape` or `media`. |
| `x`, `y` | Centre of the element as a fraction of the frame (for `align: "left"` text, `x` is the left edge). |
| `animIn` | `letter-reveal`, `pixel-letter-reveal`, `pixel-resolve`, `fade-up`, `fade`, `pop`, `grow-x`, `none`. |
| `animInDuration` | Seconds (defaults per preset; under 0.25s is flagged as abrupt). |
| `animOut` | `fade`, `pixel-out`, `fade-down`, `none`. |
| `animOutDuration` | Seconds. |
| `microMotion` | `drift` (slow wander), `breathe` (tiny scale pulse), `sway` (slight rotation), `float` (soft wiggle), `none` (flagged: nothing static). |
| `appearAt` | Absolute appear time, for elements not synced to speech. |
| `until` | Absolute time the element is gone (default: its beat's end). |

Text:

| Field | Meaning |
| --- | --- |
| `text` | Screen text. `\n` for a new line. |
| `font` | A key in `style.fonts`, or a PostScript name. |
| `size` | Font size in pixels at the output resolution. |
| `color`, `strokeColor`, `strokeWidth`, `tracking`, `align`, `allCaps` | As in After Effects. |
| `role` | `hero`, `support` or `label` (default sizes 110 / 64 / 36). |
| `sync` | Default `true`: appear word by word as the words are spoken. |
| `syncPhrase` | The spoken words to sync to when they differ from the screen text. |

Shape: `shape` (`rectangle`, `ellipse`, `underline`), `width` and `height` (fractions of frame width and height), `fill`, `strokeColor`, `strokeWidth`, `roundness`. `grow-x` grows it from its left edge.

Media: `src` (image, video, or the first frame of a PNG sequence), `sequence: true` for sequences such as a Blender render, `width` (fraction of frame width).

## Example beat

```json
{
  "id": "S04",
  "name": "the number",
  "start": 9.8,
  "end": 13.2,
  "elements": [
    { "id": "number", "kind": "text", "text": "$1M", "syncPhrase": "a million dollars", "font": "primary", "size": 160, "color": "#3DDC84", "x": 0.78, "y": 0.42, "role": "hero" },
    { "id": "label", "kind": "text", "text": "in year one", "font": "accent", "size": 56, "color": "#F5F5F0", "x": 0.78, "y": 0.56, "animIn": "fade-up" },
    { "id": "bar", "kind": "shape", "shape": "underline", "width": 0.14, "x": 0.78, "y": 0.62, "fill": "#3DDC84", "animIn": "grow-x" }
  ],
  "transitionOut": { "type": "pixel", "duration": 0.4 },
  "notes": "Hero number lands on 'million'."
}
```

## What the checks mean

| Check | Level | Fix |
| --- | --- | --- |
| spoken | error | The text isn't said in its beat. Change the text, use `syncPhrase`, move the element to the right beat, or (if the editor agrees) `sync: false` + `appearAt`. |
| no-go | error | Move the element beside the zone. |
| reserved-bottom | error | Move it up. |
| beats | error/warning | Overlapping beats (error) or elements running outside their beat. |
| content | error | A text element without text, or media without `src`. |
| hold | warning | Lengthen the beat, shorten the entrance or exit, or start the element earlier. |
| abrupt | warning | Lengthen the animation. |
| static | warning | Give it micro-motion. |
| coverage | warning | Extend beats so every second is covered. |
| fonts / palette | warning | Stick to the style. |
| overlap / frame | warning | Text colliding with text, or running off the frame. Estimates only; check the preview. |
