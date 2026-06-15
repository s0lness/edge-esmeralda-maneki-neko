import type { Store, Ring, Link } from "./state.ts";

/** Featherweight, mostly-free acts. The gift is attention, not money.
 *  `words` gifts need no object, so they work where people are moving (Run Club). */
export const GIFTS: { text: string; words: boolean }[] = [
  { text: "tell them the most interesting thing you heard today", words: true },
  { text: "give them a genuine compliment about something they made or said", words: true },
  { text: "share one small recommendation - a book, a spot, a person they should meet", words: true },
  { text: "ask them the best question you've been asked this week, and answer it yourself first", words: true },
  { text: "tell them one specific thing you appreciate about Edge that they might have missed", words: true },
  { text: "bring them a coffee or tea", words: false },
  { text: "bring them a snack", words: false },
];

/** Venues where people move (runs, walks) can't take a physical hand-off. */
const MOVING = /run|walk|hike|jog|bike|yoga|dance/i;
function giftFor(venueOrTitle = ""): string {
  const pool = MOVING.test(venueOrTitle) ? GIFTS.filter((g) => g.words) : GIFTS;
  return pick(pool).text;
}

/** Spoken by the giver on approach so the receiver knows it's the game, not a stranger. */
const CODEWORDS = ["maneki sent me", "the cat sent me", "lucky paw", "pass the spark", "tiny adventure"];

let rnd = 0; // deterministic-ish rotation (no Math.random in this env)
const pick = <T>(a: T[]) => a[rnd++ % a.length];

/** An anchor event ties a ring to one real, shared place + time. */
export interface Anchor { venue?: string; at?: string; title?: string }

/** Form a ring from N players (ordered as given). Gift travels i -> i+1, last -> first.
 *  `anchor` is either ONE event (same-event ring) or an array of N events, one per
 *  hop (a CROSS-EVENT ring: the gift travels across the schedule, hop by hop).
 *  Gifts are chosen per that hop's venue (word-only where people are moving). */
export function formRing(store: Store, memberIds: string[], anchor: Anchor | Anchor[] = {}): Ring {
  const n = memberIds.length;
  const at = (i: number): Anchor => (Array.isArray(anchor) ? anchor[i] ?? {} : anchor);
  const links: Link[] = memberIds.map((g, i) => {
    const a = at(i);
    return {
      giver: g,
      receiver: memberIds[(i + 1) % n],
      status: "waiting",
      gift: giftFor(`${a.title ?? ""} ${a.venue ?? ""}`),
      codeword: pick(CODEWORDS),
      venue: a.venue,
      at: a.at,
    };
  });
  const ring: Ring = { id: store.newId("r"), members: memberIds, links, current: 0, status: "open", createdAt: Date.now() };
  store.addRing(ring);
  return ring;
}

/** The active link of a ring (the one currently being attempted). */
export function activeLink(ring: Ring): Link | undefined {
  return ring.status === "open" ? ring.links[ring.current] : undefined;
}

/** Mark the active link met and advance. Closes the ring when the last hop lands. */
export function completeActiveLink(store: Store, ring: Ring): { closed: boolean; next?: Link } {
  const link = ring.links[ring.current];
  if (!link) return { closed: false };
  link.status = "met";
  link.metAt = Date.now();
  if (ring.current >= ring.links.length - 1) {
    ring.status = "closed";
    ring.closedAt = Date.now();
    store.persist();
    return { closed: true };
  }
  ring.current += 1;
  store.persist();
  return { closed: false, next: ring.links[ring.current] };
}

/** Progress summary for the map: how far each ring has travelled. */
export function ringProgress(ring: Ring) {
  const done = ring.links.filter((l) => l.status === "met").length;
  return { id: ring.id, size: ring.members.length, done, status: ring.status,
    elapsedMin: ring.closedAt ? Math.round((ring.closedAt - ring.createdAt) / 60000) : Math.round((Date.now() - ring.createdAt) / 60000) };
}
