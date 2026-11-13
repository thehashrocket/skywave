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
  ham-ink: "#265a56"
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
    fontSize: "1rem"
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

Page order (`page.tsx`): header strip (wordmark, "Listening via …" or the receiver choice, **change**, Listen/Stop) → receiver drawer (the Receiver form, then the Receivers section: help sentence, Pick best bar, map, folded table; collapsed unless opened) → dial → controls (readout, modes, S-meter, volume, and the audio spectrum from the first audio) → status row (with Back, and Pick best on errors) → waterfall → strong signals now → presets. Choosing a receiver lives at the top but takes one line until it's wanted (UI critique, replacing design D3's receivers-last order); the instrument and its live output still sit together, so turning the dial and watching the waterfall happen in one view. Both pages end with `SiteFooter` (`.site-footer`: 0.85rem `--muted` text above a `--rule` line), the credit "Built by Jason Shultz · Source on GitHub · For Kiwi owners"; on the listening page every link opens a new tab so following one never stops the audio. The one other page, `/owners` (`app/owners/page.tsx`), is running text for KiwiSDR owners in the same frame: the wordmark (a link home) in `.console-header`, then `.owners-body` (68ch wide) with a Barlow `.owners-title` (2rem) and section `h2`s styled like the console's (1.6rem, `--glass`). Visually hidden `h2`s "Tuner" (before the dial) and "Waterfall" let screen readers reach the instrument by heading.

## Colors

