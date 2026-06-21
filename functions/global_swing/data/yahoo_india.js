/**
 * global_swing/data/yahoo_india.js
 * ==================================
 * Yahoo Finance data for NSE India stocks (live quotes + OHLCV history).
 *
 * WHY THIS FILE EXISTS:
 *   1. EODHD /eod/TCS.NSE → "Ticker Not Found" on the $29.99 plan.
 *   2. NSE www.nseindia.com → Akamai blocks Postman, many VPNs, and GCP IPs.
 *   Yahoo covers NSE as {TICKER}.NS (TCS.NSE ↔ TCS.NS) and works from cloud.
 *
 * ENDPOINTS:
 *   Live quote + today : /v8/finance/chart/{symbol}?interval=1d&range=2d
 *   Historical OHLCV   : /v8/finance/chart/{symbol}?interval=1d&range=60d
 */

const axios  = require("axios");
const logger = require("firebase-functions/logger");

const BASE    = "https://query1.finance.yahoo.com";
const HEADERS = { "User-Agent": "Mozilla/5.0 (compatible; TradingBot/1.0)" };
const TIMEOUT = 10000;
const LIVE_TTL = 5  * 60 * 1000;
const EOD_TTL  = 4  * 60 * 60 * 1000;

const _cache = new Map();

function _get(key) {
  const e = _cache.get(key);
  if (!e || Date.now() > e.exp) { _cache.delete(key); return null; }
  return e.val;
}

function _set(key, val, ttlMs) { _cache.set(key, { val, exp: Date.now() + ttlMs }); }

/** Convert app symbol TCS.NSE → Yahoo TCS.NS */
function toYahooSymbol(nseSymbol) {
  return nseSymbol.replace(/\.NSE$/i, ".NS");
}

/**
 * Live quote for one NSE stock via Yahoo Finance.
 * @param {string} symbol - e.g. "TCS.NSE"
 * @returns {Promise<{ symbol, price, changePct, volume, prevClose }|null>}
 */
async function getIndiaLiveQuote(symbol) {
  const cacheKey = `yf_in_live_${symbol}`;
  const cached   = _get(cacheKey);
  if (cached) return cached;

  const yahooSym = toYahooSymbol(symbol);

  try {
    const url = `${BASE}/v8/finance/chart/${yahooSym}?interval=1d&range=2d&includePrePost=false`;
    const { data } = await axios.get(url, { headers: HEADERS, timeout: TIMEOUT });
    const meta     = data?.chart?.result?.[0]?.meta;
    if (!meta) return null;

    const price     = Number(meta.regularMarketPrice || 0);
    const prevClose = Number(meta.chartPreviousClose || meta.regularMarketPreviousClose || 0);
    const volume    = Number(meta.regularMarketVolume || 0);

    if (price <= 0) return null;

    const changePct = prevClose > 0
      ? Math.round(((price - prevClose) / prevClose) * 100 * 100) / 100
      : 0;

    const result = { symbol, price, changePct, volume, prevClose };
    _set(cacheKey, result, LIVE_TTL);
    return result;
  } catch (err) {
    logger.warn(`getIndiaLiveQuote [${symbol}]: ${err.message}`);
    return null;
  }
}

/**
 * Live prices for multiple NSE symbols.
 * @param {string[]} symbols - e.g. ["TCS.NSE", "RELIANCE.NSE"]
 * @returns {Promise<Object>} { "TCS.NSE": 3520.5, ... }
 */
async function getIndiaLivePrices(symbols) {
  if (!symbols || symbols.length === 0) return {};

  const priceMap   = {};
  const CHUNK_SIZE = 8;

  for (let i = 0; i < symbols.length; i += CHUNK_SIZE) {
    const chunk   = symbols.slice(i, i + CHUNK_SIZE);
    const settled = await Promise.allSettled(chunk.map(sym => getIndiaLiveQuote(sym)));
    for (const r of settled) {
      if (r.status === "fulfilled" && r.value?.price > 0) {
        priceMap[r.value.symbol] = r.value.price;
      }
    }
    if (i + CHUNK_SIZE < symbols.length) {
      await new Promise(res => setTimeout(res, 300));
    }
  }

  logger.info(`Yahoo India live: ${Object.keys(priceMap).length}/${symbols.length} prices fetched`);
  return priceMap;
}

