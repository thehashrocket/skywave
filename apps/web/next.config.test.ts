import { describe, expect, it } from "vitest";
import { assertCronSecretSet, assertRadioTokenGuarded } from "./next.config";

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

  it("passes a public site's Vercel build with the token and no password", () => {
    expect(() =>
      assertRadioTokenGuarded({ VERCEL: "1", NEXT_PUBLIC_RADIO_TOKEN: "t", NEXT_PUBLIC_SITE_PUBLIC: "1" }),
    ).not.toThrow();
  });

  it("passes a Vercel build with no token", () => {
    expect(() => assertRadioTokenGuarded({ VERCEL: "1" })).not.toThrow();
  });
});

describe("assertCronSecretSet", () => {
  // Value: protects=a Production Vercel build without CRON_SECRET fails loudly instead of deploying a cron route that refuses every run (each lost skimmer day is unrecoverable), while previews and local builds still pass; fails_when=the guard is removed, checks the wrong environment, or accepts an empty value; why_new=/ship Step 11, both Codex passes (owner D5); seam=none; no_claim=Vercel exposing the variable at build time
  it("fails only a Production build without the secret", () => {
    expect(() => assertCronSecretSet({ VERCEL_ENV: "production", CRON_SECRET: "" })).toThrow(/CRON_SECRET/);
    expect(() => assertCronSecretSet({ VERCEL_ENV: "production" })).toThrow(/CRON_SECRET/);
    expect(() => assertCronSecretSet({ VERCEL_ENV: "production", CRON_SECRET: "s" })).not.toThrow();
    expect(() => assertCronSecretSet({ VERCEL_ENV: "preview" })).not.toThrow();
    expect(() => assertCronSecretSet({})).not.toThrow();
  });
});
