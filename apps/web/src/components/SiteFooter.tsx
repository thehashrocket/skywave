import Link from "next/link";

const SITE_AUTHOR = "https://jasonshultz.com";
const SOURCE = "https://github.com/thehashrocket/skywave";

/**
 * The credit line at the bottom of every page. `onPlayer` is for the listening
 * page: there, every link opens a new tab, because leaving the page would stop
 * what's playing.
 */
export function SiteFooter({ onPlayer = false }: { onPlayer?: boolean }) {
  const external = { target: "_blank", rel: "noreferrer" } as const;
  return (
    <footer className="site-footer">
      Built by{" "}
      <a href={SITE_AUTHOR} {...external}>
        Jason Shultz
      </a>
      <span aria-hidden="true"> · </span>
      <a href={SOURCE} {...external}>
        Source on GitHub
      </a>
      <span aria-hidden="true"> · </span>
      {onPlayer ? (
        <a href="/owners" target="_blank" rel="noopener">
          For Kiwi owners
        </a>
      ) : (
        <Link href="/owners">For Kiwi owners</Link>
      )}
    </footer>
  );
}
