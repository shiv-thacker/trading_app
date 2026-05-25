/**
 * global_swing/data/yahoo_japan.js
 * ===================================
 * Yahoo Finance data fetcher for Japan (TSE) stocks.
 *
 * WHY THIS FILE EXISTS:
 *   EODHD's $29.99 plan does NOT cover Tokyo Stock Exchange individual stocks.
 *   - /real-time/7203.T  → all fields return "NA"
 *   - /eod/7203.T        → "Ticker Not Found"
 *   - Screener for TSE   → empty results
 *   The Nikkei 225 index (N225.INDX) works on EODHD and is used by market_mood.js.
 *   Everything else Japan-related uses this file instead.
 *
 * DATA SOURCE: Yahoo Finance v8/finance/chart (free, no key required)
 *   Symbol format matches EODHD .T suffix: 7203.T = Toyota on Yahoo Finance.
 *   Index: ^N225 (Nikkei 225).
 *
 * ENDPOINTS USED:
 *   Quote + today's data  : /v8/finance/chart/{symbol}?interval=1d&range=2d
 *   Historical OHLCV (60d): /v8/finance/chart/{symbol}?interval=1d&range=60d
 *
 * CACHING: 5 minutes for live quotes, 4 hours for historical candles.
 * Rate limiting: batch requests in chunks of 8 with 300ms delay between chunks.
 */

const axios  = require("axios");
const logger = require("firebase-functions/logger");

const BASE    = "https://query1.finance.yahoo.com";
const HEADERS = { "User-Agent": "Mozilla/5.0 (compatible; TradingBot/1.0)" };
const TIMEOUT = 10000;

// ── Simple in-process cache (keyed by symbol+type) ───────────────────────────
const _cache = new Map();
function _get(key) {
  const e = _cache.get(key);
  if (!e || Date.now() > e.exp) { _cache.delete(key); return null; }
  return e.val;
}
function _set(key, val, ttlMs) { _cache.set(key, { val, exp: Date.now() + ttlMs }); }

const LIVE_TTL = 5  * 60 * 1000;   // 5-min cache for live quotes
const EOD_TTL  = 4  * 60 * 60 * 1000; // 4-hr cache for historical candles

// ─────────────────────────────────────────────────────────────
// Live quote for a single Japan stock
// ─────────────────────────────────────────────────────────────

/**
 * Fetch live quote for one Japan stock via Yahoo Finance chart API.
 * Returns { symbol, price, changePct, volume, fiftyTwoWeekHigh, prevClose }.
 *
 * @param {string} symbol - e.g. "7203.T", "6758.T"
 * @returns {Promise<Object|null>}
 */