/**
 * Scan a symbol list for today's top gainers (fallback when NSE API is blocked).
 * @param {string[]} watchlist    - App symbols e.g. ["TCS.NSE", ...]
 * @param {number}   minChangePct
 * @param {number}   topN
 * @returns {Promise<Array>} [{ symbol, price, changePct, volume }, ...]
 */
async function getIndiaBroadMovers(watchlist, minChangePct = 1.0, topN = 25) {
  if (!watchlist || watchlist.length === 0) return [];

  const results    = [];
  const CHUNK_SIZE = 8;

  for (let i = 0; i < watchlist.length; i += CHUNK_SIZE) {
    const chunk   = watchlist.slice(i, i + CHUNK_SIZE);
    const settled = await Promise.allSettled(chunk.map(sym => getIndiaLiveQuote(sym)));

    for (const r of settled) {
      if (r.status === "fulfilled" && r.value && r.value.price > 0) {
        results.push(r.value);
      }
    }

    if (i + CHUNK_SIZE < watchlist.length) {
      await new Promise(res => setTimeout(res, 300));
    }
  }

  const movers = results
    .filter(q => q.changePct >= minChangePct && q.price > 0)
    .sort((a, b) => b.changePct - a.changePct)
    .slice(0, topN);

  logger.info(
    `Yahoo India broad scan: ${movers.length} movers ≥ +${minChangePct}% ` +
    `from ${watchlist.length} symbols (NSE fallback)`
  );
  return movers;
}

/**
 * Fetch ~60 days of daily OHLCV for an NSE stock.
 * @param {string} symbol - App format e.g. "TCS.NSE"
 * @returns {Promise<Array>} Candles oldest → newest (same shape as eodhd_history)
 */
async function getIndiaHistoricalCandles(symbol) {
  const cacheKey = `yf_in_eod_${symbol}`;
  const cached   = _get(cacheKey);
  if (cached) return cached;

  const yahooSym = toYahooSymbol(symbol);

  try {
    const url = `${BASE}/v8/finance/chart/${yahooSym}?interval=1d&range=60d&includePrePost=false`;
    const { data } = await axios.get(url, { headers: HEADERS, timeout: TIMEOUT });
    const result   = data?.chart?.result?.[0];
    if (!result) return [];

    const timestamps = result.timestamp || [];
    const q          = result.indicators?.quote?.[0] || {};
    const opens      = q.open   || [];
    const highs      = q.high   || [];
    const lows       = q.low    || [];
    const closes     = q.close  || [];
    const volumes    = q.volume || [];
    const todayStr   = new Date().toISOString().split("T")[0];

    const candles = timestamps
      .map((ts, i) => ({
        date:           new Date(ts * 1000).toISOString().split("T")[0],
        open:           Number(opens[i]  || 0),
        high:           Number(highs[i]  || 0),
        low:            Number(lows[i]   || 0),
        close:          Number(closes[i] || 0),
        adjusted_close: Number(closes[i] || 0),
        volume:         Number(volumes[i] || 0),
      }))
      .filter(c => c.close > 0 && c.date < todayStr)
      .sort((a, b) => new Date(a.date) - new Date(b.date));

    _set(cacheKey, candles, EOD_TTL);
    logger.info(`getIndiaHistoricalCandles [${symbol}]: ${candles.length} candles via ${yahooSym}`);
    return candles;
  } catch (err) {
    logger.warn(`getIndiaHistoricalCandles [${symbol}]: ${err.message}`);
    return [];
  }
}

/**
 * @param {string[]} symbols - e.g. ["TCS.NSE", "RELIANCE.NSE"]
 * @returns {Promise<Object>} { "TCS.NSE": [...candles], ... }
 */
async function getIndiaBatchHistoricalCandles(symbols) {
  if (!symbols || symbols.length === 0) return {};

  const results    = {};
  const CHUNK_SIZE = 5;

  for (let i = 0; i < symbols.length; i += CHUNK_SIZE) {
    const chunk   = symbols.slice(i, i + CHUNK_SIZE);
    const settled = await Promise.allSettled(
      chunk.map(async sym => ({ sym, candles: await getIndiaHistoricalCandles(sym) }))
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

  logger.info(
    `getIndiaBatchHistoricalCandles: fetched for ${Object.keys(results).length}/${symbols.length} symbols`
  );
  return results;
}

module.exports = {
  toYahooSymbol,
  getIndiaLiveQuote,
  getIndiaLivePrices,
  getIndiaBroadMovers,
  getIndiaHistoricalCandles,
  getIndiaBatchHistoricalCandles,
};
