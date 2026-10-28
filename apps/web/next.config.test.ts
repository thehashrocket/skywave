import { describe, expect, it } from "vitest";
import { assertRadioTokenGuarded } from "./next.config";

describe("assertRadioTokenGuarded", () => {
  it("fails a Vercel build with the token and no password", () => {
    expect(() =>
      assertRadioTokenGuarded({ VERCEL: "1", NEXT_PUBLIC_RADIO_TOKEN: "t", APP_PASSWORD: "" }),
    ).toThrow(/APP_PASSWORD/);
  });

  it("passes a Vercel build with the token and a password", () => {
    expect(() =>
      assertRadioTokenGuarded({ VERCEL: "1", NEXT_PUBLIC_RADIO_TOKEN: "t", APP_PASSWORD: "p" }),
    ).not.toThrow();
  });

  it("passes a local build with the token and no password", () => {
    expect(() => assertRadioTokenGuarded({ NEXT_PUBLIC_RADIO_TOKEN: "t" })).not.toThrow();
  });

  it("passes a Vercel build with no token", () => {
    expect(() => assertRadioTokenGuarded({ VERCEL: "1" })).not.toThrow();
  });
});
