// Teimaninja Hafla server — real-time 1v1, shared-seed authority.
//
// STATELESS + Redis: matchmaking queue and cross-instance relay live in Redis
// so Render can run >=1 warm instance and scale out. The instance that pairs a
// match owns its round timer and the authoritative ruling.
//
// This is the foundation the multiplayer-agent + playtest-bot harden. The
// shared-seed determinism it depends on is proven client-side in
// test/playtest/hafla_determinism_test.dart.

import http from 'node:http';
import crypto from 'node:crypto';
import { WebSocketServer } from 'ws';
import Redis from 'ioredis';

import {
  PORT,
  REDIS_URL,
  ORIGIN_ALLOWLIST,
  STRICT_ORIGIN,
  ROUND_SECONDS,
  COUNTDOWN_SECONDS,
  RECONNECT_GRACE_MS,
  BOT_FALLBACK_MS,
  MMR_BUCKET,
} from './config.js';
import { C2S, S2C, encode, decode } from './protocol.js';
import { spawnBot } from './bot.js';

// ---- Redis (shared state + pub/sub relay) --------------------------------
const redis = new Redis(REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 3 });
const sub = new Redis(REDIS_URL, { lazyConnect: true });
let redisReady = false;
redis.on('ready', () => { redisReady = true; });
redis.on('error', () => { redisReady = false; });

// ---- Observability -------------------------------------------------------
// Structured one-line logs at the key match-lifecycle points so match volume,
// started→settled completion, abandon rate, and bot-vs-real share are readable
// straight from Render logs (today they live only in GA4 — the server kept no
// queryable record). Anonymized anon-Firebase uids only; NEVER log PII.
// Additive: pure observation, no effect on matchmaking/gameplay/determinism.
function obs(fields) {
  try {
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ ...fields, ts: Date.now() }));
  } catch { /* logging must never throw into the hot path */ }
}

// Local connections this instance owns: playerId → ws.
const sockets = new Map();
// Matches this instance is finalizing: matchId → match record.
const localMatches = new Map();

const QUEUE_KEY = (bucket) => `hafla:q:${bucket}`;

// Believable opponent names for the fallback bot — the player must NOT be able
// to tell it's a bot, so it never carries a "bot/מתאמן" tell. Picked
// deterministically per match (by seed) so it's stable across the VS/bar/result.
const BOT_NAMES = [
  'רוני', 'אבישי', 'ליאור', 'עידן', 'נועם', 'איתי', 'דניאל', 'יואב',
  'אורי', 'תומר', 'שגב', 'מתן', 'אלון', 'גיא', 'הראל', 'עומר',
  'אסף', 'ניר', 'יותם', 'רותם',
];
const pickBotName = (seed) => BOT_NAMES[Math.abs(seed) % BOT_NAMES.length];

// ELIMINATION duel: the match runs until ONE player is eliminated (out of
// lives / bomb) — there is NO fixed round. This long safety cap only guards
// against a zombie match where nobody is ever eliminated; it's ruled by score
// as a last resort.
const MAX_MATCH_MS = 5 * 60 * 1000;

// ---- HTTP (health) -------------------------------------------------------
const server = http.createServer(async (req, res) => {
  if (req.url === '/health' || req.url === '/healthz') {
    let ok = redisReady;
    try { ok = (await redis.ping()) === 'PONG'; } catch { ok = false; }
    res.writeHead(ok ? 200 : 503, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: ok ? 'ok' : 'degraded', redis: ok }));
    return;
  }
  res.writeHead(404);
  res.end();
});

// ---- WebSocket -----------------------------------------------------------
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const origin = req.headers.origin;
  if (!originAllowed(origin)) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

function originAllowed(origin) {
  if (!origin) return !STRICT_ORIGIN; // native apps send no Origin
  return ORIGIN_ALLOWLIST.includes(origin);
}

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.player = null;
  ws.matchId = null;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', (raw) => handleMessage(ws, raw));
  ws.on('close', () => handleClose(ws));
});

