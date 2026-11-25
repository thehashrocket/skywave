import type { Metadata } from "next";
import Link from "next/link";
import { SiteFooter } from "@/components/SiteFooter";
import { CATEGORY_HEADINGS } from "@/lib/signal-page";
import { SIGNAL_STATIONS, type SignalStation } from "@/lib/signal-stations";

const description =
  "Time signals, markers like UVB-76 and numbers stations you can tune live through public shortwave receivers, plus the ones now off the air.";

export const metadata: Metadata = {
  title: "Signal stations: time signals, markers and numbers stations · skywave",
  description,
  alternates: { canonical: "/signals" },
  openGraph: { title: "Signal stations · skywave", description, type: "website", siteName: "skywave", url: "/signals" },
};

function StationList({ stations }: { stations: readonly SignalStation[] }) {
  return (
    <ul className="signal-index">
      {stations.map((s) => (
        <li key={s.slug}>
          <Link href={`/signals/${s.slug}`}>{s.name}</Link>
          {s.aka.length > 0 && <span className="signals-aka"> · {s.aka.join(", ")}</span>}
          <span className="signal-index-blurb">{s.blurb}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * Every station in the catalog (#103), grouped like the Signal stations
 * panel, each linking to its own page: one address for search engines and
 * for others to link to. The live schedule is on each page and in the panel.
 */
export default function SignalStationsIndex() {
  const live = SIGNAL_STATIONS.filter((s) => s.schedule.kind !== "defunct");
  const history = SIGNAL_STATIONS.filter((s) => s.schedule.kind === "defunct");
  return (
    <main className="console">
      <header className="console-header">
        <Link href="/" className="wordmark owners-wordmark">
          skywave
        </Link>
      </header>
      <article className="owners-body signal-page">
        <h1 className="owners-title">Signal stations</h1>
        <p className="owners-lede">
          The oddities people tune shortwave to find. Each page says what the station is, where and when to tune,
          and links to skywave tuned to it, where Listen picks a receiver near its path.
        </p>
        {CATEGORY_HEADINGS.map(([category, heading]) => {
          const stations = live.filter((s) => s.category === category);
          if (stations.length === 0) return null;
          return (
            <section key={category} aria-labelledby={`signals-${category}`}>
              <h2 id={`signals-${category}`}>{heading}</h2>
              <StationList stations={stations} />
            </section>
          );
        })}
        {history.length > 0 && (
          <section aria-labelledby="signals-history">
            <h2 id="signals-history">Off the air</h2>
            <StationList stations={history} />
          </section>
        )}
      </article>
      <SiteFooter />
    </main>
  );
}
