import { upcomingEvents, eventParticipants, nameKey, type EdgeEvent } from "./edgeos.ts";
import { chooseGift, pickCodeword } from "./rings.ts";
import type { Store, Pairing, Player } from "./state.ts";

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

/** Make individual gifts (no cycle): pair people two-by-two, one gives to the
 *  other. Two passes so everyone available gets matched:
 *    1. within each real event (co-present players)
 *    2. everyone still free gathers "around The Hub today"
 *  Roles balance out over time; a player in an open pairing is left alone. */
export function runMatch(store: Store, presence: EventPresence[], now = Date.now()): Pairing[] {
  const created: Pairing[] = [];

  const make = (giver: Player, receiver: Player, event: EdgeEvent) => {
    const pairing: Pairing = {
      id: store.newId("g"), giver: giver.id, receiver: receiver.id,
      eventId: event.id, eventTitle: event.title,
      venue: event.venue || event.location || undefined,
      at: event.startsAt || undefined, endsAt: event.endsAt || undefined,
      gift: chooseGift(`${event.title} ${event.venue}`, receiver.preferences),
      codeword: pickCodeword(),
      receiverReady: false, giverAccepted: false, giverDone: false, receiverConfirmed: false,
      status: "open", createdAt: now,
    };
    store.addPairing(pairing);
    created.push(pairing);
  };

  // A giver must be live (their agent will actually surface the prompt). A receiver
  // can be offline: the giver still gets sent, finds them by name. "Live" = seen
  // within 2h, using last poll, or join time if they have never polled yet.
  const LIVE_WINDOW_MS = 120 * 60_000;
  const isLive = (p: Player) => now - (p.lastPollAt ?? p.joinedAt) < LIVE_WINDOW_MS;
  const pairPool = (players: Player[], event: EdgeEvent) => {
    const here = players.filter((p) => !store.hasOpenPairing(p.id) && !store.hasDeclined(p.id, event.id));
    here.sort((a, b) => (b.given - b.received) - (a.given - a.received));
    const used = new Set<string>();
    for (const giver of here) {
      if (used.has(giver.id) || !isLive(giver)) continue;          // only a live agent can give
      const receiver = here.find((p) => p.id !== giver.id && !used.has(p.id)); // receiver may be offline
      if (!receiver) break;
      used.add(giver.id); used.add(receiver.id);
      make(giver, receiver, event);
    }
  };

  // pass 1: real events, soonest first
  for (const { event, names } of [...presence].sort((a, b) => a.event.startsAt.localeCompare(b.event.startsAt)))
    pairPool(store.activePlayers().filter((p) => names.has(nameKey(p.edgeosName))), event);

  // pass 2: anyone still free is assumed to be around The Hub today
  const day = new Date(now).toISOString().slice(0, 10); // date-scoped, so "not today" doesn't block tomorrow
  const hubEvent: EdgeEvent = { id: `hub-${day}`, title: "The Hub", startsAt: new Date(now).toISOString(), endsAt: new Date(now + 8 * 3600_000).toISOString(), venue: "The Hub", location: "" };
  pairPool(store.activePlayers(), hubEvent);

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