async function handleMessage(ws, raw) {
  const msg = decode(raw.toString());
  if (!msg) return;
  const { type, data } = msg;

  switch (type) {
    case C2S.HEARTBEAT:
      ws.isAlive = true;
      break;

    case C2S.QUICK_QUEUE: {
      registerPlayer(ws, data);
      await tryMatchOrQueue(ws, data);
      break;
    }

    case C2S.CREATE_ROOM: {
      registerPlayer(ws, data);
      const code = roomCode();
      await redis.set(`hafla:room:${code}`, JSON.stringify({
        host: ws.player, mmr: data.mmr ?? 0,
      }), 'EX', 600);
      ws.roomCode = code;
      send(ws, S2C.ROOM_CREATED, { code });
      break;
    }

    case C2S.JOIN_ROOM: {
      registerPlayer(ws, data);
      const rawRoom = await redis.get(`hafla:room:${data.code}`);
      if (!rawRoom) { send(ws, S2C.ERROR, { message: 'room_not_found' }); break; }
      await redis.del(`hafla:room:${data.code}`);
      const host = JSON.parse(rawRoom);
      // The joiner's instance owns finalization (it has both? no — host may be
      // on another instance). Relay handles cross-instance; finalize-authority
      // is whichever instance calls startMatch. For room joins, the joiner.
      //
      // BUG FIX (playtest-bot): startMatch treats a/b as player ID STRINGS
      // everywhere (sockets.get(a), match.players[a], publishMatch(..,a,..)).
      // host.host is the full player OBJECT {id,name,mmr} that CREATE_ROOM
      // stored, and ws.player is also the full object — passing the objects
      // meant sockets.get({...}) was always undefined, so neither room player
      // ever received match_found and recordScore keyed by id never matched.
      // Pass the IDs, matching the quick_queue path which already uses
      // oppId / ws.player.id.
      startMatch({ a: host.host.id, b: ws.player.id, isBot: false });
      break;
    }

    case C2S.SCORE_TICK:
      relayToOpponent(ws, S2C.OPPONENT_TICK, {
        score: data.score | 0, combo: data.combo | 0, lives: data.lives | 0,
      });
      recordScore(ws, data.score | 0);
      break;

    case C2S.FINISH:
      recordScore(ws, data.score | 0, true);
      break;

    case C2S.REJOIN: {
      registerPlayer(ws, data);
      await rejoinMatch(ws, data.matchId);
      break;
    }

    case C2S.CANCEL:
      await leaveQueue(ws);
      break;
  }
}

// Bug D: a client that dropped mid-match reconnects within the grace window and
// asks to resume. Re-bind the socket to the match, re-subscribe the relay
// channel, cancel the pending abandon (handled implicitly — the abandon timer
// re-checks sockets.get(id).matchId), and replay the current opponent state so
// the returning client's opponent bar is correct again. The shared seed means
// the player's own local sim kept running, so resuming is a no-op on gameplay.
async function rejoinMatch(ws, matchId) {
  const match = matchId ? localMatches.get(matchId) : null;
  if (!match || match.settled || !match.players[ws.player.id]) {
    // Nothing to resume (wrong instance, already settled, or unknown match).
    send(ws, S2C.ERROR, { message: 'rejoin_failed' });
    return;
  }
  ws.matchId = matchId;
  if (ws.botTimer) clearTimeout(ws.botTimer);
  // Re-subscribe this instance to the relay (it may have unsubscribed nothing,
  // but a fresh subscribe is idempotent and covers a cross-instance return).
  sub.subscribe(`hafla:relay:${matchId}`).catch(() => {});
  // Clear the leaver mark so a late abandon timer sees the player is back.
  delete match.players[ws.player.id].leftAt;

  // Replay the opponent's current numbers so the resumed bar is accurate.
  const oppId = ws.player.id === match.a ? match.b : match.a;
  const opp = match.isBot
    ? { score: match.botScore ?? 0, combo: 0, lives: 0 }
    : { score: match.players[oppId]?.score ?? 0, combo: 0, lives: 0 };
  send(ws, S2C.REJOINED, { matchId, opponent: opp });
  // Let a human opponent know the reconnect succeeded (clear the "weak" hint).
  if (!match.isBot && oppId != null) {
    publishMatch(matchId, oppId, S2C.OPPONENT_TICK, {
      score: match.players[ws.player.id].score, combo: 0, lives: 0,
    });
  }
}

