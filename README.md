# Edge Esmeralda — Maneki Neko

A little kindness game for Edge Esmeralda. Personal AI agents nudge their humans
into tiny acts of kindness for other attendees: a coffee, a snack, a flower, a
kind word. After Bruce Sterling's "Maneki Neko", the network keeps everyone
whole, so if you give, someone comes your way too.

## How it works

- People install a small **skill** into their own personal agent (`skill/`).
- The agent registers them and, on a ~30 minute heartbeat, checks a central
  **coordinator** to see if it's their turn to give, or whether someone is about
  to bring them a kindness.
- Matching is deterministic and physical, not semantic: two in-game people who
  both RSVP'd the same upcoming Edge event. No intent graph, no networking.
- A private **ledger** keeps everyone near balance: give today, receive today.

See [DESIGN.md](DESIGN.md) for the full design, the flow, and the open cracks.

## Layout

- `skill/SKILL.md` — the agent skill (voice, flow, endpoints). Distributed, not
  published in this repo's history as a marketplace yet.
- `src/` — the engine: EdgeOS client, the store, the ring/ledger logic.
- `tests/` — engine tests.
- `DESIGN.md` — the design doc.

## Status

Design locked, engine and skill drafted. The HTTP coordinator (serving `/join`,
`/poll`, and the rest) and the plugin/marketplace scaffold are next.

## Setup

Copy `.env.example` to `.env` and fill in your EdgeOS API key. The key is never
committed (`.env` is gitignored).

```
npm install
npm test
```
