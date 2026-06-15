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
    giverAccepted: false, giverDone: false, receiverConfirmed: false, status: "open", createdAt: now,
  };
  store.addPairing(p);
  return p;
}
const future = () => new Date(Date.now() + 2 * 3600_000).toISOString();

describe("matcher", () => {
  it("forms a balanced cycle from co-present, free players: each gives once and receives once", () => {
    const store = freshStore();
    const names = ["Sylve", "Timour", "Talamon"];
    names.forEach((n) => store.join(n.toLowerCase(), n));
    runMatch(store, presence(names, future(), future()), Date.now());
    const ps = store.pairings();
    expect(ps).toHaveLength(3);
    expect(ps.every((p) => p.giver !== p.receiver)).toBe(true);
    const givers = ps.map((p) => p.giver).sort();
    const receivers = ps.map((p) => p.receiver).sort();
    const ids = store.players().map((p) => p.id).sort();
    expect(givers).toEqual(ids);
    expect(receivers).toEqual(ids);
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

    // receiver is primed first
    expect(pollFor(store, b)).toMatchObject({ role: "receive", stage: "prime" });
    pab.identifier = "green cap by the fig tree"; store.persist();

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
    pab.giverAccepted = true; pab.identifier = "red scarf"; store.persist();
    expect(pollFor(store, a)).toMatchObject({ role: "idle" }); // go held (90 min > 20)
    const tenBefore = Date.now() + 80 * 60_000; // poll 10 min before start
    expect(pollFor(store, a, tenBefore)).toMatchObject({ role: "give", stage: "go", find: "red scarf" });
  });
});
