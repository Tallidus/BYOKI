"use client";

import { usePathname } from "next/navigation";
import { ThemeToggle } from "./theme-toggle";

const LINKS = [
  { href: "/docs", label: "Docs" },
  { href: "/demo", label: "Live demo" },
  { href: "/downloads", label: "Downloads" },
];

export function SiteHeader() {
  const pathname = usePathname();
  return (
    <header className="site-header">
      <a className="wordmark" href="/">
        <span className="mark" aria-hidden="true" />
        BYOKI
      </a>
      <nav className="site-nav" aria-label="Primary">
        <a href="/#how-it-works">How it works</a>
        {LINKS.map((link) => (
          <a key={link.href} href={link.href} aria-current={pathname === link.href ? "page" : undefined}>
            {link.label}
          </a>
        ))}
      </nav>
      <ThemeToggle />
    </header>
  );
}
