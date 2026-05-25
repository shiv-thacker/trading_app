/**
 * global_swing/data/eodhd_live.js
 * ==================================
 * Live / near-real-time price quotes from EODHD.
 *
 * PLAN COVERAGE ($29.99):
 *   US stocks (NYSE/NASDAQ) : near real-time (WebSocket tier)
 *   India / Germany / Japan  : ~15-20 min delayed
 *
 * For India specifically: nse_live.js tries the NSE free API first
 * (real-time); this file is the fallback when NSE is unavailable.
 *
 * ENDPOINT: GET /real-time/{primarySymbol}?s=SYM2,SYM3,...
 *   - Batch up to ~15 symbols per call
 *   - Returns array when multiple, object when single
 *   - Fields: code, open, high, low, close, volume,
 *             previousClose, change, change_p, timestamp
 *
 * CACHING: 5 minutes (short TTL — live data)
 */

const { eohdGet } = require("./eodhd_client");
const logger      = require("firebase-functions/logger");

const LIVE_TTL      = 5  * 60 * 1000;   // 5-minute cache
const FX_TTL        = 60 * 60 * 1000;   // 60-minute cache for FX rates
const SENTIMENT_TTL = 60 * 60 * 1000;   // 60-minute cache for sentiment (daily data)

// ── Proxy symbols used to measure market-wide sentiment ─────────────────────
// We average the sentiment of 3 large, liquid stocks per market as a proxy
// for the whole market. These are the highest-weight names in each index.
const MARKET_SENTIMENT_PROXIES = {
  NSE:   ["RELIANCE.NSE",  "TCS.NSE",      "HDFCBANK.NSE"],
  US:    ["SPY.US",        "AAPL.US",       "MSFT.US"],
  XETRA: ["SAP.XETRA",    "SIE.XETRA",     "BMW.XETRA"],
  T:     ["7203.T",        "6758.T",        "9984.T"],
};

// ─────────────────────────────────────────────────────────────
// Live FX rate fetcher
// ─────────────────────────────────────────────────────────────

/**
 * Fetch live USD/INR exchange rate from EODHD FOREX endpoint.
 * Falls back to a safe default if the API call fails.
 *
 * EODHD FOREX symbol format: "USDINR.FOREX"
 * Returns the current bid/ask mid price.
 *
 * @returns {Promise<number>} e.g. 84.21
 */
async function getLiveUsdInrRate() {
  try {
    const data = await eohdGet(
      "/real-time/USDINR.FOREX",
      {},
      "fx_usdinr",
      FX_TTL
    );

    if (data && (data.close || data.price)) {
      const rate = parseFloat(data.close || data.price);
      if (rate > 50 && rate < 150) {   // sanity check — ₹50–₹150 per $
        logger.info(`Live USD/INR rate: ₹${rate.toFixed(2)}`);
        return Math.round(rate * 100) / 100;
      }
    }
  } catch (err) {
    logger.warn("USD/INR rate fetch failed — using default 84.0:", err.message);
  }

  // Safe fallback (close to real rate, avoids startup errors)
  return 84.0;
}

/**
 * Fetch live quotes for a batch of EODHD symbols.
 * Handles batching automatically (15 per EODHD call).
 *
 * @param {string[]} symbols - e.g. ["AAPL.US", "MSFT.US", "TCS.NSE"]
 * @returns {Promise<Object>} Map: { "AAPL.US": { price, changePct, volume, ... } }
 */
async function getLiveQuotes(symbols) {
  if (!symbols || symbols.length === 0) return {};

  const result = {};
  const BATCH  = 15;

  for (let i = 0; i < symbols.length; i += BATCH) {
    const batch = symbols.slice(i, i + BATCH);
    const [primary, ...rest] = batch;
    const params   = rest.length > 0 ? { s: rest.join(",") } : {};
    const cacheKey = `live_${[...batch].sort().join("_")}`;

    const data = await eohdGet(`/real-time/${primary}`, params, cacheKey, LIVE_TTL);
    if (!data) continue;

    // EODHD returns array for multi, plain object for single
    const items = Array.isArray(data) ? data : [data];

    for (const item of items) {
      if (!item || !item.code) continue;
      result[item.code] = {
        symbol:    item.code,
        price:     Number(item.close          || 0),
        open:      Number(item.open           || 0),
        high:      Number(item.high           || 0),
        low:       Number(item.low            || 0),
        prevClose: Number(item.previousClose  || 0),
        change:    Number(item.change         || 0),
        changePct: Number(item.change_p       || 0),
        volume:    Number(item.volume         || 0),
        timestamp: item.timestamp             || 0,
      };
    }

    if (i + BATCH < symbols.length) {
      await new Promise(r => setTimeout(r, 200)); // throttle
    }
  }

  return result;
}