| Token             | Value                                           | Role in code                                                                                                                                                                                                                |
| ----------------- | ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--enamel`        | #13303a                                         | Page background (`html, body`); floating surfaces on the map: `.map-card`, `.map-tooltip`, MapLibre control groups                                                                                                          |
| `--enamel-deep`   | #0b1e24                                         | Wells: text inputs, `.waterfall-screen`, `.smeter-track`, `.map-frame`, the focused readout, the dial's 6px bezel ring, the wide waterfall's station-name chips                                                                                                      |
| `--enamel-raised` | #1b3f4a                                         | Panels: `.controls`, `.receivers-table-wrap`, sticky table headers                                                                                                                                                          |
| `--rule`          | #2b5560                                         | 1px borders and dividers (inputs, mode segments, presets list, map card, `.map-center`), idle status lamp, readout hover border                                                                                             |
| `--glass`         | #d4e6d8                                         | Dial face top; headings (wordmark, `h2`, summary, map heading); checked mode segment; map dots                                                                                                                              |
| `--glass-shade`   | #b9d3c2                                         | Dial face gradient bottom                                                                                                                                                                                                   |
| `--ink`           | #1b2a2f                                         | Text on light surfaces: dial ticks/numerals, the checked mode, `.power`, `.map-listen`                                                                                                                                      |
| `--needle`        | #c8322b                                         | Dial needle line and cap; ring round the listening dot on the map                                                                                                                                                           |
| `--brass`         | #c19a4b                                         | Power button fill; outline buttons (Pick best, preset Save); `accent-color` for checkboxes and the volume slider; the wide waterfall's station ticks                                                                                                            |
| `--brass-dim`     | #8a6c33                                         | Broadcast band bars on the dial (opacity 0.8)                                                                                                                                                                               |
| `--text`          | #e6eee8                                         | Default text; hover color for links and table headers                                                                                                                                                                       |
| `--muted`         | #9db8b0                                         | Labels, help and meta text, units, scales, legend, idle mode segments                                                                                                                                                       |
| `--ham`           | #2f6f6a                                         | Ham band bars on the dial; the low end of the S-meter gradient                                                                                                                                                              |
| `--lamp`          | #f2c55c                                         | Links and `.link-button`; focus outlines; readout digits; listening status lamp (with glow); the tuned receiver and preset; map listening dot and labels; the Listen button on the map card                                 |
| `--danger`        | #f08a7e                                         | Error status lamp; a status message with `data-tone="danger"` (a service error, or a Pick best run that ended with nothing playing); "Receiver overloaded"; preset delete hover; a list older than 30 min in the map legend |
| `--brass-bright`  | #d3ad5e                                         | Listen (`.power`) under the pointer; the map card's Listen under the pointer                                                                                                                                                |
| `--brass-ink`     | #6b5226                                         | Broadcast band labels on the dial glass                                                                                                                                                                                     |
| `--ham-ink`       | #265a56                                         | Ham band labels on the dial glass (`--ham` is 3.65:1 at the glass's darker foot; this is 4.9:1)                                                                                                                             |
| `--meter-mid`     | #6fb29e                                         | The S-meter gradient's midpoint                                                                                                                                                                                             |
| `--wf-0`…`--wf-4` | enamel-deep, #1b545c, #70b29e, #e8d27a, #fff8de | The waterfall colormap, low to high. `Waterfall.tsx` reads them on mount (`resolveStops`) and keeps the same values as `FALLBACK_STOPS`                                                                                     |

**Map tokens.** `--map-sea`, `--map-land`, `--map-rule`, `--map-dot` and `--map-playing` are aliases (`var(--enamel-deep)`, `var(--enamel-raised)`, `var(--rule)`, `var(--glass)`, `var(--lamp)`). `--map-night` (0.31) and `--map-twilight` (0.2) are black overlays that together make about 0.45 (CSS comment). `--map-last` is glass at 45% alpha. `receiver-map-style.ts` reads them with `getComputedStyle` (`TOKEN_VARS`), and reads `--needle` and `--lamp` directly for the listening ring and the dot labels. Its `FALLBACK_TOKENS` copy the same values for tests or an unreadable stylesheet.

**Alpha tints used inline** (no token): brass 12% for outline-button hover `rgba(193,154,75,0.12)` (Pick best, presets Save); lamp 35% for text selection `rgba(242,197,92,0.35)`; glass 8% for table-row hover and the waterfall passband (16% over the trace); glass 45% for passband edges; enamel-deep 82–85% for `.map-overlay` and `.map-chip`; needle 85% dashed for the waterfall center line; danger 10% for preset delete hover; lamp 32% radial glow at the bottom of the dial.

**Browser surfaces.** Text selection is lamp at 35% with `--text` (`--ink` on the dial glass), inputs use a `--lamp` caret, and the page, the dial strip and the receiver table's scroll box use `scrollbar-color: var(--rule) var(--enamel-deep)` (browsers that ignore `scrollbar-color` keep their own).

**Known gaps**

- `--map-last` restates glass as a literal rgba instead of deriving it from `--glass`. `receiver-map-style.ts` reads the token's text and hands it to MapLibre, which can't parse a `color-mix()` or relative color, so a derived value would break the map.

## Typography

Two faces, loaded in `layout.tsx` with `display=swap`:

- **Atkinson Hyperlegible** (`--font-ui`, fallback `system-ui, sans-serif`), weights 400 and 700. Used for body text, form fields, buttons, status, table cells, help and meta text. Base size 16px with line-height 1.5 on `html, body`. Weight 700 goes on buttons (`.power`, `.pick-best`, presets Save, `.map-listen`) and `.status-state`.
- **Barlow Condensed** (`--font-instrument`, fallback `"Arial Narrow", sans-serif`), weights 500 and 600. Used for the instrument face: wordmark (2.6rem/1, 0.01em), frequency readout (3rem/1, tabular numerals; 2.6rem at ≤860px), section `h2` (1.6rem), the "All receivers" summary and map heading (1.15rem), mode segments (1.1rem), S-meter reading (1.5rem), preset frequency (1.2rem, tabular) and mode (0.95rem), map card names (1.05rem), readout unit (1.3rem), dial numerals (15px/500, majors 22px/600), dial band labels (12px/600), S-meter scale (0.8rem), waterfall axis (0.9rem) and audio spectrum ticks (0.75rem). Barlow headings use weight 600 and color `--glass`. Every Barlow use names a loaded weight: `.readout-unit`, `.preset-mode`, `.smeter-scale`, `.waterfall-axis` and `.audio-spectrum-axis` use 500.

Sizes in use for UI text: 1rem (body: the receiver list's state line, which "reads at body size", the table, status, waterfall empty text, receiver help, checkboxes, `.link-button`) and 0.85rem (small: field labels and the Receiver field's chip and hint, meta, legend, map notes, receiver host, the span picker, station names under the readout and on the waterfall), plus 0.8rem for the S-meter overload and waterfall unit. The dial's row labels ("Broadcast", "Amateur") are Atkinson 11px italic, `--muted`, set vertically in a gutter left of the glass.

Numbers that change in place use `font-variant-numeric: tabular-nums` (readout, preset frequency, table `.num` cells).

Map dot labels are not Barlow. MapLibre draws them in Noto Sans Bold 12px uppercase, because "the page's Barlow isn't available as map glyphs" (`receiver-map-style.ts`).

**Known gaps**

- The map design record says map labels are Barlow Condensed and the legend is 13px. The code uses Noto Sans Bold and 0.85rem.

## Layout

- **Page frame:** `.console` is a single-column grid, `max-width: 1120px`, centered, padding `24px 16px 64px`, `gap: 20px`. The header is a wrapping flex row (gap 12px 20px, centered): the wordmark, the strip (`.tuned-to`: while a receiver plays, "Listening via **<place>** · <host>" (`.tuned-to-text`, muted, with `.tuned-to-place` in `--text` 700 and `.tuned-to-host` muted 400, hidden at ≤520px; just the host, in `--text` 700, when the list has no place), otherwise the receiver chip without its ✕; then **change**, an inline link button named "Change receiver" with `aria-expanded`, 44px tall on touch at any width), and Listen/Stop, which submits the drawer's form (`form="receiver-form"`). The drawer (`#receiver-drawer`, `.drawer`, labelled "Choose a receiver") is an `--enamel-raised` panel with a rule border and 16px padding. Closed, it is `inert` and collapses to nothing (`.drawer[inert]`: height 0, `visibility: hidden`, and a negative `--console-gap` margin to cancel the grid gap) rather than unmounting, so a loaded map keeps its size. It starts shut on every visit, a first one included, so the dial and Listen are on the first screen (on a first visit the table inside is already open for when **change** is pressed); it opens by itself only when a blank Listen can't pick (the list hasn't loaded: the message points at the field and Try again inside); choosing a receiver in it (table, map, Switch or Enter, Pick best) closes it and moves focus to **change**. The map isn't admitted until the drawer has opened once. In the drawer, the Receiver field's choice chip sits on the label row (`.field-head`), opposite the label, so the inputs stay bottom-aligned: "Auto (best for this frequency)" (`.chip.chip-auto`, muted) or the pinned receiver's name (`.chip-label`, ellipsis at 24ch) with a ✕ (`.chip-unpin`, 22px, a 44px hit area on touch); both chips are 26px tall, so pinning doesn't move the header. After the chip, the hint "or type an address" (`.field-hint`, 0.85rem muted) stays visible, typed address or not; the row wraps when narrow. The chip's text and the hint are the input's `aria-describedby`. The fields stay editable while listening; when they name a receiver other than the one tuned, a **Switch** button (`.receiver-switch`, rule border on `--enamel-deep`, quieter than Listen) appears before Listen/Stop. "Switch to a better receiver?" (`.switch-prompt`, a live region) sits under the status row on a reserved line: plain text plus two inline link buttons. Either button moves focus to the status row, since it goes away with the offer.
- **Controls:** `.controls` is a 4-column grid `auto auto minmax(220px,1fr) minmax(140px,200px)` (readout, modes, S-meter, volume), gap `16px 28px`, padding `16px 20px`.
- **Spacing:** no spacing tokens exist. Gaps and paddings are literal px values. The common ones are 10, 4, 6, 16, 8, 20, 14 and 12px (in order of use), with 2px for tight label stacks. The front matter `spacing` group lists these values, named by size.
- **Dial width:** `.dial-glass` has `min-width: 860px` (`--glass-min`, set on `.dial-frame`, which also sizes the row-label gutter) inside `.dial-scroll` (`overflow-x: auto`), so below that width the dial scrolls sideways and `Dial.tsx` scrolls to keep the needle in view.
- **Scroll regions:** the receiver table scrolls on its own (`max-height: min(60vh, 520px)`) "so the dial stays near the top of the page", with sticky headers and `scroll-padding-top: 2.5rem`.
- **Map height:** `--map-height` is 360px, 300px at ≤860px and 220px at ≤520px. `.map-frame` reserves `min-height: var(--map-height)` from the first render "so nothing jumps when the map arrives". `.map-header` is held at `min-height: 44px` so the Center button appearing doesn't push the map down.
- **Breakpoint 860px:** `--map-height: 300px`; controls go to two columns, with the readout and modes spanning both; readout 2.6rem.
- **Breakpoint 520px:** controls go to one column (padding 14px); the readout aligns left and, where `field-sizing` is supported, shrinks to its digits; the host field goes full width; the table's Location column is hidden; table-wrap padding drops to 12px; the open waterfall canvas drops from 240px to 180px; `--map-height: 220px`; the map card docks under the map (`position: relative`, `max-height: 240px`, top border only, no radius). Receiver rows clamp the name to 2 lines, hide host · antenna and show the place (`.receiver-place`, one line with an ellipsis) instead. Strong signals shows its first 8 rows (`PHONE_ROWS` in `SignalList.tsx`, which marks later rows `data-beyond` for the CSS to hide) and a **Show all N** link-button (`.signals-more`, phones only).
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
- The dial is a wide rounded rectangle (`--radius-dial: 10px`, SVG viewBox 1000×160, or 1000×106 compact) with band bars as small rects (`rx` 1.5).
- Circles (`50%`): the 9px status lamp and the preset delete button. The needle has a 3.5px circular cap.
- `--radius-inset: 4px`: the readout input and the S-meter track.

