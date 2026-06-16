import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, type Pairing } from "../src/state.ts";
import { runMatch, expireStale, type EventPresence } from "../src/match.ts";
import { pollFor, lapseAll } from "../src/flow.ts";
import { nameKey } from "../src/edgeos.ts";

let dir = "";
function freshStore() { dir = mkdtempSync(join(tmpdir(), "maneki-")); return new Store(join(dir, "t.db.json")); }
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

function presence(names: string[], startsAt: string, endsAt: string): EventPresence[] {
  return [{ event: { id: "e1", title: "Daily Lunch", startsAt, endsAt, venue: "The Hub", location: "" }, names: new Set(names.map(nameKey)) }];
}
function manualPairing(store: Store, giver: string, receiver: string, endsAt: string, startInMin = 5): Pairing {
  const now = Date.now();
  const p: Pairing = {
    id: store.newId("g"), giver, receiver, eventId: "e1", eventTitle: "Daily Lunch",
    venue: "The Hub", at: new Date(now + startInMin * 60_000).toISOString(), endsAt,
    gift: "bring them a flat white", codeword: "the cat sent me",
    receiverReady: false, giverAccepted: false, giverDone: false, receiverConfirmed: false, status: "open", createdAt: now,
  };
  store.addPairing(p);
  return p;
}
const future = () => new Date(Date.now() + 2 * 3600_000).toISOString();

describe("matcher", () => {
  it("pairs co-present players into individual gifts (no cycle, nobody double-booked)", () => {
    const store = freshStore();
    const names = ["Aa Aa", "Bb Bb", "Cc Cc", "Dd Dd"];
    names.forEach((n) => store.join(n.toLowerCase(), n));
    runMatch(store, presence(names, future(), future()), Date.now());
    const ps = store.pairings();
    expect(ps).toHaveLength(2); // 4 players -> 2 individual gifts
    expect(ps.every((p) => p.giver !== p.receiver)).toBe(true);
    const seen = ps.flatMap((p) => [p.giver, p.receiver]);
    expect(new Set(seen).size).toBe(seen.length); // each person in at most one pairing
  });

  it("never double-books a player already in an open pairing", () => {
    const store = freshStore();
    ["Sylve", "Timour"].forEach((n) => store.join(n.toLowerCase(), n));
    const pres = presence(["Sylve", "Timour"], future(), future());
    runMatch(store, pres, Date.now());
    const before = store.pairings().length;
    runMatch(store, pres, Date.now()); // second run, everyone is busy
    expect(store.pairings().length).toBe(before);
  });

  it("expires pairings whose event has ended, freeing both to re-match", () => {
    const store = freshStore();
    ["Sylve", "Timour"].forEach((n) => store.join(n.toLowerCase(), n));
    const past = new Date(Date.now() - 2 * 3600_000).toISOString();
    runMatch(store, presence(["Sylve", "Timour"], past, past), Date.now());
    expect(store.openPairings().length).toBeGreaterThan(0);
    expireStale(store, 30, Date.now());
    expect(store.openPairings().length).toBe(0);
  });
});

