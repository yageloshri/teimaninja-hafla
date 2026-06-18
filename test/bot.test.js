// Unit tests for the fallback bot's score TIMELINE (server/src/bot.js).
//
// The bot never runs the Flame game — it emits a believable score ramp. These
// tests pin its SHAPE (monotonic, reproducible, ends at the round boundary)
// and MEASURE its final-score distribution per profile so we can calibrate the
// pps/jitter/combo bands against the real Flutter BotProfile medians.
//
//   cd server && node --test test/bot.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { spawnBot } from '../src/bot.js';
import { ROUND_SECONDS, SCORE_TICK_MS } from '../src/config.js';

// Run a bot to completion synchronously by stubbing the global timers so the
// interval fires instantly `ticks` times. spawnBot uses setInterval; we drive
// it deterministically.
function runBotSync({ matchId, seed, humanMmr }) {
  const realSetInterval = globalThis.setInterval;
  const realClearInterval = globalThis.clearInterval;
  let cb = null;
  globalThis.setInterval = (fn) => { cb = fn; return 1; };
  globalThis.clearInterval = () => {};

  const ticks = [];
  let final = null;
  const handle = spawnBot({
    matchId, seed, humanMmr,
    onTick: (t) => ticks.push({ ...t }),
    onFinish: ({ score }) => { final = score; },
  });

  const expected = Math.floor((ROUND_SECONDS * 1000) / SCORE_TICK_MS);
  for (let i = 0; i < expected && final == null; i++) cb();

  globalThis.setInterval = realSetInterval;
  globalThis.clearInterval = realClearInterval;
  handle.stop();
  return { ticks, final, expectedTicks: expected };
}

function mmrFor(profile) {
  // Pick an MMR squarely inside each band (see pickProfile in bot.js).
  return { beginner: 500, average: 2500, pro: 6000 }[profile];
}

function finalScores(profile, n = 200) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const { final } = runBotSync({
      matchId: `m-${profile}-${i}`, seed: 1000 + i, humanMmr: mmrFor(profile),
    });
    out.push(final);
  }
  return out;
}

function stats(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const median = s[Math.floor(s.length / 2)];
  const p10 = s[Math.floor(s.length * 0.1)];
  const p90 = s[Math.floor(s.length * 0.9)];
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  return { median, mean, p10, p90, min: s[0], max: s[s.length - 1] };
}

test('timeline is monotonic non-decreasing and finishes at the round boundary', () => {
  const { ticks, final, expectedTicks } = runBotSync({
    matchId: 'shape', seed: 42, humanMmr: 2500,
  });
  assert.equal(ticks.length, expectedTicks, 'one onTick per SCORE_TICK_MS');
  assert.ok(final != null, 'onFinish fired');
  for (let i = 1; i < ticks.length; i++) {
    assert.ok(ticks[i].score >= ticks[i - 1].score, 'score never decreases');
  }
  assert.equal(ticks[ticks.length - 1].score, final, 'final == last tick score');
});

test('reproducible for a given (matchId, seed)', () => {
  const a = runBotSync({ matchId: 'rep', seed: 7, humanMmr: 2500 });
  const b = runBotSync({ matchId: 'rep', seed: 7, humanMmr: 2500 });
  assert.equal(a.final, b.final, 'same inputs → same final score');
  assert.deepEqual(a.ticks.map((t) => t.score), b.ticks.map((t) => t.score));
});

test('different matches differ (not a constant)', () => {
  const a = runBotSync({ matchId: 'x', seed: 1, humanMmr: 2500 });
  const b = runBotSync({ matchId: 'y', seed: 2, humanMmr: 2500 });
  assert.notEqual(a.final, b.final);
});

test('combo never exceeds the documented cap (8) and lives stay valid', () => {
  const { ticks } = runBotSync({ matchId: 'cap', seed: 99, humanMmr: 6000 });
  for (const t of ticks) {
    assert.ok(t.combo >= 0 && t.combo <= 8, `combo in [0,8], got ${t.combo}`);
    assert.ok(t.lives >= 0 && t.lives <= 3, `lives in [0,3], got ${t.lives}`);
  }
});

test('higher-MMR bands produce higher median final scores (skill ordering)', () => {
  const beg = stats(finalScores('beginner'));
  const avg = stats(finalScores('average'));
  const pro = stats(finalScores('pro'));
  // eslint-disable-next-line no-console
  console.log('[bot-dist] beginner', beg, '\n[bot-dist] average', avg,
    '\n[bot-dist] pro', pro);
  assert.ok(avg.median > beg.median, 'average band > beginner band');
  assert.ok(pro.median > avg.median, 'pro band > average band');
});

// CALIBRATION TARGETS — the real Flutter BotProfile median Classic scores (from
// the playtest fairness run, 75s round, neutral loadout):
//   beginner ≈ 83, average ≈ 133, pro ≈ 173  (means; medians are close).
// The fallback bot's medians should land within ±25% of these so a bot
// opponent feels human and the match is close to the human's MMR.
test('CALIBRATION: bot medians match real BotProfile medians (±25%)', () => {
  const targets = { beginner: 83, average: 133, pro: 173 };
  for (const [profile, target] of Object.entries(targets)) {
    const { median } = stats(finalScores(profile));
    const lo = target * 0.75;
    const hi = target * 1.25;
    // eslint-disable-next-line no-console
    console.log(`[calibration] ${profile}: botMedian=${median} target=${target} `
      + `band=[${lo.toFixed(0)},${hi.toFixed(0)}]`);
    assert.ok(median >= lo && median <= hi,
      `${profile} bot median ${median} outside ±25% of real median ${target}`);
  }
});