function registerPlayer(ws, data) {
  ws.player = { id: data.playerId, name: data.name ?? '', mmr: data.mmr ?? 0 };
  sockets.set(ws.player.id, ws);
}

// ---- Matchmaking ---------------------------------------------------------
async function tryMatchOrQueue(ws, data) {
  const bucket = Math.floor((data.mmr ?? 0) / MMR_BUCKET);
  // Try the player's bucket and the two adjacent ones for a waiting opponent.
  for (const b of [bucket, bucket - 1, bucket + 1]) {
    const oppId = await redis.lpop(QUEUE_KEY(b));
    if (oppId && oppId !== ws.player.id) {
      startMatch({ a: oppId, b: ws.player.id, isBot: false });
      return;
    }
  }
  await redis.rpush(QUEUE_KEY(bucket), ws.player.id);
  await redis.expire(QUEUE_KEY(bucket), 60);
  ws.queuedBucket = bucket;
  send(ws, S2C.QUEUED, {});
  obs({ evt: 'queue', uid: ws.player.id, mmr: data.mmr ?? 0 });

  // Bot fallback: if still queued after BOT_FALLBACK_MS, give them a bot.
  ws.botTimer = setTimeout(async () => {
    const removed = await redis.lrem(QUEUE_KEY(bucket), 1, ws.player.id);
    if (removed > 0 && ws.readyState === ws.OPEN) {
      startMatch({ a: ws.player.id, b: null, isBot: true });
    }
  }, BOT_FALLBACK_MS);
}

async function leaveQueue(ws) {
  if (ws.botTimer) clearTimeout(ws.botTimer);
  if (ws.queuedBucket != null && ws.player) {
    await redis.lrem(QUEUE_KEY(ws.queuedBucket), 1, ws.player.id);
  }
}

// ---- Match lifecycle -----------------------------------------------------
function startMatch({ a, b, isBot }) {
  const matchId = crypto.randomUUID();
  // Shared seed: a 31-bit positive int (fits Dart's Random(seed) cleanly).
  const seed = crypto.randomInt(1, 0x7fffffff);
  const match = {
    matchId, seed, isBot,
    players: { [a]: { score: 0, finished: false, weak: false } },
    a, b,
    bot: null,
    startMs: null,
    settled: false,
  };
  if (!isBot) match.players[b] = { score: 0, finished: false, weak: false };
  localMatches.set(matchId, match);

  // Observability: a match was made. isBot = the opponent is a bot-fallback.
  // mmrBucket = the coarse MMR band the pairing came from (same arithmetic as
  // tryMatchOrQueue) — anonymized uids only, NO PII.
  const aMmr = sockets.get(a)?.player?.mmr ?? 0;
  obs({
    evt: 'match_found', matchId, p1: a, p2: isBot ? 'bot' : b, isBot,
    mmrBucket: Math.floor(aMmr / MMR_BUCKET),
  });
  bumpMatchesCounter();

  // Subscribe this instance to the match relay channel (cross-instance ticks).
  sub.subscribe(`hafla:relay:${matchId}`).catch(() => {});

  const wsA = sockets.get(a);
  if (wsA) { wsA.matchId = matchId; if (wsA.botTimer) clearTimeout(wsA.botTimer); }
  const wsB = b ? sockets.get(b) : null;
  if (wsB) { wsB.matchId = matchId; if (wsB.botTimer) clearTimeout(wsB.botTimer); }

  const oppFor = (id) => {
    const otherId = id === a ? b : a;
    return isBot && otherId == null
      ? { name: pickBotName(seed), isBot: true }
      : { name: (sockets.get(otherId)?.player?.name) ?? '', isBot: false };
  };

  publishMatch(matchId, a, S2C.MATCH_FOUND, {
    matchId, seed, mode: 'classic', roundSeconds: ROUND_SECONDS,
    opponent: oppFor(a), isBot,
  });
  if (!isBot) {
    publishMatch(matchId, b, S2C.MATCH_FOUND, {
      matchId, seed, mode: 'classic', roundSeconds: ROUND_SECONDS,
      opponent: oppFor(b), isBot: false,
    });
  }

  runCountdown(match);
}

