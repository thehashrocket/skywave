import { covers, findReceiver, isFull, rankReceivers, receiverKey, type Receiver } from "./kiwi-list";

/**
 * The list's SNR is one figure for the whole HF range, not per frequency, so a
 * stronger receiver is only worth mentioning after a real move: at least this
 * far from where the playing receiver started (or where the listener last said
 * "Not now").
 */
export const JUMP_KHZ = 1_000;

/** How much stronger (listed HF SNR) another receiver must be: about two S-units. */
export const BETTER_SNR_DB = 12;

export type Suggestion = { target: Receiver; playing: Receiver } & (
  | { reason: "uncovered" } // The playing receiver can't tune the frequency.
  | { reason: "stronger"; gapDb: number } // Whole dB, rounded down so it never overstates.
);

/**
 * Whether to offer a better receiver for the dial's frequency. Never acts: the
 * page only shows the offer, and switching takes a click.
 *
 * A receiver the list doesn't know (typed in) gets no offer, since its range
 * and signal are unknown. The target is the best-ranked receiver that covers
 * the frequency, isn't the one playing, isn't full and isn't excluded (it
 * just refused, or the listener already said Not now to it).
 */
export function suggestBetter(a: {
  receivers: readonly Receiver[];
  playing: { host: string; port: number };
  freqKhz: number;
  anchorKhz: number;
  exclude: (r: Receiver) => boolean;
}): Suggestion | null {
  const playing = findReceiver(a.receivers, a.playing.host, a.playing.port);
  if (!playing) return null;
  const playingKey = receiverKey(playing);
  const target = rankReceivers(a.receivers, a.freqKhz).find(
    (r) => receiverKey(r) !== playingKey && !isFull(r) && !a.exclude(r),
  );
  if (!target) return null;
  if (!covers(playing, a.freqKhz)) return { reason: "uncovered", target, playing };
  if (Math.abs(a.freqKhz - a.anchorKhz) < JUMP_KHZ || target.snr === null || playing.snr === null) return null;
  const gap = target.snr - playing.snr;
  return gap >= BETTER_SNR_DB ? { reason: "stronger", gapDb: Math.floor(gap), target, playing } : null;
}