describe("gift lifecycle (decoupled settle)", () => {
  it("walks prime -> offer -> go -> done -> confirm -> reveal, crediting each half independently", () => {
    const store = freshStore();
    const a = store.join("alice", "Alice");
    const b = store.join("bob", "Bob");
    const pab = manualPairing(store, a.id, b.id, future());

    // receiver is primed first; answering confirms attendance (+ optional description)
    expect(pollFor(store, b)).toMatchObject({ role: "receive", stage: "prime" });
    pab.receiverReady = true; pab.identifier = "green cap by the fig tree"; store.persist();

    // giver is offered (attendance/willingness), who + gift still hidden
    expect(pollFor(store, a)).toMatchObject({ role: "give", stage: "offer" });
    expect(pollFor(store, a)).not.toHaveProperty("find");
    pab.giverAccepted = true; store.persist();

    // now the giver gets the go, with how-to-find + codeword + gift
    const go = pollFor(store, a);
    expect(go).toMatchObject({ role: "give", stage: "go", find: "green cap by the fig tree", codeword: "the cat sent me" });
    expect(go.gift).toContain("flat white");

    // giver reports done -> giver credited immediately, no waiting on receiver
    pab.giverDone = true; a.given++; store.trySettle(pab); store.persist();
    expect(a.given).toBe(1);
    expect(pab.status).toBe("open"); // not settled until the other half lands
    expect(pollFor(store, a)).toMatchObject({ role: "idle" }); // giver now waits

    // receiver gets the settle-check, confirms -> receiver credited, pairing settles
    expect(pollFor(store, b)).toMatchObject({ role: "receive", stage: "settle-check" });
    pab.receiverConfirmed = true; b.received++; store.trySettle(pab); store.persist();
    expect(b.received).toBe(1);
    expect(pab.status).toBe("settled");

    // reveal: each side is offered the other's handle
    a.telegram = "alice_tg"; b.telegram = "bob_tg"; store.persist();
    expect(pollFor(store, a)).toMatchObject({ role: "reveal", stage: "offer-handle", handle: "bob_tg" });
    expect(pollFor(store, b)).toMatchObject({ role: "reveal", stage: "offer-handle", handle: "alice_tg" });
  });

  it("credits a one-sided report without stalling (receiver silent)", () => {
    const store = freshStore();
    const a = store.join("alice", "Alice");
    const b = store.join("bob", "Bob");
    const pab = manualPairing(store, a.id, b.id, future());
    pab.giverDone = true; a.given++; store.trySettle(pab); store.persist();
    // giver moved forward even though receiver never confirmed
    expect(a.given).toBe(1);
    expect(b.received).toBe(0);
    expect(pab.status).toBe("open");
  });

  it("skip lapses the pairing; leave removes the player from polling", () => {
    const store = freshStore();
    const a = store.join("alice", "Alice");
    const b = store.join("bob", "Bob");
    const pab = manualPairing(store, a.id, b.id, future());
    lapseAll(store, b.id); // receiver not attending
    expect(pab.status).toBe("lapsed");
    expect(pollFor(store, a)).toMatchObject({ role: "idle" });
    a.status = "left"; store.persist();
    expect(pollFor(store, a)).toMatchObject({ role: "idle" });
  });
});

describe("lead-time gating", () => {
  it("holds the offer and prime until the event is within the lead window", () => {
    const store = freshStore();
    const a = store.join("alice", "Alice");
    const b = store.join("bob", "Bob");
    manualPairing(store, a.id, b.id, future(), 300); // event 5h out, beyond the 3h offer lead
    expect(pollFor(store, a)).toMatchObject({ role: "idle" }); // giver's offer held
    expect(pollFor(store, b)).toMatchObject({ role: "idle" }); // receiver's prime held
  });

  it("holds the go until the event is imminent, even after accept + identifier", () => {
    const store = freshStore();
    const a = store.join("alice", "Alice");
    const b = store.join("bob", "Bob");
    const pab = manualPairing(store, a.id, b.id, future(), 90); // within offer lead, not go lead
    pab.giverAccepted = true; pab.receiverReady = true; pab.identifier = "red scarf"; store.persist();
    expect(pollFor(store, a)).toMatchObject({ role: "idle" }); // go held (90 min > 20)
    const tenBefore = Date.now() + 80 * 60_000; // poll 10 min before start
    expect(pollFor(store, a, tenBefore)).toMatchObject({ role: "give", stage: "go", find: "red scarf" });
  });

  it("sends the giver by the receiver's name even if the receiver never confirmed (may be offline)", () => {
    const store = freshStore();
    const a = store.join("alice", "Alice");
    const b = store.join("bob", "Bob Smith");
    const pab = manualPairing(store, a.id, b.id, future(), 5); // imminent
    pab.giverAccepted = true; store.persist(); // receiver has NOT confirmed (could be offline)
    const go = pollFor(store, a);
    expect(go).toMatchObject({ role: "give", stage: "go", who: "Bob Smith" });
    expect(go.find).toBeUndefined();
  });

  it("uses the receiver's description in the go when they did confirm one", () => {
    const store = freshStore();
    const a = store.join("alice", "Alice");
    const b = store.join("bob", "Bob");
    const pab = manualPairing(store, a.id, b.id, future(), 5);
    pab.giverAccepted = true; pab.receiverReady = true; pab.identifier = "green cap"; store.persist();
    expect(pollFor(store, a)).toMatchObject({ role: "give", stage: "go", find: "green cap" });
  });
});

