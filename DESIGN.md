---
# gstack: design-md-format=spec
name: skywave
colors:
  enamel: "#13303a"
  enamel-deep: "#0b1e24"
  enamel-raised: "#1b3f4a"
  rule: "#2b5560"
  glass: "#d4e6d8"
  glass-shade: "#b9d3c2"
  ink: "#1b2a2f"
  needle: "#c8322b"
  brass: "#c19a4b"
  brass-dim: "#8a6c33"
  text: "#e6eee8"
  muted: "#9db8b0"
  ham: "#2f6f6a"
  lamp: "#f2c55c"
  danger: "#f08a7e"
  brass-bright: "#d3ad5e"
  brass-ink: "#6b5226"
  meter-mid: "#6fb29e"
  wf-0: "{colors.enamel-deep}"
  wf-1: "#1b545c"
  wf-2: "#70b29e"
  wf-3: "#e8d27a"
  wf-4: "#fff8de"
  map-sea: "{colors.enamel-deep}"
  map-land: "{colors.enamel-raised}"
  map-rule: "{colors.rule}"
  map-night: "rgba(0, 0, 0, 0.31)"
  map-twilight: "rgba(0, 0, 0, 0.2)"
  map-dot: "{colors.glass}"
  map-playing: "{colors.lamp}"
  map-last: "rgba(212, 230, 216, 0.45)"
typography:
  body:
    fontFamily: "Atkinson Hyperlegible"
    fontSize: "16px"
    fontWeight: 400
    lineHeight: 1.5
  body-bold:
    fontFamily: "Atkinson Hyperlegible"
    fontSize: "16px"
    fontWeight: 700
    lineHeight: 1.5
  meta:
    fontFamily: "Atkinson Hyperlegible"
    fontSize: "0.85rem"
    fontWeight: 400
  wordmark:
    fontFamily: "Barlow Condensed"
    fontSize: "2.6rem"
    fontWeight: 600
    lineHeight: 1
    letterSpacing: "0.01em"
  readout:
    fontFamily: "Barlow Condensed"
    fontSize: "3rem"
    fontWeight: 600
    lineHeight: 1
  section-heading:
    fontFamily: "Barlow Condensed"
    fontSize: "1.6rem"
    fontWeight: 600
  sub-heading:
    fontFamily: "Barlow Condensed"
    fontSize: "1.15rem"
    fontWeight: 600
  instrument-label:
    fontFamily: "Barlow Condensed"
    fontSize: "1.1rem"
    fontWeight: 600
  dial-number:
    fontFamily: "Barlow Condensed"
    fontSize: "15px"
    fontWeight: 500
  dial-number-major:
    fontFamily: "Barlow Condensed"
    fontSize: "22px"
    fontWeight: 600
rounded:
  knob: "999px"
  panel: "6px"
  dial: "10px"
  inset: "4px"
  round: "50%"
spacing:
  s2: "2px"
  s4: "4px"
  s6: "6px"
  s8: "8px"
  s10: "10px"
  s12: "12px"
  s14: "14px"
  s16: "16px"
  s20: "20px"
  s24: "24px"
  touch-target: "44px"
  console-max-width: "1120px"
  map-height: "360px"
components:
  power:
    backgroundColor: "{colors.brass}"
    textColor: "{colors.ink}"
    rounded: "{rounded.knob}"
    padding: "9px 20px"
  power-on:
    backgroundColor: "transparent"
    textColor: "{colors.brass}"
    rounded: "{rounded.knob}"
  pick-best:
    backgroundColor: "transparent"
    textColor: "{colors.brass}"
    rounded: "{rounded.knob}"
    padding: "7px 16px"
  presets-save:
    backgroundColor: "transparent"
    textColor: "{colors.brass}"
    rounded: "{rounded.knob}"
    padding: "7px 16px"
  link-button:
    textColor: "{colors.lamp}"
    fontSize: "0.92rem"
  map-listen:
    backgroundColor: "{colors.lamp}"
    textColor: "{colors.ink}"
    rounded: "{rounded.knob}"
    height: "36px"
  map-overlay:
    backgroundColor: "rgba(11, 30, 36, 0.82)"
    textColor: "{colors.text}"
  map-card:
    backgroundColor: "{colors.enamel}"
    rounded: "{rounded.panel}"
    width: "280px"
  controls-panel:
    backgroundColor: "{colors.enamel-raised}"
    rounded: "{rounded.panel}"
    padding: "16px 20px"
  mode-checked:
    backgroundColor: "{colors.glass}"
    textColor: "{colors.ink}"
