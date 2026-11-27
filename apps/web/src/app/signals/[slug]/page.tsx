import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { SignalLive } from "@/components/SignalLive";
import { SiteFooter } from "@/components/SiteFooter";
import { PRIYOM_SCHEDULE_PAGE } from "@/lib/priyom-schedule";
import { CATEGORY_HEADINGS, channelText, checkedText, listenHref, pageDescription, scheduleLines, stationHref } from "@/lib/signal-page";
import { findStation, SIGNAL_STATIONS } from "@/lib/signal-stations";

// One page per catalog station, built at deploy (#103); any other slug is a 404.
export const dynamicParams = false;

export function generateStaticParams() {
  return SIGNAL_STATIONS.map((s) => ({ slug: s.slug }));
}

type Params = { params: Promise<{ slug: string }> };

/** "UVB-76 (The Buzzer)" for a title, or the bare name. */
function titleName(name: string, aka: readonly string[]): string {
  return aka.length ? `${name} (${aka[0]})` : name;
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const station = findStation((await params).slug);
  if (!station) return {};
  const defunct = station.schedule.kind === "defunct";
  const title = `${titleName(station.name, station.aka)}${defunct ? "" : ": listen live"} · skywave`;
  const description = pageDescription(station);
  return {
    title,
    description,
    alternates: { canonical: `/signals/${station.slug}` },
    openGraph: { title, description, type: "website", siteName: "skywave", url: `/signals/${station.slug}` },
    twitter: { card: "summary_large_image", title, description },
  };
}

/** A source's site, as the link's text. */
function sourceName(url: string): string {
  const host = new URL(url).hostname.replace(/^www\./, "");
  if (host.endsWith("wikipedia.org")) return "Wikipedia";
  if (host === "priyom.org") return "Priyom";
  if (host === "nist.gov") return "NIST";
  return host;
}

/**
 * A signal station's own page (#103): what it is, where it's sent from, its
 * frequencies and schedule, whether it's on now (with Listen, which opens the
 * main page tuned to it), when listeners last heard it, and where to read
 * more. Built at deploy from the catalog; the live part fills in on the
 * client. A station off the air for good gets its history and no Listen.
 * Blurbs are our own words; sources are linked, never copied.
 */
export default async function SignalStationPage({ params }: Params) {
  const station = findStation((await params).slug);
  if (!station) notFound();
  const defunct = station.schedule.kind === "defunct";
  const category = CATEGORY_HEADINGS.find(([c]) => c === station.category)?.[1] ?? station.category;
  return (
    <main className="console">
      <header className="console-header">
        <Link href="/" className="wordmark owners-wordmark">
          skywave
        </Link>
      </header>

      <article className="owners-body signal-page">
        <p className="signal-crumbs">
          <Link href="/signals">Signal stations</Link> · {defunct ? "History" : category}
        </p>
        <h1 className="owners-title">{station.name}</h1>
        {station.aka.length > 0 && <p className="signal-aka">Also called {station.aka.join(", ")}</p>}
        <p className="owners-lede">{station.blurb}</p>

        {!defunct && <SignalLive slug={station.slug} />}

        {station.tx && (
          <section aria-labelledby="signal-where">
            <h2 id="signal-where">Where it&rsquo;s sent from</h2>
            <p>
              {station.tx.label}
              {station.tx.confidence === "approx" ? " (reported area)" : ""}
              {station.tx.confidence === "country" ? " (country only)" : ""}
            </p>
          </section>
        )}

        <section aria-labelledby="signal-when">
          <h2 id="signal-when">{defunct ? "History" : "When and where to tune"}</h2>
          {scheduleLines(station).map((line) => (
            <p key={line}>{line}</p>
          ))}
          {!defunct && station.channels.length > 0 && (
            <ul className="signal-channels">
              {station.channels.map((ch) => (
                <li key={ch.khz}>
                  <span className="signal-freq">{channelText(ch)}</span>{" "}
                  <Link href={listenHref(station, ch)} aria-label={`Tune ${station.name} on ${channelText(ch)}`}>
                    Tune it
                  </Link>
                </li>
              ))}
            </ul>
          )}
          {!defunct && station.priyom && (
            <p>
              Its frequencies change, so skywave takes each transmission from{" "}
              <a href={PRIYOM_SCHEDULE_PAGE} target="_blank" rel="noreferrer">
                Priyom&rsquo;s schedule
              </a>{" "}
              (CC BY-NC-SA 4.0).{" "}
              <Link href={stationHref(station)}>Open it in skywave</Link> to see it in the Signal stations panel,
              with Listen when it&rsquo;s on.
            </p>
          )}
          {!defunct && (
            <p className="signal-note">
              Tune opens skywave on that frequency; press Listen there and it picks a receiver by the path from
              the transmitter. A station can be off the air or too weak to hear on the receiver it picks.
            </p>
          )}
        </section>

        {station.sources.length > 0 && (
          <section aria-labelledby="signal-sources">
            <h2 id="signal-sources">Read more</h2>
            <ul>
              {station.sources.map((url) => (
                <li key={url}>
                  <a href={url} target="_blank" rel="noreferrer">
                    {sourceName(url)}
                  </a>
                </li>
              ))}
            </ul>
            <p className="signal-note">Details checked {checkedText(station.checked)}</p>
          </section>
        )}
      </article>
      <SiteFooter />
    </main>
  );
}
