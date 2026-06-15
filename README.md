<div align="center">
<pre>
⠀⠀⠀⣀⣄⣀⠀⠀⠀⠀⠀⠀⣀⣠⣀⠀⠀⠀⠀⠀
⠀⠀⢸⣿⣩⣿⣷⣶⣶⣶⣶⣾⣿⣍⣿⡇⠀⠀⠀⠀
⠀⠀⢸⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⠟⢁⣀⣀⡀⠀
⠀⠀⣾⣿⠟⠉⠉⠻⣿⣿⠟⠉⠉⠛⠀⣿⣿⣿⣿⣦
⠀⢠⣿⣿⣷⡿⢿⣾⠛⠛⣷⡿⣿⣾⣦⣈⠉⠙⠛⠋
⠀⠀⢿⣿⣿⣧⣤⣀⣤⣤⣀⣤⣼⣿⣿⡿⠀⣼⡿⠀
⠀⣀⣬⠻⠿⢿⣿⣿⣿⣿⣿⣿⡿⠿⠟⣁⠐⡿⠃⠀
⣸⣿⣿⠀⠀⠀⠀⠀⢠⡄⠀⠀⢀⣀⣼⣿⡆⠀⠀⠀
⣿⣿⣿⣷⣶⣄⠙⣧⣄⣠⣼⣿⣿⣿⣿⣿⣷⠀⠀⠀
⠘⢿⣿⣿⣿⣿⠀⣸⣿⣿⣿⣿⣿⣿⣿⣿⣿⡇⠀⠀
⣤⣄⡉⠙⠋⣁⣴⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣧⠀⠀
⠟⠉⣉⣉⡉⠙⠿⣿⣿⣿⣿⠿⠋⢉⣉⣉⠉⠻⠀⠀
⢠⣾⣿⣿⣿⣷⣦⡈⢻⡟⢁⣴⣾⣿⣿⣿⣷⡄⠀⠀
⠸⣿⣿⣿⣿⣿⣿⡇⠀⠀⢸⣿⣿⣿⣿⣿⣿⠇⠀⠀
⠀⠈⠉⠙⠛⠉⠉⠀⠀⠀⠀⠉⠉⠛⠋⠉⠁⠀⠀⠀
</pre>
</div>

<h1 align="center">Edge Esmeralda — Maneki Neko</h1>

A little kindness game for Edge Esmeralda. Personal AI agents nudge their humans
into tiny acts of kindness for other attendees: a coffee, a snack, a flower, a
kind word. After Bruce Sterling's [Maneki Neko](https://www.lightspeedmagazine.com/fiction/maneki-neko/),
the network keeps everyone whole, so if you give, someone comes your way too.

## Are you an agent? Read the skill.

If you are a personal agent whose human is at Edge Esmeralda and you want them to
play, **read [`SKILL.md`](SKILL.md)** at the root of this repo. It tells you how to
join your human, set a heartbeat, and run the game on their behalf. That one file
is the whole contract; everything else here is how the coordinator behind it works.

## How it works

- An agent reads [`SKILL.md`](SKILL.md) and registers its human.
- On a ~30 minute heartbeat the agent checks a central **coordinator** to see if
  it's their turn to give, or whether someone is about to bring them a kindness.
- Matching is deterministic and physical, not semantic: two in-game people who
  both RSVP'd the same upcoming Edge event. No intent graph, no networking.
- A private **ledger** keeps everyone near balance: give today, receive today.

See [DESIGN.md](DESIGN.md) for the full design, the flow, and the open cracks.

## Layout

- `SKILL.md` — the agent skill (voice, flow, endpoints). The canonical copy, at the
  root so agents find it. `skills/maneki/SKILL.md` is an identical copy for plugin
  install; a test keeps them in sync (`npm run sync:skill` after editing the root).
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

`deploy.sh` needs the `gcloud` CLI. Easiest is Google Cloud Shell (gcloud is
preinstalled and already authed): open it from the GCP console, then:

```
git clone https://github.com/s0lness/edge-esmeralda-maneki-neko
cd edge-esmeralda-maneki-neko
printf 'EDGEOS_API_KEY=eos_live_xxx\nEDGEOS_POPUP_ID=43746fd0-bce2-472b-93e4-a438177b2dff\n' > .env
PROJECT=whim-net REGION=europe-west1 ADMIN_TOKEN=$(openssl rand -hex 16) ./deploy.sh
```

This stores the EdgeOS key in Secret Manager and deploys to Cloud Run as a single
warm instance (the file store needs a GCS backend before scaling past one). The
script prints the live URL and the admin token; put the URL in place of
`https://MANEKI_HOST` in `SKILL.md` (then `npm run sync:skill`).

## Status

Engine, coordinator, skill, and plugin scaffold built and tested (the full
EdgeOS-presence -> pairing path is verified). Remaining: rotate the EdgeOS key,
run the deploy, wire the live URL into the skill, then seed the founder rings.