## Components

- **Dial** (`Dial.tsx`, `.dial`, `.dial-glass`): an SVG `role="slider"`.
  - Two layouts (`FULL`, `COMPACT` in `Dial.tsx`): 1000×160 at rest, and 1000×106 from the visit's first audio (`.dial[data-compact]`), with both band rows, the staggered labels and the MHz scale set closer, shorter ticks and 18px 5 MHz numerals. It doesn't animate and doesn't grow back on Stop. The gutter's height is the glass width × `--dial-aspect` (0.16, or 0.106 compact) and its labels' `top` follow the active layout; `globals.test.ts` checks both against `Dial.tsx`.
  - Broadcast bands (`.dial-band-broadcast`, `--brass-dim`, labels `--brass-ink`) sit above the MHz scale, and ham bands (`.dial-band-ham`, `--ham`, labels `--ham-ink`) sit below it.
  - The row labels "Broadcast" and "Amateur" sit outside the glass in `.dial-gutter` (14px, 12px from the glass, sized to the glass's height with container query units so a scrollbar under the strip can't shift them; `aria-hidden`), read bottom to top and centered on their band rows, so the needle never crosses them and they stay in view while a phone scrolls the strip.
  - Ticks and baseline are `--ink`, and numerals are 0–30 MHz in Barlow. The needle is a 2.5px `--needle` line with a cap.
  - `cursor: ew-resize`, `touch-action: pan-y`. The focus outline is 2px lamp at offset 8px. The hint text below is `.dial-hint` (0.85rem muted), with a touch sentence "Drag the dial or tap a band to tune." on coarse pointers.
  - A mouse or pen tunes on press and drag. A finger waits: it tunes once it has moved 8px sideways (more than up or down), or on a tap when it lifts; a page scroll that starts on the dial (`pointercancel`) tunes nothing. On a phone, a touch drag that ends within 40px of the strip's edge scrolls the strip to center the needle, so repeated drags reach the whole 0–30 MHz.
