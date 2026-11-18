import { describe, expect, it } from "vitest";
import type { Broadcast } from "./eibi";
import { eibiTransmitter } from "./reception";

const b = (station: string, lang = "E", target = "Eu", khz = 9_580): Broadcast => ({
  khz,
  start: 0,
  end: 1440,
  days: "",
  station,
  lang,
  target,
});

describe("eibiTransmitter", () => {
  it("is null with nothing scheduled", () => {
    expect(eibiTransmitter([])).toBeNull();
  });

  it("names one station, with its first listing's language and target", () => {
    expect(eibiTransmitter([b("KBS World Radio", "E", "NAm"), b("KBS World Radio", "K", "NAm")])).toEqual({
      kind: "eibi",
      name: "KBS World Radio",
      detail: "E/NAm",
      label: "KBS World Radio",
    });
  });

  it.each([
    [["A", "B"], "anything from A or B", "A / B"],
    [["A", "B", "C"], "anything from A, B or C", "A / B / C"],
  ])("asks about %j together", (stations, label, name) => {
    expect(eibiTransmitter(stations.map((s) => b(s)))).toEqual({ kind: "eibi", name, label });
  });

  it("names only the nearest listing when more than three share it", () => {
    const tx = eibiTransmitter(["Near", "B", "C", "D"].map((s) => b(s)));
    expect(tx).toMatchObject({ name: "Near", label: "Near" });
  });
});