function runCountdown(match) {
  let n = COUNTDOWN_SECONDS;
  const tick = () => {
    if (match.settled) return;
    if (n > 0) {
      broadcast(match, S2C.COUNTDOWN, { n });
      n--;
      setTimeout(tick, 1000);
    } else {
      match.startMs = Date.now();
      broadcast(match, S2C.GO, { serverStartMs: match.startMs });
      if (match.isBot) startBot(match);
      // Safety cap only (no fixed round): if nobody is ever eliminated, rule
      // by score as a last resort.
      match.deadline = setTimeout(() => {
        const a = match.players[match.a].score;
        const b = match.isBot
          ? (match.botScore ?? 0)
          : match.players[match.b].score;
        settle(match, {
          reason: 'timeout',
          loserSeat: a < b ? 'a' : b < a ? 'b' : null,
        });
      }, MAX_MATCH_MS);
    }
  };
  tick();
}

function startBot(match) {
  const humanMmr = sockets.get(match.a)?.player?.mmr ?? 0;
  match.bot = spawnBot({
    matchId: match.matchId, seed: match.seed, humanMmr,
    // Keep the latest bot score for the opponent bar + the result display.
    onTick: (t) => {
      match.botScore = t.score;
      publishMatch(match.matchId, match.a, S2C.OPPONENT_TICK, t);
    },
    // The bot is ELIMINATED at its skill-based survival time → the human wins
    // (unless the human was already eliminated first — settle guards that).
    onEliminated: ({ score }) => {
      match.botScore = score;
      settle(match, { reason: 'eliminated', loserSeat: 'b' });
    },
  });
}

function recordScore(ws, score, finished = false) {
  const match = localMatches.get(ws.matchId);
  if (!match || match.settled) return;
  const p = match.players[ws.player.id];
  if (!p) return;
  p.score = Math.max(p.score, score);
  if (finished && !p.finished) {
    p.finished = true;
    p.finishedAt = Date.now();
    // ELIMINATION: the FIRST player to be eliminated (their local run ended —
    // out of lives / bomb) LOSES; the survivor wins. settle() guards order, so
    // if the bot (or the other human) was eliminated first this is a no-op.
    const seat = ws.player.id === match.a ? 'a' : 'b';
    settle(match, { reason: 'eliminated', loserSeat: seat });
  }
}

