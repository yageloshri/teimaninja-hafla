// Bot fallback opponent (spec §3): if no human is found in ~10s, drop in a
// smooth bot so the queue NEVER stalls. The bot must feel HUMAN, not perfect —
// final pacing is tuned against playtest-bot's real profiles
// (handoffs/hafla-design.md → playtest-bot coordination).
//
// The server does NOT run the Flame game for the bot. It emits a HUMAN-LIKE
// score timeline whose rate tracks the game's own fruit-spawn ramp (slow start,
// accelerating) with combo spikes, plus a skill-based elimination time — so the
// opening isn't a free win and the bot's progress reads naturally, not flat.

import { SCORE_TICK_MS } from './config.js';

const PROFILES = {
  // HUMAN-LIKE pacing. `skill` = the fraction of the fruit actually on screen
  // that the bot slices — its score therefore tracks the GAME's own spawn ramp
  // (slow start, accelerating), not a flat rate from t=0. `survivalMin/Max` (s)
  // = when the bot is eliminated; both bounds start AFTER the trivial early
  // phase (no bombs for the first 10s, ~1 fruit/2.9s) so the bot never dies
  // unrealistically early and the opening isn't a free win. All rise with skill.
  beginner: { skill: 0.50, comboChance: 0.10, survivalMin: 24, survivalMax: 70 },
  average: { skill: 0.68, comboChance: 0.16, survivalMin: 50, survivalMax: 120 },
  pro: { skill: 0.85, comboChance: 0.24, survivalMin: 90, survivalMax: 200 },
};

// Fruit per SECOND the game spawns at elapsed time t — mirrors SpawnDirector:
// waves of waveItemsMin→Max (1→5) over waveItemsRampTime (140s), wave interval
// decaying waveIntervalStart→Floor (2.9→1.05s) with tau 60. A human's score
// rate ≈ this × their accuracy, so the bot uses the same curve.
function gameFruitPerSec(t) {
  const items = 1 + 4 * Math.min(1, t / 140);
  const interval = 1.05 + 1.85 * Math.exp(-t / 60);
  return items / interval;
}

function pickProfile(humanMmr) {
  // Match the human roughly so games are close (fun), not stomps.
  if (humanMmr < 1500) return 'beginner';
  if (humanMmr < 4000) return 'average';
  return 'pro';
}

// Deterministic-ish PRNG so a given (matchId,seed) bot is reproducible in
// playtest. Mulberry32.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/// Returns a callback-driven bot for the ELIMINATION duel. `onTick` fires every
/// SCORE_TICK_MS with the bot's live numbers (for the opponent bar);
/// `onEliminated({score})` fires once when the bot's skill-based survival time
/// is up (→ the human wins, unless already settled). `stop()` cancels it.
export function spawnBot({ matchId, seed, humanMmr, onTick, onEliminated }) {
  const profile = PROFILES[pickProfile(humanMmr)];
  const rand = rng((seed ^ hashCode(matchId)) | 0);
  // The bot's survival time = when it gets eliminated. (ROUND_SECONDS is no
  // longer a round length — there's no fixed round in the elimination model.)
  const survivalMs = Math.round(
    (profile.survivalMin +
      rand() * (profile.survivalMax - profile.survivalMin)) * 1000);

  const dt = SCORE_TICK_MS / 1000;
  let score = 0; // accumulated as a float; reported rounded
  let combo = 0;
  let elapsed = 0;
  let done = false;

  const interval = setInterval(() => {
    elapsed += SCORE_TICK_MS;
    const t = elapsed / 1000;
    // Foods sliced this tick = skill × what's actually on screen now (ramps with
    // the game), with mild steadiness noise — no flat rate, no unrealistic
    // early scoring.
    let gain = profile.skill * gameFruitPerSec(t) * dt *
        (1 + (rand() * 2 - 1) * 0.18);
    // Combo bursts — the human-like spikes; they only start once the board has
    // enough fruit to chain (a few seconds in), and build a multiplier.
    const comboReady = Math.min(1, t / 18);
    if (rand() < profile.comboChance * comboReady) {
      combo = Math.min(8, combo + 1);
      gain += gain * (0.8 + combo * 0.25);
    } else {
      combo = 0;
    }
    score += Math.max(0, gain);

    // Lives tick down toward elimination so the opponent bar shows it fading.
    const lives = Math.max(0, Math.ceil(3 * (1 - elapsed / survivalMs)));
    onTick({ score: Math.round(score), combo, lives });

    if (elapsed >= survivalMs && !done) {
      done = true;
      clearInterval(interval);
      onEliminated({ score: Math.round(score) });
    }
  }, SCORE_TICK_MS);

  return { stop: () => clearInterval(interval), isBot: true, survivalMs };
}

function hashCode(str) {
  let h = 0;
  for (let k = 0; k < str.length; k++) {
    h = (Math.imul(31, h) + str.charCodeAt(k)) | 0;
  }
  return h;
}