async function getJapanLiveQuote(symbol) {
  const cacheKey = `yf_live_${symbol}`;
  const cached   = _get(cacheKey);
  if (cached) return cached;

  try {
    const url  = `${BASE}/v8/finance/chart/${symbol}?interval=1d&range=2d&includePrePost=false`;
    const { data } = await axios.get(url, { headers: HEADERS, timeout: TIMEOUT });
    const meta     = data?.chart?.result?.[0]?.meta;
    if (!meta) return null;

    const price    = Number(meta.regularMarketPrice   || 0);
    const prevClose = Number(meta.chartPreviousClose  || meta.regularMarketPreviousClose || 0);
    const volume   = Number(meta.regularMarketVolume  || 0);
    const high52w  = Number(meta.fiftyTwoWeekHigh     || 0);

    if (price <= 0) return null;

    const changePct = prevClose > 0
      ? Math.round(((price - prevClose) / prevClose) * 100 * 100) / 100
      : 0;

    const result = { symbol, price, changePct, volume, prevClose, fiftyTwoWeekHigh: high52w };
    _set(cacheKey, result, LIVE_TTL);
    return result;

  } catch (err) {
    logger.warn(`getJapanLiveQuote [${symbol}]: ${err.message}`);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────
// Historical OHLCV candles for a single Japan stock
// ─────────────────────────────────────────────────────────────

/**
 * Fetch ~60 days of daily OHLCV candles for a Japan stock.
 * Returns array in same shape as eodhd_history.getHistoricalCandles().
 *
 * @param {string} symbol - e.g. "7203.T"
 * @returns {Promise<Array>} Candles oldest → newest
 */
async function getJapanHistoricalCandles(symbol) {
  const cacheKey = `yf_eod_${symbol}`;
  const cached   = _get(cacheKey);
  if (cached) return cached;

  try {
    const url    = `${BASE}/v8/finance/chart/${symbol}?interval=1d&range=60d&includePrePost=false`;
    const { data } = await axios.get(url, { headers: HEADERS, timeout: TIMEOUT });
    const result   = data?.chart?.result?.[0];
    if (!result) return [];

    const timestamps = result.timestamp           || [];
    const q          = result.indicators?.quote?.[0] || {};
    const opens      = q.open   || [];
    const highs      = q.high   || [];
    const lows       = q.low    || [];
    const closes     = q.close  || [];
    const volumes    = q.volume || [];

    const candles = timestamps
      .map((ts, i) => ({
        date:           new Date(ts * 1000).toISOString().split("T")[0],
        open:           Number(opens[i]  || 0),
        high:           Number(highs[i]  || 0),
        low:            Number(lows[i]   || 0),
        close:          Number(closes[i] || 0),
        adjusted_close: Number(closes[i] || 0),  // Yahoo doesn't distinguish
        volume:         Number(volumes[i] || 0),
      }))
      .filter(c => c.close > 0)
      .sort((a, b) => new Date(a.date) - new Date(b.date));

    _set(cacheKey, candles, EOD_TTL);
    logger.info(`getJapanHistoricalCandles [${symbol}]: ${candles.length} candles`);
    return candles;

  } catch (err) {
    logger.warn(`getJapanHistoricalCandles [${symbol}]: ${err.message}`);
    return [];
  }
}

// ─────────────────────────────────────────────────────────────
// Batch historical candles for multiple Japan symbols
// ─────────────────────────────────────────────────────────────

/**
 * Fetch historical candles for multiple Japan symbols in parallel.
 * @param {string[]} symbols
 * @returns {Promise<Object>} { "7203.T": [...candles], "6758.T": [...] }
 */
async function getJapanBatchHistoricalCandles(symbols) {
  if (!symbols || symbols.length === 0) return {};
  const results    = {};
  const CHUNK_SIZE = 5;

  for (let i = 0; i < symbols.length; i += CHUNK_SIZE) {
    const chunk   = symbols.slice(i, i + CHUNK_SIZE);
    const settled = await Promise.allSettled(
      chunk.map(async sym => ({ sym, candles: await getJapanHistoricalCandles(sym) }))
    );
    for (const r of settled) {
      if (r.status === "fulfilled" && r.value) {
        results[r.value.sym] = r.value.candles;
      }
    }
    if (i + CHUNK_SIZE < symbols.length) {
      await new Promise(res => setTimeout(res, 300));
    }
  }

  logger.info(`getJapanBatchHistoricalCandles: fetched for ${Object.keys(results).length}/${symbols.length} symbols`);
  return results;
}

// ─────────────────────────────────────────────────────────────
// Top movers scanner — scans Japan watchlist via Yahoo Finance
// ─────────────────────────────────────────────────────────────

/**
 * Scan Japan watchlist for today's top gainers.
 * Equivalent to getTopMovers() in eodhd_live.js but uses Yahoo Finance.
 *
 * @param {string[]} watchlist   - Array of EODHD-format symbols e.g. ["7203.T", "6758.T"]
 * @param {number}   minChangePct - Minimum % gain (default 1.0%)
 * @param {number}   topN         - Max results (default 20)
 * @returns {Promise<Array>}      - [{ symbol, price, changePct, volume }, ...]
 */
async function getJapanBroadMovers(watchlist, minChangePct = 1.0, topN = 20) {
  if (!watchlist || watchlist.length === 0) return [];

  const results    = [];
  const CHUNK_SIZE = 8;  // Yahoo Finance tolerates ~8 parallel requests comfortably

  for (let i = 0; i < watchlist.length; i += CHUNK_SIZE) {
    const chunk   = watchlist.slice(i, i + CHUNK_SIZE);
    const settled = await Promise.allSettled(chunk.map(sym => getJapanLiveQuote(sym)));

    for (const r of settled) {
      if (r.status === "fulfilled" && r.value && r.value.price > 0) {
        results.push(r.value);
      }
    }

    if (i + CHUNK_SIZE < watchlist.length) {
      await new Promise(res => setTimeout(res, 300));
    }
  }

  const withPrice = results.filter(q => q.price > 0);
  const withVol   = results.filter(q => q.volume > 0);

  logger.info(
    `getJapanBroadMovers: ${results.length}/${watchlist.length} quotes received ` +
    `| ${withPrice.length} have price | ${withVol.length} have volume`
  );

  const movers = results
    .filter(q => q.changePct >= minChangePct && q.price > 0)
    .sort((a, b) => b.changePct - a.changePct)
    .slice(0, topN);

  logger.info(`getJapanBroadMovers: ${movers.length} stocks ≥ +${minChangePct}% from ${watchlist.length}-symbol watchlist`);
  return movers;
}

module.exports = {
  getJapanLiveQuote,
  getJapanHistoricalCandles,
  getJapanBatchHistoricalCandles,
  getJapanBroadMovers,
};
