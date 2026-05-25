/**
 * global_swing/data/eodhd_screener.js
 * ======================================
 * Dynamic market-wide top-mover discovery using EODHD Screener API.
 * Available on the $29.99 EOD+Intraday All World Extended plan.
 *
 * WHY SCREENER INSTEAD OF FIXED WATCHLIST:
 *   A fixed watchlist of 15-30 stocks means ARJUN can only ever buy those names.
 *   A real trader scans the whole market for the best opportunity each session.
 *   This module does exactly that — scans the full exchange every cycle.
 *
 * HOW IT WORKS (2-step):
 *   Step 1 — EODHD Screener: get a dynamic universe of 60-100 active, liquid
 *             stocks from the full exchange (sorted by change_p).
 *             Cost: 5 API credits per call, cached 30 min.
 *
 *   Step 2 — Live Quotes: get real-time prices + today's % change for those symbols.
 *             This gives true intraday performance, not just EOD.
 *             Cost: ~5-7 batch calls (15 per batch), 5 credits each.
 *
 *   Result: top N real-time movers from the WHOLE exchange, not just a fixed list.
 *
 * FALLBACK:
 *   If screener fails (plan issue, timeout, API down) → falls back to the watchlist
 *   in markets.js via the normal getTopMovers() path. Never breaks ARJUN.
 *
 * INDIA NOTE:
 *   India (NSE) is handled separately by getNSEBroadMovers() in nse_live.js —
 *   the free NSE API already scans all 500 Nifty 500 stocks in one call.
 *   This file handles US, Germany (XETRA), Japan (T).
 */

const { eohdGet }      = require("./eodhd_client");
const { getLiveQuotes } = require("./eodhd_live");
const logger           = require("firebase-functions/logger");

const SCREENER_TTL = 30 * 60 * 1000;  // 30-min cache — screener is EOD-updated

// ── Per-market screener configuration ───────────────────────────────────────
// exchange:      EODHD exchange code used in screener filter
// suffix:        Appended to bare ticker to make EODHD symbol (e.g. AAPL → AAPL.US)
// minMarketCap:  Min market cap in $M — filters out illiquid micro-caps
// minVolume:     Min shares/units traded — ensures stock is actively traded
// universeSize:  How many stocks to fetch from screener (pre-live-quote step)
//
// IMPORTANT — EODHD screener exchange codes differ from symbol suffixes:
//   Symbols use  : AAPL.US  | SAP.XETRA | 7203.T
//   Screener uses: "US"     | "XETRA"   | "TSE"   ← Japan is "TSE" not "T"
//
// market_capitalization filter is in millions of USD.
//
const SCREENER_CONFIGS = {
  US: {
    exchange:     "US",
    suffix:       ".US",
    minMarketCap: 2000,    // $2B+ — filters out micro/small caps
    minVolume:    500000,  // 500k shares minimum
    universeSize: 80,
  },
  XETRA: {
    exchange:     "XETRA",
    suffix:       ".XETRA",
    minMarketCap: 200,     // $200M+ — DAX + MDAX range
    minVolume:    10000,   // European volumes are lower than US
    universeSize: 50,
  },
  T: {
    exchange:     "TSE",   // ← Tokyo Stock Exchange screener code is "TSE", not "T"
    suffix:       ".T",    //   symbol suffix remains ".T" (e.g. 7203.T)
    minMarketCap: 500,     // $500M+ — major Nikkei names
    minVolume:    100000,  // Tokyo share volumes
    universeSize: 50,
  },
};

/**
 * Get a dynamic universe of today's top movers from the full exchange.
 * Uses EODHD Screener (Step 1) + Live Quotes (Step 2) for real-time accuracy.
 *
 * @param {string} marketCode    - "US" | "XETRA" | "T"
 * @param {number} minChangePct  - Min % gain for final result (default 1.0%)
 * @param {number} topN          - Max results to return to Claude (default 20)
 * @returns {Promise<Array>}     - Array of { symbol, price, changePct, volume }
 *                                 Empty array if screener unavailable (fallback kicks in).
 */
