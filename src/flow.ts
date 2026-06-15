import type { Store, Player } from "./state.ts";

export interface Poll {
  role: "give" | "receive" | "reveal" | "idle";
  stage: string;
  gift?: string;
  find?: string;
  codeword?: string;
  venue?: string;
  at?: string;
  event?: string;
  handle?: string | null;
}

/** Decide the single most urgent thing this player's agent should surface now.
 *  One action per tick; priority: deliver > prime > offer > settle > reveal. */
export function pollFor(store: Store, p: Player): Poll {
  if (p.status === "left") return { role: "idle", stage: "idle" };
  const gp = store.giverPairing(p.id);
  const rp = store.receiverPairing(p.id);
  if (gp && gp.giverAccepted && gp.identifier)
    return { role: "give", stage: "go", gift: gp.gift, find: gp.identifier, codeword: gp.codeword, venue: gp.venue, at: gp.at, event: gp.eventTitle };
  if (rp && !rp.identifier)
    return { role: "receive", stage: "prime", venue: rp.venue, at: rp.at, event: rp.eventTitle };
  if (gp && !gp.giverAccepted)
    return { role: "give", stage: "offer", venue: gp.venue, at: gp.at, event: gp.eventTitle };
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
