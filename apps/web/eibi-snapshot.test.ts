import { describe, expect, it, vi } from "vitest";
import { snapshot } from "./scripts/eibi-snapshot";

const HEADER = "kHz:75;Time(UTC):93;Days:59;ITU:49;Station:201;Lng:49;Target:62;Remarks:135;P:35;Start:60;Stop:60;";

describe("eibi:snapshot", () => {
  // Value: protects=the refresh script asks for the season's file, keeps it as decoded Latin-1 text with its season, and refuses to write anything that isn't the schedule; fails_when=a moved file or error page becomes the bundled fallback, or accented names are garbled in it; why_new=owner decision: bundled snapshot; seam=fetch; no_claim=eibispace.de's availability
  it("saves the season's file, and only the schedule", async () => {
    const file = `${HEADER}\r\n9580;0000-2400;;B;Rádio Nacional;P;SAm;;1;;\r\n`;
    const fetchImpl = vi.fn(async () => new Response(Buffer.from(file, "latin1")));
    const { json, count } = await snapshot("b26", fetchImpl as unknown as typeof fetch);
    expect(fetchImpl).toHaveBeenCalledWith("http://www.eibispace.de/dx/sked-b26.csv", { redirect: "error" });
    expect(count).toBe(1);
    expect(JSON.parse(json)).toEqual({ season: "b26", csv: file });
    fetchImpl.mockImplementation(async () => new Response("<html>moved</html>"));
    await expect(snapshot("b26", fetchImpl as unknown as typeof fetch)).rejects.toThrow(/header/);
    fetchImpl.mockImplementation(async () => new Response("", { status: 404 }));
    await expect(snapshot("b26", fetchImpl as unknown as typeof fetch)).rejects.toThrow(/404/);
  });
});
