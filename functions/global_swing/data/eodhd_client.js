/**
 * global_swing/data/eodhd_client.js
 * ===================================
 * Base EODHD HTTP client — handles API key, retries, and caching.
 *
 * API KEY SETUP:
 *   Add to functions/.env:  EODHD_API_KEY=your_paid_key
 *   Firebase loads this file automatically during deploy.
 *   NEVER hardcode the key in source code.
 *
 * EODHD BASE URL: https://eodhd.com/api/
 * All endpoints accept ?api_token=...&fmt=json
 *
 * PLAN ($29.99/month) LIMITS:
 *   - 100,000 API calls / day
 *   - Intraday costs 5 calls per request
 *   - Real-time WebSocket available for US stocks
 *   - ~15-min delayed for India / EU / Japan via /real-time endpoint
 *
 * CONFIRMED WORKING ON THIS PLAN:
 *   /real-time/NSEI.INDX  → Nifty 50 live
 *   /real-time/AAPL.US    → US stocks real-time
 *   /eod/{symbol}         → 30-day OHLCV history (any exchange)
 */

const axios  = require("axios");
const logger = require("firebase-functions/logger");

// ── API key — read from process.env (set in functions/.env) ──
// To configure: add EODHD_API_KEY=your_key to functions/.env
function getApiKey() {
  return process.env.EODHD_API_KEY || null;
}

// ── Axios instance ────────────────────────────────────────────
const eohdAxios = axios.create({
  baseURL: "https://eodhd.com/api",
  timeout: 12000,
  headers: { Accept: "application/json" },
});

// ── In-process cache (survives within one function invocation) ─
const _cache = new Map();

function _cacheGet(key) {
  const entry = _cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) { _cache.delete(key); return null; }
  return entry.value;
}

function _cacheSet(key, value, ttlMs) {
  _cache.set(key, { value, expiresAt: Date.now() + ttlMs });
}

/**
 * Core EODHD GET with 3-attempt retry + exponential backoff.
 * Automatically appends api_token and fmt=json to every request.
 *
 * @param {string} path       - e.g. "/eod/AAPL.US" or "/real-time/NSEI.INDX"
 * @param {Object} params     - Additional query params (no need to add api_token/fmt)
 * @param {string} cacheKey   - Optional: unique key for caching the response
 * @param {number} cacheTtlMs - Cache duration in ms (0 = no cache)
 * @returns {Promise<any>}    - Parsed JSON, or null on failure
 */
async function eohdGet(path, params = {}, cacheKey = null, cacheTtlMs = 0) {
  // Return cached value if available
  if (cacheKey) {
    const cached = _cacheGet(cacheKey);
    if (cached !== null) return cached;
  }

  const apiKey = getApiKey();
  if (!apiKey) {
    throw new Error(
      "EODHD API key missing. Add EODHD_API_KEY=your_key to functions/.env and redeploy."
    );
  }

  const fullParams = { ...params, api_token: apiKey, fmt: "json" };

  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const { data } = await eohdAxios.get(path, { params: fullParams });

      if (cacheKey && cacheTtlMs > 0) {
        _cacheSet(cacheKey, data, cacheTtlMs);
      }
      return data;
    } catch (err) {
      lastErr = err;
      const status = err?.response?.status;

      // Client errors (bad symbol, unauthorised, bad params) — no point retrying
      if (status === 404 || status === 400 || status === 401 || status === 403 || status === 422) {
        const body = JSON.stringify(err?.response?.data ?? "no body");
        logger.warn(`EODHD ${status} on ${path}: ${err.message} | response body: ${body}`);
        return null;
      }

      if (attempt < 3) {
        // 500ms, 1000ms backoff
        await new Promise(r => setTimeout(r, 500 * attempt));
      }
    }
  }

  logger.error(`EODHD request failed after 3 attempts [${path}]: ${lastErr?.message}`);
  return null;
}

/**
 * Clear the in-process cache.
 * Called at the start of each hourly swing cycle so stale data is never used.
 */
function clearEohdCache() {
  _cache.clear();
  logger.info("EODHD in-process cache cleared");
}

module.exports = { eohdGet, clearEohdCache };
