import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Garage Assistant",
  description: "Reference app for BYOKI AI connections",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
