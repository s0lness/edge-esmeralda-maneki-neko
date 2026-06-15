# maneki — design

A small kindness game for Edge Esmeralda. Personal AI agents nudge their humans
into tiny acts of kindness for other attendees. After Bruce Sterling's "Maneki
Neko": a gift economy where the network keeps you whole, not a ledger you settle
by hand.

## Core model: a ledger, not fixed rings

No pre-computed ring. Each player has a running balance of given vs received.
The cat's one job: **no one stays a net giver overnight.** You gave today, so
the cat sends someone your way today. This is more faithful to Sterling (your
gift never loops back to *you*; the system just keeps you whole) and far more
robust than a fixed ring (no single flake can stall a cycle, no upfront N-way
matching, works from 2 live players upward).

The ring engine still exists for the rare case we want a themed closed loop, but
the ledger is the backbone.

### The invariant

Keep every active player's running balance near zero within a day: prefer pairing
a giver who is neutral-or-in-credit with a receiver who has given but not yet
received (or a newcomer).

**Each side posts its own entry; we never wait on both.** The two confirmations
are decoupled:

- Alice says "I gave" → credit Alice as a giver (the cat now owes her). Posted.
- Bob says "I received" → close Bob's owed status. Posted.

These are two independent postings, not one transaction needing both signatures.
Trusting each half is safe because of an asymmetry:

- Claiming you **received** is self-penalizing (it only makes the cat less likely
  to send you a gift), so there is no incentive to lie. Trust it freely.
- Claiming you **gave** earns a return, so it is mildly gameable. But the stake is
  a coffee, and a serial false-giver surfaces as a pattern (their claimed
  receivers never corroborate). So both reports are kept and cross-checked as a
  **corroboration / fraud signal, never as a gate.** Alice gave + Bob confirms =
  clean; Alice gave + Bob repeatedly never confirms = soft flag to the host.

## Ticking forward

There is no global "advance to the next event" barrier (that is the ring model).
The matcher is a loop that runs **on the heartbeat against the event schedule**:
each tick, for each upcoming event, it reads who RSVP'd, who is live and in-game,
and current balances, then forms new pairings to fill needs. Each pairing's life
is bounded by its event's end (expiry). **Human reports never gate the clock** — a
laggard just carries a slightly stale balance, which self-heals.

Laggards are handled without ever blocking:

1. **One gentle nudge.** The agent asks once ("did you manage to bring that over?"
   / "did someone bring you something?"), deduped so it never nags.
2. **Expiry.** Still silent by event-end plus a short grace → the pairing lapses,
   nothing posts, both re-enter the pool for a later event.

Failure modes are benign by design: worst case is a redundant second gift or an
extra nudge. Over-delivering kindness is acceptable; stalling is not.

## Who can be matched (the gate)

A pairing only forms when ALL hold:

1. **Both RSVP'd the same upcoming dated event** (via EdgeOS `eventParticipants`).
   This single gate does three jobs at once: it guarantees co-presence (kills the
   no-show), proves both are on-site that day (handles the "only here a week" and
   "must be week 3" worry for free, since someone who has left has no RSVPs), and
   gives a real, public place + time to meet.
2. **Both are live** (their agent has polled recently). Hosted Hermes agents are
   always running, so this mostly holds, but we still only pair live players.
3. **Both are in the game** (joined, not exited).

Presence is therefore never self-declared. It is an RSVP to a real dated event.

## The flow

1. **Join (once).** The agent registers its human with their Edge name and the
   things they like to be called. Onboarding also captures **preferences**:
   favorite drink, anything to avoid (allergies). Server verifies the Edge name
   against the attendee directory (kills "join as someone famous"). Returns a
   token the agent polls with. Nothing about ids/tokens is ever spoken to the human.

