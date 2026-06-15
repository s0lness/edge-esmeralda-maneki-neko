import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomBytes } from "node:crypto";

/** A person playing. Their own agent pushes to them; we just hold a token the
 *  agent polls with, and their Edge name so we can place them at events. */
export interface Player {
  id: string;
  handle: string;
  edgeosName: string;
  token: string;
  ringId?: string;   // which ring they belong to (a founder's ring)
  joinedAt: number;
}

export type LinkStatus = "waiting" | "offered" | "accepted" | "primed" | "met" | "skipped";

/** One hop of the cascade: giver does a kindness for receiver. */
export interface Link {
  giver: string;   // player id
  receiver: string;
  status: LinkStatus;
  gift?: string;          // the act, chosen at offer time
  identifier?: string;    // receiver-provided: "green cap by the window"
  codeword: string;       // giver says it so receiver knows it's the game
  venue?: string;         // proposed rendezvous (real EdgeOS event/venue)
  at?: string;            // proposed time
  offeredAt?: number;
  metAt?: number;
}

/** A ring: members in order; the gift travels member[i] -> member[i+1], and the
 *  final hop closes back to member[0]. We measure whether (and how fast) it closes. */
export interface Ring {
  id: string;
  members: string[];      // ordered player ids
  links: Link[];          // links[i]: members[i] -> members[(i+1) % n]
  current: number;        // index of the active link
  status: "open" | "closed" | "stalled";
  createdAt: number;
  closedAt?: number;
}

interface Data { players: Player[]; rings: Ring[]; seq: number }

export class Store {
  private path: string;
  private data: Data;
  constructor(file = process.env.MANEKI_DB ?? "maneki.db.json") {
    this.path = resolve(process.cwd(), file);
    this.data = existsSync(this.path) ? JSON.parse(readFileSync(this.path, "utf8")) : { players: [], rings: [], seq: 1 };
  }
  private save() { writeFileSync(this.path, JSON.stringify(this.data, null, 2)); }

  // players
  /** Register a player; returns the (token-bearing) record. Re-joining with the
   *  same edgeosName updates the handle and keeps the token/ring. */
  join(handle: string, edgeosName: string, ringId?: string): Player {
    let p = edgeosName ? this.data.players.find((x) => x.edgeosName.toLowerCase() === edgeosName.toLowerCase()) : undefined;
    if (p) { p.handle = handle; if (ringId && !p.ringId) p.ringId = ringId; }
    else {
      p = { id: `p${this.data.seq++}`, handle, edgeosName, token: this.token(), ringId, joinedAt: Date.now() };
      this.data.players.push(p);
    }
    this.save();
    return p;
  }
  player(id: string) { return this.data.players.find((p) => p.id === id); }
  playerByToken(token: string) { return this.data.players.find((p) => p.token === token); }
  players() { return this.data.players; }

  // rings
  addRing(r: Ring) { this.data.rings.push(r); this.save(); }
  ring(id: string) { return this.data.rings.find((r) => r.id === id); }
  rings() { return this.data.rings; }
  ringOfLink(giver: string, receiver: string): Ring | undefined {
    return this.data.rings.find((r) => r.status === "open" && r.links[r.current]?.giver === giver && r.links[r.current]?.receiver === receiver);
  }
  persist() { this.save(); }
  newId(p = "r") { return `${p}${this.data.seq++}`; }
  token() { return randomBytes(8).toString("hex"); }
}
