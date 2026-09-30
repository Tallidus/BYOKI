import type { Metadata } from "next";
import { SiteFooter } from "../components/site-footer";
import { SiteHeader } from "../components/site-header";
import { publicSiteOrigin } from "../lib/env";
import api from "../lib/generated/api.json";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL(publicSiteOrigin()),
  title: {
    default: "BYOKI",
    template: "%s · BYOKI",
  },
  description:
    "TypeScript SDK for adding bring-your-own API keys to your app. Users connect OpenAI, Anthropic, or Gemini. You store the key on your server and route by capability.",
};

const themeBoot = `(function(){try{var t=localStorage.getItem("byoki-theme");if(t==="light"||t==="dark")document.documentElement.setAttribute("data-theme",t);}catch(e){}})();`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <script dangerouslySetInnerHTML={{ __html: themeBoot }} />
        <a className="skip" href="#content">
          Skip to content
        </a>
        <SiteHeader />
        <div id="content">{children}</div>
        <SiteFooter version={api.packages[0]?.version ?? "0.1.0"} />
      </body>
    </html>
  );
}
