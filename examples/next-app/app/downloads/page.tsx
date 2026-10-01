import { CodeBlock } from "../../components/code-block";
import { formatBytes, loadDownloadManifest } from "../../lib/downloads";
import api from "../../lib/generated/api.json";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Downloads",
  description: "Download BYOKI package tarballs and a minimal Node starter kit produced by the site build.",
};

export default function DownloadsPage() {
  const manifest = loadDownloadManifest();
  return (
    <main className="wrap">
      <p className="kicker">Downloads</p>
      <h1>Packages and a starter kit, built from this source.</h1>
      <p className="lede">
        The demo app build runs <code className="inline">pnpm pack</code> for each <code className="inline">@byoki/*</code> package and writes the tarballs plus a starter zip into <code className="inline">public/artifacts</code>. The files below are that output, so they match the commit that was deployed.
      </p>

      <section className="section" id="install">
        <h2>Install</h2>
        <p>When the packages are on npm:</p>
        <CodeBlock code={manifest?.registryInstall.pnpm ?? api.install.pnpm} label="pnpm" />
        <CodeBlock code={manifest?.registryInstall.npm ?? api.install.npm} label="npm" />
        {manifest ? (
          <>
            <p>
              Before the packages are published, download the tarballs into one directory and use this <code className="inline">package.json</code> fragment. The overrides keep nested <code className="inline">@byoki/*</code> dependencies on those files instead of the npm registry.
            </p>
            <CodeBlock code={manifest.tarballInstall} label="package.json" />
            <CodeBlock code="corepack pnpm install" label="shell" />
          </>
        ) : null}
      </section>

      <section className="section">
        <h2>Package tarballs</h2>
        {manifest ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Package</th>
                  <th>File</th>
                  <th>Size</th>
                  <th>SHA-256</th>
                </tr>
              </thead>
              <tbody>
                {manifest.files.map((file) => (
                  <tr key={file.file}>
                    <td>
                      <code>{file.packageName}</code>
                      <div className="meta">{file.version}</div>
                    </td>
                    <td>
                      <a href={`/artifacts/${file.file}`} download>
                        {file.file}
                      </a>
                    </td>
                    <td>{formatBytes(file.bytes)}</td>
                    <td>
                      <code>{file.sha256}</code>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="banner">Download files are written during the app build. From the repository root, run <code className="inline">corepack pnpm --filter @byoki/example build</code>.</p>
        )}
      </section>

      <section className="section">
        <h2>Starter kit</h2>
        <p>
          The zip is a Node 20 HTTP server that binds to <code className="inline">127.0.0.1</code>, plus the core, server, providers, and pricing tarballs in <code className="inline">vendor/</code>. It is a local integration kit. Its user id is a fixed <code className="inline">local-dev</code> placeholder, which is a different choice from the public demo’s per-visitor sessions.
        </p>
        {manifest ? (
          <p>
            <a className="button" href={`/artifacts/${manifest.starter.file}`} download>
              Download {manifest.starter.file}
            </a>
          </p>
        ) : null}
        {manifest ? (
          <p className="meta">
            {formatBytes(manifest.starter.bytes)} · SHA-256 <code className="inline">{manifest.starter.sha256}</code>
          </p>
        ) : null}
      </section>
    </main>
  );
}
