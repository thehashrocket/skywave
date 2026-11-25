// @vitest-environment jsdom
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import OwnersPage from "./page";

// A path, not new URL(…, import.meta.url): under jsdom Vite rewrites that into a dev-server URL.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../..");

afterEach(cleanup);

describe("/owners", () => {
  // Value: protects=an owner's opt-out link opens the repo's opt-out issue form; fails_when=the form file is renamed or moved, or the link's template= drifts from it (GitHub then shows a blank issue); why_new=new page and form; seam=none; no_claim=that GitHub renders the form or the repo is public
  it("links owners to the opt-out issue form that exists in the repo", () => {
    render(<OwnersPage />);
    const link = screen.getByRole("link", { name: "Open an opt-out request" });
    const template = new URL(link.getAttribute("href")!).searchParams.get("template");
    expect(template).toBeTruthy();
    expect(existsSync(resolve(REPO_ROOT, ".github/ISSUE_TEMPLATE", template!))).toBe(true);
  });

  // Value: protects=the page names both identities owners see in their user list: the service's own and a named listener's "skywave <name>"; fails_when=the heading, the skywavehf.com name or the named-listener form is dropped from the lede; why_new=new page, and named listeners (#108); seam=none; no_claim=what KIWI_IDENT is set to in production
  it("names the identities owners see in their Kiwi's user list", () => {
    const { container } = render(<OwnersPage />);
    expect(screen.getByRole("heading", { level: 1, name: "For KiwiSDR owners" })).toBeTruthy();
    expect(screen.getByText("skywavehf.com")).toBeTruthy();
    const lede = container.querySelector(".owners-lede")?.textContent?.replace(/\s+/g, " ");
    expect(lede).toContain("shows as skywave followed by it, like “skywave N0CALL”");
  });
});