/**
 * Fetch live data for a single market index.
 * Used by market_mood.js to determine today's index move.
 *
 * Confirmed working: NSEI.INDX (Nifty 50), GSPC.INDX (S&P 500)
 *
 * @param {string} indexSymbol - e.g. "NSEI.INDX", "GSPC.INDX", "GDAXI.INDX"
 * @returns {Promise<Object|null>} { price, changePct, change } or null
 */
async function getLiveIndex(indexSymbol) {
  const cacheKey = `live_idx_${indexSymbol}`;
  const data     = await eohdGet(`/real-time/${indexSymbol}`, {}, cacheKey, LIVE_TTL);
  if (!data) return null;

  const item = Array.isArray(data) ? data[0] : data;
  if (!item) return null;

  return {
    symbol:    item.code,
    price:     Number(item.close         || 0),
    prevClose: Number(item.previousClose || 0),
    changePct: Number(item.change_p      || 0),
    change:    Number(item.change        || 0),
    timestamp: item.timestamp            || 0,
  };
}

/**
 * Scan the watchlist for a market and return today's top gainers.
 * Filters by minimum % change and positive volume.
 * Sorted descending by % change.
 *
 * @param {string[]} watchlist    - EODHD symbols for the market
 * @param {number}   minChangePct - Min % gain to qualify (default 1.0%)
 * @param {number}   topN         - Max results (default 10)
 * @returns {Promise<Array>}      - Top movers with live quote data
 */
async function getTopMovers(watchlist, minChangePct = 1.0, topN = 10) {
  const quotes = await getLiveQuotes(watchlist);

  const movers = Object.values(quotes)
    .filter(q => q.changePct >= minChangePct && q.volume > 0)
    .sort((a, b) => b.changePct - a.changePct)
    .slice(0, topN);

  logger.info(`getTopMovers: ${movers.length} stocks ≥ +${minChangePct}% from ${watchlist.length}-symbol watchlist`);
  return movers;
}

/**
 * Fetch EODHD sentiment scores for all 4 markets in one batch.
 * Uses 3 proxy stocks per market and averages to get market-wide sentiment.
 *
 * EODHD /api/sentiments returns a normalized score per ticker per day:
 *   -1 = very negative, 0 = neutral, +1 = very positive
 *
 * API cost: 5 base + (12 symbols × 5) = 65 credits per call.
 * Cached for 1 hour — sentiment is daily, not tick-by-tick.
 *
 * @returns {Promise<Object>} Map: { NSE: 0.32, US: -0.12, XETRA: 0.05, T: 0.21 }
 *                            null means sentiment unavailable for that market.
 */
async function getAllMarketSentiments() {
  const today      = new Date().toISOString().split("T")[0];
  const yesterday  = new Date(Date.now() - 86400000).toISOString().split("T")[0];
  const allSymbols = Object.values(MARKET_SENTIMENT_PROXIES).flat();
  const cacheKey   = `sentiment_all_${today}`;

  let rawData;
  try {
    // EODHD sentiments endpoint: /api/sentiments?s=AAPL.US,MSFT.US&from=...&to=...
    // Note: does NOT use /real-time prefix — it's a standalone endpoint.
    rawData = await eohdGet(
      "/sentiments",
      { s: allSymbols.join(","), from: yesterday, to: today, fmt: "json" },
      cacheKey,
      SENTIMENT_TTL
    );
  } catch (err) {
    logger.warn("Sentiment fetch failed (non-fatal):", err.message);
    return {};
  }

  // 404 means endpoint not found (plan may not include it) — skip silently
  if (!rawData) {
    logger.info("Sentiment API returned no data — proceeding without sentiment");
    return {};
  }

  if (!rawData || typeof rawData !== "object") return {};

  const results = {};

  for (const [marketCode, proxies] of Object.entries(MARKET_SENTIMENT_PROXIES)) {
    const scores = [];

    for (const sym of proxies) {
      const entries = rawData[sym];
      if (!Array.isArray(entries) || entries.length === 0) continue;

      // Prefer today's score; fall back to yesterday's
      const todayEntry = entries.find(e => e.date === today);
      const entry      = todayEntry || entries[entries.length - 1];

      if (entry && typeof entry.normalized === "number" && entry.count >= 2) {
        scores.push(entry.normalized);
      }
    }

    if (scores.length > 0) {
      const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
      results[marketCode] = Math.round(avg * 1000) / 1000;
      logger.info(
        `Sentiment [${marketCode}]: ${results[marketCode].toFixed(3)} ` +
        `(from ${scores.length}/${proxies.length} proxies)`
      );
    } else {
      results[marketCode] = null; // not enough data — won't affect mood score
      logger.info(`Sentiment [${marketCode}]: no data`);
    }
  }

  return results;
}

module.exports = {
  getLiveQuotes,
  getLiveIndex,
  getTopMovers,
  getLiveUsdInrRate,
  getAllMarketSentiments,
  MARKET_SENTIMENT_PROXIES,
};
