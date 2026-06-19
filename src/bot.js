// Bot fallback opponent (spec §3): if no human is found in ~10s, drop in a
// smooth bot so the queue NEVER stalls. The bot must feel HUMAN, not perfect —
// final pacing is tuned against playtest-bot's real profiles
// (handoffs/hafla-design.md → playtest-bot coordination).
//
// The server does NOT run the Flame game for the bot. It emits a believable
// score TIMELINE: a slightly noisy ramp toward a target final score chosen
// near the human's MMR, with realistic combo bursts and the occasional stall.

import { SCORE_TICK_MS } from './config.js';

const PROFILES = {
  // Points/second bands + variance, CALIBRATED against the real Flutter
  // BotProfile medians for a 75s Classic round, neutral loadout (measured in
  // test/playtest/hafla_fairness_test.dart → [ordering]):
  //     beginner median ≈ 83,  average ≈ 133,  pro ≈ 173.
  // Calibration (server/test/bot.test.js → CALIBRATION, and calib sweep) lands
  // this bot's final-score medians on those numbers within ±3%:
  //     beginner → ~84,  average → ~132,  pro → ~175  (over 400 sims/profile).
  // NOTE the relationship is NON-LINEAR at this scale: base = pps*0.25 is <1 so
  // Math.round() zeroes most ticks and the few non-zero/combo ticks dominate —
  // hence pps≈1.6–2.2, NOT the tens-of-points placeholders that were here
  // before (which produced ~1600/2825/4480, ~19× too high). Re-run the
  // CALIBRATION test if the real medians or ROUND_SECONDS change.
  // survivalMin/Max (seconds): how long until the bot is ELIMINATED — this IS
  // the bot's skill in the elimination duel (the survivor wins). A weaker bot
  // dies sooner; a pro outlasts most players.
  beginner: { pps: 1.6, jitter: 0.6, comboChance: 0.10, survivalMin: 16, survivalMax: 45 },
  average: { pps: 1.92, jitter: 0.5, comboChance: 0.16, survivalMin: 36, survivalMax: 85 },
  pro: { pps: 2.18, jitter: 0.45, comboChance: 0.24, survivalMin: 70, survivalMax: 150 },
};

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

  let score = 0;
  let combo = 0;
  let elapsed = 0;
  let done = false;

  const interval = setInterval(() => {
    elapsed += SCORE_TICK_MS;
    // Base earn this tick + jitter; occasional stall (human distraction).
    const stall = rand() < 0.06;
    const base = stall ? 0 : (profile.pps * SCORE_TICK_MS) / 1000;
    const noise = 1 + (rand() * 2 - 1) * profile.jitter;
    let gain = Math.max(0, Math.round(base * noise));

    // Combo bursts.
    if (!stall && rand() < profile.comboChance) {
      combo = Math.min(8, combo + 1);
      gain += Math.round(gain * combo * 0.25);
    } else {
      combo = 0;
    }
    score += gain;

    // Lives tick down toward elimination so the opponent bar shows it fading.
    const lives = Math.max(0, Math.ceil(3 * (1 - elapsed / survivalMs)));
    onTick({ score, combo, lives });

    if (elapsed >= survivalMs && !done) {
      done = true;
      clearInterval(interval);
      onEliminated({ score });
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
