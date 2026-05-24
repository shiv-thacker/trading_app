/**
 * global_swing/data/nse_live.js
 * ================================
 * NSE India live price fetcher — PRIMARY source for India positions.
 *
 * WHY NSE DIRECT (not just EODHD):
 *   EODHD gives India prices ~15-20 min delayed.
 *   For stop-loss enforcement (−7% hard stop), a fresh price matters.
 *   NSE's public API returns real-time prices from the exchange.
 *
 * FALLBACK PATTERN (used in global_swing/index.js):
 *   1. Try getNSELivePrices() — if it succeeds → use it
 *   2. If NSE returns {} (403, timeout, GCP block) → fall back to
 *      eodhd_live.getLiveQuotes() for the missing symbols
 *
 * KNOWN LIMITATIONS:
 *   - NSE occasionally blocks GCP IPs (returns 403)
 *   - Requires a fresh session cookie from www.nseindia.com
 *   - Cookie is cached 5 minutes to avoid hammering NSE
 *   - This module is India-only; it is NOT called for US/DE/JP
 */

const axios  = require("axios");
const logger = require("firebase-functions/logger");

// NSE requires browser-like headers to avoid 403
const NSE_HEADERS = {
  "User-Agent":      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept":          "application/json, text/plain, */*",
  "Accept-Language": "en-IN,en;q=0.9",
  "Referer":         "https://www.nseindia.com/",
  "Origin":          "https://www.nseindia.com",
};

const nseAxios = axios.create({ timeout: 10000, headers: NSE_HEADERS });

// Session cookie cache
let _nseCookie       = null;
let _nseCookieExpiry = 0;

/**
 * Obtains a fresh NSE session cookie.
 * Cached for 5 minutes — reused across calls within the same cycle.
 * Returns null silently if NSE is unreachable (caller falls back).
 */
async function getNseCookie() {
  if (_nseCookie && Date.now() < _nseCookieExpiry) return _nseCookie;

  try {
    const res = await axios.get("https://www.nseindia.com", {
      timeout: 8000,
      headers: NSE_HEADERS,
    });
    const rawCookies = res.headers["set-cookie"] || [];
    _nseCookie       = rawCookies.map(c => c.split(";")[0]).join("; ");
    _nseCookieExpiry = Date.now() + 5 * 60_000;
    return _nseCookie;
  } catch {
    return null;  // Silently fail — caller will use EODHD fallback
  }
}

/**
 * Fetch live prices for a list of NSE symbols.
 *
 * Uses the Nifty 500 batch endpoint — most efficient (1 API call for all).
 * Strips ".NSE" suffix before lookup (NSE API uses bare symbols).
 *
 * @param {string[]} eohdSymbols - EODHD format: ["TCS.NSE", "RELIANCE.NSE"]
 * @returns {Promise<Object>}    Price map: { "TCS.NSE": 3520.50, ... }
 *   Returns {} on any failure — caller falls back to EODHD.
 */
async function getNSELivePrices(eohdSymbols) {
  if (!eohdSymbols || eohdSymbols.length === 0) return {};

  // Convert "TCS.NSE" → "TCS" for NSE API lookup
  const bareSymbols = eohdSymbols.map(s => s.replace(".NSE", ""));

  try {
    const cookie  = await getNseCookie();
    const headers = cookie ? { ...NSE_HEADERS, Cookie: cookie } : NSE_HEADERS;

    // Single batch call for entire Nifty 500
    const { data } = await nseAxios.get(
      "https://www.nseindia.com/api/equity-stockIndices?index=NIFTY%20500",
      { headers }
    );

    const stocks = (data?.data || []).filter(s => s.symbol && s.symbol !== "NIFTY 500");

    const priceMap = {};
    for (const s of stocks) {
      if (bareSymbols.includes(s.symbol)) {
        priceMap[`${s.symbol}.NSE`] = Number(parseFloat(s.lastPrice || 0).toFixed(2));
      }
    }

    const found = Object.keys(priceMap).length;
    logger.info(`NSE live: ${found}/${eohdSymbols.length} prices fetched`);
    return priceMap;

  } catch (err) {
    logger.warn(`NSE live fetch failed — EODHD fallback will be used: ${err.message}`);
    return {};
  }
}

/**
 * Fetch the Nifty 50 index level directly from NSE.
 * Used as a more accurate India index reading (EODHD is delayed).
 *
 * @returns {Promise<{ price: number, changePct: number } | null>}
 */
async function getNSENiftyIndex() {
  try {
    const cookie  = await getNseCookie();
    const headers = cookie ? { ...NSE_HEADERS, Cookie: cookie } : NSE_HEADERS;

    const { data } = await nseAxios.get(
      "https://www.nseindia.com/api/allIndices",
      { headers }
    );

    const nifty50 = (data?.data || []).find(i => i.index === "NIFTY 50");
    if (!nifty50) return null;

    return {
      price:     Number(parseFloat(nifty50.last          || 0).toFixed(2)),
      changePct: Number(parseFloat(nifty50.percentChange || 0).toFixed(2)),
    };
  } catch (err) {
    logger.warn(`NSE Nifty 50 index fetch failed: ${err.message}`);
    return null;
  }
}

module.exports = { getNSELivePrices, getNSENiftyIndex };
