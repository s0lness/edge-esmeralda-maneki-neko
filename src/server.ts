/** maneki coordinator. Egress-only personal agents poll this on a heartbeat; it
 *  matches co-present players, walks each gift through its lifecycle, and keeps a
 *  private give/received ledger. No agent-to-agent channel: every agent pushes to
 *  its own human. See DESIGN.md. */
import { createServer, type ServerResponse, type IncomingMessage } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Store } from "./state.ts";
import { nameKey } from "./edgeos.ts";
import { buildPresence, runMatch, expireStale, type EventPresence } from "./match.ts";
import { pollFor, lapseAll } from "./flow.ts";
import { telegramFor, isFullName, loadDirectory, directorySize } from "./directory.ts";
import { restore, downloadObject } from "./persist.ts";

// local .env loader (no-op on Cloud Run, where env comes from the platform)
if (existsSync(".env")) {
  for (const line of readFileSync(".env", "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

const PORT = Number(process.env.PORT ?? 8080);
const ADMIN = process.env.ADMIN_TOKEN ?? "";
const TICK_MIN = Number(process.env.TICK_MIN ?? 3);
const store = new Store();

// The skill is served from here so agents can self-update (private repo, no GitHub
// access needed). skillVersion rides every poll; agents refresh when it climbs.
const SKILL_TEXT = existsSync("SKILL.md") ? readFileSync("SKILL.md", "utf8") : "";
const SKILL_VERSION = Number(SKILL_TEXT.match(/^version:\s*(\d+)/m)?.[1] ?? 1);
const NEWS = process.env.MANEKI_NEWS ?? "";

// presence cache (EdgeOS is rate-limited; refresh at most every 10 min)
let presence: EventPresence[] = [];
let presenceAt = 0;
async function refreshPresence(maxAgeMs = 10 * 60_000) {
  const now = Date.now();
  if (presence.length && now - presenceAt < maxAgeMs) return;
  try { presence = await buildPresence(); presenceAt = now; } catch { /* keep stale */ }
}
async function tick() {
  await refreshPresence();
  expireStale(store);
  runMatch(store, presence);
}

/** A shareable, no-dependency landing page. Forward the URL and anyone can join. */
function landingHtml(base: string): string {
  const snippet = `play maneki — read ${base}/skill and follow it. My Edge name is [your full name].`;
  return `<!doctype html><html lang=en><head><meta charset=utf-8>
<meta name=viewport content="width=device-width,initial-scale=1">
<title>maneki — a tiny kindness game</title>
<style>
:root{color-scheme:light dark}
body{margin:0;min-height:100vh;display:grid;place-items:center;font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#faf8f3;color:#2a2a28}
@media(prefers-color-scheme:dark){body{background:#16150f;color:#ece8df}}
.card{max-width:520px;padding:40px 28px;text-align:center}
pre.cat{font-size:13px;line-height:1.15;margin:0 0 8px;color:#c9a227}
h1{font-size:28px;margin:.2em 0}
p.tag{opacity:.85;margin:.2em 0 1.6em}
.snip{text-align:left;background:#00000010;border:1px solid #00000020;border-radius:12px;padding:16px;font-size:14px}
@media(prefers-color-scheme:dark){.snip{background:#ffffff10;border-color:#ffffff20}}
.snip code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap;word-break:break-word}
button{margin-top:12px;border:0;border-radius:999px;padding:10px 18px;font-size:14px;font-weight:600;background:#c9a227;color:#1a1700;cursor:pointer}
button:active{transform:translateY(1px)}
.fine{opacity:.6;font-size:13px;margin-top:18px}
</style></head><body><div class=card>
<pre class=cat> /\\_/\\
( =^.^= )
 (")_(")</pre>
<h1>maneki</h1>
<p class=tag>a tiny kindness game at Edge Esmeralda 🐾<br>your agent nudges you to make a stranger's day, and someone makes yours.</p>
<div class=snip><code id=s>${snippet}</code></div>
<button id=b>copy</button>
<p class=fine>Paste that to your personal AI agent. It does the rest.<br>No app, no signup form.</p>
</div>
<script>document.getElementById('b').onclick=function(){navigator.clipboard.writeText(document.getElementById('s').innerText).then(()=>{this.innerText='copied ✓'})}</script>
</body></html>`;
}

function json(res: ServerResponse, code: number, obj: unknown) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "content-type": "application/json" });
  res.end(body);
}
function readBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve) => {
    let d = ""; req.on("data", (c) => (d += c));
    req.on("end", () => { try { resolve(d ? JSON.parse(d) : {}); } catch { resolve({}); } });
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  const path = url.pathname;
  const method = req.method ?? "GET";
  try {
    if (method === "GET" && path === "/healthz") return json(res, 200, { ok: true, service: "maneki", skillVersion: SKILL_VERSION });

    if (method === "GET" && path === "/") {
      const base = `https://${req.headers.host ?? "maneki-404362472402.europe-west1.run.app"}`;
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(landingHtml(base));
      return;
    }

    if (method === "GET" && path === "/skill") {
      res.writeHead(200, { "content-type": "text/markdown; charset=utf-8" });
      res.end(SKILL_TEXT);
      return;
    }

    if (method === "GET" && path === "/poll") {
      const p = store.playerByToken(url.searchParams.get("token") ?? "");
      if (!p) return json(res, 401, { error: "unknown token" });
      if (p.status === "left") return json(res, 200, { role: "idle", stage: "idle", skillVersion: SKILL_VERSION });
      p.lastPollAt = Date.now(); store.persist();
      return json(res, 200, { ...pollFor(store, p), skillVersion: SKILL_VERSION, ...(NEWS ? { news: NEWS } : {}) });
    }

    if (method === "POST" && path === "/join") {
      const b = await readBody(req);
      if (!b.handle || !b.edgeosName) return json(res, 400, { error: "handle and edgeosName required" });
      const edgeName = String(b.edgeosName).trim();
      // A lone first name / nickname can't be placed at events (this is the "Chase"
      // failure). Require a real full name and let the agent re-ask.
      if (!isFullName(edgeName))
        return json(res, 422, { ok: false, reason: "need_full_name", message: "I need your full name exactly as it appears in Edge (first and last) so I can find you at events." });
      const p = store.join(String(b.handle), edgeName, b.preferences);
      const tg = telegramFor(p.edgeosName); if (tg && !p.telegram) { p.telegram = tg; store.persist(); }
      // Are they RSVP'd to anything we can match on? If not, the agent nudges them.
      await refreshPresence();
      const rsvp = presence.some((ep) => ep.names.has(nameKey(p.edgeosName)));
      return json(res, 200, { token: p.token, rsvp });
    }

    const tokenPosts = ["/accept", "/identifier", "/done", "/confirm", "/reveal", "/skip", "/leave", "/flag"];
    if (method === "POST" && tokenPosts.includes(path)) {
      const b = await readBody(req);
      const p = store.playerByToken(String(b.token ?? ""));
      if (!p) return json(res, 401, { error: "unknown token" });
      switch (path) {
        case "/accept": { const gp = store.giverPairing(p.id); if (gp) gp.giverAccepted = true; store.persist(); break; }
        case "/identifier": { const rp = store.receiverPairing(p.id); if (rp) { rp.receiverReady = true; if (b.identifier) rp.identifier = String(b.identifier); } store.persist(); break; }
        case "/done": { const gp = store.giverPairing(p.id); if (gp) { gp.giverDone = true; p.given++; store.trySettle(gp); } store.persist(); break; }
        case "/confirm": { const rp = store.receiverPairing(p.id); if (rp) { rp.receiverConfirmed = true; p.received++; store.trySettle(rp); } store.persist(); break; }
        case "/reveal": {
          const sv = store.revealPairing(p.id);
          if (sv) { if (sv.giver === p.id) sv.giverRevealOk = !!b.ok; else sv.receiverRevealOk = !!b.ok; store.persist(); }
          const other = sv ? store.player(sv.giver === p.id ? sv.receiver : sv.giver) : undefined;
          return json(res, 200, { ok: true, handle: b.ok && other ? other.telegram ?? null : null });
        }
        case "/skip": {
          // "not going to this event" -> remember it so the matcher stops re-pairing
          // them there (EdgeOS over-reports recurring-event RSVPs), then lapse.
          for (const pr of store.openPairings()) if (pr.giver === p.id || pr.receiver === p.id) store.decline(p.id, pr.eventId);
          lapseAll(store, p.id);
          break;
        }
        case "/leave": p.status = "left"; store.persist(); lapseAll(store, p.id); break;
        case "/flag": store.flag(p.id, String(b.note ?? "")); break;
      }
      return json(res, 200, { ok: true });
    }

    if (path.startsWith("/admin")) {
      if (!ADMIN || req.headers["x-admin-token"] !== ADMIN) return json(res, 403, { error: "forbidden" });
      if (method === "POST" && path === "/admin/match") {
        await tick();
        return json(res, 200, { ok: true, open: store.openPairings().length, players: store.activePlayers().length, events: presence.length });
      }
      if (method === "POST" && path === "/admin/seed") {
        const b = await readBody(req);
        const founders = Array.isArray(b.founders) ? b.founders : [];
        const seeded = founders.map((f: any) => {
          const p = store.join(String(f.handle), String(f.edgeosName), f.drink ? { drink: String(f.drink) } : undefined);
          const tg = telegramFor(p.edgeosName); if (tg) p.telegram = tg;
          return { handle: p.handle, edgeosName: p.edgeosName, token: p.token };
        });
        store.persist();
        return json(res, 200, { seeded });
      }
      if (method === "POST" && path === "/admin/decline") {
        // Operator clears someone from an event (e.g. EdgeOS falsely RSVP'd them to a
        // whole recurring series). Declines every in-window event matching the title.
        const b = await readBody(req);
        const pl = store.players().find((x) => x.edgeosName.toLowerCase() === String(b.edgeosName ?? "").toLowerCase());
        if (!pl) return json(res, 404, { error: "player not found" });
        const title = String(b.eventTitle ?? "").toLowerCase();
        let n = 0;
        for (const ep of presence) if (title && ep.event.title.toLowerCase().includes(title)) { store.decline(pl.id, ep.event.id); n++; }
        for (const pr of store.openPairings()) if ((pr.giver === pl.id || pr.receiver === pl.id) && store.hasDeclined(pl.id, pr.eventId)) pr.status = "lapsed";
        store.persist();
        return json(res, 200, { ok: true, declinedEvents: n });
      }
      if (method === "GET" && path === "/admin/state")
        return json(res, 200, { players: store.players(), pairings: store.pairings(), flags: store.flags() });
    }

    if (method === "GET" && path === "/stats") {
      const ps = store.pairings();
      return json(res, 200, {
        players: store.activePlayers().length,
        settled: ps.filter((x) => x.status === "settled").length,
        inFlight: ps.filter((x) => x.status === "open").length,
      });
    }

    return json(res, 404, { error: "not found" });
  } catch (e: any) {
    return json(res, 500, { error: String(e?.message ?? e) });
  }
});

