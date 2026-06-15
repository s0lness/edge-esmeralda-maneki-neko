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

- `skills/maneki/SKILL.md` — the agent skill (voice, flow, endpoints).
- `.claude-plugin/` — plugin + marketplace manifests, so an agent can install it.
- `src/server.ts` — the HTTP coordinator (the orchestra).
- `src/match.ts` — EdgeOS co-presence matcher + expiry.
- `src/flow.ts` — the poll state machine (what an agent should do this tick).
- `src/state.ts` — the store: players, ledger, pairings.
- `src/edgeos.ts` — EdgeOS events + participants client.
- `src/directory.ts` — optional name -> Telegram lookup (PII, supplied at runtime).
- `tests/` — engine + lifecycle tests.
- `DESIGN.md` — the design doc.

## Coordinator API

- `POST /join {handle, edgeosName, preferences}` -> `{token}`
- `GET  /poll?token=` -> `{role, stage, ...}`
- `POST /accept` · `/identifier` · `/done` · `/confirm` · `/reveal` · `/skip` · `/leave` · `/flag`
- `POST /admin/seed`, `POST /admin/match`, `GET /admin/state` (require `x-admin-token`)
- `GET /stats` (public, no PII)

## Run locally

```
npm install
npm test
cp .env.example .env   # fill in EDGEOS_API_KEY
ADMIN_TOKEN=dev npm start   # serves on :8080
```

## Deploy

Where gcloud is installed and authed (Cloud Shell / WSL / Mac):

```
PROJECT=your-project REGION=us-west1 ADMIN_TOKEN=$(openssl rand -hex 16) ./deploy.sh
```

This stores the EdgeOS key in Secret Manager and deploys to Cloud Run as a single
warm instance (the file store needs a GCS backend before scaling past one). The
script prints the live URL; put it in place of `https://MANEKI_HOST` in the skill.

## Status

Engine, coordinator, skill, and plugin scaffold built and tested (the full
EdgeOS-presence -> pairing path is verified). Remaining: rotate the EdgeOS key,
run the deploy, wire the live URL into the skill, then seed the founder rings.