2. **Match.** Server finds a valid pairing per the gate above and assigns a gift
   (using the receiver's drink preference when the gift is a drink).

3. **Prime the receiver (Bob).** Bob's agent: "someone may bring you a little
   something at {event}. How will they spot you?" Keep who/why a mystery. Take his
   self-chosen identifier ("green cap by the window"). Never reveal his name/handle
   to the giver, only this identifier.

4. **Offer to the giver (Alice).** Alice's agent dares her warmly, naming the
   place and the act. On yes, she's committed; on "not now", ask again next tick.

5. **Go.** Once both are primed, Alice's agent tells her exactly how to find Bob
   (his identifier), the codeword to say so he knows it's the game, and the act
   (with his drink if relevant).

6. **Settle (decoupled).** Alice tells her agent she gave → credit Alice. Bob's
   agent confirms he received → close Bob's owed status. Each posts independently;
   neither waits on the other. The two together corroborate (fraud signal), but
   either alone is enough to move that person's balance.

7. **Reveal.** After settle, each agent *offers* to share the other's Telegram
   handle so they can stay in touch ("want me to pass along their handle?").
   Opt-out is fine. This is the directory's second job and the payoff of the game.

## Exit vs. not-now (two different things)

- **"not now"** — skip this one offer, stay in the game. Ask again next tick.
- **"I'm out"** — leave entirely. Removed from all future matching until they
  rejoin. A hard stop, no friction, honored instantly.

## Gifts

Small, warm, never a transaction. The giver can always swap, and there is always
a free option. Drink gifts use the receiver's stored preference.

- bring them their go-to drink (coffee/tea/water — we know it from join)
- bring them a snack or a piece of seasonal fruit
- a single flower from the plaza
- share half of the pastry you already bought
- fill their water bottle on a hot afternoon
- a handwritten note: "glad you're here"
- (moving venues like Run Club, word-only) a genuine compliment, a recommendation,
  the most interesting thing you heard today

Avoid anything that reads as networking, costs more than a few dollars, or feels
like an obligation.

## The directory's role

586 visible Telegram handles, name-linked. Used server-side only, never shown to
other players except at the post-settle reveal:

1. **Verify** the claimed Edge name at join.
2. **Disambiguate** name → RSVP matching (the two "Alex"es).
3. **Reveal** each other's handle after a settled exchange (opt-in).

We do NOT DM anyone via their directory handle. Delivery always goes through the
person's own agent (a bot can't DM someone who hasn't started it).

## Distribution & updates

Published as a Claude Code plugin, Edge-style:

- A git marketplace repo: `marketplace.json` + `plugin.json` with a `version`.
- `userConfig` carries `MANEKI_TOKEN` (sensitive), so no hand-wired env.
- A heartbeat task (interval ~30m) registered following Edge's rules: silence is
  the default, at most one user-facing message per tick, dedup on ids in
  `heartbeat-state.json`, so we compose with the agent's existing heartbeat.
- **Update channel:** structural changes ship by version bump + push (agents
  re-pull). High-churn *content* (gift list, copy, timings) lives server-side in
  the `/poll` payload so we don't cut a release per tweak. A short "what's new"
  line can ride the poll payload for in-band news.

## Server endpoints

- `POST /join {handle, edgeosName, preferences?}` → `{token}`
- `GET  /poll?token=` → `{role, stage, gift?, find?, codeword?, venue?, at?, reveal?, news?}`
- `POST /accept {token}` — giver commits
- `POST /identifier {token, identifier}` — receiver says how to be spotted
- `POST /done {token}` — giver marks given
- `POST /confirm {token}` — receiver confirms received (double-entry settle)
- `POST /reveal {token, ok}` — opt in/out of sharing handle post-settle
- `POST /skip {token}` — not now
- `POST /leave {token}` — exit the game entirely
- `POST /flag {token, note}` — something felt off (escalates to a Telegram DM to the host)

## Cracks & mitigations (live list)

| crack | mitigation |
|---|---|
| no-show / hang | gate on shared dated RSVP; offers expire at event end; receiver only ever told "someone *might*" |
| consent / safety | joining is consent; public events only; receiver picks what to share; instant exit; agent's "stop and tell your human" is first line |
| silent delivery failure | only pair live agents (Hermes always-on helps) |
| identity spoofing | verify Edge name against the directory at join |
| gift burden | suggested not mandated; swap allowed; free option always; drink known from join |
| gaming the ledger | balances stay private, never a public scoreboard; receipt-claims are self-penalizing; serial false-givers surface via missing corroboration |
| someone goes silent / lags | each side posts its own entry (never wait on both); one deduped nudge; pairing expires and re-pools if unreported |
| only-here-a-week / week 3 | handled free by the shared-RSVP gate (no RSVP, no match) |

The two to watch hardest: safety (can harm a person) and silent delivery failure
(breaks trust with no error anywhere).
