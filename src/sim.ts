/** Simulation: the three founder rings (same-event) + one cross-event ring,
 *  anchored to REAL EdgeOS events. Run: npx tsx src/sim.ts */
import { existsSync, readFileSync } from "node:fs";
import { Store } from "./state.ts";
import { formRing, activeLink, completeActiveLink, type Anchor } from "./rings.ts";
import { upcomingEvents, type EdgeEvent } from "./edgeos.ts";

// minimal .env loader (no dep)
if (existsSync(".env")) {
  for (const line of readFileSync(".env", "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

const fmtTime = (iso: string) => {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleString("en-US", { weekday: "short", hour: "numeric", minute: "2-digit", timeZone: "America/Los_Angeles" });
};
const anchorOf = (e: EdgeEvent): Anchor => ({ title: e.title, venue: e.venue || e.location || "TBD", at: fmtTime(e.startsAt) });
const name = (store: Store, id: string) => store.player(id)!.handle;

function printRing(store: Store, ringId: string, header: string, crossEvent = false) {
  const ring = store.ring(ringId)!;
  console.log(`\n${header}`);
  ring.links.forEach((l, i) => {
    const g = name(store, l.giver), r = name(store, l.receiver);
    const closes = i === ring.links.length - 1 ? "   <- closes back to the founder" : "";
    const where = crossEvent ? `\n          @ ${l.venue} (${l.at})  ·  ${l.gift}` : `  ·  ${l.gift}`;
    console.log(`  hop ${i + 1}: ${g.padEnd(8)} -> ${r.padEnd(8)} | say "${l.codeword}"${closes}${where}`);
  });
  if (!crossEvent) {
    const a = ring.links[0];
    console.log(`  all at: ${a.venue} (${a.at})`);
  }
  // walk it to closure to prove it closes
  let guard = 0;
  while (store.ring(ringId)!.status === "open" && guard++ < 20) completeActiveLink(store, store.ring(ringId)!);
  console.log(`  -> ring ${store.ring(ringId)!.status} after ${ring.links.length} hops`);
}

async function main() {
  const store = new Store(`sim-${Date.now()}.db.json`);
  const events = await upcomingEvents(new Date().toISOString(), 60);
  if (!events.length) { console.log("No events from EdgeOS (check key)."); return; }

  // pick a few real, distinct events to anchor to
  const byTitle = (re: RegExp) => events.find((e) => re.test(e.title));
  const lunch = byTitle(/lunch/i) ?? events[0];
  const run = byTitle(/run|jog/i) ?? events[1] ?? events[0];
  const deep = byTitle(/deep work|coworking|cowork|focus/i) ?? events[2] ?? events[0];
  const fireside = byTitle(/fireside|talk|panel|session|circle/i) ?? events[3] ?? events[0];
  const dinner = byTitle(/dinner|social|party|happy hour/i) ?? events[4] ?? events[0];

  console.log("=== EdgeOS events used as anchors ===");
  for (const e of [run, deep, lunch, fireside, dinner]) console.log(`  ${e.title}  @ ${e.venue || e.location}  (${fmtTime(e.startsAt)})`);

  // --- three founder rings, each anchored to ONE shared event ---
  const ringA = formRing(store, [store.join("sylve", "sylve").id, store.join("amir", "amir").id, store.join("lena", "lena").id], anchorOf(lunch));
  const ringB = formRing(store, [store.join("timour", "timour").id, store.join("nadia", "nadia").id, store.join("kofi", "kofi").id, store.join("rishi", "rishi").id], anchorOf(deep));
  const ringC = formRing(store, [store.join("talamon", "talamon").id, store.join("mei", "mei").id, store.join("juno", "juno").id], anchorOf(fireside));

  console.log("\n========== SAME-EVENT FOUNDER RINGS ==========");
  printRing(store, ringA.id, `RING A (founder: sylve)`);
  printRing(store, ringB.id, `RING B (founder: timour)`);
  printRing(store, ringC.id, `RING C (founder: talamon)`);

  // --- one CROSS-EVENT ring: each hop at a successive event, gift travels the day ---
  const ids = [store.join("dorian", "dorian").id, store.join("priya", "priya").id, store.join("theo", "theo").id];
  const crossAnchors = [anchorOf(run), anchorOf(deep), anchorOf(lunch)]; // morning -> midday
  const ringX = formRing(store, ids, crossAnchors);

  console.log("\n========== CROSS-EVENT RING (travels the schedule) ==========");
  printRing(store, ringX.id, `RING X (founder: dorian) — one hop per event, morning to midday`, true);
}

main().catch((e) => { console.error(e); process.exit(1); });