---

# skywave

This file records the design system that already exists in `apps/web/src/app/globals.css` and the components that use it. All tokens are in `:root` at the top of that file, and the two fonts are loaded from Google Fonts in `apps/web/src/app/layout.tsx`. Nothing here is aspirational: where the code is inconsistent, the relevant section says what the code does and lists the gap under **Known gaps**. When the code changes, update this file.

## Overview

skywave plays public KiwiSDR receivers in the browser. You tune shortwave broadcasters and ham bands, watch the signal on a waterfall, and pick a receiver from a list or a greyline map (README). It's a personal tool (the map design record calls it builder mode) for a listener who wants sound quickly.

The page is drawn as a radio console. The page is enamel teal (`--enamel`), and the "one loud thing on the page" (globals.css comment) is a celadon glass dial (`--glass` → `--glass-shade`) with a red needle (`--needle`). Primary controls are brass (`--brass`). Live state, links, focus and the tuned frequency light up amber like a pilot lamp (`--lamp`). Instrument text (wordmark, readouts, headings, dial numerals) uses a condensed face, Barlow Condensed. Running text uses Atkinson Hyperlegible. `color-scheme: dark` is set, and there is no light theme.

Page order (`page.tsx`): header (wordmark, receiver form, Listen/Stop) → dial → controls (readout, modes, S-meter, volume) → status row (with Back, and Pick best on errors) → waterfall → strong signals now → presets → Receivers section (help sentence, Pick best bar, map, folded table). The instrument and its live output come first, so turning the dial and watching the waterfall happen in one view; choosing a receiver comes after. Visually hidden `h2`s "Tuner" (before the dial) and "Waterfall" let screen readers reach the instrument by heading.

## Colors

