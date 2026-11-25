"use client";

import Link from "next/link";
import { formatWait } from "@/lib/ghostnet";
import { nextTx, onAirTx, PRIYOM_ON_AIR_MS, PRIYOM_SCHEDULE_PAGE, type PriyomTx } from "@/lib/priyom-schedule";
import { channelText, listenHref } from "@/lib/signal-page";
import {
  activeChannelAt,
  findStation,
  nextStartAfter,
  windowSpanAt,
  type SignalChannel,
} from "@/lib/signal-stations";
import { usePriyomSchedule } from "@/lib/use-priyom-schedule";
import { useServerTick } from "@/lib/use-server-tick";
import { useSignalLastHeard } from "@/lib/use-signal-last-heard";
import { localLabel, utcLabel } from "@/lib/utc-time";
import { heardText } from "./SignalStations";

const MINUTE = 60_000;

/** A Priyom slot's frequency as a channel, when it has one Skywave can tune. */
function txChannel(tx: PriyomTx | null): SignalChannel | null {
  return tx && tx.khz !== null && tx.mode !== null ? { khz: tx.khz, mode: tx.mode } : null;
}

/**
 * The live half of a signal station's page (#103): whether it's on the air
 * now, with a Listen link that opens the main page tuned to it; otherwise
 * when it's next on, in UTC and the visitor's own time; and when listeners
 * last heard it. Takes the slug and looks the station up in the catalog, so
 * the static page and this part always describe the same entry. Shows
 * nothing until the page knows the server's time, so the static HTML never
 * carries a stale "on now".
 */
export function SignalLive({ slug }: { slug: string }) {
  const station = findStation(slug);
  const now = useServerTick(MINUTE);
  const priyom = usePriyomSchedule();
  const heard = useSignalLastHeard();
  if (!station || station.schedule.kind === "defunct") return null;
  if (now === null) return <p className="signal-live" aria-busy="true" />;

  let status: React.ReactNode = null;
  if (station.priyom) {
    const on = priyom ? onAirTx(priyom, station.priyom, now) : null;
    const next = priyom ? nextTx(priyom, station.priyom, now) : null;
    const onCh = txChannel(on);
    const nextCh = txChannel(next);
    if (!priyom) {
      status = (
        <>
          Schedule unavailable right now;{" "}
          <a href={PRIYOM_SCHEDULE_PAGE} target="_blank" rel="noreferrer">
            check Priyom
          </a>
          .
        </>
      );
    } else if (on && onCh) {
      status = (
        <>
          On the air now on {channelText(onCh)}, {formatWait(on.startMs + PRIYOM_ON_AIR_MS - now, false)} left.{" "}
          <Link href={listenHref(station, onCh)} className="signal-listen">
            Listen
          </Link>
        </>
      );
    } else if (next) {
      status = (
        <>
          Next on {utcLabel(next.startMs)} ({localLabel(next.startMs)})
          {nextCh ? ` on ${channelText(nextCh)}` : ""}, in {formatWait(next.startMs - now, false)}.
        </>
      );
    } else {
      status = (
        <>
          Nothing listed in the coming week;{" "}
          <a href={PRIYOM_SCHEDULE_PAGE} target="_blank" rel="noreferrer">
            check Priyom
          </a>
          .
        </>
      );
    }
  } else {
    const ch = activeChannelAt(station, now);
    const span = windowSpanAt(station, now);
    const next = nextStartAfter(station, now);
    if (ch) {
      status = (
        <>
          On the air now on {channelText(ch)}
          {span ? `, ${formatWait(span.endMs - now, false)} left` : ""}.{" "}
          <Link href={listenHref(station, ch)} className="signal-listen">
            Listen
          </Link>
        </>
      );
    } else if (next !== null) {
      status = (
        <>
          Next on {utcLabel(next)} ({localLabel(next)}), in {formatWait(next - now, false)}.
        </>
      );
    }
  }
  const heardLine = heardText(heard?.[station.slug], now);
  return (
    <div className="signal-live">
      {status && <p className="signal-status">{status}</p>}
      {heardLine && <p className="signal-heard-line">Listeners: {heardLine}.</p>}
    </div>
  );
}