// Boot: pull any GCS snapshot into the local file BEFORE serving, so a fresh Cloud
// Run instance comes up with the saved players + ledger instead of empty.
const DB_PATH = resolve(process.cwd(), process.env.MANEKI_DB ?? "maneki.db.json");
const DIR_OBJECT = process.env.MANEKI_DIRECTORY_OBJECT ?? "directory.md";
const DIR_PATH = resolve(process.cwd(), "directory.local.md");
(async () => {
  await restore(DB_PATH);
  store.reload();
  // Attendee directory is PII: pulled from the private bucket at boot, never the
  // repo. Powers name lookup for the post-gift handle reveal.
  if (await downloadObject(DIR_OBJECT, DIR_PATH)) {
    loadDirectory(DIR_PATH);
    // Backfill telegram for anyone who joined before the directory existed, so the
    // post-gift reveal has a handle to offer.
    let filled = 0;
    for (const pl of store.players()) if (!pl.telegram) { const tg = telegramFor(pl.edgeosName); if (tg) { pl.telegram = tg; filled++; } }
    if (filled) store.persist();
    console.log(`[directory] loaded ${directorySize()} attendees, backfilled ${filled} handles`);
  }
  server.listen(PORT, () => console.log(`maneki coordinator on :${PORT} (tick ${TICK_MIN}m, skill v${SKILL_VERSION})`));
  setInterval(() => { tick().catch(() => {}); }, TICK_MIN * 60_000);
  setTimeout(() => { tick().catch(() => {}); }, 4000);
})();

export { pollFor, store };
