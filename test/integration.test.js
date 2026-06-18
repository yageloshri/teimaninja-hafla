// Integration tests: boot the REAL server (src/index.js) against a local Redis
// and drive it with scripted WebSocket clients through the full match
// lifecycle. Validates matchmaking, shared-seed delivery, relay, bot fallback,
// disconnect→grace→abandon, and the authoritative ruling/tie-break.
//
// Requires a local Redis on 127.0.0.1:6379. If unavailable, these tests are
// skipped (see the top-level guard). Run:
//   cd server && node --test test/integration.test.js

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { WebSocket } from 'ws';

const PORT = 8137; // unlikely to collide
const WS_URL = `ws://127.0.0.1:${PORT}`;
const RECONNECT_GRACE_INT = 400; // mirrors RECONNECT_GRACE_MS in the spawn env
const SERVER_CWD = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let serverProc = null;
let redisUp = false;

async function checkRedis() {
  return new Promise((resolve) => {
    const sock = net.connect(6379, '127.0.0.1');
    sock.setTimeout(500);
    sock.on('connect', () => { sock.end(); resolve(true); });
    sock.on('error', () => resolve(false));
    sock.on('timeout', () => { sock.destroy(); resolve(false); });
  });
}

before(async () => {
  redisUp = await checkRedis();
  if (!redisUp) return;
  serverProc = spawn('node', ['src/index.js'], {
    cwd: SERVER_CWD,
    env: {
      ...process.env,
      PORT: String(PORT),
      REDIS_URL: 'redis://127.0.0.1:6379',
      STRICT_ORIGIN: 'false',
      ROUND_SECONDS: '2', // short rounds so finish-driven tests are fast
      COUNTDOWN_SECONDS: '0', // skip the 3s countdown in tests
      BOT_FALLBACK_MS: '600', // fast bot fallback
      RECONNECT_GRACE_MS: '400', // fast abandon
      SCORE_TICK_MS: '100',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // Wait for the listen log.
  await Promise.race([
    new Promise((resolve) => {
      serverProc.stdout.on('data', (d) => {
        if (String(d).includes('listening')) resolve();
      });
    }),
    delay(4000),
  ]);
  await delay(200);
});

after(async () => {
  if (serverProc) {
    serverProc.kill('SIGKILL');
    await once(serverProc, 'exit').catch(() => {});
  }
});

// ---- tiny client helper --------------------------------------------------
function client() {
  const ws = new WebSocket(WS_URL);
  const inbox = [];
  const waiters = [];
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    const evt = { type: m.t, data: m.d ?? {} };
    inbox.push(evt);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].pred(evt)) {
        waiters[i].resolve(evt);
        waiters.splice(i, 1);
      }
    }
  });
  const api = {
    ws,
    open: () => (ws.readyState === ws.OPEN ? Promise.resolve() : once(ws, 'open')),
    send: (t, d = {}) => ws.send(JSON.stringify({ t, d })),
    // Wait for the first (already-received or future) message matching pred.
    wait: (type, timeout = 3000) =>
      new Promise((resolve, reject) => {
        const pred = (e) => e.type === type;
        const found = inbox.find(pred);
        if (found) return resolve(found);
        const to = setTimeout(
          () => reject(new Error(`timeout waiting for ${type}; got `
            + JSON.stringify(inbox.map((e) => e.type)))), timeout);
        waiters.push({ pred, resolve: (e) => { clearTimeout(to); resolve(e); } });
      }),
    all: (type) => inbox.filter((e) => e.type === type),
    close: () => ws.close(),
    inbox,
  };
  return api;
}

const guard = () => (redisUp ? false : 'no local Redis on 127.0.0.1:6379');

test('quick_queue pairs two humans with the SAME seed, then GO', async (t) => {
  if (guard()) return t.skip(guard());
  const a = client();
  const b = client();
  await a.open();
  await b.open();
  a.send('quick_queue', { playerId: 'A1', name: 'Alice', mmr: 100 });
  // a should be queued first
  await a.wait('queued');
  b.send('quick_queue', { playerId: 'B1', name: 'Bob', mmr: 120 });

  const mfA = await a.wait('match_found');
  const mfB = await b.wait('match_found');
  assert.equal(mfA.data.seed, mfB.data.seed, 'both players get the SAME seed');
  assert.ok(mfA.data.seed >= 1 && mfA.data.seed <= 0x7fffffff, 'seed in range');
  assert.equal(mfA.data.isBot, false);
  assert.equal(mfA.data.matchId, mfB.data.matchId, 'same matchId');

  await a.wait('go');
  await b.wait('go');
  a.close();
  b.close();
});

