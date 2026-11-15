// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { playThroughSilentMode } from "./use-radio";

function withSession(session: unknown) {
  Object.defineProperty(navigator, "audioSession", { value: session, configurable: true });
}

describe("playThroughSilentMode", () => {
  afterEach(() => {
    Reflect.deleteProperty(navigator, "audioSession");
    vi.restoreAllMocks();
  });

  // Value: protects=iPhones on silent hear the radio (Web Audio is otherwise muted by the ring switch with no error); fails_when=the session type isn't set to "playback"; why_new=on an iPhone in silent mode the spectrum moved but nothing played; seam=a fake navigator.audioSession; no_claim=iOS's actual routing
  it("asks for the playback session where the browser offers one", () => {
    const session = { type: "auto" };
    withSession(session);
    playThroughSilentMode();
    expect(session.type).toBe("playback");
  });

  // Value: protects=browsers without the API, or that reject the value, still start audio; fails_when=it throws on a missing session or a setter that throws; why_new=new call on the Listen path; seam=fake session; no_claim=none
  it("does nothing where there's no session, and swallows a rejected value", () => {
    expect(() => playThroughSilentMode()).not.toThrow();
    withSession({
      get type() {
        return "auto";
      },
      set type(_v: string) {
        throw new TypeError("unsupported");
      },
    });
    expect(() => playThroughSilentMode()).not.toThrow();
  });
});
