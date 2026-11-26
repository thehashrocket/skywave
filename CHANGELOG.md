# Changelog

Notable changes to skywave, newest first. Versions come from `VERSION` (four parts, `MAJOR.MINOR.PATCH.MICRO`); /ship bumps it and writes each release's entry here. Before 0.44.0.0 the numbers were assigned afterwards, one per merged PR (minor for a feature, patch for a fix, micro for docs, chores and dependency bumps).

## [0.61.0.0] - 2026-11-26 ([#144](https://github.com/thehashrocket/skywave/issues/144), [#146](https://github.com/thehashrocket/skywave/issues/146))

### Added
- **The radio service keeps a log of why receivers refuse.** Every Listen that ends on an error, every refusal the service makes itself, and every receiver that starts playing writes one line: the receiver, the error, the receiver's own reason (for example "full, 4 listeners max" or "HTTP 503"), how many seconds of audio played first, and how many listeners the service had at that moment. In production it lives in a rotating file on the data volume, so a redeploy doesn't wipe it the way it wipes the container's logs, and it never holds up anyone's audio while it writes. It is how we will find out why Pick best was giving up under load (#144) and whether the service itself falls behind when busy (#146). Listener names and addresses are never written, and the page for receiver owners now says what the log keeps.
- **Analytics now say how each Pick best run ended:** played, gave up, stopped or failed, with the refusals it met on the way. A receiver turned down for Skywave's own one-listener limit is counted as its own event, `radio_refused` (once per switch, or once per Pick best run with how many receivers it met), so the `radio_error` count still means only receivers that failed and can be compared with earlier weeks as it is.

### Changed
- **A receiver that already has a Skywave listener no longer uses up one of Pick best's three tries.** Skywave allows one of its listeners per volunteer receiver, and that refusal used to look like a full receiver ("busy"). It now has its own reason, Pick best skips past it for free, and it no longer contributes to "Tried 3 receivers and none worked". Tabs left open from before the update keep the old behaviour until reloaded.
- **Switching to a receiver that already has a Skywave listener keeps your current station playing.** Before, the station you were hearing stopped first and then the switch was refused, leaving you with nothing. Now the switch is refused straight away, the dial and receiver field go back to the station still playing, and the status line says why.

### Fixed
- **Pick best always finishes going back.** When a run gave up and went back to the station you were hearing, a receiver whose address has capital letters could leave the button on "checking" for good. It now says "Back on …" once that station plays, or "Couldn't get back to …" if it refuses.

## [0.60.0.0] - 2026-11-26 ([#148](https://github.com/thehashrocket/skywave/issues/148))

### Added
- **E06 and F06 have their own pages.** Two more Russian numbers stations join Signal stations: E06 (a man's voice reading numbers in English) and F06 (its operator's digital data bursts). Their times and frequencies come from Priyom's schedule, like E11 and E07.
- **F06's data bursts are tunable.** Priyom lists F06 in RTTY. skywave tunes it in USB 2.125 kHz below Priyom's frequency so you hear the bursts, and shows both numbers: "17532 kHz RTTY · dial 17529.875 USB". On a phone the panel puts the dial on a second line instead of widening the table. The RTTY decoder stays off; turn it on yourself if you want to try it.
- **Tuned by hand, you can still be asked.** When the dial sits on a frequency where the only station on the air is one from Signal stations (WWV on 20 MHz, UVB-76, E11 during a Priyom slot), "Did you hear it?" now asks about that station, even if you didn't press Listen. A frequency several stations share asks about the broadcasts there as before.

### Changed
- **One answer to "what's on this frequency".** The frequency readout, the waterfall's labels, Strong signals, Find a station and "Did you hear it?" now read one list built from EiBi, Priyom and Signal stations, so they agree with each other and with the Signal stations panel. A numbers station is named only where and when Priyom's schedule has it, not on every frequency EiBi lists for the season. Time signals and markers use Signal stations' names and frequencies, such as "UVB-76" and "WWV"; searching "The Buzzer" or EiBi's other names still finds them.
- **A clear mark when Priyom's schedule can't be had.** If Priyom is unreachable, numbers stations fall back to EiBi's season times and say so: "season schedule, not confirmed" on the readout and in Find a station, "(unconfirmed)" on the waterfall. They're never asked about while unconfirmed. Until Priyom's schedule first arrives, they show nothing.
- **Every "on now" uses the same clock.** Station names, Find a station and the greyline now follow the server's corrected time, the clock the Signal stations panel uses, so a phone a few minutes off no longer names a station the panel says hasn't started.
- **Half a kilohertz off still counts.** An answer about a Signal stations station is taken within 0.5 kHz of its frequency, so The Squeaky Wheel on 3364 kHz (how EiBi and most lists print its 3363.5) can be asked about. Answers are filed under the station's own frequency.
- **Strong signals tunes the named station's mode.** Clicking a strong signal now tunes the mode of the station named on it, such as USB for a numbers station, instead of always AM.

### Fixed
- **The readout no longer names a numbers station on a frequency it isn't using.** For example, on Thursday at 13:00 the readout named E11 on 5371 kHz, one of EiBi's candidate frequencies for the season, while Priyom had it on 4909. Now 5371 shows nothing for E11 and 4909 names it once.
- **One question per frequency.** A frequency listed by both EiBi and Signal stations could ask "Did you hear it?" twice, once for each. It now asks once.
- **An old shared link no longer sends Listen into dead air.** A link naming a numbers station on last month's frequency used to rank receivers for that frequency whenever the station was on the air anywhere. Listen now checks that the station is on the air on the dial's frequency, and otherwise picks a receiver the usual way.

## [0.58.2.1] - 2026-11-25 ([#104](https://github.com/thehashrocket/skywave/issues/104))

### Fixed
- **CHU's page gives the right closing date.** Canada's CHU time signal went off the air on 22 June 2026, after more than a century of broadcasts. Its page and the Signal stations history said October 2023, which was when a different time signal, the one CBC radio carried, ended. It now says "Off the air since 2026-06".
- **The Pip and The Squeaky Wheel link Priyom.** Their pages now list Priyom's station page first under Read more. Priyom confirms the frequencies skywave already used: The Pip on 5448 kHz by day and 3756 kHz by night, The Squeaky Wheel on 5367 kHz by day and 3363.5 kHz by night.

## [0.58.2.0] - 2026-11-25 ([#137](https://github.com/thehashrocket/skywave/issues/137))

### Fixed
- **Sound comes back when you return to the listening tab on a phone.** On iPhones especially, opening a link in a new tab (a station's page, Priyom, a receiver) could leave skywave silent when you came back, until you pressed Listen again. Now the sound starts again by itself when you return. If the phone won't allow that without a tap, the status line shows **Tap to resume audio** instead of a silent player, and screen readers hear "Sound paused". This also covers an iPhone pausing the sound for a call.
- **Resumed sound plays live, not seconds behind.** Audio that arrived while the phone had the sound stopped is thrown away, so you hear what the receiver is picking up now. More generally, if the player ever falls more than a second behind (a burst of delayed audio arriving at once), it jumps to the current audio instead of taking minutes to catch up.

## [0.58.1.1] - 2026-11-25 ([#139](https://github.com/thehashrocket/skywave/issues/139))

### Fixed
- **Radio service updates reach the live service again, whatever the time of day.** One of skywave's automatic checks read the real clock and asked whether a 20 MHz numbers station's path was in daylight, so it failed at some hours of the day and passed at others. While it failed, changes to the radio service merged but were never put live, with no warning. The check now runs at a fixed midday time, so it gives the same answer at any hour. Nothing changes on the site itself.

## [0.58.1.0] - 2026-11-25 ([#133](https://github.com/thehashrocket/skywave/issues/133))

### Fixed
- **Leaving the listening page mid-Listen no longer keeps a receiver busy.** If skywave moved off the listening page while a Listen was still starting its audio, the Listen could finish anyway: it connected to the receiver and held one of its volunteer's listener slots, with nothing on screen to stop it until the tab closed. Now a Listen that hasn't connected yet is dropped when the page goes away, and the audio it was setting up is shut. Today every link on the listening page opens a new tab, so this guards against future same-tab links.

## [0.58.0.0] - 2026-11-25 ([#103](https://github.com/thehashrocket/skywave/issues/103))

### Added
- **A page for every signal station.** Each station in Signal stations now has its own page, such as `/signals/uvb-76`. It covers what the station is and its other names, where it's sent from, its schedule in plain words, and links to where you can read more.
- **Tune it from the page.** Each frequency on a station's page has a "Tune it" link that opens skywave tuned there with the station named, so Listen picks a receiver placed to hear it. A live line says whether the station is on the air now (with Listen) or when it's next on, in UTC and your own time, and when listeners last heard it.
- **Numbers stations point to Priyom.** Their pages link Priyom's schedule (with its licence) instead of a fixed frequency, and say "on the air now" even before Priyom lists the frequency. Stations off the air for good get their history and nothing to tune.
- **All stations on one page.** `/signals` lists every station, grouped like the panel, with the ones off the air last.
- **Share a station.** A shared station link shows that station's own preview card, such as "UVB-76 · The Buzzer".
- **Station names link to their pages.** In Signal stations, a station's name opens its page in a new tab, so what you're listening to keeps playing.
- **Easier to find in search.** The site now has a sitemap and a robots.txt, both on www.skywavehf.com.

## [0.57.0.0] - 2026-11-25 ([#102](https://github.com/thehashrocket/skywave/issues/102))

### Added
- **See when a signal station was last heard.** Each station in Signal stations now says when a listener last answered "Heard" about it, such as "heard 40 min ago", from the "Did you hear it?" answers. A station nobody has heard in the last week shows nothing, and stations off the air for good never do.
- **WWV or WWVH heard.** The two share 2.5, 5, 10 and 15 MHz, so a "Heard" on one of those frequencies shows on both rows as "WWV or WWVH heard …". WWV's own 20 MHz answers stay WWV's.
- **Rows stay put.** The "heard" line has its own space in every row from the start, and reports never reorder the stations, so a badge arriving can't move another station's Listen under your finger.
- **Updated every 10 minutes**, so the database can sleep between reads; a new "heard" can take up to about 20 minutes to appear.

## [0.56.0.0] - 2026-11-25 ([#101](https://github.com/thehashrocket/skywave/issues/101))

### Added
- **Tell us whether you heard a signal station.** After you press Listen on a signal station and a minute of its audio has played, "Did you hear it?" asks about that station: Heard, Not heard or Didn't open, with an optional comment. It asks only after a Listen, never for a station a shared link named or a frequency you tuned by hand, and never about a station that went off the air before the minute was up.
- **WWV or WWVH?** The two share 2.5, 5, 10 and 15 MHz, so their questions name the voice that tells them apart: "Did you hear WWV (a man's voice)…?" or "WWVH (a woman's voice)".
- **Answers are checked before they're kept.** The server accepts an answer only about a station in the catalog that was on the air on that frequency, and a numbers-station answer only when Priyom's schedule lists that transmission. WWV and WWVH on one frequency count separately, and a signal answer doesn't stop you answering about a broadcast there later.

### Fixed
- **Numbers stations that started just before midnight or noon UTC stay listed.** A transmission that began a few minutes before 00:00 or 12:00 UTC could drop out of "On now" when the schedule refreshed just after; the server now keeps the 12 hours before as well.

## [0.55.0.0] - 2026-11-25

### Added
- **Fold the sections you don't need.** Saved frequencies, Find a station, Signal stations and Strong signals now each fold under their heading, so there's less to scroll past on the main page. Click a heading (it has a small arrow) to fold or open it.
- **Folded sections stay useful.** A folded section's heading shows what's inside in one muted line, such as "12 saved", "1,240 on now in English", "E11 on now" or "14 found". Find a station keeps its filters while folded, and Signal stations keeps announcing the station you picked to screen readers.
- **Remembered.** Everything starts open on a first visit. A section you fold stays folded on your next visit in the same browser. A link to a signal station opens Signal stations for that visit without changing what you folded.

## [0.54.1.0] - 2026-11-25

### Fixed
- **The Signal stations section no longer talks over you.** Screen readers used to hear every numbers station starting and ending ("E11 on the air now", "E11 ended") for the whole visit, which with Priyom's schedule could be every few minutes, even while you were listening to something else. Now the section speaks only about the station you pressed Listen on: connecting, playing, and its own slot starting or ending on the frequency you're tuned to. If a connection fails and you press Listen again, you hear "Connecting…" again, and picking a new station never repeats a "Playing." left over from the one before. Other stations' times are still in the tables.

## [0.54.0.0] - 2026-11-25 ([#99](https://github.com/thehashrocket/skywave/issues/99), [#100](https://github.com/thehashrocket/skywave/issues/100))

### Added
- **Signal stations.** A new section after Find a station lists the shortwave oddities people go looking for: time signals (WWV, WWVH, RWM), markers (UVB-76 "The Buzzer", The Pip, The Squeaky Wheel) and numbers stations (E07, E11, S06, S11a, V07, M12). It groups them as:
  - **On now**, with the time left.
  - **Up next**, within 6 hours, with UTC and local times.
  - **Always on.**
  - **Later**, for numbers stations with nothing in the next 6 hours, with a link to Priyom when no time is known.
  - **History**, folded, for stations off the air for good.

  Numbers-station times and frequencies come from Priyom's schedule and are credited to Priyom.
- **Listen on a signal station** tunes it and picks a receiver by the path from the transmitter. Below 8 MHz it prefers a receiver with a dark path, or one within 800 km by day. From 10 MHz up it prefers a daylit path, like the IBP beacons. Listen shows only when there's something on the air to tune, so it doesn't land in dead air.
- **Share a station:** a link with `&sig=` (for example `?sig=uvb-76`) opens the page tuned to the station and scrolled to the panel, and Listen then picks by its path. Copy link keeps it.

## [0.53.0.0] - 2026-11-25 ([#98](https://github.com/thehashrocket/skywave/issues/98))

### Added
- **The signal stations catalog**, the groundwork for a Signal stations panel (#100). Nothing shows on the page yet. It lists:
  - time signals: WWV, WWVH and RWM
  - markers: UVB-76 "The Buzzer", The Pip and The Squeaky Wheel
  - numbers stations: E07, E11, S06, S11a, V07 and M12
  - stations now off the air: CHU, Lincolnshire Poacher and Cherry Ripe

  Each entry has its frequencies, mode, transmitter site and sources, and the catalog can tell which stations are on the air at any moment. The Pip and The Squeaky Wheel change frequency between day and night; the catalog follows the sun at the transmitter to pick which.
- **Numbers-station times from Priyom.** The server reads [Priyom's schedule](https://priyom.org/number-stations/station-schedule) for the coming week, at most every six hours, and logs which stations' times or frequencies changed between reads. If Priyom can't be reached, it keeps the last good copy. Numbers-station details come from Priyom (CC BY-NC-SA 4.0) and are credited to it.

## [0.52.0.0] - 2026-11-25 ([#108](https://github.com/thehashrocket/skywave/issues/108))

### Added
- **Show up by name on receivers.** An optional "Your call sign or name" field in the receiver drawer. When set, the receiver's user list shows you as "skywave N0CALL" instead of the plain Skywave name, so other listeners on that Kiwi can see who's there. The field previews exactly what most receivers will show (many cut names at 16 characters), and notes that the receiver's owner and its other listeners can see it. Letters, digits, `/`, `-`, `_` and spaces, up to 24 characters; anything else falls back to the default. It applies from your next Listen, even on the receiver already playing. Your name stays out of the radio service's logs.
- The page for receiver owners (`/owners`) now explains that a listener who sets a name shows as "skywave" followed by it, such as "skywave N0CALL".

### Security
- `effect`, which Prisma uses, is pinned to 3.22.5 to fix a high-severity bug where a crafted string could make one of its regular expressions very slow ([GHSA-7589-6fvf-x4pw](https://github.com/advisories/GHSA-7589-6fvf-x4pw)).

## [0.51.0.0] - 2026-11-25

### Added
- **Google Tag Manager, with consent.** Where `NEXT_PUBLIC_GTM_ID` is set (Production only), a slim bar at the bottom asks whether skywave may use Google Analytics cookies to count visits. Tag Manager loads only after Accept, with Google's ad storage left off (the bar asks about analytics only); Decline loads nothing, and the answer is remembered and applies in every open tab. On a first visit the bar never takes focus, and the page leaves room under it, so the dial, controls and footer stay usable while it's up.
- "Cookie settings" in the footer reopens the bar. It takes focus, so screen readers land on it. Withdrawing consent switches off Google Analytics on the page and deletes Google's analytics and ads cookies without reloading it, so whatever's playing keeps playing; accepting again on the same page turns analytics back on.

## [0.49.0.0] - 2026-11-25 ([#92](https://github.com/thehashrocket/skywave/issues/92))

### Added
- **RTTY decoding.** Turn on "Decode RTTY" under the mode buttons and text from 45.45-baud, 170 Hz-shift RTTY shows in a panel under the waterfall. It finds the two tones itself, has a Reverse switch for stations sending the other way round, and decodes on the receiver channel you're already using, so it takes no extra slot on the volunteer's Kiwi. Listen on the GhostNet strip's RTTY row turns it on.
- The decoder prints only while a real RTTY signal is there: noise, a lone carrier, two unrelated carriers and other data modes (PSK31, MFSK16) stay quiet or nearly so. When stations take turns on the same tones, each one's text shows from its first word, and a short fade never prints words twice. If the decoder ever fails, even while starting up, it turns itself off and the audio keeps playing; Turn off closes the panel and it stays closed.
- Two tools for the radio service: `scripts/record_window.py` records I/Q from up to three receivers at a set UTC time (reconnecting after a drop, giving up on a receiver that refuses apps), and `scripts/decode_rtty_wav.py` decodes RTTY from a recording.

## [0.48.2.0] - 2026-11-24 ([#116](https://github.com/thehashrocket/skywave/issues/116), [#117](https://github.com/thehashrocket/skywave/issues/117))

### Fixed
- Find a station's status line no longer says "in English" over non-voice rows: with a language picked and non-voice included, it reads "in English (plus non-voice)" (#116).
- Rows in the on-now list stop repeating "on now" (the status line says it), so station names get the width; screen readers still hear "on now", and name-search rows still show it (#116).
- "Aimed at" and the rows' "to …" line show tidy names: no EiBi footnote asterisk ("Taiwan", not "Taiwan *"), no bracketed note it hid ("Ogasawara"), and "Bangladesh" not "Bangla Desh". In the "Aimed at" list only, "Tas" reads "Tas (unnamed in EiBi)" and compass headings read like "West-northwest (beam heading)". Codes and filtering are unchanged (#117).

## [0.48.1.0] - 2026-11-24 ([#115](https://github.com/thehashrocket/skywave/issues/115))

### Fixed
- **A shared frequency names the station you're most likely hearing.** When several broadcasts share a frequency, the readout, the waterfall labels and "Did you hear it?" now lead with the one aimed at where the receiver playing is. On 5,935 kHz through a North American receiver, that's WWCR 2 instead of Xizang RTV. With nothing playing, Find a station's "Aimed at" region decides; with neither, the order is EiBi's, as before.
- "Did you hear it?" goes by the receiver's own listed location only, never your Find a station filter, so an answer is saved under the station the receiver could actually pick up.

### Changed
- Each "Did you hear it?" answer about a scheduled station also records which rule chose the station and the region it ranked by, so the receiver-ranking study (#61) can tell answers from before and after this change apart.

## [0.48.0.1] - 2026-11-23

### Changed
- The README describes the UTC clock, the UTC time in the tuning bar, and when saved frequencies say they were saved.

## [0.48.0.0] - 2026-11-23 ([#106](https://github.com/thehashrocket/skywave/issues/106), [#107](https://github.com/thehashrocket/skywave/issues/107))

### Added
- **A UTC clock in the header.** Next to the wordmark, the UTC weekday and date sit over a 24-hour clock that ticks each second ("Mon 23 Nov" over "14:05:09 UTC"), so you can read any schedule without checking another clock. It follows the server's time, so it agrees with the beacon slots and GhostNet countdowns even when your device's clock is off.
- On wider screens the sticky tuning bar shows the time too ("14:05 UTC"), so it stays in view while you scroll down to the schedules.
- **Saved frequencies say when you saved them.** A station you save in your browser shows "saved Sat 2214 UTC" under its name, or the date ("saved 8 Nov 2214 UTC") once it's a week old, and the year once it's from another year. Hover for the full date and your local time. Stations saved before this release show no time.

### Fixed
- **A full list says so instead of losing your save.** A browser keeps up to 200 saved frequencies. Saving another used to drop one without a word; now the save is refused with "You have 200 saved frequencies. Delete one to save another." and the name you typed stays in the box.
- Local times (GhostNet's "Thu 5:00 pm PST" and the saved-time hover) follow a time-zone change made during a visit, such as after travel, without a reload.

## [0.47.1.0] - 2026-11-23 ([#110](https://github.com/thehashrocket/skywave/issues/110))

### Fixed
- **Typing in the Languages filter puts the closest matches first.** Names that start with what you typed come first, then names with a later word that does, then names that only contain it. Typing "hin" lists Hindi above Chinese, so Tab lands on Hindi. Your picks still stay at the top.

## [0.47.0.0] - 2026-11-23 ([#109](https://github.com/thehashrocket/skywave/issues/109), [#110](https://github.com/thehashrocket/skywave/issues/110))

### Added
- **Browse what's on the air now.** With nothing typed, Find a station lists every broadcast the schedule has on now, the shortwave broadcast bands first and everything else under "Outside the broadcast bands". Typing a name still finds one station.
- **Filter by where a broadcast is aimed.** Aimed at narrows the list to a broad region (North America, Europe, Asia, Africa, Middle East, Oceania, Latin America) or one of the schedule's area and country codes. A broadcast aimed at "the Americas" or at Russia counts for each region it covers.
- **Filter by language.** Pick one or more languages from a searchable list of the languages on the schedule, your picks listed first; a broadcast in "French, English" counts for English. Include non-voice keeps or hides time signals, Morse and data.
- Your filters are remembered in the browser. A language you saved that the new season doesn't carry stays picked and says so, so you can untick it.
- While a receiver with a known location is playing, Find a station offers its region with one click ("Aimed at North America (where this receiver is)?"). It's never applied on its own.
- When the filters hide everything, the line under the box says what they hid ("BBC has 3 broadcasts in the next 24 hours, none in Spanish to Asia.") and Clear filters puts them back.

### Fixed
- A station's "to …" line lists only where it's aimed at that time, so a weekend target no longer shows on its weekday broadcast.

## [0.46.0.0] - 2026-11-23 ([#91](https://github.com/thehashrocket/skywave/issues/91))

### Added
- **See when GhostNet is on the air.** A folded GhostNet strip under the IBP beacons shows S2 Underground's weekly volunteer HF nets and bridges: what's on now with time left and the next slot, and when each one opens next, in UTC and your local time.
- **Listen to a net in one press.** From 15 minutes before a window opens, Listen tunes the net's frequency and mode and picks a receiver in the net's own region first. The RTTY slot tunes the right dial for its tones.
- A **GhostNet** button in the header opens the strip and moves focus to it, without leaving beacon mode.
- A tuned on-air row says what you'll hear: JS8Call and RTTY tones that Skywave can't decode yet, or an emergency voice channel that's usually silent.
- Once the net you picked is over and the receiver is still playing, the status row says so and asks you to stop when you're done, since the receiver is a volunteer's.

### Changed
- Following a net to its next slot with Listen keeps the receiver that's playing and just moves its dial, so the audio isn't cut.
- The IBP beacon strip and the GhostNet strip share one look, and on phones each GhostNet row stacks its details beside the frequency.

## [0.45.0.0] - 2026-11-22 ([#90](https://github.com/thehashrocket/skywave/issues/90))

### Added
- **Keep tuning without scrolling back up.** Once you scroll past the tuning controls, a bar pins to the top of the window with the frequency, the four modes, the receiver and Listen/Stop. It goes away when the controls come back into view, and on a phone it takes two rows.
- **Change receiver from anywhere.** Press the receiver name in the bar to jump to the receiver drawer, opened and ready.
- If a Listen from the bar can't start, or the receiver refuses it, the status line that says why comes into focus.

### Changed
- The bar's modes, receiver and Listen/Stop work like the ones they mirror: pressing the mode already on changes nothing, the arrow and letter keys still tune with the bar focused, and keyboard focus never lands hidden under the bar.

## [0.44.0.0] - 2026-11-22 ([#89](https://github.com/thehashrocket/skywave/issues/89))

### Added
- **Tune with the arrow keys from anywhere on the page.** The left and right arrow keys move 1 kHz (Shift for 10) without clicking the dial first, so you can click a saved frequency and fine-tune right away. Text fields, the volume, the mode buttons and the receiver map keep their own arrow keys, and the up and down arrows, Page Up and Page Down still scroll the page.
- **Switch mode from the keyboard.** A, U, L and C pick AM, USB, LSB and CW from anywhere outside a text field. A **Letter keys change mode** switch under the mode buttons turns them off, and the choice is remembered.

### Changed
- **Saved frequencies sit higher on the page,** right under the waterfall and above Find a station and Strong signals now, so changing stations doesn't mean scrolling to the bottom.
- After you click a mode button with the mouse, the left and right arrow keys tune instead of switching to the next mode.

## [0.43.0.0] - 2026-11-22 ([#88](https://github.com/thehashrocket/skywave/pull/88))

### Added
- **Find a station by name.** Type part of a station's name above Strong signals to see its broadcasts that are on the air now or start in the next 24 hours, one row per frequency, time and language. Click a row to tune there.
- Matching ignores accents, case and word order, and understands EiBi's short forms, so "R." matches Radio and "VoA" matches Voice of America.
- Each row says where the broadcast is aimed, and a row the current receiver's band scan heard says "Strong here". When nothing is playing, or the receiver can't reach a row, a note offers Pick best for it.
- A click picks the row's mode: AM for broadcasters, USB for aeronautical and maritime voice, and CW for Morse listings.

## [0.42.1.1] - 2026-11-21 ([#87](https://github.com/thehashrocket/skywave/pull/87))

### Changed
- Documented the two parts of the "Did you hear it?" work that were never built (a per-receiver heard-rate view and automatic CW detection), to start once there are enough answers per receiver.

## [0.42.1.0] - 2026-11-21 ([#86](https://github.com/thehashrocket/skywave/pull/86))

### Added
- A hand-run probe for the receiver-ranking study in #61 counts broadcast answers with a WSPR spot near both the transmitter and the receiver.

### Fixed
- The twice-daily RBN skimmer snapshot now refuses pages cut off at a row boundary, keeps the 630 m band, reads HTML entities and caps how many refused pages it keeps. A good list whose save failed is always kept.

## [0.42.0.0] - 2026-11-21 ([#85](https://github.com/thehashrocket/skywave/pull/85))

### Added
- **Count which answered receivers are spotters themselves.** A hand-run script for #61 matches the receivers listeners answered about against RBN skimmers and WSPR reporters by grid square. A source it can't trust reads as missing, never as zero matches.

## [0.41.0.0] - 2026-11-20 ([#84](https://github.com/thehashrocket/skywave/pull/84))

### Added
- **A daily record of where RBN's skimmers are.** A Vercel cron fetches the Reverse Beacon Network's skimmer list, with each skimmer's grid, at 01:30 and 13:30 UTC and saves one copy per UTC day, original page included. RBN keeps no history, and the #61 beacon replay needs to know where each skimmer was.
- A page that isn't the list, stops partway through a row, or holds under 80% of the last saved day's skimmers is set aside instead of saved as that day.

## [0.40.0.0] - 2026-11-20 ([#83](https://github.com/thehashrocket/skywave/pull/83))

### Changed
- **Safer transmitter-site updates.** The twice-yearly EiBi refresh gives up on a download after 30 seconds or 3 MB, and its PR shows the transmitter-site count before and after.
- The server's site table can no longer shrink a little at a time through slightly short downloads, and each site keeps at most 20 coordinates.

## [0.39.0.0] - 2026-11-19 ([#82](https://github.com/thehashrocket/skywave/pull/82))

### Added
- **Answers record where a broadcast was sent from.** Each "Did you hear it?" answer about a broadcast now saves the station's possible transmitter sites from EiBi's site list, or the country when EiBi doesn't say. The page doesn't change, and a lookup problem never loses the answer.
- The site list ships with the app and refreshes in the background at most once a day. A new list with under 80% of the last good one's sites is refused. The seasonal snapshot job bundles it too.

## [0.38.0.0] - 2026-11-19 ([#81](https://github.com/thehashrocket/skywave/pull/81))

### Added
- **Beacons RBN didn't hear yesterday are marked.** A beacon the Reverse Beacon Network's skimmers didn't spot all of the previous UTC day reads "Not spotted by RBN yesterday." in the band strip and is dimmed on the map, often days before NCDXF's list catches up. Listen and the question still work.
- One server downloads RBN's daily file once a day after 01:00 UTC and saves each beacon's spot count for every server to read. No page waits on the download.

## [0.37.0.0] - 2026-11-19 ([#80](https://github.com/thehashrocket/skywave/pull/80))

### Added
- **An invitation under beacons listed off the air.** After NCDXF's note, the band strip adds "Heard it anyway? Answer the question after its turn; NCDXF wants to know."

## [0.36.0.0] - 2026-11-19 ([#79](https://github.com/thehashrocket/skywave/pull/79))

### Added
- **See which beacons NCDXF lists as off the air.** Their rows in the band strip are greyed with NCDXF's note, and they are drawn dimmer on the map. Listen and the question still work, since NCDXF asks to hear when one comes back.
- Each beacon answer records the beacon's listed status, so a "heard" answer on a beacon listed off is a back-on-the-air report.
- The status list refreshes every 3 hours and keeps the last good copy when a fetch fails.

## [0.35.5.0] - 2026-11-19 ([#78](https://github.com/thehashrocket/skywave/pull/78))

### Fixed
- The page now knows the server's time to the millisecond and checks it again every 5 minutes, when the tab comes back into view and after a sleep, so beacon Listen and "Did you hear it?" stay on the right beacon all visit.
- A beacon Listen waiting on the clock can no longer reopen a volunteer's receiver after Stop.

## [0.35.4.0] - 2026-11-19 ([#77](https://github.com/thehashrocket/skywave/pull/77))

### Added
- Reports note how many of their ranked receivers were really on the public list.

### Fixed
- After a laptop sleep or a change to the computer's clock, the page asks the server for its time again, so the beacon strip, the beacon question and a report's Pick best time stay right.

## [0.35.3.0] - 2026-11-19 ([#76](https://github.com/thehashrocket/skywave/pull/76))

### Fixed
- The beacon strip and "Did you hear it?" keep the server's time when someone sets their computer's clock back, and are right again as soon as a laptop wakes from sleep.

## [0.35.2.0] - 2026-11-19 ([#75](https://github.com/thehashrocket/skywave/pull/75))

### Fixed
- A "Did you hear it?" answer keeps how Pick best chose its receiver only when that choice held from the moment the question appeared, so it no longer borrows a choice that was dropped and made again. The server accepts receiver addresses only in the spelling the page writes.

## [0.35.1.0] - 2026-11-19 ([#74](https://github.com/thehashrocket/skywave/pull/74))

### Fixed
- Closed a few rare ways an answer could carry the wrong Pick best context. Each answer now records which version of the rules wrote it, so the #61 study can tell old answers from fixed ones.

## [0.35.0.0] - 2026-11-19 ([#73](https://github.com/thehashrocket/skywave/pull/73))

### Added
- **Answers keep how Pick best chose the receiver.** When Pick best did the choosing, each "Did you hear it?" answer now stores what started the run (a beacon, Listen, a link, the drawer or the better-receiver offer), the receiver's place in the ranking, the top ten candidates, and the receiver's position, signal and listener count. #61 uses this to test whether another receiver order would have picked receivers people heard.
- Malformed or mismatched context is dropped, and the answer is still kept.

## [0.34.0.0] - 2026-11-18 ([#71](https://github.com/thehashrocket/skywave/pull/71))

### Added
- **Pick best prefers a receiver that's quieter than usual.** The radio service measures each receiver's noise floor from waterfall frames it already pulls (band scans and the wide view), never opening a connection just to measure. Receivers with enough measurements trade places in 3 dB steps by how far below their own usual level they are this hour.
- The radio service keeps 30 days of hourly levels per receiver and band in SQLite on a Docker volume that survives redeploys, and serves them to the web app at `/noise`.

## [0.33.0.0] - 2026-11-18 ([#70](https://github.com/thehashrocket/skywave/pull/70))

### Added
- **The picked beacon stays marked in the beacon strip** as it moves up the bands, and a line under its row says it's on air now during its turn, or counts down to its next one.
- If the first turn after Listen didn't play long enough to ask about, the strip says "Missed the start" and when the beacon is back.

## [0.32.0.0] - 2026-11-18 ([#68](https://github.com/thehashrocket/skywave/pull/68))

### Added
- **An IBP beacons button in the header.** It sits beside **change**, opens the receiver drawer with the beacon strip expanded, and moves focus there.

### Changed
- While the drawer and the beacon strip are open, "Did you hear it?" for a beacon appears directly under that band's row instead of on the status line.

## [0.31.0.0] - 2026-11-18 ([#66](https://github.com/thehashrocket/skywave/pull/66))

### Added
- **IBP beacon mode.** A band strip under the map shows which of the 18 International Beacon Project beacons is on each of the 5 bands right now, with a countdown to the next change. Listen tunes the band in CW and runs Pick best with receivers ranked for that beacon: 1,000 to 8,000 km away, with a sunlit path from 14 MHz up.
- The map shows all 18 beacons, fills and labels the five on the air, and draws a path from the picked beacon to the receiver.
- Beacon timing follows the server's clock, so a wrong computer clock doesn't name the wrong beacon.
- "Did you hear it?" asks about the beacon you picked once at least 7 seconds of its turn have played.

## [0.30.2.0] - 2026-11-18 ([#65](https://github.com/thehashrocket/skywave/pull/65))

### Fixed
- Updated `@vercel/functions` to 3.11.3, which drops a copy of zod that could exhaust memory validating oversized collections (Dependabot alert #1).

## [0.30.1.0] - 2026-11-18 ([#64](https://github.com/thehashrocket/skywave/pull/64))

### Fixed
- Updated Next.js to 16.4.5, the November 2026 security release, which closes an information disclosure advisory (Dependabot alert #6). Builds on 16.4.2 had started failing on the known vulnerability.

## [0.30.0.0] - 2026-11-18 ([#63](https://github.com/thehashrocket/skywave/pull/63))

### Added
- **"Did you hear it?"** After a minute of audio on a frequency where EiBi lists a station, a line under the status row asks whether you heard it, with Heard, Not heard, Didn't open and an optional comment. It never stops or retunes anything, asks at most once every 10 minutes, and stops asking after you close it twice.
- Answers are saved without IPs, names or callsigns, under a random ID kept in the browser, and are limited per listener and per receiver each hour.

## [0.29.2.0] - 2026-11-15 ([#58](https://github.com/thehashrocket/skywave/pull/58))

### Fixed
- Audio now plays on an iPhone set to silent, in Safari and Chrome. As with any media app, starting skywave pauses audio from other apps.

## [0.29.1.0] - 2026-11-15 ([#57](https://github.com/thehashrocket/skywave/pull/57))

### Fixed
- When the radio service can't be reached, the page now says a VPN, ad blocker or firewall may be blocking it, instead of telling listeners to start it with a developer command.
- A connection that never opened no longer adds "The connection to the radio service was lost too." After a real drop the page says "Press Listen to reconnect."

## [0.29.0.0] - 2026-11-15 ([#56](https://github.com/thehashrocket/skywave/pull/56))

### Added
- **Listening shows up in analytics.** A `listen_start` event fires when a receiver's first audio plays, with mode and frequency, and a `radio_error` event fires on each error with its code, so the Vercel dashboard shows whether visitors actually hear a receiver.

## [0.28.0.0] - 2026-11-13 ([#55](https://github.com/thehashrocket/skywave/pull/55))

### Added
- **An audio spectrum under the S-meter,** like a rig's AF display, showing what's coming out of the speaker up to about 6 kHz. It is taken ahead of the volume, so turning down doesn't flatten it, and it appears with the waterfall at the first audio.

## [0.27.0.0] - 2026-11-13 ([#54](https://github.com/thehashrocket/skywave/pull/54))

### Added
- **A spectrum trace over both waterfalls.** A line along the top shows the spectrum right now on the waterfall's own levels, so a spike on the trace is the bright line under it.
- The passband shading is darker where it crosses the trace, and a small red pointer marks the tuned frequency. Station names on the wide view move below the trace.

## [0.26.1.0] - 2026-11-13 ([#53](https://github.com/thehashrocket/skywave/pull/53))

### Fixed
- The receiver drawer now starts shut, so a first visit shows the frequency readout instead of a map and receiver table. Listen on Auto already picks a receiver. A listener on r/shortwave couldn't find where to enter a frequency.

## [0.26.0.0] - 2026-11-13 ([#52](https://github.com/thehashrocket/skywave/pull/52))

### Added
- **A credit footer** on the listening page and `/owners`, with links to jasonshultz.com, the source on GitHub and the page for Kiwi owners. On the listening page each link opens a new tab, so the audio keeps playing.

## [0.25.0.0] - 2026-11-12 ([#51](https://github.com/thehashrocket/skywave/pull/51))

### Added
- **A page for KiwiSDR owners** at `/owners`. It explains what skywave does on their receiver, the limits it keeps, and two ways to opt out, one of them a GitHub issue form. The main page links to it in a new tab.

### Changed
- skywave's production radio service now names itself `skywavehf.com` in each Kiwi's user list. Self-hosted copies keep the default `skywave`.

## [0.24.0.0] - 2026-11-12 ([#50](https://github.com/thehashrocket/skywave/pull/50))

### Added
- **KiwiSDR owners can opt out.** Receivers named in `BLOCKED_RECEIVERS` (a host, or a host and port) are refused by the radio service, so Pick best moves on, and hidden from the web app's list and map.

## [0.23.1.0] - 2026-11-12 ([#49](https://github.com/thehashrocket/skywave/pull/49))

### Changed
- Merged Vercel's generated Web Analytics setup. The same analytics had already shipped in 0.23.0.0, so this merge changed no files.

## [0.23.0.0] - 2026-11-12 ([#48](https://github.com/thehashrocket/skywave/pull/48))

### Added
- **Share links.** A link like `/?f=9580&m=am&rx=host:port` opens skywave tuned there with that receiver pinned, ready for Listen. A Copy link button makes one.
- Link previews with a real title, description and a generated card image.
- Vercel Web Analytics.
- A public-site setting: on a public deployment the shared saved frequencies are read-only, and each browser keeps its own.

## [0.22.0.0] - 2026-11-12 ([#46](https://github.com/thehashrocket/skywave/pull/46))

### Added
- **Fairer use of volunteers' receivers.** By default only one skywave listener can use a given Kiwi at a time, and one address can hold at most two listeners. A full receiver is refused as busy, so Pick best moves on.

### Changed
- The listener-limit message now says why the limit exists.

### Fixed
- A late dial move after a session ended no longer opens a new channel on the receiver.

## [0.21.2.1] - 2026-11-11 ([#45](https://github.com/thehashrocket/skywave/pull/45))

### Changed
- The radio service now runs on a DigitalOcean Droplet behind Caddy with automatic TLS, and GitHub Actions redeploys it after CI passes on `main`.

## [0.21.2.0] - 2026-11-10 ([#43](https://github.com/thehashrocket/skywave/pull/43))

### Fixed
- Station names on the waterfall are no longer cut at about 12 characters. They show the station with a count of others on the frequency, like "Voice of Turkey +1".
- In Strong signals, the "+N more" count stays visible when a long station name is cut short.

## [0.21.1.1] - 2026-11-10 ([#42](https://github.com/thehashrocket/skywave/pull/42))

### Changed
- Updated fast-uri to 3.1.9 for its URI parsing security fixes.

## [0.21.1.0] - 2026-11-10 ([#44](https://github.com/thehashrocket/skywave/pull/44))

### Fixed
- Pick best now moves on when a receiver says it's full, refuses apps or wants a password within 15 seconds of starting to play, instead of leaving the page on "Problem".

## [0.21.0.1] - 2026-11-10 ([#41](https://github.com/thehashrocket/skywave/pull/41))

### Added
- A GitHub workflow refreshes the bundled EiBi schedule on 1 April and 1 November and opens a PR with the new copy.

## [0.21.0.0] - 2026-11-10 ([#40](https://github.com/thehashrocket/skywave/pull/40))

### Added
- **Station names from the EiBi schedule.** The station scheduled on your frequency shows under the readout ("KBS World Radio · English"), with "+N more" on a shared frequency.
- Strong signals rows name the station, and the wide waterfall marks each scheduled station in view.
- The schedule refreshes daily, with a bundled copy for when EiBi's site can't be reached.

## [0.20.0.0] - 2026-11-10 ([#39](https://github.com/thehashrocket/skywave/pull/39))

### Added
- **A wide waterfall from the receiver itself.** Choose Audio, 15 kHz, 60 kHz (the default), 230 kHz or the whole band. Click a signal to tune it, snapped to the channel step. The view follows the dial near its edges.
- It uses the waterfall stream the band scan already shares with the audio, so it takes no extra slot on the volunteer's Kiwi. It starts once the receiver has played for 10 seconds.

## [0.19.0.0] - 2026-11-10 ([#38](https://github.com/thehashrocket/skywave/pull/38))

### Added
- **Fine tuning on the readout.** With the pointer resting on the number, or the box focused, the mouse wheel and the Up and Down arrows step by the channel spacing: 9 or 10 kHz on medium wave depending on the receiver's region, 5 kHz for shortwave AM, 100 Hz for SSB and 10 Hz for CW. Shift steps ten at once.

### Changed
- A header strip shows "Listening via" and the receiver's place, with **change** and Listen/Stop. The receiver fields, list and map move into a drawer that closes once you choose a receiver.
- The dial switches to a shorter layout once audio plays, leaving room for the waterfall.

## [0.18.0.0] - 2026-11-10 ([#37](https://github.com/thehashrocket/skywave/pull/37))

### Added
- **Auto receiver by default.** Listen runs Pick best for the dial's frequency.
- **Pin a receiver** by choosing it from the table or map or typing an address. The ✕ goes back to Auto.
- **Switch receivers while listening,** without pressing Stop.
- **"Switch to a better receiver?"** When the playing receiver can't tune the frequency, or the dial has moved 1 MHz or more and another receiver is 12 dB stronger, skywave offers a switch. It never switches by itself.

## [0.17.0.0] - 2026-11-09 ([#36](https://github.com/thehashrocket/skywave/pull/36))

### Changed
- **Easier to read.** Ham band labels on the dial are darker, and the band row labels sit beside the dial where the needle can't run through them.
- On phones the readout fits its digits. Strong signals fills each column top to bottom, and the "Blank picks the best receiver" hint stays beside the Receiver label instead of vanishing with the placeholder.

## [0.16.1.1] - 2026-10-28 ([#34](https://github.com/thehashrocket/skywave/pull/34))

### Changed
- Documented why the ham-band scan was shelved, and two ideas for later, quick-tune buttons for the ham bands and live DX cluster spots.

## [0.16.1.0] - 2026-10-28 ([#35](https://github.com/thehashrocket/skywave/pull/35))

### Fixed
- Vercel builds no longer fail when a build cache is restored, because the build now generates the Prisma client itself.

## [0.16.0.0] - 2026-10-28 ([#32](https://github.com/thehashrocket/skywave/pull/32))

### Added
- **The web app runs on Vercel** with Neon Postgres. Each deploy applies database migrations first, so a failed migration leaves the previous deploy serving.
- A Vercel build refuses to put the radio token in public JavaScript when no site password is set. The README covers the setup.

## [0.15.2.0] - 2026-10-26 ([#31](https://github.com/thehashrocket/skywave/pull/31))

### Fixed
- When the radio service refuses or fails a retune, the dial and mode move back to what's actually playing.

## [0.15.1.2] - 2026-10-26 ([#30](https://github.com/thehashrocket/skywave/pull/30))

### Fixed
- A refused request now leaves the station playing, and the radio service checks tune input more strictly (ports, hosts, modes, deeply nested JSON) instead of dropping the socket and its audio.

## [0.15.1.1] - 2026-10-26 ([#29](https://github.com/thehashrocket/skywave/pull/29))

### Changed
- CI now runs the radio tests on Python 3.12 as well as 3.13, and radio service shutdown waits on every cleanup still closing a Kiwi within one deadline.

## [0.15.1.0] - 2026-10-25 ([#28](https://github.com/thehashrocket/skywave/pull/28))

### Fixed
- Stop, a receiver switch or the time limit no longer shows "Something broke" when cleanup hits an error, and a volunteer's Kiwi channel is never left open after its slot frees.
- On shutdown the radio service waits up to 5 seconds for sockets still closing their Kiwis.

## [0.15.0.0] - 2026-10-25 ([#27](https://github.com/thehashrocket/skywave/pull/27))

### Added
- **Idle browser sockets close.** A socket with nothing playing and no message for 10 minutes (`IDLE_SOCKET_MINUTES`) is closed quietly, and a Listen that crosses the hang-up is sent again on a new socket.
- **One address can hold at most 8 sockets** (`MAX_SOCKETS_PER_IP`), and the page explains when that limit is hit, mentioning that the network may be shared.

## [0.14.3.0] - 2026-10-25 ([#26](https://github.com/thehashrocket/skywave/pull/26))

### Fixed
- The "Stopped" or error status now goes out only after the Kiwi channel has closed and the slot is free, so reconnecting on it can't be refused or go over a volunteer's limit.
- The session time limit now fires even when a receiver goes quiet. A `MAX_SESSION_MINUTES` below 1 now stops the service at startup.

## [0.14.2.0] - 2026-10-23 ([#25](https://github.com/thehashrocket/skywave/pull/25))

### Fixed
- A listener slot now frees only after every socket on that Kiwi channel has closed, including after a cancelled switch and a band scan's waterfall, so another listener can't take it while the old channel is still open.

## [0.14.1.0] - 2026-10-23 ([#24](https://github.com/thehashrocket/skywave/pull/24))

### Fixed
- Fixed a flaky radio service test that tuned a second listener before the first one's slot was free. A new test checks the slot stays held until the Kiwi connection closes.

## [0.14.0.0] - 2026-10-23 ([#23](https://github.com/thehashrocket/skywave/pull/23))

### Added
- **A blank Listen runs Pick best,** and skywave remembers your last frequency and mode.
- Pick best leaves out receivers that refused (full, no apps, needs a password) for 15 minutes.

### Changed
- A design pass over the whole page brings a new order (dial, controls, waterfall, strong signals, presets, receivers), a status row that says where you're listening, and 44 px tap targets in the receiver list.
- The readout accepts kHz and MHz units and flags bad input with "Enter 10 to 30,000 kHz".

## [0.13.1.0] - 2026-10-22 ([#22](https://github.com/thehashrocket/skywave/pull/22))

### Fixed
- Coming back to a receiver within 30 seconds no longer shows the old scan answer. The scan waits out the 30-second limit and runs fresh, and the limit now counts per address and receiver across all connections.

## [0.13.0.0] - 2026-10-22 ([#21](https://github.com/thehashrocket/skywave/pull/21))

### Added
- **Strong signals now.** About 10 seconds after a receiver starts playing, skywave scans its medium wave and 14 shortwave broadcast bands and lists the strongest carriers. Click one to tune it in AM.
- The scan shares the audio's channel on the Kiwi, so it takes no extra slot and never ends the audio. Results are shared for 10 minutes, and each listener gets at most one scan every 30 seconds.

## [0.12.1.3] - 2026-10-22 ([#20](https://github.com/thehashrocket/skywave/pull/20))

### Changed
- Documented how to run the web app when port 3000 is already taken.

## [0.12.1.2] - 2026-10-22 ([#19](https://github.com/thehashrocket/skywave/pull/19))

### Changed
- Documented the phone controls that still have tap targets under 44 px.

## [0.12.1.1] - 2026-10-22 ([#18](https://github.com/thehashrocket/skywave/pull/18))

### Added
- Added DESIGN.md, which records the web app's existing colors, type, layout and components.

## [0.12.1.0] - 2026-10-22 ([#17](https://github.com/thehashrocket/skywave/pull/17))

### Fixed
- A dial move made while switching receivers is no longer lost when the connection drops, so the dial and the audio stay on the same frequency.

## [0.12.0.0] - 2026-10-22 ([#16](https://github.com/thehashrocket/skywave/pull/16))

### Changed
- **Bigger tap targets on phones.** Inline buttons such as Retry map, Browse receivers, Reload page and Try again now have 44 px tap targets.
- The map credits start folded on narrow screens instead of covering the map.

## [0.11.0.1] - 2026-10-22 ([#15](https://github.com/thehashrocket/skywave/pull/15))

### Changed
- Documented two phone problems to fix, small inline tap targets and map credits that cover the map.

## [0.11.0.0] - 2026-10-22 ([#14](https://github.com/thehashrocket/skywave/pull/14))

### Added
- **Pick best moves on after a late refusal.** If a receiver plays and then refuses apps within 15 seconds, Pick best tries the next one.
- After a deploy, the map offers "Reload page" when its code can't load.

### Fixed
- Receiver list ages now come from the server, so a wrong computer clock doesn't skew them, and Try again shows "Trying again…" while it works.

## [0.10.0.0] - 2026-10-21 ([#13](https://github.com/thehashrocket/skywave/pull/13))

### Added
- **A greyline receiver map.** Every listed receiver with a position appears on a map shaded for night and twilight and redrawn each minute. Dots show night, full, out-of-range, connecting and listening receivers. Click one to see a card, then Listen to switch.
- If the map can't load or draw, it says why and offers Retry map and Browse receivers.

## [0.9.0.0] - 2026-10-21 ([#12](https://github.com/thehashrocket/skywave/pull/12))

### Changed
- **The receiver table holds still.** When the list refreshes, rows stay put and a "List updated. Show it" line offers the new copy.

### Fixed
- Back offers the last receiver that played unless it's already on screen, and Pick best's way back keeps the old receiver's https and list settings.
- An unknown error no longer leaves the page on "Connecting…", and a radio service that never opens is reported as unreachable after 10 seconds.
- With no list loaded yet, the picker tries again every 15 seconds instead of every 15 minutes.

## [0.8.0.0] - 2026-10-21 ([#11](https://github.com/thehashrocket/skywave/pull/11))

### Added
- **A Night column** in the receiver table says whether the sun has set at each receiver right now, and sorts night first.
- **Back to the previous receiver:** a link beside the status line returns to the last receiver that played.

### Changed
- A tune from idle reads "Connecting…" with a Stop button, and the table rings the receiver being tuned until it plays.
- The page now reads radio first, then a Receivers section with Pick best and the folded table.

## [0.7.2.0] - 2026-10-21 ([#10](https://github.com/thehashrocket/skywave/pull/10))

### Fixed
- Receivers whose owners allow only the Kiwi's own web page (about 1 in 6) are dropped from the list, so Pick best stops offering them. When one refuses anyway, the message says so and Pick best names the reason.
- A saved receiver that refuses apps is forgotten, and a "full" message now gives the receiver's listener limit.

## [0.7.1.0] - 2026-10-21 ([#9](https://github.com/thehashrocket/skywave/pull/9))

### Fixed
- Receivers sending just enough audio are no longer dropped for a frame they sent in time.

## [0.7.0.0] - 2026-10-21 ([#8](https://github.com/thehashrocket/skywave/pull/8))

### Fixed
- **A broken receiver can't hold a listener slot.** A receiver that sends only status messages, empty blocks or a trickle of audio now times out, and a Kiwi that stops reading is let go.
- A slow browser tab is no longer blamed on a healthy receiver.
- A corrupt frame can no longer stall audio or blank the waterfall, because oversized audio frames and spectrum rows with impossible values are skipped.

## [0.6.0.0] - 2026-10-21 ([#7](https://github.com/thehashrocket/skywave/pull/7))

### Changed
- **The stream uses less than half the data.** Audio and waterfall frames are now sent in a compact format, cutting each listener's stream from 556 to 237 kbit/s.

### Fixed
- A receiver block with no samples no longer crashes the session.

## [0.5.1.0] - 2026-10-20 ([#6](https://github.com/thehashrocket/skywave/pull/6))

### Added
- Dependabot checks the pnpm dependencies weekly.

### Fixed
- About a third of public receivers connected and then sent nothing. They now play, because skywave dials the path current KiwiSDR firmware answers on.

## [0.5.0.0] - 2026-10-20 ([#5](https://github.com/thehashrocket/skywave/pull/5))

### Changed
- **The receiver list keeps only entries on KiwiSDR ports** (80 and 8070 to 8079, plus 443 for https), and the parser refuses odd entries, more private address ranges and overlong fields.
- Receivers of equal rank are shuffled per visitor instead of following the mirror's order, and IPv6 addresses show in brackets, so a copied address pastes back.
- A pasted URL without a port gets the right default port.

## [0.4.0.0] - 2026-10-20 ([#4](https://github.com/thehashrocket/skywave/pull/4))

### Changed
- **Pick best says plainly where it's going back to:** "Going back to X…", then "Back on X" or "Couldn't get back to X". A receiver that was still connecting counts as one to go back to.
- Only a receiver that actually plays is saved, and bad saved data starts fresh instead of crashing the page.

### Fixed
- When the public list stops answering, the last copy is still shown with its age, and a failed refresh over a usable list no longer shows an error.

## [0.3.0.0] - 2026-10-20 ([#3](https://github.com/thehashrocket/skywave/pull/3))

### Added
- **Receivers that use https now work,** from the list or a pasted `https://` address.

### Changed
- Each listener gets their own address-lookup limit, and a busy lookup asks Pick best to retry the same receiver once.

### Fixed
- A browser tab that stops reading no longer leaves the stream on a silent "Listening": the session ends after 15 seconds.

## [0.2.0.1] - 2026-10-20 ([#2](https://github.com/thehashrocket/skywave/pull/2))

### Added
- CI runs the typecheck and both test suites on every push.

## [0.2.0.0] - 2026-10-20 ([#1](https://github.com/thehashrocket/skywave/pull/1))

### Added
- **Pick best receiver.** One click tunes the strongest public receiver that covers your frequency, moves on if one fails, and goes back to what was playing if nothing works.
- **Browse the public receiver list.** Search, filter (covers this frequency, has a free slot) and sort it, and switch receivers mid-listen. Pasted receiver URLs work too.
- The list comes from a public KiwiSDR mirror, is cached for 15 minutes, and leaves out entries skywave can't dial.

## [0.1.0.0] - 2026-10-19

### Added
- **Listen to public KiwiSDR receivers in the browser.** Paste a receiver's address, press Listen and hear AM, USB, LSB or CW, demodulated by skywave's own radio service.
- A dial that switches to the usual sideband in ham bands, a frequency readout you can type into, an S-meter, a waterfall you can click to tune, and saved frequencies.
- An optional site password (`APP_PASSWORD`).
- The radio service dials only public addresses, needs a token when served beyond localhost, and caps how many listeners it serves and for how long.