- **Frequency readout** (`FrequencyReadout.tsx`, `.readout-input`): a transparent input with lamp digits in Barlow 600, 3rem, right-aligned, 9.4ch wide (fits "29,999.99" with its padding). At ≤520px it shrinks to its digits (`field-sizing: content`, min 4ch, max 9.4ch so a long or rejected entry scrolls inside the box) and aligns left, so "kHz" sits beside the number; browsers without `field-sizing` keep the width.
  - Once the pointer has rested on the number for 500 ms with no wheel movement (`WHEEL_REST_MS`), or while it has focus, a wheel over it tunes one step per notch; a scroll that only passes over it keeps scrolling the page. Arrow Up/Down step the same way while it has focus and nothing is typed. The wheel tunes (up is up; a trackpad's small deltas add up to one notch, a reversal starts again), Shift ten, snapping to the step's grid: AM channels (10 kHz on medium wave when the receiver playing is in the Americas, 9 elsewhere, on long wave or with no position; 5 on shortwave), 100 Hz for SSB, 10 Hz for CW (`tuningStepKhz`, `stepKhz` in `radio-types.ts`). The page doesn't scroll under it; over typed text the wheel does nothing. The input's `title` says "Rest the pointer here and scroll, or use the up and down arrow keys, to fine-tune".
  - It reads kHz (commas or spaces only as thousands separators, so "1,5" is rejected rather than read as 15), optionally with a unit (`kHz`/`k`, `MHz`, or `M` with a decimal point, since "20m" reads as a band name), 10–30,000 kHz. Anything else stays in the box with `aria-invalid` and a muted 0.85rem `.readout-error` line, "Enter 10 to 30,000 kHz", tied by `aria-describedby`; Escape restores the current frequency.
  - The line under the number (`.readout-below`, 0.85rem) is held even when empty (`min-height: 1lh`), so it never moves the page. It shows the station the EiBi schedule has on the tuned frequency now (`#freq-station`, `.readout-station`: `--text`, the name cut short with an ellipsis in `.readout-station-name`), or, in its place, a rejected entry's message; while another frequency is being typed, neither. The input's `aria-describedby` points at whichever is showing, so the name is read with the frequency. On a shared frequency an inline **+N more** link-button (`aria-expanded`) opens the other listings as `.readout-others`, a plain list labelled "Also scheduled now", under the line. `contain: inline-size` keeps a long name from widening the readout's column.
  - Hover shows a `--rule` border.
  - Focus drops the outline and uses a lamp border on an `--enamel-deep` fill.
  - `.readout-unit` "kHz" is muted Barlow.
- **Mode buttons** (`.modes` fieldset, `.mode` labels with hidden radios): segments in Barlow 600 1.1rem, muted on a `--rule` border. The checked segment is a `--glass` fill with `--ink` text, and keyboard focus draws the lamp outline on the visible span.
- **S-meter** (`SMeter.tsx`, `.smeter`): the reading is Barlow 1.5rem with dBm in 0.85rem muted. "Receiver overloaded" is `--danger`.
  - The track is 8px `--enamel-deep`. The fill is a `--ham` → `--meter-mid` → `--lamp` gradient scaled with `transform: scaleX` and a 180ms linear transition.
  - A 1px S9 marker sits on the track, with a Barlow scale (1–9, +20, +40) below.
- **Volume** (`.volume`): a native range input with `accent-color: var(--brass)`.
- **Audio spectrum** (`AudioSpectrum.tsx`, `.audio-spectrum`): what's going to the speaker, from 0 Hz to half the radio's audio rate (a rig's AF-FFT). It appears with the waterfall, from the visit's first audio, and stays through Stop, lying flat while nothing plays. It sits under the S-meter and volume (`grid-column: 3 / -1`; a full row at ≤860px). Muted 0.85rem "Audio" label; a 56px `--enamel-deep` well (`--radius-inset`) with a cream line (`--wf-4` at 90%) over a celadon wash (`--wf-2` at 35%), -100 to -20 dBFS; Barlow 500 0.75rem muted ticks in kHz, the last naming the unit. Drawn each animation frame from an `AnalyserNode` (fftSize 1024, smoothing 0.6) that `useRadio` taps from the player ahead of the volume, so the volume doesn't change it. `aria-hidden`: the S-meter and status say the same in words.
- **Status line** (`.status`, `role="status"`, `data-state`): a 9px lamp, bold state text, muted detail, and a message on its own line (max 75ch).
  - The lamp is `--rule` when idle, `--lamp` with a glow when listening, `--lamp` at 0.5 opacity when connecting, and `--danger` on error. The message turns `--danger` when `data-tone="danger"`.
  - Where the receiver playing is shows in the header strip ("Listening via …"); the status row only says it to screen readers (a visually hidden " via <place>" after "Listening"), since the strip isn't a live region and a switch should be heard.
  - The message is the newest of three: Pick best's note, the service's message, or the page's own (a blank Listen or the error link before the list has loaded). While a Pick best run is going, its note beats that run's refusals.
- **Pick best on errors** (`.link-button.status-pick`): beside Back in `.status-row`, outside the live region, only while the status is a receiver's own error (one naming a host; not a down service or blocked audio) and Pick best is settled (no run, no watch). Before the list loads it says to press Pick best receiver again, since Listen would redial the receiver that just failed. Pick best, from any button, leaves out receivers that refused in the last 15 minutes (the list's copy of them can be that old; playing again clears it, and only full, no-apps and password answers count); when that leaves nothing it says so instead of "No listed receiver covers this frequency". The service's own uncoded errors show no link. Once a run starts the link goes away and focus moves to the status row (`tabIndex=-1`); "Show all N" likewise moves focus to the first row it reveals.
- **Back button** (`.link-button.status-back`): sits in `.status-row` outside the live region. It's left-aligned with `overflow-wrap: anywhere`, because receiver names run long and "a wrapped button label would center".
- **Power** (`.power` / `.power-on`): Listen is a filled brass pill with ink text, weight 700, min-width 7em. Stop is the brass outline version.
- **Pick best** (`.pick-best`): a brass outline pill (7px 16px, weight 700) with a brass 12% hover. Disabled is opacity 0.45. While a run is going, the same class becomes "Stop picking". Its line (`.receivers-note`, 1rem muted, `role="status"`) gives the list's state (loading, failed with Try again, stale) or the fixed description; Pick best's run notes go to the status line.
- **Link button** (`.link-button`): text styled as a lamp link, 1rem, underlined with `text-underline-offset: 3px`. Hover changes it to `--text` with a 2px underline. `.inline` drops the padding and inherits the font size for use inside sentences. Disabled or `aria-disabled="true"` drops to opacity 0.45 with `cursor: default` and no hover change.
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
- **Waterfall** (`Waterfall.tsx`, `.waterfall`): a 240px canvas (180px at ≤520px) in a deep, rounded screen; only a live waterfall (`[data-active]`) takes clicks, shows `cursor: crosshair` and the "Click a signal" title. Above the picture, inside the same screen, a spectrum trace (`.waterfall-trace`, `--trace-h`: 64px, 48px at ≤520px, with a rule line under it) draws the newest row as a line on the picture's own levels (`traceYs`), steadied by keeping 60% of the last trace (reset when the view clears): a cream line (`--wf-4` at 90%) over a celadon wash (`--wf-2` at 22%). The picture canvas is `.waterfall-picture`. It has a glass-tinted passband strip, 16% over the trace and 8% over the picture, a dashed needle-red center line with a needle-red pointer at the top (`.waterfall-center::before`, 11×7px), centered muted empty text, and a Barlow kHz axis with an Atkinson unit caption on its own line below the tick labels (it wraps on narrow screens) that adds "Click a signal to tune to it." ("Tap…" on touch). Both waterfalls draw through `createPainter` (same colormap and auto-level).
- **Wide waterfall** (`WideWaterfall.tsx`, `.waterfall[data-wide]`): the receiver's own waterfall, same screen, canvas and marks, but placed in RF: the needle line sits at the tuned frequency and the passband strip at the Kiwi's passband, each only while inside the picture (the strip clipped at the edges). The axis ticks are frequencies at a round step (`tickStepKhz`, four to eight across), all centered on their mark, and the caption reads "kHz · Click a signal to tune to it.". Notes over the picture ("Opening the receiver's waterfall…", "Scanning the bands…", a view error as `role="alert"`) sit on an enamel-deep chip so they read over a picture. It takes clicks only once a frame has arrived and not while frozen or in error. Scheduled stations (EiBi) get an 8px brass tick at the top of the picture (`.waterfall-station`, in `.waterfall-stations`, an overlay from under the trace down, with `pointer-events: none`) and a name under it where it fits (`.waterfall-station-name`: 0.85rem on an enamel-deep chip, cut at 150px): the station alone with a count of any others, "Voice of Turkey +1" (`shortLabel`), since the readout gives the tuned one's language. Labels go nearest the tuned frequency first, each at least 158px from the last (`placeLabels`). The marks are `aria-hidden` and let clicks through; the readout's line says the tuned station in words. Not shown while a note covers the picture.
- **Span picker** (`SpanPicker.tsx`, `.span-picker`, `.span-step`): a segmented row like the modes, in Atkinson 0.85rem: Audio, 15 kHz, 60 kHz, 230 kHz, "<band> band". `aria-pressed` marks the chosen width (glass ground, ink text); widths the service can't stream, and Band outside a band, are disabled at 50% opacity. It appears with the waterfall's opening (the first audio), sits half the page gap above the screen, and is 44px tall on coarse pointers. While a wide width is chosen but the receiver hasn't yet earned its waterfall (the scan's wait: 10 s of play with Pick best done), the audio waterfall shows and `.span-note` (0.85rem, muted) after the buttons says "The receiver's waterfall starts in a few seconds."
  - Until the visit's first audio it's a 56px strip (no trace, axis, passband or center line) reading "Press Listen to hear the band. A blank receiver picks the best one." (or "Tuning in…" while a tune connects). `data-open` grows it to full height (200ms, none under reduced motion) and it stays open for the visit.