| Token             | Value                                           | Role in code                                                                                                                                                                                                                |
| ----------------- | ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--enamel`        | #13303a                                         | Page background (`html, body`); floating surfaces on the map: `.map-card`, `.map-tooltip`, MapLibre control groups                                                                                                          |
| `--enamel-deep`   | #0b1e24                                         | Wells: text inputs, `.waterfall-screen`, `.smeter-track`, `.map-frame`, the focused readout, the dial's 6px bezel ring                                                                                                      |
| `--enamel-raised` | #1b3f4a                                         | Panels: `.controls`, `.receivers-table-wrap`, sticky table headers                                                                                                                                                          |
| `--rule`          | #2b5560                                         | 1px borders and dividers (inputs, mode segments, presets list, map card, `.map-center`), idle status lamp, readout hover border                                                                                             |
| `--glass`         | #d4e6d8                                         | Dial face top; headings (wordmark, `h2`, summary, map heading); checked mode segment; map dots                                                                                                                              |
| `--glass-shade`   | #b9d3c2                                         | Dial face gradient bottom                                                                                                                                                                                                   |
| `--ink`           | #1b2a2f                                         | Text on light surfaces: dial ticks/numerals, the checked mode, `.power`, `.map-listen`                                                                                                                                      |
| `--needle`        | #c8322b                                         | Dial needle line and cap; ring round the listening dot on the map                                                                                                                                                           |
| `--brass`         | #c19a4b                                         | Power button fill; outline buttons (Pick best, preset Save); `accent-color` for checkboxes and the volume slider                                                                                                            |
| `--brass-dim`     | #8a6c33                                         | Broadcast band bars on the dial (opacity 0.8)                                                                                                                                                                               |
| `--text`          | #e6eee8                                         | Default text; hover color for links and table headers                                                                                                                                                                       |
| `--muted`         | #9db8b0                                         | Labels, help and meta text, units, scales, legend, idle mode segments                                                                                                                                                       |
| `--ham`           | #2f6f6a                                         | Ham band bars and labels on the dial; the low end of the S-meter gradient                                                                                                                                                   |
| `--lamp`          | #f2c55c                                         | Links and `.link-button`; focus outlines; readout digits; listening status lamp (with glow); the tuned receiver and preset; map listening dot and labels; the Listen button on the map card                                 |
| `--danger`        | #f08a7e                                         | Error status lamp; a status message with `data-tone="danger"` (a service error, or a Pick best run that ended with nothing playing); "Receiver overloaded"; preset delete hover; a list older than 30 min in the map legend |
| `--brass-bright`  | #d3ad5e                                         | Listen (`.power`) under the pointer; the map card's Listen under the pointer                                                                                                                                                |
| `--brass-ink`     | #6b5226                                         | Broadcast band labels on the dial glass                                                                                                                                                                                     |
| `--meter-mid`     | #6fb29e                                         | The S-meter gradient's midpoint                                                                                                                                                                                             |
| `--wf-0`…`--wf-4` | enamel-deep, #1b545c, #70b29e, #e8d27a, #fff8de | The waterfall colormap, low to high. `Waterfall.tsx` reads them on mount (`resolveStops`) and keeps the same values as `FALLBACK_STOPS`                                                                                     |

**Map tokens.** `--map-sea`, `--map-land`, `--map-rule`, `--map-dot` and `--map-playing` are aliases (`var(--enamel-deep)`, `var(--enamel-raised)`, `var(--rule)`, `var(--glass)`, `var(--lamp)`). `--map-night` (0.31) and `--map-twilight` (0.2) are black overlays that together make about 0.45 (CSS comment). `--map-last` is glass at 45% alpha. `receiver-map-style.ts` reads them with `getComputedStyle` (`TOKEN_VARS`), and reads `--needle` and `--lamp` directly for the listening ring and the dot labels. Its `FALLBACK_TOKENS` copy the same values for tests or an unreadable stylesheet.

**Alpha tints used inline** (no token): brass 12% for outline-button hover `rgba(193,154,75,0.12)` (Pick best, presets Save); lamp 35% for text selection `rgba(242,197,92,0.35)`; glass 8% for table-row hover and the waterfall passband; glass 45% for passband edges; enamel-deep 82–85% for `.map-overlay` and `.map-chip`; needle 85% dashed for the waterfall center line; danger 10% for preset delete hover; lamp 32% radial glow at the bottom of the dial.

**Browser surfaces.** Text selection is lamp at 35% with `--text` (`--ink` on the dial glass), inputs use a `--lamp` caret, and the page, the dial strip and the receiver table's scroll box use `scrollbar-color: var(--rule) var(--enamel-deep)` (browsers that ignore `scrollbar-color` keep their own).

**Known gaps**

- `--map-last` restates glass as a literal rgba instead of deriving it from `--glass`. `receiver-map-style.ts` reads the token's text and hands it to MapLibre, which can't parse a `color-mix()` or relative color, so a derived value would break the map.

## Typography

Two faces, loaded in `layout.tsx` with `display=swap`:

- **Atkinson Hyperlegible** (`--font-ui`, fallback `system-ui, sans-serif`), weights 400 and 700. Used for body text, form fields, buttons, status, table cells, help and meta text. Base size 16px with line-height 1.5 on `html, body`. Weight 700 goes on buttons (`.power`, `.pick-best`, presets Save, `.map-listen`) and `.status-state`.
- **Barlow Condensed** (`--font-instrument`, fallback `"Arial Narrow", sans-serif`), weights 500 and 600. Used for the instrument face: wordmark (2.6rem/1, 0.01em), frequency readout (3rem/1, tabular numerals; 2.6rem at ≤860px), section `h2` (1.6rem), the "All receivers" summary and map heading (1.15rem), mode segments (1.1rem), S-meter reading (1.5rem), preset frequency (1.2rem, tabular), map card names (1.05rem), readout unit (1.3rem), dial numerals (15px/500, majors 22px/600), dial band labels (12px/600), S-meter scale (0.8rem) and waterfall axis (0.9rem). Barlow headings use weight 600 and color `--glass`. Every Barlow use names a loaded weight: `.readout-unit`, `.preset-mode`, `.smeter-scale` and `.waterfall-axis` use 500.

Sizes in use for UI text: 1rem (the receiver list's state line, which "reads at body size", and the table), 0.95rem (status, waterfall empty text), 0.92rem (receiver help, checkboxes, `.link-button`), 0.85rem (field labels, meta, legend, map notes, receiver host; the most common small size), 0.8rem (S-meter overload, waterfall unit). The dial's row labels ("Broadcast", "Amateur") are Atkinson 11px italic.

Numbers that change in place use `font-variant-numeric: tabular-nums` (readout, preset frequency, table `.num` cells).

Map dot labels are not Barlow. MapLibre draws them in Noto Sans Bold 12px uppercase, because "the page's Barlow isn't available as map glyphs" (`receiver-map-style.ts`).

**Known gaps**

- Near-duplicate small sizes: 0.92rem and 0.95rem sit side by side with 0.85rem and 1rem.
- The map design record says map labels are Barlow Condensed and the legend is 13px. The code uses Noto Sans Bold and 0.85rem.

## Layout

- **Page frame:** `.console` is a single-column grid, `max-width: 1120px`, centered, padding `24px 16px 64px`, `gap: 20px`. The header is a wrapping flex row (wordmark left, receiver form right, aligned to the bottom, gap 16px).
- **Controls:** `.controls` is a 4-column grid `auto auto minmax(220px,1fr) minmax(140px,200px)` (readout, modes, S-meter, volume), gap `16px 28px`, padding `16px 20px`.
- **Spacing:** no spacing tokens exist. Gaps and paddings are literal px values. The common ones are 10, 4, 6, 16, 8, 20, 14 and 12px (in order of use), with 2px for tight label stacks. The front matter `spacing` group lists these values, named by size.
- **Dial width:** `.dial-glass` has `min-width: 860px` inside `.dial-scroll` (`overflow-x: auto`), so below that width the dial scrolls sideways and `Dial.tsx` scrolls to keep the needle in view.
- **Scroll regions:** the receiver table scrolls on its own (`max-height: min(60vh, 520px)`) "so the dial stays near the top of the page", with sticky headers and `scroll-padding-top: 2.5rem`.
- **Map height:** `--map-height` is 360px, 300px at ≤860px and 220px at ≤520px. `.map-frame` reserves `min-height: var(--map-height)` from the first render "so nothing jumps when the map arrives". `.map-header` is held at `min-height: 44px` so the Center button appearing doesn't push the map down.
- **Breakpoint 860px:** `--map-height: 300px`; controls go to two columns, with the readout and modes spanning both; readout 2.6rem.
- **Breakpoint 520px:** controls go to one column (padding 14px); the host field goes full width; the table's Location column is hidden; table-wrap padding drops to 12px; the open waterfall canvas drops from 240px to 180px; `--map-height: 220px`; the map card docks under the map (`position: relative`, `max-height: 240px`, top border only, no radius). Receiver rows clamp the name to 2 lines, hide host · antenna and show the place (`.receiver-place`, one line with an ellipsis) instead. Strong signals shows its first 8 rows (`PHONE_ROWS` in `SignalList.tsx`, which marks later rows `data-beyond` for the CSS to hide) and a **Show all N** link-button (`.signals-more`, phones only).
- **Touch targets at ≤520px:** `.pick-best`, `.link-button` and table header buttons get `min-height: 44px`, and the summary gets `padding-block: 10px`. An inline link inside a sentence (`.link-button.inline`) keeps the line's height. It uses `min-height: 0; padding-block: 10px; margin-block: -10px`, so the hit area grows while the line box stays put.
- **Coarse pointer:** `@media (max-width: 520px), (pointer: coarse)` sets `.map-listen`, `.map-card-close` and the MapLibre control buttons to at least 44×44px ("Fingers, at any width"), and gives `.power`, the presets Save button and `.receiver-choose` `min-height: 44px`, the mode segments 10px vertical padding, and `.preset-delete` a 44px hit area (a `::before` 6px outside its 32px ✕). `.map-center` is 44px tall at all sizes.
- **Pointer-specific hints:** the dial hint and the waterfall caption hold two sentences: `.hint-fine` (mouse and keyboard) and `.hint-coarse` (touch, `aria-hidden`). Under `(pointer: coarse)` the touch one shows and the fine one is only visually hidden, so screen readers always get the keyboard sentence.

## Elevation & Depth

Depth comes from three enamel tones, not shadows:

- `--enamel-deep`: recessed wells (inputs, waterfall, S-meter track, map frame, focused readout).
- `--enamel`: the page, plus surfaces that float over the map (card, tooltip, MapLibre controls), which sit on the deep map.
- `--enamel-raised`: panels on the page (`.controls`, `.receivers-table-wrap`).

Stacking on the map: `.map-tooltip` and `.map-card` sit at `z-index: 3`, "above MapLibre's controls (z-index 2)". The sticky table header is at `z-index: 1`. `.map-overlay` is a translucent enamel-deep scrim (0.82) with no blur. No `backdrop-filter` is used anywhere.

The only real glass effect is the dial (`.dial-glass`):

- A vertical gradient from glass to glass-shade.
- A lamp-amber radial glow from below (`rgba(242,197,92,0.32)`).
- An inner 1px ink edge at 35% and an inner white highlight (`inset 0 8px 18px rgba(255,255,255,0.35)`).
- A 6px `--enamel-deep` ring that reads as a bezel (`0 0 0 6px`).

Other shadows:

- The listening status lamp glows (`box-shadow: 0 0 8px var(--lamp)`).
- Table headers use `inset 0 -1px 0 var(--rule)` as a bottom border that moves with the sticky cell.

## Shapes

- `--radius-knob: 999px` makes pills: `.power`, `.pick-best`, presets Save, `.map-center`, `.map-listen`, `.map-chip`. The mode group is a segmented pill: the first and last segments take the knob radius on their outer side, and segments overlap with `margin-left: -1px`.
- `--radius-panel: 6px` is for panels and fields: inputs, `.controls`, `.receivers-table-wrap`, `.waterfall-screen`, `.map-frame`, `.map-card`, `.map-tooltip`.
- The dial is a wide rounded rectangle (`--radius-dial: 10px`, SVG viewBox 1000×160) with band bars as small rects (`rx` 1.5).
- Circles (`50%`): the 9px status lamp and the preset delete button. The needle has a 3.5px circular cap.
- `--radius-inset: 4px`: the readout input and the S-meter track.

## Components

- **Dial** (`Dial.tsx`, `.dial`, `.dial-glass`): an SVG `role="slider"`.
  - Broadcast bands (`.dial-band-broadcast`, `--brass-dim`) sit above the MHz scale, and ham bands (`.dial-band-ham`, `--ham`) sit below it.
  - Ticks and baseline are `--ink`, and numerals are 0–30 MHz in Barlow. The needle is a 2.5px `--needle` line with a cap.
  - `cursor: ew-resize`, `touch-action: pan-y`. The focus outline is 2px lamp at offset 8px. The hint text below is `.dial-hint` (0.85rem muted), with a touch sentence "Drag the dial or tap a band to tune." on coarse pointers.
  - A mouse or pen tunes on press and drag. A finger waits: it tunes once it has moved 8px sideways (more than up or down), or on a tap when it lifts; a page scroll that starts on the dial (`pointercancel`) tunes nothing. On a phone, a touch drag that ends within 40px of the strip's edge scrolls the strip to center the needle, so repeated drags reach the whole 0–30 MHz.
- **Frequency readout** (`FrequencyReadout.tsx`, `.readout-input`): a transparent input with lamp digits in Barlow 600, 3rem, right-aligned, 9.4ch wide (fits "29,999.99" with its padding).
  - It reads kHz (commas or spaces only as thousands separators, so "1,5" is rejected rather than read as 15), optionally with a unit (`kHz`/`k`, `MHz`, or `M` with a decimal point, since "20m" reads as a band name), 10–30,000 kHz. Anything else stays in the box with `aria-invalid` and a muted 0.85rem `.readout-error` line, "Enter 10 to 30,000 kHz", tied by `aria-describedby`; Escape restores the current frequency. The message's line is held even when empty (`min-height: 1lh`), so it never moves the page.
  - Hover shows a `--rule` border.
  - Focus drops the outline and uses a lamp border on an `--enamel-deep` fill.
  - `.readout-unit` "kHz" is muted Barlow.
- **Mode buttons** (`.modes` fieldset, `.mode` labels with hidden radios): segments in Barlow 600 1.1rem, muted on a `--rule` border. The checked segment is a `--glass` fill with `--ink` text, and keyboard focus draws the lamp outline on the visible span.
- **S-meter** (`SMeter.tsx`, `.smeter`): the reading is Barlow 1.5rem with dBm in 0.85rem muted. "Receiver overloaded" is `--danger`.
  - The track is 8px `--enamel-deep`. The fill is a `--ham` → `--meter-mid` → `--lamp` gradient scaled with `transform: scaleX` and a 180ms linear transition.
  - A 1px S9 marker sits on the track, with a Barlow scale (1–9, +20, +40) below.
- **Volume** (`.volume`): a native range input with `accent-color: var(--brass)`.
- **Status line** (`.status`, `role="status"`, `data-state`): a 9px lamp, bold state text, muted detail, and a message on its own line (max 75ch).
  - The lamp is `--rule` when idle, `--lamp` with a glow when listening, `--lamp` at 0.5 opacity when connecting, and `--danger` on error. The message turns `--danger` when `data-tone="danger"`.
  - While listening, the detail reads "from <place> · <host>" with the place (`.status-place`) in `--text`, when the list has a location for the receiver; otherwise "on <host>".
  - The message is the newest of three: Pick best's note, the service's message, or the page's own (a blank Listen or the error link before the list has loaded). While a Pick best run is going, its note beats that run's refusals.
- **Pick best on errors** (`.link-button.status-pick`): beside Back in `.status-row`, outside the live region, only while the status is a receiver's own error (one naming a host; not a down service or blocked audio) and Pick best is settled (no run, no watch). Before the list loads it says to press Pick best receiver again, since Listen would redial the receiver that just failed. Pick best, from any button, leaves out receivers that refused in the last 15 minutes (the list's copy of them can be that old; playing again clears it, and only full, no-apps and password answers count); when that leaves nothing it says so instead of "No listed receiver covers this frequency". The service's own uncoded errors show no link. Once a run starts the link goes away and focus moves to the status row (`tabIndex=-1`); "Show all N" likewise moves focus to the first row it reveals.
- **Back button** (`.link-button.status-back`): sits in `.status-row` outside the live region. It's left-aligned with `overflow-wrap: anywhere`, because receiver names run long and "a wrapped button label would center".
- **Power** (`.power` / `.power-on`): Listen is a filled brass pill with ink text, weight 700, min-width 7em. Stop is the brass outline version.
- **Pick best** (`.pick-best`): a brass outline pill (7px 16px, weight 700) with a brass 12% hover. Disabled is opacity 0.45. While a run is going, the same class becomes "Stop picking". Its line (`.receivers-note`, 1rem muted, `role="status"`) gives the list's state (loading, failed with Try again, stale) or the fixed description; Pick best's run notes go to the status line.
- **Link button** (`.link-button`): text styled as a lamp link, 0.92rem, underlined with `text-underline-offset: 3px`. Hover changes it to `--text` with a 2px underline. `.inline` drops the padding and inherits the font size for use inside sentences. Disabled or `aria-disabled="true"` drops to opacity 0.45 with `cursor: default` and no hover change.
- **Receiver table** (`ReceiverPicker.tsx`, inside `details.receivers-browse`): the summary is a Barlow 1.15rem glass heading. The wrap is an `--enamel-raised` panel.
  - The sort note ("Best first", or a **Sort by best** link-button once sorted) is the table's `caption` (`.receivers-sort`, 0.85rem muted), above the headers rather than among the filters.
  - Sticky header buttons are 0.85rem muted, with ↕/▲/▼ glyphs shown through `content: … / ""` so screen readers stay on `aria-sort`.
  - Rows have a 50% `--rule` divider and a glass 8% hover, and the name underlines on hover.
  - The tuned row's name and its ● or ○ mark (`.receiver-tuned`) are `--lamp`. Night cells read `--glass`, day cells `--muted`, and the listener count of a full receiver is muted.
- **Map panel** (`MapPanel.tsx`, `.map-panel`):
  - The heading is "Receiver map · N kHz" (Barlow 1.15rem glass), with a `.map-center` pill (rule border, glass text, 44px).
  - `.map-frame` is a deep, rounded, overflow-hidden frame. The canvas fades in over 200ms.
  - Overlay states, all centered inside the frame at `--map-height`:
    - `.map-shell` "Map loads in a few seconds" (muted).
    - `.map-overlay` scrims for "Map unavailable: …" (Retry map · Browse receivers as inline link buttons), "Receiver list unavailable" (Retry receiver list) and "No receivers to show".
    - `.map-chip` (top-left pill) for a playing receiver with no location.
  - Below the frame are `.map-legend`, with glyph keys (`.key-night` glass, `.key-listening` lamp, `.key-full`/`.key-last` muted) and times that turn `--danger` past 30 min, and `.map-note`.
- **Map card** (`ReceiverMap.tsx`, `.map-card`, `role="dialog"`): an enamel card, 280px, rule border, panel radius. It's clamped inside the map through `--card-x`, with `max-height: calc(var(--map-height) - 16px)`.
  - Items have a Barlow name, a muted host, `.map-card-fields`, and `.map-listen` (a filled lamp pill with ink text, 36px tall, 44px on touch).
  - A 36px ✕ closes it. "Zoom into this area" is a `.link-button`.
  - `.map-tooltip` is the read-only hover label.
- **Map dots** (`receiver-map-style.ts`): radius 4 (6 when tuned, 9 during the 600ms emphasis).
  - Listening is a `--map-playing` fill with a 1.5px `--needle` ring. Connecting and full receivers are rings with no fill. Last is a `--map-last` ring.
  - Opacity is 1 when tuned, 0.2 out of range, 1 at night and 0.55 by day.
  - Coastlines and borders are 0.5px `--map-rule`.
- **Waterfall** (`Waterfall.tsx`, `.waterfall`): a 240px canvas (180px at ≤520px) in a deep, rounded screen; only a live waterfall (`[data-active]`) takes clicks, shows `cursor: crosshair` and the "Click a signal" title. It has a glass-tinted passband strip, a dashed needle-red center line, centered muted empty text, and a Barlow kHz axis with an Atkinson unit caption on its own line below the tick labels (it wraps on narrow screens) that adds "Click a signal to tune to it." ("Tap…" on touch).
  - Until the visit's first audio it's a 56px strip (no axis, passband or center line) reading "Press Listen to hear the band. A blank receiver picks the best one." (or "Tuning in…" while a tune connects). `data-open` grows it to full height (200ms, none under reduced motion) and it stays open for the visit.
- **Strong signals now** (`SignalList.tsx`, `.presets.signals`): the band scan's list, built from the presets' classes and grid (auto-fill, min 300px; rows, tabular Barlow frequency, current row in lamp) with wider frequency and band columns (6ch, 4.2ch) and a muted "N dB above noise" note (`.signal-strength`). Before the first scan it says when the scan comes: "about 10 seconds after a receiver starts playing", or, while Pick best is still checking the receiver, "once Pick best has finished checking this receiver, about 25 seconds in". State text sits in `.presets-note` paragraphs inside a `role="status"` div. Scan again is a standalone `.link-button` (`.signals-again`, 12px bottom margin, not `.inline`) outside that live region, so only the text is announced; it's `aria-disabled` while a scan runs or nothing is playing, so it keeps keyboard focus. Hidden when the radio service can't scan, and when nothing is playing and there's no scan to show.
- **Presets** (`Presets.tsx`, `.presets`): an `h2` "Saved frequencies".
  - `.presets-list` is an auto-fill grid (min 300px, or the full width when narrower) of rows with a `--rule` bottom border.
  - Each `.preset-tune` row shows the frequency (Barlow 1.2rem tabular, lamp when current), the mode (Barlow muted) and the name (glass and underlined on hover).
  - `.preset-delete` is a round 32px × that turns `--danger` on hover.
  - `.presets-save` is a field plus a brass outline pill Save button (7px 16px, brass 12% hover, disabled at opacity 0.45).

- **Map card Listen** (`.map-listen`) turns `--brass-bright` under the pointer and dims to 0.45 when disabled.

**Known gaps**

- The design record says the card's Listen is "styled like `.receiver-choose`" with max-height panel − 24px. The code uses a filled lamp pill and −16px.
- The map design record orders the page with the Receivers section before the waterfall (D3) and gives the map's placeholder "Map loads once the radio is playing". The code puts the Receivers section last, after presets, and the placeholder reads "Map loads in a few seconds".

## Do's and Don'ts

Rules the code follows:

- **Do** show keyboard focus as a 2px `--lamp` outline at offset 2px (global `:focus-visible`). It's restated on `.map-frame` and on the mode span (whose radio input is invisible). The only deviations have a stated reason: offset 8px on the dial, −2px inside the table's scroll box ("The scroll box clips anything outside it, so draw focus rings inside"), and the readout, which swaps the outline for a lamp border on focus.
- **Do** use `--lamp` for "this is live / this is the one": the listening lamp, the tuned table row, the current preset, the map's listening dot. Connecting reuses lamp but dimmer (0.5 opacity lamp; a ring instead of a dot in the table and on the map).
- **Do** keep `--needle` for the tuning position: the dial needle, the waterfall center line, the listening dot's ring.
- **Do** keep `--danger` for failures and warnings (error status, overload, old list, delete hover).
- **Do** honor `prefers-reduced-motion`. It removes the S-meter fill transition, the waterfall's growth from strip to full height, and the map fade-in. In JS (`ReceiverMap.tsx`) it skips the 600ms dot emphasis and uses `jumpTo` instead of `easeTo`, and zooms with duration 0.
- **Do** reserve space for content that arrives late: `.map-frame` min-height, `.map-header` at 44px, `.receivers-updated` at `min-height: 1lh`, `.status` at `min-height: 1.5em`. The one deliberate exception is the waterfall strip, which grows once, on the visit's first audio, after the listener pressed Listen.
- **Do** keep an inline link at the line's height while giving it a 44px tap target on phones (padding plus a matching negative margin).
- **Do** put a costly action on its own line, away from cheap ones. The map overlay's "Reload page (stops the radio)" sits in `.map-overlay-costly` with `margin-top: 16px`, below Retry and Browse.
- **Do** dim disabled buttons with `opacity: 0.45` and `cursor: default` (`.pick-best`, presets Save, `.map-center`, `.map-listen`, `.link-button`).
- **Do** give touch its own hint with `.hint-coarse` (`aria-hidden`) beside a `.hint-fine` sentence that stays readable to screen readers.
- **Do** use tabular numerals for frequencies and counts that update in place.
- **Don't** style the map from hard-coded colors. Colors come from the `--map-*` tokens (plus `--needle` and `--lamp`) through `resolveTokens`, with `FALLBACK_TOKENS` kept equal to `:root`.
- **Don't** add drop shadows to panels. Depth comes from the enamel tones. The only outer shadows are the dial bezel ring and the status lamp glow.
