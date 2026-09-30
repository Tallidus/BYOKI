export default function NotFound() {
  return (
    <main className="wrap">
      <p className="kicker">404</p>
      <h1>That page is not part of BYOKI.</h1>
      <p className="lede">The demo, docs, and downloads are linked from the home page.</p>
      <div className="button-row">
        <a className="button" href="/">
          Back home
        </a>
      </div>
    </main>
  );
}
