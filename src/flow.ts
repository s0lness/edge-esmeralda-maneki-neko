import type { Store, Player } from "./state.ts";

export interface Poll {
  role: "give" | "receive" | "reveal" | "idle";
  stage: string;
  gift?: string;
  who?: string;        // receiver's name, so the giver can find them even with no description
  find?: string;
  codeword?: string;
  venue?: string;
  at?: string;
  event?: string;
  handle?: string | null;
}

// Lead-time gating: give people time to prepare, but don't send them to find
// someone who isn't there yet.
export const OFFER_LEAD_MIN = 180; // surface offers + primes when the event is within 3h
export const GO_LEAD_MIN = 20;     // hold the "go" until the event is within 20 min (or live)

/** Minutes from `now` until the event starts (negative once it has started).
 *  Missing time -> treat as imminent so it never blocks. */
function minsUntil(at: string | undefined, now: number): number {
  if (!at) return 0;
  const t = Date.parse(at);
  return Number.isNaN(t) ? 0 : (t - now) / 60000;
}

/** Decide the single most urgent thing this player's agent should surface now.
 *  One action per tick; priority: deliver > prime > offer > settle > reveal.
 *  Timing-gated: offers/primes wait until the event is near, the "go" waits
 *  until it's basically happening. */
export function pollFor(store: Store, p: Player, now: number = Date.now()): Poll {
  if (p.status === "left") return { role: "idle", stage: "idle" };
  const gp = store.giverPairing(p.id);
  const rp = store.receiverPairing(p.id);
  // give: go — once the event is imminent or live. The receiver's name is always
  // included so the giver can find them even if they never described themselves;
  // `find` (a self-description) is a bonus when present.
  if (gp && gp.giverAccepted && minsUntil(gp.at, now) <= GO_LEAD_MIN) {
    const receiver = store.player(gp.receiver);
    return { role: "give", stage: "go", gift: gp.gift, who: receiver?.edgeosName, find: gp.identifier, codeword: gp.codeword, venue: gp.venue, at: gp.at, event: gp.eventTitle };
  }
  // receive: prime — within the offer lead, so they have time to answer
  if (rp && !rp.identifier && minsUntil(rp.at, now) <= OFFER_LEAD_MIN)
    return { role: "receive", stage: "prime", venue: rp.venue, at: rp.at, event: rp.eventTitle };
  // give: offer — within the offer lead
  if (gp && !gp.giverAccepted && minsUntil(gp.at, now) <= OFFER_LEAD_MIN)
    return { role: "give", stage: "offer", venue: gp.venue, at: gp.at, event: gp.eventTitle };
  // receive: settle-check (no time gate; only fires after the giver acted)
  if (rp && rp.giverDone && !rp.receiverConfirmed)
    return { role: "receive", stage: "settle-check", venue: rp.venue, event: rp.eventTitle };
  const sv = store.revealPairing(p.id);
  if (sv) {
    const other = store.player(sv.giver === p.id ? sv.receiver : sv.giver);
    return { role: "reveal", stage: "offer-handle", handle: other?.telegram ?? null, event: sv.eventTitle };
  }
  return { role: "idle", stage: "idle" };
}

/** Lapse every open pairing involving this player (used by skip / leave). */
export function lapseAll(store: Store, pid: string) {
  let changed = false;
  for (const pr of store.openPairings()) if (pr.giver === pid || pr.receiver === pid) { pr.status = "lapsed"; changed = true; }
  if (changed) store.persist();
}
