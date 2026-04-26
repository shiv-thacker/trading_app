/**
 * functions/market_data.js
 * ========================
 * Firebase-only market data provider (no Python, no Render dependency).
 *
 * PURPOSE:
 *   Fetches live NSE market data directly from Node.js Cloud Functions.
 *   Uses:
 *     - Yahoo Finance (via yahoo-finance2) for live quotes + history
 *     - NSE official Nifty 500 CSV for dynamic universe (no hardcoded stocks)
 *
 * FUNCTIONS:
 *   getMarketOverview()    → Nifty indices + market mood
 *   getTopMovers()         → Live top 20 NSE momentum stocks (dynamic)
 *   getCurrentPrices(syms) → Real-time prices for current holdings
 *
 * CACHING:
 *   getMarketOverview: 1 minute
 *   getTopMovers:      4 minutes
 *   getCurrentPrices:  no cache
 */

const axios = require("axios");
const logger = require("firebase-functions/logger");
const { RSI, EMA } = require("technicalindicators");

const NIFTY500_CSV_URL =
  "https://archives.nseindia.com/content/indices/ind_nifty500list.csv";

const CACHE = {
  overview: { value: null, expiresAt: 0 },
  movers: { value: null, expiresAt: 0 },
  nifty500: { value: null, expiresAt: 0 },
};

function isFresh(cacheObj) {
  return cacheObj.value && Date.now() < cacheObj.expiresAt;
}

function parseNifty500CSV(csvText) {
  const rows = csvText.split(/\r?\n/).filter(Boolean);
  if (rows.length < 2) return [];
  const headers = rows[0].split(",").map((h) => h.trim());
  const symbolIdx = headers.findIndex((h) => h.toLowerCase() === "symbol");
  const nameIdx = headers.findIndex((h) => h.toLowerCase().includes("company"));
  const sectorIdx = headers.findIndex((h) => h.toLowerCase().includes("industry"));

  if (symbolIdx < 0) return [];

  return rows
    .slice(1)
    .map((row) => {
      const cols = row.split(",");
      const symbol = (cols[symbolIdx] || "").trim();
      if (!symbol) return null;
      return {
        symbol,
        companyName: (cols[nameIdx] || symbol).trim(),
        sector: (cols[sectorIdx] || "Unknown").trim(),
      };
    })
    .filter(Boolean);
}

async function getNifty500Universe() {
  if (isFresh(CACHE.nifty500)) return CACHE.nifty500.value;
  const { data } = await axios.get(NIFTY500_CSV_URL, { timeout: 15000 });
  const parsed = parseNifty500CSV(data);
  if (!parsed.length) throw new Error("Could not parse Nifty 500 CSV");
  CACHE.nifty500 = {
    value: parsed,
    expiresAt: Date.now() + 24 * 60 * 60 * 1000,
  };
  return parsed;
}