// Authoritative ruling — ELIMINATION: `loserSeat` is the player eliminated
// FIRST (or who abandoned). They lose; the other wins. `loserSeat` is null only
// on the rare safety-timeout with equal scores → a genuine tie.
function settle(match, { reason, loserSeat }) {
  if (match.settled) return;
  match.settled = true;
  if (match.deadline) clearTimeout(match.deadline);
  if (match.bot) match.bot.stop();

  const aScore = match.players[match.a].score;
  const bScore = match.isBot ? (match.botScore ?? 0) : match.players[match.b].score;

  const outcomeForSeat = (seat) =>
    loserSeat == null ? 'tie' : loserSeat === seat ? 'lost' : 'won';

  publishMatch(match.matchId, match.a, S2C.RESULT, {
    outcome: outcomeForSeat('a'), myScore: aScore, oppScore: bScore, reason,
  });
  if (!match.isBot) {
    publishMatch(match.matchId, match.b, S2C.RESULT, {
      outcome: outcomeForSeat('b'), myScore: bScore, oppScore: aScore, reason,
    });
  }

  // Observability: a match settled. Map the internal reason to the reported
  // taxonomy (normal/abandon/cap), and resolve winner/loser uids from the
  // eliminated seat. `null` loserSeat = a genuine tie on the safety timeout.
  const obsReason =
    reason === 'abandon' ? 'abandon' : reason === 'timeout' ? 'cap' : 'normal';
  const seatUid = (seat) =>
    seat === 'a' ? match.a : (match.isBot ? 'bot' : match.b);
  const winner = loserSeat == null ? null
    : seatUid(loserSeat === 'a' ? 'b' : 'a');
  const loser = loserSeat == null ? null : seatUid(loserSeat);
  const durationMs = match.startMs ? Date.now() - match.startMs : 0;
  obs({
    evt: 'settle', matchId: match.matchId, winner, loser,
    isBot: match.isBot, durationMs, reason: obsReason,
  });

  // TODO(firebase-agent handoff): POST result to the Firestore-writing path
  // (hafla_won / hafla_lost / hafla_abandoned). Kept out of the hot path.
  persistResult(match, { aScore, bScore, reason: obsReason }).catch(() => {});

  sub.unsubscribe(`hafla:relay:${match.matchId}`).catch(() => {});
  localMatches.delete(match.matchId);
}

async function persistResult(match, payload) {
  // Off the request hot path, fire-and-forget (settle()'s .catch swallows any
  // error), and gated on redisReady so it NEVER affects gameplay if Redis is
  // flaky. Two things happen here, both additive observability:
  //
  //  1) XADD onto hafla:results — the durable per-match stream a future
  //     result-worker can drain to Firestore (kept for that handoff).
  //  2) In-process daily counters in Redis so match volume / completion /
  //     abandon / bot-share are queryable WITHOUT a separate worker or a
  //     Firestore rules deploy. We chose the in-process INCRs (not a standalone
  //     worker) because they add zero new process, zero deps, and run inside
  //     this already-running settle path — the lowest-risk thing that makes the
  //     data queryable. Query later with e.g. `MGET hafla:stats:2026-06-29:*`
  //     or GET the individual keys.
  if (!redisReady) return;
  await redis.xadd('hafla:results', '*',
    'matchId', match.matchId,
    'a', match.a, 'b', String(match.b ?? 'bot'),
    'aScore', String(payload.aScore), 'bScore', String(payload.bScore),
    'reason', payload.reason);

  // Daily aggregate counters (UTC day). `matches` is incremented at match_found
  // time; here we count the SETTLED side so started→settled completion is
  // readable as settled/matches. A pipeline keeps it to one round-trip.
  const day = new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
  const base = `hafla:stats:${day}`;
  const ttl = 90 * 24 * 60 * 60; // keep ~90 days, then self-expire
  const pipe = redis.pipeline();
  pipe.incr(`${base}:settled`);
  pipe.expire(`${base}:settled`, ttl);
  if (payload.reason === 'abandon') {
    pipe.incr(`${base}:abandoned`);
    pipe.expire(`${base}:abandoned`, ttl);
  }
  if (match.isBot) {
    pipe.incr(`${base}:bot`);
    pipe.expire(`${base}:bot`, ttl);
  }
  await pipe.exec();
}

// Bump the daily `matches` counter when a match is MADE (not when it settles),
// so started→settled completion = settled/matches is meaningful. Fire-and-
// forget, redisReady-gated — never on the gameplay path.
function bumpMatchesCounter() {
  if (!redisReady) return;
  const day = new Date().toISOString().slice(0, 10);
  const key = `hafla:stats:${day}:matches`;
  const ttl = 90 * 24 * 60 * 60;
  redis.pipeline().incr(key).expire(key, ttl).exec().catch(() => {});
}