test('score_tick is relayed to the opponent', async (t) => {
  if (guard()) return t.skip(guard());
  const a = client();
  const b = client();
  await a.open();
  await b.open();
  a.send('quick_queue', { playerId: 'A2', name: 'A', mmr: 200 });
  await a.wait('queued');
  b.send('quick_queue', { playerId: 'B2', name: 'B', mmr: 210 });
  await a.wait('go');
  await b.wait('go');

  a.send('score_tick', { score: 42, combo: 2, lives: 3 });
  const tick = await b.wait('opponent_tick');
  assert.equal(tick.data.score, 42);
  assert.equal(tick.data.combo, 2);
  a.close();
  b.close();
});

test('authoritative result: higher score wins; both told consistent outcome',
  async (t) => {
    if (guard()) return t.skip(guard());
    const a = client();
    const b = client();
    await a.open();
    await b.open();
    a.send('quick_queue', { playerId: 'A3', name: 'A', mmr: 300 });
    await a.wait('queued');
    b.send('quick_queue', { playerId: 'B3', name: 'B', mmr: 310 });
    await a.wait('go');
    await b.wait('go');

    a.send('finish', { score: 100 });
    b.send('finish', { score: 60 });

    const rA = await a.wait('result');
    const rB = await b.wait('result');
    assert.equal(rA.data.outcome, 'won', 'A (100) beats B (60)');
    assert.equal(rB.data.outcome, 'lost');
    assert.equal(rA.data.myScore, 100);
    assert.equal(rA.data.oppScore, 60);
    assert.equal(rB.data.myScore, 60);
    assert.equal(rB.data.oppScore, 100);
    a.close();
    b.close();
  });

test('Bug C: equal scores with BOTH finishing → server timestamp breaks it '
  + '(no tie); outcomes are mirrored', async (t) => {
  if (guard()) return t.skip(guard());
  const a = client();
  const b = client();
  await a.open();
  await b.open();
  a.send('quick_queue', { playerId: 'A4', name: 'A', mmr: 400 });
  await a.wait('queued');
  b.send('quick_queue', { playerId: 'B4', name: 'B', mmr: 410 });
  await a.wait('go');
  await b.wait('go');
  // A finishes first; B finishes a beat later with the SAME score.
  a.send('finish', { score: 70 });
  await delay(60);
  b.send('finish', { score: 70 });
  const rA = await a.wait('result');
  const rB = await b.wait('result');
  // Exactly one won and the other lost — never a tie when someone finished.
  assert.deepEqual([rA.data.outcome, rB.data.outcome].sort(), ['lost', 'won']);
  // A finished earlier → A wins by the server timestamp.
  assert.equal(rA.data.outcome, 'won', 'earliest finisher (A) wins the tie-break');
  assert.equal(rB.data.outcome, 'lost');
  a.close();
  b.close();
});

test('Bug C: a genuine TIE survives only on a timeout (neither finished)',
  async (t) => {
    if (guard()) return t.skip(guard());
    const a = client();
    const b = client();
    await a.open();
    await b.open();
    a.send('quick_queue', { playerId: 'A4b', name: 'A', mmr: 420 });
    await a.wait('queued');
    b.send('quick_queue', { playerId: 'B4b', name: 'B', mmr: 430 });
    await a.wait('go');
    await b.wait('go');
    // Neither sends finish — the round deadline (ROUND_SECONDS=2 + grace) fires
    // a timeout settle with equal 0–0 scores and no finish stamps → real tie.
    const rA = await a.wait('result', 6000);
    const rB = await b.wait('result', 6000);
    assert.equal(rA.data.reason, 'timeout');
    assert.equal(rA.data.outcome, 'tie');
    assert.equal(rB.data.outcome, 'tie');
    a.close();
    b.close();
  });

test('create_room → join_room pairs the two with the same seed', async (t) => {
  if (guard()) return t.skip(guard());
  const host = client();
  const friend = client();
  await host.open();
  await friend.open();
  host.send('create_room', { playerId: 'H1', name: 'Host', mmr: 500 });
  const created = await host.wait('room_created');
  assert.match(created.data.code, /^[A-Z2-9]{5}$/, 'room code is 5 unambiguous chars');

  friend.send('join_room', { playerId: 'F1', name: 'Friend', mmr: 9000, code: created.data.code });
  const mfHost = await host.wait('match_found');
  const mfFriend = await friend.wait('match_found');
  assert.equal(mfHost.data.seed, mfFriend.data.seed, 'room players share the seed');
  assert.equal(mfHost.data.isBot, false);
  host.close();
  friend.close();
});

test('join_room with a bad code → error', async (t) => {
  if (guard()) return t.skip(guard());
  const c = client();
  await c.open();
  c.send('join_room', { playerId: 'X1', name: 'X', mmr: 0, code: 'ZZZZZ' });
  const err = await c.wait('error');
  assert.equal(err.data.message, 'room_not_found');
  c.close();
});

