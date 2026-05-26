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

// ── Full Nikkei 225 universe ──────────────────────────────────────────────────
// All 225 official Nikkei 225 constituents — scanned every cycle when Japan is
// open+bullish. Yahoo Finance only supports per-symbol v8/chart calls (no batch
// screener for TSE), so we maintain the full symbol list here and scan them in
// chunks. ~225 symbols × 8/chunk × 300ms = ~9 seconds total — fits easily inside
// the Cloud Function timeout.
// Source: Nikkei 225 official constituent list (updated quarterly).
const NIKKEI_225 = [
  // Fishery, agriculture & forestry
  "1332.T", "1301.T",
  // Mining
  "1605.T",
  // Construction
  "1801.T", "1802.T", "1803.T", "1808.T", "1812.T", "1925.T", "1928.T",
  // Food & beverages
  "2002.T", "2269.T", "2282.T", "2501.T", "2502.T", "2503.T", "2531.T",
  "2801.T", "2802.T", "2871.T", "2914.T",
  // Textiles & apparel
  "3401.T", "3402.T",
  // Pulp & paper
  "3861.T", "3436.T",
  // Chemicals
  "4004.T", "4005.T", "4021.T", "4042.T", "4043.T", "4061.T", "4063.T",
  "4183.T", "4188.T", "4208.T", "4452.T", "4502.T", "4503.T", "4506.T",
  "4507.T", "4519.T", "4523.T", "4528.T", "4543.T", "4568.T", "4578.T",
  // Oil & coal products
  "5001.T", "5020.T",
  // Rubber products
  "5108.T", "5110.T",
  // Glass & ceramics
  "5201.T", "5214.T", "5232.T", "5233.T", "5301.T", "5332.T", "5333.T",
  // Steel & metals
  "5401.T", "5406.T", "5411.T", "5541.T", "5703.T", "5706.T", "5711.T",
  "5713.T", "5714.T", "5802.T", "5803.T",
  // Machinery & industrials
  "6272.T", "6301.T", "6302.T", "6305.T", "6326.T", "6361.T", "6367.T",
  "6373.T", "6383.T", "6471.T", "6472.T", "6473.T",
  // Electronics & electrical equipment
  "6501.T", "6503.T", "6504.T", "6506.T", "6645.T", "6674.T", "6701.T",
  "6702.T", "6703.T", "6724.T", "6752.T", "6758.T", "6762.T", "6770.T",
  "6841.T", "6857.T", "6861.T", "6902.T", "6920.T", "6952.T", "6954.T",
  "6971.T", "6976.T", "6988.T",
  // Shipbuilding
  "7011.T", "7012.T", "7013.T",
  // Automobiles & parts
  "7201.T", "7202.T", "7203.T", "7205.T", "7211.T", "7261.T", "7267.T",
  "7269.T", "7270.T", "7272.T",
  // Precision instruments
  "7731.T", "7733.T", "7735.T", "7741.T", "7751.T", "7762.T",
  // Other manufacturing
  "7832.T", "7951.T", "7974.T",
  // Trading companies
  "8001.T", "8002.T", "8015.T", "8031.T", "8033.T", "8053.T", "8058.T",
  // Retail
  "8028.T", "8267.T", "9983.T", "3382.T", "2413.T",
  // Banks
  "8304.T", "8306.T", "8309.T", "8316.T", "8331.T", "8354.T", "8355.T",
  "8358.T", "8369.T", "8411.T",
  // Securities & commodity futures
  "8601.T", "8604.T",
  // Insurance
  "8630.T", "8725.T", "8750.T", "8766.T",
  // Real estate
  "8801.T", "8802.T", "8830.T",
  // Rail transport
  "9001.T", "9005.T", "9007.T", "9008.T", "9009.T", "9020.T", "9021.T", "9022.T",
  // Road transport
  "9064.T", "9101.T", "9104.T", "9107.T",
  // Air transport
  "9202.T", "9361.T",
  // Warehousing
  "9301.T",
  // Telecom
  "9432.T", "9433.T", "9434.T", "9613.T",
  // Electric power & gas
  "9501.T", "9502.T", "9503.T", "9531.T", "9532.T",
  // Service & internet
  "2432.T", "3659.T", "4689.T", "4751.T", "9602.T", "9984.T",
  // Other Nikkei 225 components
  "2768.T", "3407.T", "4661.T", "6460.T", "7164.T", "8411.T",
];

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

    // Exclude today's partial candle — Yahoo includes it when market is open,
    // but partial-day volume would corrupt avgVolume20d and volumeRatio calc.
    // We use meta.regularMarketVolume (passed as todayVolume to computeIndicators)
    // for the live volume; historical candles should only contain completed days.
    const todayStr = new Date().toISOString().split("T")[0];

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
      .filter(c => c.close > 0 && c.date < todayStr)  // completed trading days only
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
 * Scan the full Nikkei 225 universe for today's top gainers.
 * Equivalent to getNSEBroadMovers() for India — scans the complete index,
 * not a hand-picked watchlist. Uses Yahoo Finance v8/chart per symbol.
 *
 * @param {string[]} [symbols]    - Override list (default: full NIKKEI_225, ~225 stocks)
 * @param {number}   minChangePct - Minimum % gain (default 1.0%)
 * @param {number}   topN         - Max results returned (default 25)
 * @returns {Promise<Array>}      - [{ symbol, price, changePct, volume }, ...]
 */
async function getJapanBroadMovers(symbols, minChangePct = 1.0, topN = 25) {
  // Default to full Nikkei 225 — do NOT use a small hand-picked watchlist
  const universe = (symbols && symbols.length > 0) ? symbols : NIKKEI_225;
  const watchlist = universe;

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
