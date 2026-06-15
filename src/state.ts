import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { scheduleUpload } from "./persist.ts";

export interface Preferences { drink?: string; avoid?: string }

/** A person playing. Their own agent pushes to them; we just hold a token the
 *  agent polls with, their Edge name so we can place them at events, and a
 *  running ledger (given vs received) so the cat keeps everyone near balance. */
export interface Player {
  id: string;
  handle: string;
  edgeosName: string;
  token: string;
  ringId?: string;          // legacy: themed-ring membership (ledger is the backbone now)
  preferences?: Preferences;
  telegram?: string;        // resolved server-side from the directory; shown only at reveal
  given: number;            // settled gifts given
  received: number;         // settled gifts received
  status: "active" | "left";
  joinedAt: number;
  lastPollAt?: number;
}

/** One opportunistic gift between two present people. Both sides advance their
 *  own half independently (see DESIGN: decoupled single-entry settle). */
export interface Pairing {
  id: string;
  giver: string;            // player id
  receiver: string;         // player id
  eventId: string;
  eventTitle: string;
  venue?: string;
  at?: string;              // ISO start
  endsAt?: string;          // ISO end, for expiry
  gift: string;
  codeword: string;
  identifier?: string;      // receiver's "how to spot me"
  giverAccepted: boolean;
  giverDone: boolean;       // giver says they gave -> giver.given++
  receiverConfirmed: boolean; // receiver says they got it -> receiver.received++
  giverRevealOk?: boolean;
  receiverRevealOk?: boolean;
  status: "open" | "lapsed" | "settled";
  createdAt: number;
}

export interface Flag { playerId: string; note: string; at: number }

// --- legacy ring model (kept for themed loops + existing tests) ---
export type LinkStatus = "waiting" | "offered" | "accepted" | "primed" | "met" | "skipped";
export interface Link {
  giver: string; receiver: string; status: LinkStatus;
  gift?: string; identifier?: string; codeword: string;
  venue?: string; at?: string; offeredAt?: number; metAt?: number;
}
export interface Ring {
  id: string; members: string[]; links: Link[]; current: number;
  status: "open" | "closed" | "stalled"; createdAt: number; closedAt?: number;
}

interface Data { players: Player[]; rings: Ring[]; pairings: Pairing[]; flags: Flag[]; seq: number }

export class Store {
  private path: string;
  private data: Data;
  constructor(file = process.env.MANEKI_DB ?? "maneki.db.json") {
    this.path = resolve(process.cwd(), file);
    this.data = this.read();
  }
  private read(): Data {
    const fresh: Data = { players: [], rings: [], pairings: [], flags: [], seq: 1 };
    return existsSync(this.path) ? { ...fresh, ...JSON.parse(readFileSync(this.path, "utf8")) } : fresh;
  }
  /** Re-read from the local file. Call after a boot-time GCS restore overwrote it. */
  reload() { this.data = this.read(); }
  private save() {
    writeFileSync(this.path, JSON.stringify(this.data, null, 2));
    scheduleUpload(this.path); // GCS snapshot (no-op outside Cloud Run)
  }
  persist() { this.save(); }

  // players
  /** Register a player; returns the (token-bearing) record. Re-joining with the
   *  same edgeosName updates handle/preferences and keeps the token + ledger. */
  join(handle: string, edgeosName: string, preferences?: Preferences): Player {
    let p = edgeosName ? this.data.players.find((x) => x.edgeosName.toLowerCase() === edgeosName.toLowerCase()) : undefined;
    if (p) {
      p.handle = handle;
      if (preferences) p.preferences = { ...p.preferences, ...preferences };
      if (p.status === "left") p.status = "active";
    } else {
      p = {
        id: `p${this.data.seq++}`, handle, edgeosName, token: this.token(),
        preferences, given: 0, received: 0, status: "active", joinedAt: Date.now(),
      };
      this.data.players.push(p);
    }
    this.save();
    return p;
  }
  player(id: string) { return this.data.players.find((p) => p.id === id); }
  playerByToken(token: string) { return this.data.players.find((p) => p.token === token); }
  players() { return this.data.players; }
  activePlayers() { return this.data.players.filter((p) => p.status === "active"); }

  // pairings
  addPairing(p: Pairing) { this.data.pairings.push(p); this.save(); }
  pairings() { return this.data.pairings; }
  openPairings() { return this.data.pairings.filter((p) => p.status === "open"); }
  /** Open pairing where this player is the giver and hasn't finished giving. */
  giverPairing(pid: string) { return this.data.pairings.find((p) => p.status === "open" && p.giver === pid && !p.giverDone); }
  /** Open pairing where this player is the receiver and hasn't confirmed. */
  receiverPairing(pid: string) { return this.data.pairings.find((p) => p.status === "open" && p.receiver === pid && !p.receiverConfirmed); }
  /** Any open pairing involving this player (used to gate re-matching). */
  hasOpenPairing(pid: string) { return this.data.pairings.some((p) => p.status === "open" && (p.giver === pid || p.receiver === pid)); }
  /** A settled pairing this player is in but hasn't answered the reveal for. */
  revealPairing(pid: string) {
    return this.data.pairings.find((p) => p.status === "settled" && (
      (p.giver === pid && p.giverRevealOk === undefined) || (p.receiver === pid && p.receiverRevealOk === undefined)
    ));
  }
  /** Mark settled if both halves are in. */
  trySettle(p: Pairing) { if (p.giverDone && p.receiverConfirmed) p.status = "settled"; }

  flag(playerId: string, note: string) { this.data.flags.push({ playerId, note, at: Date.now() }); this.save(); }
  flags() { return this.data.flags; }

  // legacy rings
  addRing(r: Ring) { this.data.rings.push(r); this.save(); }
  ring(id: string) { return this.data.rings.find((r) => r.id === id); }
  rings() { return this.data.rings; }
  ringOfLink(giver: string, receiver: string): Ring | undefined {
    return this.data.rings.find((r) => r.status === "open" && r.links[r.current]?.giver === giver && r.links[r.current]?.receiver === receiver);
  }

  newId(p = "x") { return `${p}${this.data.seq++}`; }
  token() { return randomBytes(8).toString("hex"); }
}
