// Pure-logic unit tests (no Redis, no sockets). The matchmaking/ruling helpers
// in src/index.js are not exported, so these tests assert the PROPERTIES of the
// exact same pure logic (mirrored here, kept in lock-step with index.js). The
// REAL functions are exercised end-to-end in integration.test.js; this file is
// the fast, Redis-free guard for the algebra (bucketing, room-code charset,
// ruling/tie-break) and documents the intended invariants.
//
//   cd server && node --test test/logic.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { MMR_BUCKET } from '../src/config.js';

// --- mirrors src/index.js ---------------------------------------------------
const bucketOf = (mmr) => Math.floor((mmr ?? 0) / MMR_BUCKET);
const adjacentBuckets = (b) => [b, b - 1, b + 1];
const ruleFor = (mine, theirs) =>
  mine > theirs ? 'won' : mine < theirs ? 'lost' : 'tie';

// Mirrors settle()'s winner selection in src/index.js (Bug C). Returns the
// winning seat 'a' | 'b', or null for a genuine tie (neither finished).
function winnerSeat(aScore, bScore, aFin, bFin) {
  if (aScore > bScore) return 'a';
  if (aScore < bScore) return 'b';
  if (aFin != null && (bFin == null || aFin < bFin)) return 'a';
  if (bFin != null && (aFin == null || bFin < aFin)) return 'b';
  return null;
}

function roomCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 5; i++) s += alphabet[crypto.randomInt(alphabet.length)];
  return s;
}
// ---------------------------------------------------------------------------

test('MMR bucketing: same band collides, adjacent bands are reachable', () => {
  // Two players within one MMR_BUCKET land in the same bucket → instant match.
  assert.equal(bucketOf(0), bucketOf(MMR_BUCKET - 1));
  // A player exactly one bucket up is found via the ±1 adjacency scan.
  const lo = bucketOf(10);
  const hi = bucketOf(10 + MMR_BUCKET);
  assert.notEqual(lo, hi);
  assert.ok(adjacentBuckets(lo).includes(hi),
    'a one-bucket-stronger opponent is reachable via the ±1 scan');
  // Two buckets apart should NOT match (skill gap guard).
  const far = bucketOf(10 + 2 * MMR_BUCKET);
  assert.ok(!adjacentBuckets(lo).includes(far),
    'players >1 bucket apart are not paired');
});

test('MMR bucketing handles missing/zero mmr', () => {
  assert.equal(bucketOf(undefined), 0);
  assert.equal(bucketOf(null), 0);
  assert.equal(bucketOf(0), 0);
});

test('ruling is symmetric and consistent for both seats', () => {
  // Higher score wins; the loser sees the mirror outcome.
  assert.equal(ruleFor(100, 60), 'won');
  assert.equal(ruleFor(60, 100), 'lost');
  // Equal → tie for BOTH (current behavior; see tie-break note below).
  assert.equal(ruleFor(70, 70), 'tie');
  // Property: for any a != b, exactly one seat 'won' and the other 'lost'.
  for (const [a, b] of [[1, 2], [999, 0], [-1, 50], [50, -1]]) {
    const oa = ruleFor(a, b);
    const ob = ruleFor(b, a);
    if (a === b) {
      assert.equal(oa, 'tie');
      assert.equal(ob, 'tie');
    } else {
      assert.deepEqual([oa, ob].sort(), ['lost', 'won']);
    }
  }
});

test('abandon sentinel (-1) always loses to any non-negative score', () => {
  // handleClose sets the abandoner score to -1; the opponent (>=0) must win.
  assert.equal(ruleFor(-1, 0), 'lost');
  assert.equal(ruleFor(0, -1), 'won');
  assert.equal(ruleFor(-1, 150), 'lost');
});

test('room code: 5 chars from the unambiguous alphabet (no O/0/I/1)', () => {
  for (let i = 0; i < 2000; i++) {
    const c = roomCode();
    assert.match(c, /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{5}$/);
    assert.ok(!/[O0I1]/.test(c), 'no ambiguous characters');
  }
});

test('room code space is large enough to make collisions rare', () => {
  // 31^5 ≈ 28.6M codes. Sanity: 5000 codes should be ~all unique.
  const seen = new Set();
  for (let i = 0; i < 5000; i++) seen.add(roomCode());
  assert.ok(seen.size > 4990, `expected near-unique codes, got ${seen.size}`);
});

// Bug C — simultaneous-finish tie-break by the server finish timestamp
// ("server timestamp breaks simultaneous finishes"). winnerSeat mirrors the
// real settle() selection in src/index.js.
test('Bug C: equal scores broken by earliest finishedAt (server timestamp)',
  () => {
    // a finished before b → a wins despite equal scores.
    assert.equal(winnerSeat(70, 70, 1000, 1200), 'a');
    // b finished first → b wins.
    assert.equal(winnerSeat(70, 70, 1200, 1000), 'b');
    // Only one side finished (the other timed out at the same score) → the
    // finisher wins.
    assert.equal(winnerSeat(70, 70, 1000, null), 'a');
    assert.equal(winnerSeat(70, 70, null, 1000), 'b');
  });

test('Bug C: tie remains a legitimate outcome when NEITHER finished (timeout)',
  () => {
    // Timeout settle with equal scores and no finish stamps → real tie.
    assert.equal(winnerSeat(70, 70, null, null), null);
  });

test('Bug C: a strict score difference always trumps the timestamp', () => {
  // Higher score wins even if it finished LATER.
  assert.equal(winnerSeat(100, 60, 2000, 1000), 'a');
  assert.equal(winnerSeat(60, 100, 1000, 2000), 'b');
});
