import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export type DownloadFile = {
  file: string;
  packageName: string;
  version: string;
  bytes: number;
  sha256: string;
};

export type DownloadManifest = {
  files: DownloadFile[];
  starter: { file: string; bytes: number; sha256: string };
  tarballInstall: string;
  registryInstall: { pnpm: string; npm: string };
};

export function loadDownloadManifest(): DownloadManifest | null {
  const file = path.join(process.cwd(), "public", "artifacts", "manifest.json");
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, "utf8")) as DownloadManifest;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