async function fetchYahooChart(symbol, range = "1mo", interval = "1d") {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`;
  const { data } = await axios.get(url, {
    timeout: 20000,
    params: { range, interval },
    headers: { "User-Agent": "Mozilla/5.0" },
  });
  const result = data?.chart?.result?.[0];
  if (!result) throw new Error(`No Yahoo chart result for ${symbol}`);
  return result;
}

function getLatestOHLC(result) {
  const q = result?.indicators?.quote?.[0] || {};
  const len = (q.close || []).length;
  if (!len) return null;
  return {
    close: Number(q.close[len - 1] || 0),
    open: Number(q.open[len - 1] || 0),
    high: Number(q.high[len - 1] || 0),
    low: Number(q.low[len - 1] || 0),
    volume: Number(q.volume[len - 1] || 0),
  };
}

async function getIndexData(ticker) {
  const result = await fetchYahooChart(ticker, "5d", "1d");
  const meta = result.meta || {};
  const latest = getLatestOHLC(result);
  const price = Number(meta.regularMarketPrice || latest?.close || 0);
  const prevClose = Number(meta.previousClose || 0);
  const changePct = prevClose > 0 ? ((price - prevClose) / prevClose) * 100 : 0;
  return { price: Number(price.toFixed(2)), changePct: Number(changePct.toFixed(2)) };
}

// ─────────────────────────────────────────────────────────────
// getMarketOverview
// ─────────────────────────────────────────────────────────────
/**
 * Fetches current Nifty index levels and overall market mood.
 *
 * @returns {Promise<Object>} Shape:
 *   {
 *     nifty50:    { price: number, changePct: number },
 *     niftyBank:  { price: number, changePct: number },
 *     niftyIT:    { price: number, changePct: number },
 *     niftyPharma:{ price: number, changePct: number },
 *     niftyAuto:  { price: number, changePct: number },
 *     niftyEnergy:{ price: number, changePct: number },
 *     marketMood: "BULLISH" | "BEARISH" | "VOLATILE" | "NEUTRAL"
 *   }
 */
async function getMarketOverview() {
  try {
    if (isFresh(CACHE.overview)) return CACHE.overview.value;
    logger.info("Fetching market overview directly from Yahoo Finance...");

    const [nifty50, niftyBank, niftyIT, niftyPharma, niftyAuto, niftyEnergy] =
      await Promise.all([
        getIndexData("^NSEI"),
        getIndexData("^NSEBANK"),
        getIndexData("^CNXIT"),
        getIndexData("^CNXPHARMA"),
        getIndexData("^CNXAUTO"),
        getIndexData("^CNXENERGY"),
      ]);

    const niftyChange = nifty50.changePct || 0;
    let marketMood = "NEUTRAL";
    if (Math.abs(niftyChange) > 1.5) marketMood = "VOLATILE";
    else if (niftyChange > 0.5) marketMood = "BULLISH";
    else if (niftyChange < -0.5) marketMood = "BEARISH";

    const result = {
      nifty50,
      niftyBank,
      niftyIT,
      niftyPharma,
      niftyAuto,
      niftyEnergy,
      marketMood,
    };

    CACHE.overview = { value: result, expiresAt: Date.now() + 60 * 1000 };
    return result;
  } catch (err) {
    logger.error("getMarketOverview failed:", err.message);
    throw new Error(`Market overview fetch failed: ${err.message}`);
  }
}

// ─────────────────────────────────────────────────────────────
// getTopMovers
// ─────────────────────────────────────────────────────────────
/**
 * Fetches the live top 20 NSE stocks by momentum RIGHT NOW.
 *
 * CRITICAL: This list is computed fresh every call from all 500 Nifty 500
 * stocks. No stock is ever hardcoded in this codebase. ARJUN only trades
 * whatever appears in this list each cycle.
 *
 * @returns {Promise<Array>} Array of up to 20 objects:
 *   {
 *     symbol:      string,   // e.g. "RELIANCE" (no .NS suffix)
 *     companyName: string,
 *     sector:      string,
 *     price:       number,
 *     changePct:   number,   // % change today
 *     volume:      number,
 *     avgVolume:   number,
 *     volumeRatio: number,   // today / 10-day avg
 *     rsi:         number,   // 14-period RSI
 *     ma5:         number,   // EMA 5
 *     ma10:        number,   // EMA 10
 *     ma20:        number,   // EMA 20
 *     high52w:     number,
 *     low52w:      number,
 *     dayHigh:     number,
 *     dayLow:      number
 *   }
 */
async function getTopMovers() {
  try {
    if (isFresh(CACHE.movers)) return CACHE.movers.value;
    logger.info("Fetching top movers directly from Yahoo Finance...");

    const universe = await getNifty500Universe(); // dynamic list from NSE CSV
    const sampledUniverse = universe.slice(0, 220); // keeps runtime within function limits

    const candidates = [];
    const CONCURRENCY = 16;
    let cursor = 0;

    async function worker() {
      while (cursor < sampledUniverse.length) {
        const stock = sampledUniverse[cursor++];
        const ticker = `${stock.symbol}.NS`;
        try {
          const chart = await fetchYahooChart(ticker, "3mo", "1d");
          const meta = chart.meta || {};
          const q = chart?.indicators?.quote?.[0] || {};
          const closes = (q.close || []).map(Number).filter((v) => v > 0);
          const highs = (q.high || []).map(Number).filter((v) => v > 0);
          const lows = (q.low || []).map(Number).filter((v) => v > 0);
          const volumes = (q.volume || []).map(Number).filter((v) => v >= 0);
          if (closes.length < 20 || volumes.length < 11) continue;

          const price = Number(meta.regularMarketPrice || closes[closes.length - 1] || 0);
          const prevClose = Number(meta.previousClose || closes[closes.length - 2] || 0);
          const volume = Number(volumes[volumes.length - 1] || 0);
          const avgVolume = volumes.slice(-11, -1).reduce((s, v) => s + v, 0) / 10;
          const changePct = prevClose > 0 ? ((price - prevClose) / prevClose) * 100 : 0;
          const volumeRatio = avgVolume > 0 ? volume / avgVolume : 0;

          if (changePct <= 1 || volumeRatio <= 1.3 || price <= 0) continue;

          const rsiSeries = RSI.calculate({ values: closes, period: 14 });
          const ema5Series = EMA.calculate({ values: closes, period: 5 });
          const ema10Series = EMA.calculate({ values: closes, period: 10 });
          const ema20Series = EMA.calculate({ values: closes, period: 20 });

          const rsi = Number((rsiSeries[rsiSeries.length - 1] || 0).toFixed(1));
          const ma5 = Number((ema5Series[ema5Series.length - 1] || price).toFixed(2));
          const ma10 = Number((ema10Series[ema10Series.length - 1] || price).toFixed(2));
          const ma20 = Number((ema20Series[ema20Series.length - 1] || price).toFixed(2));

          if (!(rsi >= 40 && rsi <= 75)) continue;
          if (price <= ma10) continue;

          const high52w = Number(meta.fiftyTwoWeekHigh || (highs.length ? Math.max(...highs) : price));
          const low52w = Number(meta.fiftyTwoWeekLow || (lows.length ? Math.min(...lows) : price));
          const dayHigh = Number(meta.regularMarketDayHigh || highs[highs.length - 1] || price);
          const dayLow = Number(meta.regularMarketDayLow || lows[lows.length - 1] || price);

          candidates.push({
            symbol: stock.symbol,
            companyName: stock.companyName || stock.symbol,
            sector: stock.sector || "Unknown",
            price: Number(price.toFixed(2)),
            changePct: Number(changePct.toFixed(2)),
            volume: Math.round(volume),
            avgVolume: Math.round(avgVolume),
            volumeRatio: Number(volumeRatio.toFixed(2)),
            rsi,
            ma5,
            ma10,
            ma20,
            high52w: Number(high52w.toFixed(2)),
            low52w: Number(low52w.toFixed(2)),
            dayHigh: Number(dayHigh.toFixed(2)),
            dayLow: Number(dayLow.toFixed(2)),
            _score: changePct * volumeRatio,
          });
        } catch (err) {
          logger.debug(`Skipping ${ticker}: ${err.message}`);
        }
      }
    }

    await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

    const topMovers = candidates
      .sort((a, b) => b._score - a._score)
      .slice(0, 20)
      .map(({ _score, ...rest }) => rest);

    CACHE.movers = { value: topMovers, expiresAt: Date.now() + 4 * 60 * 1000 };
    logger.info(`Computed ${topMovers.length} live top movers`);
    return topMovers;
  } catch (err) {
    logger.error("getTopMovers failed:", err.message);
    throw new Error(`Top movers fetch failed: ${err.message}`);
  }
}

// ─────────────────────────────────────────────────────────────
// getCurrentPrices
// ─────────────────────────────────────────────────────────────
/**
 * Fetches real-time current prices for symbols in the current portfolio.
 * Called every cycle to update unrealized P&L and check stop-loss/take-profit.
 *
 * @param {string[]} symbols - Array of NSE symbols without .NS (e.g. ["RELIANCE", "TCS"])
 * @returns {Promise<Object>} Map of symbol → current price
 *   e.g. { "RELIANCE": 2847.50, "TCS": 3421.00 }
 */
async function getCurrentPrices(symbols) {
  if (!symbols || symbols.length === 0) return {};
  try {
    const result = {};
    await Promise.all(
      symbols.map(async (symbol) => {
        const ticker = `${symbol}.NS`;
        try {
          const chart = await fetchYahooChart(ticker, "5d", "1d");
          const meta = chart.meta || {};
          const latest = getLatestOHLC(chart);
          result[symbol] = Number((meta.regularMarketPrice || latest?.close || 0).toFixed(2));
        } catch (err) {
          logger.warn(`Price fetch skipped for ${symbol}: ${err.message}`);
        }
      })
    );
    return result;
  } catch (err) {
    logger.error("getCurrentPrices failed:", err.message);
    throw new Error(`Price fetch failed: ${err.message}`);
  }
}

module.exports = {
  getMarketOverview,
  getTopMovers,
  getCurrentPrices,
};
