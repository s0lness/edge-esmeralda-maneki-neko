/** maneki coordinator. Egress-only personal agents poll this on a heartbeat; it
 *  matches co-present players, walks each gift through its lifecycle, and keeps a
 *  private give/received ledger. No agent-to-agent channel: every agent pushes to
 *  its own human. See DESIGN.md. */
import { createServer, type ServerResponse, type IncomingMessage } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { Store } from "./state.ts";
import { buildPresence, runMatch, expireStale, type EventPresence } from "./match.ts";
import { pollFor, lapseAll } from "./flow.ts";
import { telegramFor } from "./directory.ts";

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
    if (method === "GET" && (path === "/" || path === "/healthz")) return json(res, 200, { ok: true, service: "maneki", skillVersion: SKILL_VERSION });

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
      const p = store.join(String(b.handle), String(b.edgeosName), b.preferences);
      const tg = telegramFor(p.edgeosName); if (tg && !p.telegram) { p.telegram = tg; store.persist(); }
      return json(res, 200, { token: p.token });
    }

    const tokenPosts = ["/accept", "/identifier", "/done", "/confirm", "/reveal", "/skip", "/leave", "/flag"];
    if (method === "POST" && tokenPosts.includes(path)) {
      const b = await readBody(req);
      const p = store.playerByToken(String(b.token ?? ""));
      if (!p) return json(res, 401, { error: "unknown token" });
      switch (path) {
        case "/accept": { const gp = store.giverPairing(p.id); if (gp) gp.giverAccepted = true; store.persist(); break; }
        case "/identifier": { const rp = store.receiverPairing(p.id); if (rp && b.identifier) rp.identifier = String(b.identifier); store.persist(); break; }
        case "/done": { const gp = store.giverPairing(p.id); if (gp) { gp.giverDone = true; p.given++; store.trySettle(gp); } store.persist(); break; }
        case "/confirm": { const rp = store.receiverPairing(p.id); if (rp) { rp.receiverConfirmed = true; p.received++; store.trySettle(rp); } store.persist(); break; }
        case "/reveal": {
          const sv = store.revealPairing(p.id);
          if (sv) { if (sv.giver === p.id) sv.giverRevealOk = !!b.ok; else sv.receiverRevealOk = !!b.ok; store.persist(); }
          const other = sv ? store.player(sv.giver === p.id ? sv.receiver : sv.giver) : undefined;
          return json(res, 200, { ok: true, handle: b.ok && other ? other.telegram ?? null : null });
        }
        case "/skip": lapseAll(store, p.id); break;
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

server.listen(PORT, () => console.log(`maneki coordinator on :${PORT} (tick ${TICK_MIN}m)`));
setInterval(() => { tick().catch(() => {}); }, TICK_MIN * 60_000);
setTimeout(() => { tick().catch(() => {}); }, 4000);

export { pollFor, store };
