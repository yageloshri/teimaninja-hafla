// Wire protocol for Hafla. JSON messages over WebSocket.
// SHARED-SEED model: the server is authoritative. It draws the seed, relays
// score numbers (~250ms), and rules the winner. It never sends fruit positions.

// Client → server
export const C2S = {
  QUICK_QUEUE: 'quick_queue', // {playerId, name, mmr}
  CREATE_ROOM: 'create_room', // {playerId, name, mmr} → returns {code}
  JOIN_ROOM: 'join_room', // {playerId, name, mmr, code}
  CANCEL: 'cancel', // leave the queue / abandon room before GO
  SCORE_TICK: 'score_tick', // {score, combo, lives}  (sent ~every 250ms)
  FINISH: 'finish', // {score} — local run ended (timer or out of lives)
  REJOIN: 'rejoin', // {matchId} — reconnect within the grace window; rebind
  HEARTBEAT: 'hb',
};

// Server → client
export const S2C = {
  QUEUED: 'queued', // {} — waiting for an opponent
  ROOM_CREATED: 'room_created', // {code} — share via teman-ninja.com/c/
  MATCH_FOUND: 'match_found', // {matchId, seed, mode, roundSeconds, opponent, isBot}
  COUNTDOWN: 'countdown', // {n}  3..2..1
  GO: 'go', // {serverStartMs}
  OPPONENT_TICK: 'opponent_tick', // {score, combo, lives}
  OPPONENT_WEAK: 'opponent_weak', // {} — opponent's connection is poor
  RESULT: 'result', // {outcome:'won'|'lost'|'tie', myScore, oppScore, reason}
  OPPONENT_LEFT: 'opponent_left', // {grace:true} — reconnect window open
  REJOINED: 'rejoined', // {matchId, opponent:{score,combo,lives}} — resume state replay
  ERROR: 'error', // {message}
};

export function encode(type, data = {}) {
  return JSON.stringify({ t: type, d: data });
}

export function decode(raw) {
  try {
    const m = JSON.parse(raw);
    if (typeof m?.t !== 'string') return null;
    return { type: m.t, data: m.d ?? {} };
  } catch {
    return null;
  }
}
