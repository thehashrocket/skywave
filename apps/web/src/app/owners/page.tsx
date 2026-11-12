import type { Metadata } from "next";
import Link from "next/link";

// Each Kiwi shows the radio service as KIWI_IDENT (skywavehf.com in production)
// in its user list; this is the page that name leads an owner to.

const REPO = "https://github.com/thehashrocket/skywave";
const OPT_OUT = `${REPO}/issues/new?template=opt-out.yml`;

export const metadata: Metadata = {
  title: "For KiwiSDR owners · skywave",
  description:
    "How skywave uses public KiwiSDR receivers, the limits it keeps to, and how to keep it off yours.",
};

export default function OwnersPage() {
  return (
    <main className="console">
      <header className="console-header">
        <Link href="/" className="wordmark owners-wordmark">
          skywave
        </Link>
      </header>

      <article className="owners-body">
        <h1 className="owners-title">For KiwiSDR owners</h1>
        <p className="owners-lede">
          If <strong>skywavehf.com</strong> shows up in your Kiwi&rsquo;s user list, someone is listening to your
          receiver through skywave, a free web app that plays public KiwiSDRs. Thank you for running it. This
          page says what skywave does on your receiver, the limits it keeps to, and how to keep it off.
        </p>

        <section aria-labelledby="owners-what">
          <h2 id="owners-what">What it does on your Kiwi</h2>
          <ul>
            <li>
              Each skywave listener takes <strong>one channel</strong>, the same as a listener on your Kiwi&rsquo;s
              own page. The waterfall and the band scan ride on that channel; they never open a second one.
            </li>
            <li>
              It asks for <strong>raw I/Q</strong> (about 12 kHz wide) and does the demodulation on skywave&rsquo;s
              own server. I/Q is never compressed, so a skywave listener uses more of your upload than one on
              your Kiwi&rsquo;s page: roughly 0.4&ndash;0.65 Mbit/s, depending on your Kiwi&rsquo;s sample rate.
            </li>
            <li>
              The connection comes from skywave&rsquo;s server, not the listener&rsquo;s browser, so your Kiwi
              sees the server&rsquo;s address rather than the listener&rsquo;s.
            </li>
          </ul>
        </section>

        <section aria-labelledby="owners-limits">
          <h2 id="owners-limits">The limits it keeps to</h2>
          <ul>
            <li>
              <strong>One skywave listener per receiver at a time.</strong> A crowd can&rsquo;t fill your channels:
              the next skywave listener is sent to another receiver.
            </li>
            <li>
              <strong>Sessions end after an hour,</strong> and skywave as a whole holds only a small, fixed
              number of listeners at once.
            </li>
            <li>
              <strong>Your API setting is respected.</strong> If you allow no connections from apps other than
              your Kiwi&rsquo;s own page (<code>ext_api</code> 0 in the public list), skywave leaves your receiver
              out of its list and map, and your Kiwi turns it away if someone types your address.
            </li>
            <li>
              <strong>A refusal is taken at its word.</strong> When your Kiwi says it&rsquo;s full, needs a
              password or takes no apps, skywave&rsquo;s automatic picker leaves it alone for 15 minutes.
            </li>
            <li>
              <strong>Band scans are shared.</strong> A finished scan of your receiver is kept for 10 minutes for
              everyone listening there, and one listener can ask for a new one at most every 30 seconds.
            </li>
          </ul>
        </section>

        <section aria-labelledby="owners-opt-out">
          <h2 id="owners-opt-out">Keeping skywave off your receiver</h2>
          <p>Either works:</p>
          <ul>
            <li>
              <strong>Tell us.</strong>{" "}
              <a href={OPT_OUT} target="_blank" rel="noreferrer">
                Open an opt-out request
              </a>{" "}
              with your receiver&rsquo;s address (a free GitHub account is needed). It goes on a blocklist that
              both hides your receiver and stops skywave&rsquo;s server from connecting to it, whoever asks.
            </li>
            <li>
              <strong>Change your Kiwi.</strong> Set the number of connections allowed from non-Kiwi apps to 0.
              That turns away skywave and every other app straight away, without waiting on us.
            </li>
          </ul>
        </section>

        <section aria-labelledby="owners-more">
          <h2 id="owners-more">More</h2>
          <p>
            skywave is open source:{" "}
            <a href={REPO} target="_blank" rel="noreferrer">
              github.com/thehashrocket/skywave
            </a>
            . Questions, problems or ideas are welcome as{" "}
            <a href={`${REPO}/issues`} target="_blank" rel="noreferrer">
              issues
            </a>
            .
          </p>
          <p>
            <Link href="/">Back to skywave</Link>
          </p>
        </section>
      </article>
    </main>
  );
}
