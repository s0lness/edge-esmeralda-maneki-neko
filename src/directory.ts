import { existsSync, readFileSync } from "node:fs";
import { nameKey } from "./edgeos.ts";

/** Optional: the Edge attendee directory (name -> Telegram handle), used ONLY
 *  server-side to verify a join and to reveal handles AFTER a settled gift. It is
 *  never exposed to other players and never used to deliver messages. The file is
 *  PII (586 handles): keep it out of git, supply via DIRECTORY_FILE. */
let map: Map<string, string> | null = null;

export function loadDirectory(file = process.env.DIRECTORY_FILE): Map<string, string> {
  if (map) return map;
  map = new Map();
  if (file && existsSync(file)) {
    const txt = readFileSync(file, "utf8");
    // matches lines like:  - **Amanda Young**: [Hello_amanda_young](https://t.me/...)
    const re = /^- \*\*(.+?)\*\*:\s*\[([^\]]+)\]/gm;
    let m: RegExpExecArray | null;
    while ((m = re.exec(txt))) {
      const name = m[1].trim();
      const handle = m[2].trim().replace(/^@/, "");
      if (name && /^[A-Za-z0-9_]{4,32}$/.test(handle)) map.set(nameKey(name), handle);
    }
  }
  return map;
}

export function telegramFor(name: string): string | undefined {
  return loadDirectory().get(nameKey(name));
}

export function directorySize(): number {
  return loadDirectory().size;
}

/** A plausible full name: at least two word-tokens that carry real letters.
 *  Rejects lone first names / nicknames ("Chase") that can't be placed at events. */
export function isFullName(name: string): boolean {
  return String(name).trim().split(/\s+/).filter((t) => t.replace(/[^A-Za-z]/g, "").length >= 2).length >= 2;
}
