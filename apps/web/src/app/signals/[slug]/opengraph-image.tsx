import { ImageResponse } from "next/og";
import { findStation, SIGNAL_STATIONS } from "@/lib/signal-stations";

// The card a shared station link shows (#103): the station's name in the site
// card's look, so a UVB-76 link on Reddit or Discord shows UVB-76.
export const alt = "A signal station on skywave";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

// Only catalog stations get a card; any other slug is a 404, not an image rendered on demand.
export const dynamicParams = false;

export function generateStaticParams() {
  return SIGNAL_STATIONS.map((s) => ({ slug: s.slug }));
}

export default async function StationImage({ params }: { params: Promise<{ slug: string }> }) {
  const station = findStation((await params).slug);
  // Any other slug is a 404, never a card rendered on demand.
  if (!station) return new Response(null, { status: 404 });
  const name = station.name;
  const aka = station.aka[0];
  const defunct = station.schedule.kind === "defunct";
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
      <div style={{ display: "flex", fontSize: 40, fontWeight: 700, color: "#f2c55c" }}>skywave</div>
      <div style={{ display: "flex", flexDirection: "column" }}>
        <div style={{ fontSize: 120, fontWeight: 700, color: "#d4e6d8", letterSpacing: -2 }}>{name}</div>
        {aka && <div style={{ fontSize: 48, marginTop: 8, color: "#9db8b0" }}>{aka}</div>}
      </div>
      <div style={{ display: "flex", fontSize: 36, color: "#d4e6d8" }}>
        {defunct ? "Off the air now: its history" : "Listen live through receivers around the world"}
      </div>
    </div>,
    size,
  );
}