// ---- Relay (cross-instance via Redis pub/sub) ----------------------------
function relayToOpponent(ws, type, data) {
  const match = localMatches.get(ws.matchId);
  if (!match) {
    // Opponent's instance owns the match; publish to the relay channel.
    if (ws.matchId) {
      redis.publish(`hafla:relay:${ws.matchId}`,
        JSON.stringify({ from: ws.player.id, type, data }));
    }
    return;
  }
  const oppId = ws.player.id === match.a ? match.b : match.a;
  publishMatch(match.matchId, oppId, type, data);
}

// Deliver to a player whether they're local or on another instance.
function publishMatch(matchId, playerId, type, data) {
  if (playerId == null) return;
  const local = sockets.get(playerId);
  if (local && local.readyState === local.OPEN) {
    send(local, type, data);
  } else {
    redis.publish(`hafla:relay:${matchId}`,
      JSON.stringify({ to: playerId, type, data }));
  }
}

sub.on('message', (_chan, raw) => {
  try {
    const m = JSON.parse(raw);
    if (m.to) {
      const ws = sockets.get(m.to);
      if (ws && ws.readyState === ws.OPEN) send(ws, m.type, m.data);
    }
  } catch { /* ignore */ }
});

// ---- Disconnect / reconnect ----------------------------------------------
function handleClose(ws) {
  if (!ws.player) return;
  leaveQueue(ws);
  sockets.delete(ws.player.id);

  const match = localMatches.get(ws.matchId);
  if (!match || match.settled) return;
  const leaverId = ws.player.id;
  const leaverSeat = leaverId === match.a ? 'a' : 'b';
  // Only a human opponent is notified. In a bot match there is no opponent
  // socket (oppId is null) — OPPONENT_LEFT/RESULT to null are no-ops, so skip
  // the phantom notify entirely (Bug E).
  const oppId = match.isBot ? null : (leaverSeat === 'a' ? match.b : match.a);
  if (oppId != null) {
    // Tell the opponent a reconnect window is open; abandon = their win.
    publishMatch(match.matchId, oppId, S2C.OPPONENT_LEFT, { grace: true });
  }
  match.players[leaverId].leftAt = Date.now();
  setTimeout(() => {
    if (match.settled) return;
    const back = sockets.get(leaverId);
    if (back && back.matchId === match.matchId) return; // rejoined in time
    // Abandon. The leaver simply loses; no phantom opponent in a bot match.
    match.players[leaverId].score = -1; // ensure loss
    if (match.isBot) {
      // The human abandoned a bot match: resolve cleanly, the human lost.
      match.botScore = Math.max(match.botScore ?? 0, 0);
    }
    // The leaver is the loser; the opponent wins.
    settle(match, { reason: 'abandon', loserSeat: leaverSeat });
  }, RECONNECT_GRACE_MS);
}

// ---- Helpers -------------------------------------------------------------
function send(ws, type, data) {
  if (ws.readyState === ws.OPEN) ws.send(encode(type, data));
}
function broadcast(match, type, data) {
  publishMatch(match.matchId, match.a, type, data);
  if (!match.isBot) publishMatch(match.matchId, match.b, type, data);
}
function roomCode() {
  // 5 unambiguous chars (no O/0/I/1) — easy to read aloud / type.
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 5; i++) s += alphabet[crypto.randomInt(alphabet.length)];
  return s;
}

// Drop dead sockets (mobile backgrounding = disconnect, spec §4).
setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { ws.terminate(); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch { /* ignore */ }
  }
}, 15_000);

// ---- Boot ----------------------------------------------------------------
async function boot() {
  await redis.connect().catch(() => {});
  await sub.connect().catch(() => {});
  server.listen(PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`[hafla] listening on :${PORT}  redis=${REDIS_URL.replace(/:[^:@/]*@/, ':***@')}`);
  });
}
boot();
