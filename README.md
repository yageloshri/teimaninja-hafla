# Teimaninja — Hafla server (חפלה, real-time 1v1)

Stateless Node + `ws` + Redis. Authoritative **shared-seed** broker: it draws
one seed for both players, relays score numbers (~250ms), and rules the winner.
It never sends fruit positions — both clients play the same seed locally and
the spawn sequence is byte-identical (proven in the Flutter test
`test/playtest/hafla_determinism_test.dart`).

Owned by `multiplayer-agent`. Behind the client flag `hafla_enabled` (default
OFF). Full design + rollout: `../handoffs/hafla-design.md`.

## Run locally
```bash
cd server
npm install
docker run -p 6379:6379 redis        # or any local Redis
npm run dev                          # http://localhost:8080/health
```

## Protocol
JSON over WebSocket, see `src/protocol.js`. Client→server: `quick_queue`,
`create_room`, `join_room`, `score_tick`, `finish`, `cancel`, `hb`.
Server→client: `queued`, `room_created`, `match_found`, `countdown`, `go`,
`opponent_tick`, `opponent_weak`, `result`, `opponent_left`, `error`.

## Deploy (Render)
`render.yaml` is a blueprint, but finish in the dashboard per
`../handoffs/hafla-design.md` → **Render manual checklist** (Professional plan
auto-scaling, min-1 always-warm / no scale-to-zero, Key Value/Redis instance).

## Not yet wired (multiplayer-agent backlog)
- Firestore result-writer that drains the `hafla:results` Redis stream and
  emits the analytics events (firebase-agent handoff).
- Bot pacing tuned against playtest-bot real medians.
- Load/fairness validation: two playtest bots in one shared-seed match.
