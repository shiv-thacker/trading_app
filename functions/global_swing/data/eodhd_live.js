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

const LIVE_TTL = 5 * 60 * 1000;  // 5-minute cache

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

module.exports = { getLiveQuotes, getLiveIndex, getTopMovers };
