// Central config — all from env so nothing secret is committed.
// Render injects these (REDIS_URL from the Render Key Value/Redis addon).

export const PORT = Number(process.env.PORT || 8080);

// Redis connection. Render's Key Value service provides REDIS_URL.
// Falls back to localhost for local dev. The server is STATELESS: all shared
// match state lives in Redis so Render can run >=1 warm instance and scale out.
export const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';

// Origin allowlist for the WebSocket upgrade. Comma-separated.
// In-app WebView/native clients send no Origin → allowed unless STRICT_ORIGIN.
export const ORIGIN_ALLOWLIST = (process.env.ORIGIN_ALLOWLIST ||
  'https://teman-ninja.com,https://www.teman-ninja.com')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// When true, a missing Origin header is rejected. Native apps send no Origin,
// so keep this false in production for the mobile game.
export const STRICT_ORIGIN = process.env.STRICT_ORIGIN === 'true';

// Match shape (mirrors handoffs/hafla-design.md and the client).
export const ROUND_SECONDS = Number(process.env.ROUND_SECONDS || 75); // 60–90
export const COUNTDOWN_SECONDS = Number(process.env.COUNTDOWN_SECONDS || 3);
export const SCORE_TICK_MS = Number(process.env.SCORE_TICK_MS || 250);

// Matchmaking.
export const BOT_FALLBACK_MS = Number(process.env.BOT_FALLBACK_MS || 10_000);
export const MMR_BUCKET = Number(process.env.MMR_BUCKET || 500); // bestScore band
export const RECONNECT_GRACE_MS =
  Number(process.env.RECONNECT_GRACE_MS || 10_000);

// Keys/secrets the server may need (Firestore writes happen via a separate
// service-account env on the worker; see hafla-design.md). Never log these.
export const SERVER_SHARED_SECRET = process.env.SERVER_SHARED_SECRET || '';