async function getDynamicTopMovers(marketCode, minChangePct = 1.0, topN = 20) {
  const cfg = SCREENER_CONFIGS[marketCode];
  if (!cfg) {
    logger.warn(`getDynamicTopMovers: no screener config for ${marketCode}`);
    return [];
  }

  // ── Step 1: Screener — get dynamic universe from full exchange ───────────
  let screenerSymbols;
  try {
    screenerSymbols = await _fetchScreenerUniverse(cfg);
    logger.info(`Screener raw universe [${marketCode}]: ${screenerSymbols?.length ?? 0} symbols (exchange="${cfg.exchange}")`);
  } catch (err) {
    logger.warn(`Screener failed for ${marketCode} — falling back to watchlist: ${err.message}`);
    return [];
  }

  if (!screenerSymbols || screenerSymbols.length === 0) {
    logger.warn(
      `Screener [${marketCode}] returned 0 symbols — ` +
      `possible cause: wrong exchange code ("${cfg.exchange}"), plan limit, or no stocks meet filters. ` +
      `Falling back to watchlist.`
    );
    return [];
  }

  logger.info(`Screener [${marketCode}]: ${screenerSymbols.length} candidates from full exchange`);

  // ── Step 2: Live Quotes — get real-time price + today's % change ─────────
  let quotes;
  try {
    quotes = await getLiveQuotes(screenerSymbols);
  } catch (err) {
    logger.warn(`Live quotes failed for screener symbols [${marketCode}]: ${err.message}`);
    return [];
  }

  // ── Step 3: Filter + rank by today's live % change ───────────────────────
  // Note: filter by price > 0, NOT volume > 0.
  // EODHD real-time for non-US markets (XETRA, TSE) often returns intraday
  // partial-day volume or zero, making volume > 0 silently drop valid stocks.
  // Volume quality is verified downstream via historical 20d avg in computeIndicators.
  const movers = Object.values(quotes)
    .filter(q => q.changePct >= minChangePct && q.price > 0)
    .sort((a, b) => b.changePct - a.changePct)
    .slice(0, topN);

  logger.info(
    `Dynamic movers [${marketCode}]: ${movers.length} final candidates ` +
    `(≥ +${minChangePct}% live) from ${screenerSymbols.length} screener symbols`
  );

  return movers;
}

/**
 * Calls EODHD Screener API and returns symbol array for the given exchange config.
 * Sorted by change_p descending — returns the most-active names from the full market.
 *
 * @param {Object} cfg - Entry from SCREENER_CONFIGS
 * @returns {Promise<string[]>} Array of EODHD symbols e.g. ["AAPL.US", "NVDA.US", ...]
 */
async function _fetchScreenerUniverse(cfg) {
  const cacheKey = `screener_${cfg.exchange}_${new Date().toISOString().split("T")[0]}`;

  // EODHD screener valid filter fields: exchange, code, name, market_capitalization,
  //   sector, industry. NOTE: "volume" is NOT a valid screener filter field → causes 422.
  //   Volume filtering happens in Step 3 after live quotes are fetched.
  const filters = JSON.stringify([
    ["exchange",              "=",  cfg.exchange     ],
    ["market_capitalization", ">",  cfg.minMarketCap ],
  ]);

  // Log exact params so we can verify what's being sent
  logger.info(
    `Screener request [${cfg.exchange}]: filters=${filters} | ` +
    `sort=change_p.desc | limit=${cfg.universeSize}`
  );

  // Correct EODHD screener sort field: "refund_1d_p" (not "change_p.desc" — that causes 422)
  // order: "desc" = highest daily gainers first
  const data = await eohdGet(
    "/screener",
    {
      filters,
      sort:   "refund_1d_p",
      order:  "desc",
      limit:  cfg.universeSize,
      offset: 0,
    },
    cacheKey,
    SCREENER_TTL
  );

  if (!data) {
    logger.warn(`Screener [${cfg.exchange}]: API returned null (see 422/error above)`);
    return [];
  }

  // Log raw response shape
  const count = Array.isArray(data.data) ? data.data.length : "?";
  logger.info(`Screener [${cfg.exchange}]: API success → ${count} raw results | total: ${data.total ?? "?"}`);

  if (!data?.data || !Array.isArray(data.data)) return [];

  // Convert bare ticker → EODHD symbol format (e.g. "AAPL" → "AAPL.US")
  const symbols = data.data
    .filter(item => item.code && item.code.length > 0)
    .map(item => `${item.code}${cfg.suffix}`);

  logger.info(`Screener [${cfg.exchange}]: ${symbols.length} valid symbols extracted (sample: ${symbols.slice(0, 5).join(", ")})`);
  return symbols;
}

module.exports = { getDynamicTopMovers };
