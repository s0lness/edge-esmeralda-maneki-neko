import { upcomingEvents, eventParticipants, nameKey, type EdgeEvent } from "./edgeos.ts";
import { chooseGift, pickCodeword } from "./rings.ts";
import type { Store, Pairing } from "./state.ts";

export interface EventPresence { event: EdgeEvent; names: Set<string> }

/** Pull upcoming events in the window and who RSVP'd each, keyed by normalized
 *  name. This is the only presence signal: an RSVP to a real dated event proves
 *  co-presence, on-site-that-day, and a public place to meet, all at once. */
export async function buildPresence(windowHours = 12, maxEvents = 20): Promise<EventPresence[]> {
  const now = Date.now();
  const horizon = now + windowHours * 3600_000;
  const events = (await upcomingEvents(new Date(now).toISOString(), 60))
    .filter((e) => { const t = Date.parse(e.startsAt); return t && t <= horizon; })
    .slice(0, maxEvents);
  const out: EventPresence[] = [];
  for (const event of events) {
    try {
      const parts = await eventParticipants(event.id);
      const names = new Set(parts.map((p) => nameKey(`${p.firstName} ${p.lastName}`)).filter(Boolean));
      if (names.size) out.push({ event, names });
    } catch { /* skip events we can't read */ }
  }
  return out;
}

/** Form opportunistic gift cycles among co-present, free, active players. Each
 *  matched player gives to one neighbor and receives from another, so the ledger
 *  stays balanced and same-day reciprocity holds without a brittle fixed ring.
 *  A player already in an open pairing is left alone until it settles or lapses. */
export function runMatch(store: Store, presence: EventPresence[], now = Date.now()): Pairing[] {
  const created: Pairing[] = [];
  for (const { event, names } of presence) {
    const here = store.activePlayers().filter((p) =>
      names.has(nameKey(p.edgeosName)) && !store.hasOpenPairing(p.id)
    );
    if (here.length < 2) continue;
    // those most "owed" (gave more than they've received) get placed to receive sooner
    here.sort((a, b) => (b.given - b.received) - (a.given - a.received));
    const n = here.length;
    for (let i = 0; i < n; i++) {
      const giver = here[i];
      const receiver = here[(i + 1) % n];
      if (giver.id === receiver.id) continue;
      const pairing: Pairing = {
        id: store.newId("g"),
        giver: giver.id,
        receiver: receiver.id,
        eventId: event.id,
        eventTitle: event.title,
        venue: event.venue || event.location || undefined,
        at: event.startsAt || undefined,
        endsAt: event.endsAt || undefined,
        gift: chooseGift(`${event.title} ${event.venue}`, receiver.preferences),
        codeword: pickCodeword(),
        giverAccepted: false,
        giverDone: false,
        receiverConfirmed: false,
        status: "open",
        createdAt: now,
      };
      store.addPairing(pairing);
      created.push(pairing);
    }
  }
  return created;
}

/** Lapse open pairings whose event has ended (plus grace). Nothing settles; both
 *  parties re-enter the pool on the next match run. Returns how many lapsed. */
export function expireStale(store: Store, graceMin = 30, now = Date.now()): number {
  let n = 0;
  for (const p of store.openPairings()) {
    const end = p.endsAt ? Date.parse(p.endsAt) : (p.at ? Date.parse(p.at) + 2 * 3600_000 : 0);
    if (end && now > end + graceMin * 60_000) { p.status = "lapsed"; n++; }
  }
  if (n) store.persist();
  return n;
}