describe("liveness (giver must be live, receiver can be offline)", () => {
  it("won't make a stale-agent player a giver, but will pair a live giver to an offline receiver", () => {
    const store = freshStore();
    const live = store.join("live", "Live One");
    const stale = store.join("stale", "Stale One");
    const now = Date.now();
    live.lastPollAt = now;
    stale.lastPollAt = now - 5 * 3600_000; // 5h ago: stale
    store.persist();
    runMatch(store, presence(["Live One", "Stale One"], future(), future()), now);
    const ps = store.openPairings();
    expect(ps).toHaveLength(1);
    expect(ps[0].giver).toBe(live.id);     // the live one gives
    expect(ps[0].receiver).toBe(stale.id); // the offline one receives
  });

  it("makes no pairing when nobody is live to give", () => {
    const store = freshStore();
    const now = Date.now();
    for (const n of ["A A", "B B"]) { const p = store.join(n.toLowerCase(), n); p.lastPollAt = now - 5 * 3600_000; }
    store.persist();
    runMatch(store, presence(["A A", "B B"], future(), future()), now);
    expect(store.openPairings()).toHaveLength(0);
  });
});

describe("hub fallback (no-RSVP floaters)", () => {
  it("pulls a no-RSVP floater into a hub event with someone who is going", () => {
    const store = freshStore();
    const goer = store.join("goer", "Hub Goer");
    const floater = store.join("floater", "No Rsvp");
    const pres: EventPresence[] = [{
      event: { id: "h1", title: "Deep Work", startsAt: future(), endsAt: future(), venue: "The Hub - Co-Work", location: "" },
      names: new Set([nameKey("Hub Goer")]), // only the goer RSVP'd
    }];
    runMatch(store, pres, Date.now());
    const ids = new Set([goer.id, floater.id]);
    expect(store.pairings().some((p) => ids.has(p.giver) && ids.has(p.receiver))).toBe(true);
  });

  it("matches two floaters around the hub even with no events at all", () => {
    const store = freshStore();
    store.join("a", "Aaa Bbb");
    store.join("b", "Ccc Ddd");
    runMatch(store, [], Date.now());
    expect(store.openPairings().length).toBeGreaterThan(0);
  });
});

describe("ledger balance (received -> give next)", () => {
  it("makes the one who received the giver, and the one who gave the receiver", () => {
    const store = freshStore();
    const now = Date.now();
    const a = store.join("a", "A Aa"); a.received = 2; a.given = 0; a.lastPollAt = now; // received -> should give
    const b = store.join("b", "B Bb"); b.given = 2; b.received = 0; b.lastPollAt = now;  // gave -> should receive
    store.persist();
    runMatch(store, presence(["A Aa", "B Bb"], future(), future()), now);
    const op = store.openPairings();
    expect(op).toHaveLength(1);
    expect(op[0].giver).toBe(a.id);
    expect(op[0].receiver).toBe(b.id);
  });
});

describe("declined events (recurring-RSVP guard)", () => {
  it("skip records a decline so the matcher won't re-pair them at that event", () => {
    const store = freshStore();
    const names = ["Alice A", "Bob B"];
    names.forEach((n) => store.join(n.toLowerCase(), n));
    const pres = presence(names, future(), future()); // event id "e1"
    runMatch(store, pres, Date.now());
    expect(store.openPairings().length).toBeGreaterThan(0);
    // the receiver declines: lapse + record decline for that event
    const bob = store.players().find((p) => p.edgeosName === "Bob B")!;
    for (const pr of store.openPairings()) if (pr.giver === bob.id || pr.receiver === bob.id) store.decline(bob.id, pr.eventId);
    lapseAll(store, bob.id);
    expect(store.hasDeclined(bob.id, "e1")).toBe(true);
    // matcher must not re-pair Bob AT e1 (he may still get a hub offer elsewhere)
    runMatch(store, pres, Date.now());
    expect(store.openPairings().some((p) => (p.giver === bob.id || p.receiver === bob.id) && p.eventId === "e1")).toBe(false);
  });
});