- **Strong signals now** (`SignalList.tsx`, `.presets.signals`): the band scan's list, built from the presets' classes, except that `.signals-list` flows in CSS columns (300px wide) instead of the presets' grid, so the strongest-first order runs down each column (rows, tabular Barlow frequency, current row in lamp) with wider frequency and band columns (6ch, 4.2ch) and a muted "N dB above noise" note (`.signal-strength`). Over the note, the scheduled station on that frequency (`.signal-station`, body text, one line, every listing in its tooltip), when EiBi lists one: the name (`.signal-station-name`) is cut short with an ellipsis, and " +N more" (`.signal-station-more`, muted) stays whole after it; both sit in `.signal-what`, a column flex with `min-width: 0` so the row keeps to its column. Tuning a row shows its full listing under the readout. Before the first scan it says when the scan comes: "about 10 seconds after a receiver starts playing", or, while Pick best is still checking the receiver, "once Pick best has finished checking this receiver, about 25 seconds in". State text sits in `.presets-note` paragraphs inside a `role="status"` div. Scan again is a standalone `.link-button` (`.signals-again`, 12px bottom margin, not `.inline`) outside that live region, so only the text is announced; it's `aria-disabled` while a scan runs or nothing is playing, so it keeps keyboard focus. Hidden when the radio service can't scan, and when nothing is playing and there's no scan to show.
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
- **Do** reserve space for content that arrives late: `.map-frame` min-height, `.map-header` at 44px, `.receivers-updated` at `min-height: 1lh`, `.status` at `min-height: 1.5em`, `.switch-prompt` at `min-height: 1lh` (an offer that wraps on a phone can still add a line), `.chip` at `min-height: 26px` (Auto and a pin are the same height). The one deliberate exception is the visit's first audio, after the listener pressed Listen: the waterfall strip grows, the span picker appears above it and the dial goes compact, once, together. Opening and closing the receiver drawer moves the page too: when asked, and when a blank Listen can't pick.
- **Do** keep an inline link at the line's height while giving it a 44px tap target on phones (padding plus a matching negative margin).
- **Do** put a costly action on its own line, away from cheap ones. The map overlay's "Reload page (stops the radio)" sits in `.map-overlay-costly` with `margin-top: 16px`, below Retry and Browse.
- **Do** dim disabled buttons with `opacity: 0.45` and `cursor: default` (`.pick-best`, presets Save, `.map-center`, `.map-listen`, `.link-button`).
- **Do** give touch its own hint with `.hint-coarse` (`aria-hidden`) beside a `.hint-fine` sentence that stays readable to screen readers.
- **Do** use tabular numerals for frequencies and counts that update in place.
- **Don't** style the map from hard-coded colors. Colors come from the `--map-*` tokens (plus `--needle` and `--lamp`) through `resolveTokens`, with `FALLBACK_TOKENS` kept equal to `:root`.
- **Don't** add drop shadows to panels. Depth comes from the enamel tones. The only outer shadows are the dial bezel ring and the status lamp glow.
