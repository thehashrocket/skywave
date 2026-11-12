// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { SiteFooter } from "./SiteFooter";

afterEach(cleanup);

const footerLinks = () => within(screen.getByRole("contentinfo")).getAllByRole("link");

describe("SiteFooter", () => {
  // Value: protects=on the listening page every footer link opens a new tab, so following one never unmounts the player and cuts the audio; fails_when=a link loses target="_blank" or the owners link goes back to a same-tab next/link with onPlayer set; why_new=new footer on the listening page; seam=none; no_claim=browser tab behavior (jsdom doesn't navigate)
  it("opens every link in a new tab on the listening page", () => {
    render(<SiteFooter onPlayer />);
    const links = footerLinks();
    expect(links.map((a) => a.textContent)).toEqual(["Jason Shultz", "Source on GitHub", "For Kiwi owners"]);
    for (const a of links) expect(a.getAttribute("target"), a.textContent!).toBe("_blank");
  });

  // Value: protects=the credit links to the author's site and the owners link stays in the same tab off the player; fails_when=the author URL changes or the owners link starts opening tabs from /owners itself; why_new=new footer; seam=none; no_claim=client-side routing
  it("credits the author and keeps the owners link in the same tab off the player", () => {
    render(<SiteFooter />);
    expect(screen.getByRole("link", { name: "Jason Shultz" }).getAttribute("href")).toBe("https://jasonshultz.com");
    const owners = screen.getByRole("link", { name: "For Kiwi owners" });
    expect(owners.getAttribute("href")).toBe("/owners");
    expect(owners.getAttribute("target")).toBeNull();
  });
});
