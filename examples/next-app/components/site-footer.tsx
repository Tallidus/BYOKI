export function SiteFooter({ version }: { version: string }) {
  return (
    <footer className="site-footer">
      <p>
        BYOKI {version} · MIT · <a href="https://github.com/Tallidus/BYOKI">GitHub</a>
      </p>
      <p>
        <a href="/docs">Docs</a> · <a href="/demo">Demo</a> · <a href="/downloads">Downloads</a>
      </p>
    </footer>
  );
}
