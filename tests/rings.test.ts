import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/state.ts";
import { formRing, activeLink, completeActiveLink, ringProgress } from "../src/rings.ts";

let dir = "";
function freshStore() {
  dir = mkdtempSync(join(tmpdir(), "maneki-"));
  return new Store(join(dir, "t.db.json"));
}
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

describe("kindness ring", () => {
  it("forms a ring of 5 and closes after exactly 5 hops, last hop returning to start", () => {
    const store = freshStore();
    const ids = ["a", "b", "c", "d", "e"].map((h) => store.join(h, h).id);
    const ring = formRing(store, ids);
    expect(ring.links).toHaveLength(5);
    // first hop is members[0] -> members[1]
    expect(activeLink(ring)!.giver).toBe(ids[0]);
    expect(activeLink(ring)!.receiver).toBe(ids[1]);
    // last link closes back to the start
    expect(ring.links[4].giver).toBe(ids[4]);
    expect(ring.links[4].receiver).toBe(ids[0]);

    let closed = false;
    for (let hop = 0; hop < 5; hop++) {
      expect(ring.status).toBe("open");
      const r = completeActiveLink(store, store.ring(ring.id)!);
      closed = r.closed;
    }
    expect(closed).toBe(true);
    const fresh = store.ring(ring.id)!;
    expect(fresh.status).toBe("closed");
    expect(fresh.closedAt).toBeTruthy();
    expect(ringProgress(fresh).done).toBe(5);
  });

  it("each link gives to the next; every member is once a giver and once a receiver", () => {
    const store = freshStore();
    const ids = ["a", "b", "c", "d", "e"].map((h) => store.join(h, h).id);
    const ring = formRing(store, ids);
    const givers = ring.links.map((l) => l.giver).sort();
    const receivers = ring.links.map((l) => l.receiver).sort();
    expect(givers).toEqual([...ids].sort());
    expect(receivers).toEqual([...ids].sort());
  });

  it("a ring carries codewords so the giver can identify safely", () => {
    const store = freshStore();
    const ids = ["a", "b", "c"].map((h) => store.join(h, h).id);
    const ring = formRing(store, ids);
    for (const l of ring.links) expect(l.codeword.length).toBeGreaterThan(3);
  });
});

