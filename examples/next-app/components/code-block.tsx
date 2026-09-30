import { CopyButton } from "./copy-button";

export function CodeBlock({ code, label }: { code: string; label?: string }) {
  return (
    <figure className="codeblock">
      <figcaption>
        <span>{label ?? "Example"}</span>
        <CopyButton value={code} />
      </figcaption>
      <pre>
        <code>{code}</code>
      </pre>
    </figure>
  );
}
