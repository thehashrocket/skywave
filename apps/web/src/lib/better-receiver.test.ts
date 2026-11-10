import { describe, expect, it } from "vitest";
import { BETTER_SNR_DB, JUMP_KHZ, suggestBetter } from "./better-receiver";
import type { Receiver } from "./kiwi-list";

function rx(host: string, over: Partial<Receiver> = {}): Receiver {
  return {
    id: host,
    name: host.toUpperCase(),
    location: "",
    antenna: "",
    host,
    port: 8073,
    users: 0,
    usersMax: 8,
    snr: 20,
    minKhz: 0,
    maxKhz: 30_000,
    ...over,
  };
}

const here = rx("here", { snr: 10 });
const never = () => false;
const at = (freqKhz: number, anchorKhz: number, receivers: Receiver[], exclude: (r: Receiver) => boolean = never) =>
  suggestBetter({ receivers, playing: { host: "here", port: 8073 }, freqKhz, anchorKhz, exclude });

describe("suggestBetter", () => {
  // Value: protects=a receiver that can't tune the dial's frequency gets an offer at once, whatever the move; fails_when=the uncovered case waits on the jump or SNR gates; why_new=switch prompt; seam=none; no_claim=whether the Kiwi itself refuses the tune (it doesn't: the service checks a global range)
  it("offers the best covering receiver when the playing one can't tune the frequency", () => {
    const narrow = rx("here", { snr: 40, minKhz: 0, maxKhz: 10_000 });
    const s = at(15_000, 14_990, [narrow, rx("other", { snr: 5 })]);
    expect(s?.reason).toBe("uncovered");
    expect(s?.target.host).toBe("other");
  });

  // Value: protects=a stronger receiver is offered only after a real move and a real gap (the list's SNR isn't per-frequency, so either alone would nag); fails_when=either gate is dropped or the thresholds slip by one; why_new=switch prompt thresholds (owner: ≥1 MHz, ≥12 dB); seam=none; no_claim=whether the list's SNR predicts reception
  it("offers a much stronger receiver only after a big move", () => {
    const strong = rx("strong", { snr: 10 + BETTER_SNR_DB });
    expect(at(10_000 + JUMP_KHZ, 10_000, [here, strong])?.reason).toBe("stronger");
    expect(at(10_000 - JUMP_KHZ, 10_000, [here, strong])?.reason).toBe("stronger");
    expect(at(10_000 + JUMP_KHZ - 1, 10_000, [here, strong])).toBeNull();
    expect(at(10_000 + JUMP_KHZ, 10_000, [here, rx("strong", { snr: 10 + BETTER_SNR_DB - 1 })])).toBeNull();
  });

  // Value: protects=the gap the prompt reads out is whole dB, rounded down so it never claims more than the list says; fails_when=raw float arithmetic reaches the text ("14.299999999999997 dB"); why_new=conventions review; seam=none; no_claim=none beyond protects
  it("reports the gap in whole dB, rounded down", () => {
    const s = at(20_000, 5_000, [rx("here", { snr: 10.1 }), rx("strong", { snr: 24.4 })]);
    expect(s).toMatchObject({ reason: "stronger", gapDb: 14 });
  });

  // Value: protects=no offer is made on missing data: an unlisted (typed) receiver, or an unknown SNR on either side; fails_when=a null SNR reads as 0 or -1 and triggers "stronger", or an unlisted receiver gets offers; why_new=switch prompt; seam=none; no_claim=none beyond protects
  it("stays quiet without the data to judge", () => {
    expect(
      suggestBetter({
        receivers: [rx("strong", { snr: 40 })],
        playing: { host: "typed.example", port: 8073 },
        freqKhz: 20_000,
        anchorKhz: 5_000,
        exclude: never,
      }),
    ).toBeNull();
    expect(at(20_000, 5_000, [rx("here", { snr: null }), rx("strong", { snr: 40 })])).toBeNull();
    expect(at(20_000, 5_000, [here, rx("strong", { snr: null })])).toBeNull();
  });

  // Value: protects=the offer never names a receiver that's full, excluded (just refused, or dismissed), or the one already playing, and moves on to the next; fails_when=the target skips any of those filters, so accepting cuts audio for a refusal; why_new=switch prompt; seam=none; no_claim=the refusal memory itself (use-pick-best tests)
  it("skips full, excluded and playing receivers, and matches the host in any case", () => {
    const list = [
      rx("HERE", { snr: 10 }),
      rx("full", { snr: 50, users: 8 }),
      rx("refused", { snr: 45 }),
      rx("next", { snr: 30 }),
    ];
    const s = at(20_000, 5_000, list, (r) => r.host === "refused");
    expect(s?.target.host).toBe("next");
    expect(s?.playing.host).toBe("HERE");
    expect(at(20_000, 5_000, [here])).toBeNull();
  });
});
