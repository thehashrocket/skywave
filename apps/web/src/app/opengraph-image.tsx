import { ImageResponse } from "next/og";

// The card a shared link shows on Reddit, Mastodon, Discord and the rest.
export const alt = "skywave: listen to shortwave and ham radio through receivers around the world";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

// A frozen slice of waterfall: deterministic, so every build draws the same card.
const ROWS = 11;
const COLS = 60;
function level(r: number, c: number): number {
  const carrier = Math.exp(-((c - 18) ** 2) / 3) + 0.8 * Math.exp(-((c - 41) ** 2) / 6);
  const noise = (Math.sin(r * 12.9898 + c * 78.233) * 43758.5453) % 1;
  return Math.min(1, carrier + Math.abs(noise) * 0.18);
}

export default function OpengraphImage() {
  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        padding: "64px 72px",
        background: "#0b1e24",
        color: "#e6eee8",
      }}
    >
      <div style={{ display: "flex", flexDirection: "column" }}>
        <div style={{ fontSize: 96, fontWeight: 700, color: "#f2c55c", letterSpacing: -2 }}>skywave</div>
        <div style={{ fontSize: 38, marginTop: 12, color: "#d4e6d8", maxWidth: 900 }}>
          Listen to shortwave and ham radio through receivers around the world, right in your browser.
        </div>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
        {Array.from({ length: ROWS }, (_, r) => (
          <div key={r} style={{ display: "flex", gap: 3 }}>
            {Array.from({ length: COLS }, (_, c) => {
              const v = level(r, c);
              return (
                <div
                  key={c}
                  style={{
                    width: 14.6,
                    height: 12,
                    background: v > 0.6 ? "#f2c55c" : v > 0.3 ? "#c19a4b" : "#1b3f4a",
                    opacity: 0.35 + v * 0.65,
                  }}
                />
              );
            })}
          </div>
        ))}
      </div>
    </div>,
    size,
  );
}