test('bot fallback: solo queue gets a bot match + result after the round',
  async (t) => {
    if (guard()) return t.skip(guard());
    const a = client();
    await a.open();
    a.send('quick_queue', { playerId: 'SOLO1', name: 'Solo', mmr: 100 });
    await a.wait('queued');
    // After BOT_FALLBACK_MS (600), a bot match is created.
    const mf = await a.wait('match_found', 3000);
    assert.equal(mf.data.isBot, true, 'fallback opponent is a bot');
    assert.ok(mf.data.opponent, 'opponent present');
    await a.wait('go');
    // Bot emits opponent ticks during the round.
    const tick = await a.wait('opponent_tick', 3000);
    assert.ok(tick.data.score >= 0);
    // Human finishes; server must rule once the bot also finishes.
    a.send('finish', { score: 9999 });
    const r = await a.wait('result', 5000);
    assert.equal(r.data.outcome, 'won', 'human with 9999 beats the bot');
    a.close();
  });

test('disconnect → opponent_left grace → abandon makes the opponent win',
  async (t) => {
    if (guard()) return t.skip(guard());
    const a = client();
    const b = client();
    await a.open();
    await b.open();
    a.send('quick_queue', { playerId: 'A5', name: 'A', mmr: 600 });
    await a.wait('queued');
    b.send('quick_queue', { playerId: 'B5', name: 'B', mmr: 610 });
    await a.wait('go');
    await b.wait('go');
    // A rage-quits (hard socket close, no finish).
    a.ws.terminate();
    // B should be told the opponent left (reconnect window open)...
    const left = await b.wait('opponent_left', 2000);
    assert.equal(left.data.grace, true);
    // ...then after RECONNECT_GRACE_MS with no return, B wins by abandon.
    const r = await b.wait('result', 3000);
    assert.equal(r.data.outcome, 'won', 'B wins when A abandons');
    assert.match(r.data.reason, /abandon/);
    b.close();
  });

test('Bug D: REJOIN within the grace window resumes the match (no abandon)',
  async (t) => {
    if (guard()) return t.skip(guard());
    const a = client();
    const b = client();
    await a.open();
    await b.open();
    a.send('quick_queue', { playerId: 'RJA', name: 'A', mmr: 700 });
    await a.wait('queued');
    b.send('quick_queue', { playerId: 'RJB', name: 'B', mmr: 710 });
    const mfA = await a.wait('match_found');
    await a.wait('go');
    await b.wait('go');
    // B posts a score so the rejoin replay has something to deliver.
    b.send('score_tick', { score: 55, combo: 2, lives: 3 });
    await delay(50);
    // A's socket drops mid-match (no finish).
    a.ws.terminate();
    // B is told A left (grace open).
    await b.wait('opponent_left', 2000);
    // A reconnects within the grace window and REJOINs the SAME match.
    const a2 = client();
    await a2.open();
    a2.send('rejoin', { playerId: 'RJA', name: 'A', mmr: 700, matchId: mfA.data.matchId });
    const rejoined = await a2.wait('rejoined', 2000);
    assert.equal(rejoined.data.matchId, mfA.data.matchId);
    assert.equal(rejoined.data.opponent.score, 55, 'opponent score replayed on resume');
    // The match must NOT have abandoned — finishing now still rules normally.
    a2.send('finish', { score: 200 });
    b.send('finish', { score: 100 });
    const rA = await a2.wait('result', 3000);
    assert.equal(rA.data.outcome, 'won', 'resumed player wins on the merits, not abandon');
    assert.ok(!/abandon/.test(rA.data.reason ?? ''),
      'a resumed match is not ruled an abandon');
    a2.close();
    b.close();
  });

test('Bug D: REJOIN with an unknown/settled matchId → rejoin_failed error',
  async (t) => {
    if (guard()) return t.skip(guard());
    const c = client();
    await c.open();
    c.send('rejoin', { playerId: 'GHOST', name: 'G', mmr: 0, matchId: 'no-such-match' });
    const err = await c.wait('error', 2000);
    assert.equal(err.data.message, 'rejoin_failed');
    c.close();
  });

test('Bug E: human disconnect in a BOT match resolves cleanly (no phantom '
  + 'opponent notify, human simply abandoned)', async (t) => {
  if (guard()) return t.skip(guard());
  const a = client();
  await a.open();
  a.send('quick_queue', { playerId: 'BOTDC', name: 'Solo', mmr: 100 });
  await a.wait('queued');
  const mf = await a.wait('match_found', 3000);
  assert.equal(mf.data.isBot, true);
  await a.wait('go');
  // The human drops mid bot-match. There is no opponent socket, so the only
  // observable effect must be a clean settle after the grace — no crash, no
  // phantom notify. (The human is the only client; we just assert the server
  // stays healthy and the abandon path runs.)
  a.ws.terminate();
  await delay(RECONNECT_GRACE_INT + 400);
  // Server is still alive and serving health after a bot-match abandon.
  const h = await fetch(`http://127.0.0.1:${PORT}/health`).then((r) => r.json());
  assert.equal(h.status, 'ok', 'server healthy after a bot-match disconnect');
});
