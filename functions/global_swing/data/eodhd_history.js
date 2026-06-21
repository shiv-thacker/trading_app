/**
 * global_swing/data/eodhd_history.js
 * =====================================
 * Fetches 30-day End-of-Day (EOD) OHLCV candle history from EODHD.
 *
 * WHY THIS IS THE FIX FOR THE "BUY AT 52W HIGH" PROBLEM:
 *   The old system had no real price history — EMAs were in-memory
 *   (reset on every cold start), so Claude had no context.
 *   Now: real 30-day OHLCV → technical.js computes RSI, EMA20, 52W
 *   proximity accurately. If a stock is near its 52W high, the data
 *   will show it and the validator blocks the buy.
 *
 * ENDPOINT: GET /eod/{symbol}?from=YYYY-MM-DD&to=YYYY-MM-DD
 * RESPONSE: [{date, open, high, low, close, adjusted_close, volume}, ...]
 * COST:     1 API call per symbol
 *
 * CACHING: 4 hours (EOD data doesn't change intraday — safe to cache)
 *
 * WORKS FOR US / Germany on $29.99 plan:
 *   USA:     AAPL.US, NVDA.US
 *   Germany: SAP.XETRA
 *
 * India (.NSE) and Japan (.T) use Yahoo Finance — see yahoo_india.js / yahoo_japan.js.
 */

const { eohdGet } = require("./eodhd_client");
const logger      = require("firebase-functions/logger");

const HISTORY_CACHE_TTL = 4 * 60 * 60 * 1000; // 4 hours

/** Returns a YYYY-MM-DD string for N days ago. */
function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().split("T")[0];
}

/**
 * Fetch 30 trading days of daily OHLCV for a single symbol.
 * Requests 50 calendar days to guarantee ~30 trading days.
 *
 * @param {string} symbol - EODHD symbol e.g. "TCS.NSE", "AAPL.US", "7203.T"
 * @returns {Promise<Array>} Array of candle objects, oldest → newest.
 *   Each: { date, open, high, low, close, adjusted_close, volume }
 */
async function getHistoricalCandles(symbol) {
  const from     = daysAgo(50);   // ~50 calendar days ≈ 35 trading days
  const to       = daysAgo(0);
  const cacheKey = `eod_${symbol}_${from}`;

  const data = await eohdGet(
    `/eod/${symbol}`,
    { from, to },
    cacheKey,
    HISTORY_CACHE_TTL
  );

  if (!data || !Array.isArray(data) || data.length === 0) {
    logger.warn(`getHistoricalCandles: no data returned for ${symbol}`);
    return [];
  }

  // Sort ascending so index 0 = oldest, last = most recent
  const candles = data
    .filter(c => c && c.date && c.close)
    .sort((a, b) => new Date(a.date) - new Date(b.date));

  return candles;
}

/**
 * Fetch 30-day candles for multiple symbols in parallel.
 * Limits concurrency to 5 requests at a time to avoid rate limits.
 *
 * @param {string[]} symbols
 * @returns {Promise<Object>} Map: { "TCS.NSE": [...candles], "AAPL.US": [...] }
 */
async function getBatchHistoricalCandles(symbols) {
  if (!symbols || symbols.length === 0) return {};

  // Skip symbols EODHD does not cover — callers should use Yahoo modules instead
  const supported = symbols.filter(s => !s.endsWith(".NSE") && !s.endsWith(".T"));
  if (supported.length === 0) return {};

  const results    = {};
  const CHUNK_SIZE = 5;  // 5 parallel requests max

  for (let i = 0; i < supported.length; i += CHUNK_SIZE) {
    const chunk   = supported.slice(i, i + CHUNK_SIZE);
    const settled = await Promise.allSettled(
      chunk.map(async sym => ({ sym, candles: await getHistoricalCandles(sym) }))
    );

    for (const r of settled) {
      if (r.status === "fulfilled" && r.value) {
        results[r.value.sym] = r.value.candles;
      }
    }

    // Small breathing room between chunks
    if (i + CHUNK_SIZE < supported.length) {
      await new Promise(res => setTimeout(res, 300));
    }
  }

  logger.info(`getBatchHistoricalCandles: fetched for ${Object.keys(results).length}/${supported.length} symbols`);
  return results;
}

module.exports = { getHistoricalCandles, getBatchHistoricalCandles };
