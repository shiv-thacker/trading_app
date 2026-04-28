/**
 * functions/market_data.js
 * ========================
 * Firebase-only market data provider — powered entirely by NSE India's own APIs.
 *
 * WHY NSE APIS instead of Yahoo Finance:
 *   Yahoo Finance's REST API blocks Google Cloud Platform (GCP) IPs with 403.
 *   NSE India's own public API endpoints work from cloud servers, return live
 *   data for all 500 Nifty 500 stocks in a single request, and need no auth.
 *
 * DATA SOURCES:
 *   getMarketOverview()    → GET /api/allIndices          (Nifty indices)
 *   getTopMovers()         → GET /api/equity-stockIndices  (all 500 stocks)
 *   getCurrentPrices(syms) → cached Nifty500 data, individual fallback
 *
 * CACHING:
 *   getMarketOverview: 1 minute
 *   getTopMovers:      4 minutes
 *   getCurrentPrices:  no cache
 */

const axios  = require("axios");
const logger = require("firebase-functions/logger");

// ─────────────────────────────────────────────────────────────
// Shared HTTP client + NSE headers
// ─────────────────────────────────────────────────────────────

const NSE_HEADERS = {
  "User-Agent":      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
                     "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept":          "application/json, text/plain, */*",
  "Accept-Language": "en-IN,en;q=0.9",
  "Referer":         "https://www.nseindia.com/",
  "Origin":          "https://www.nseindia.com",
};

const nseClient = axios.create({ timeout: 15000, headers: NSE_HEADERS });

// ─────────────────────────────────────────────────────────────
// Cache
// ─────────────────────────────────────────────────────────────

const CACHE = {
  overview:  { value: null, expiresAt: 0 },
  movers:    { value: null, expiresAt: 0 },
  // nifty500 data is shared between getTopMovers and getCurrentPrices
  nifty500:  { value: null, expiresAt: 0 },
};

function isFresh(entry) {
  return entry.value !== null && Date.now() < entry.expiresAt;
}

function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

// ─────────────────────────────────────────────────────────────
// Core NSE fetch with retry
// ─────────────────────────────────────────────────────────────

async function nseGet(path) {
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const { data } = await nseClient.get(`https://www.nseindia.com${path}`);
      return data;
    } catch (err) {
      lastErr = err;
      const status = err?.response?.status;
      if (status === 404 || status === 400) throw err;   // non-retryable
      if (attempt < 3) await sleep(400 * attempt);
    }
  }
  throw lastErr;
}

// ─────────────────────────────────────────────────────────────
// getMarketOverview
// ─────────────────────────────────────────────────────────────
/**
 * Returns live Nifty index levels and market mood.
 *
 * @returns {Promise<Object>}
 *   { nifty50, niftyBank, niftyIT, niftyPharma, niftyAuto, niftyEnergy, marketMood }
 *   Each index: { price: number, changePct: number }
 */
async function getMarketOverview() {
  try {
    if (isFresh(CACHE.overview)) return CACHE.overview.value;
    logger.info("Fetching market overview from NSE allIndices...");

    const data = await nseGet("/api/allIndices");
    const list = data?.data || [];

    const WANTED = {
      "NIFTY 50":     "nifty50",
      "NIFTY BANK":   "niftyBank",
      "NIFTY IT":     "niftyIT",
      "NIFTY PHARMA": "niftyPharma",
      "NIFTY AUTO":   "niftyAuto",
      "NIFTY ENERGY": "niftyEnergy",
    };

    const result = {};
    for (const item of list) {
      const key = WANTED[item.index];
      if (!key) continue;
      result[key] = {
        price:     Number((item.last          || 0).toFixed(2)),
        changePct: Number((item.percentChange || 0).toFixed(2)),
      };
    }

    // Fill any missing indices with zeros
    for (const key of Object.values(WANTED)) {
      if (!result[key]) result[key] = { price: 0, changePct: 0 };
    }

    const niftyChange = result.nifty50.changePct;
    let marketMood = "NEUTRAL";
    if (Math.abs(niftyChange) > 1.5) marketMood = "VOLATILE";
    else if (niftyChange > 0.5)      marketMood = "BULLISH";
    else if (niftyChange < -0.5)     marketMood = "BEARISH";

    result.marketMood = marketMood;
    CACHE.overview = { value: result, expiresAt: Date.now() + 60_000 };
    return result;
  } catch (err) {
    logger.error("getMarketOverview failed:", err.message);
    throw new Error(`Market overview fetch failed: ${err.message}`);
  }
}

// ─────────────────────────────────────────────────────────────
// Fetch all Nifty 500 stocks (shared between getTopMovers / getCurrentPrices)
// ─────────────────────────────────────────────────────────────

async function fetchNifty500() {
  if (isFresh(CACHE.nifty500)) return CACHE.nifty500.value;
  logger.info("Fetching Nifty 500 stocks from NSE...");

  const data  = await nseGet("/api/equity-stockIndices?index=NIFTY%20500");
  const stocks = (data?.data || []).filter((s) => s.symbol && s.symbol !== "NIFTY 500");

  CACHE.nifty500 = { value: stocks, expiresAt: Date.now() + 4 * 60_000 };
  return stocks;
}

// ─────────────────────────────────────────────────────────────
// getTopMovers
// ─────────────────────────────────────────────────────────────
/**
 * Returns the live top 20 NSE momentum stocks from the Nifty 500 universe.
 * Uses a single NSE batch API call (no per-stock requests).
 *
 * Scoring: pChange × totalTradedVolume (volume-weighted momentum)
 * Filters:
 *   - pChange > 1.5%         (stock moving up today)
 *   - totalTradedVolume > 50,000   (liquid enough to trade)
 *   - lastPrice > 20         (not a penny stock)
 *   - lastPrice > previousClose    (positive close vs open)
 *
 * @returns {Promise<Array>} Up to 20 objects with live stock data
 */
async function getTopMovers() {
  try {
    if (isFresh(CACHE.movers)) return CACHE.movers.value;
    logger.info("Computing top movers from Nifty 500 data...");

    const stocks = await fetchNifty500();

    const candidates = [];
    for (const s of stocks) {
      const price     = Number(s.lastPrice          || 0);
      const prevClose = Number(s.previousClose      || 0);
      const changePct = Number(s.pChange            || 0);
      const volume    = Number(s.totalTradedVolume  || 0);
      const dayHigh   = Number(s.dayHigh            || price);
      const dayLow    = Number(s.dayLow             || price);
      const yearHigh  = Number(s.yearHigh           || price);
      const yearLow   = Number(s.yearLow            || price);

      // Momentum filters
      if (changePct  <= 1.5)    continue;
      if (volume     <= 50000)  continue;
      if (price      <= 20)     continue;
      if (prevClose > 0 && price <= prevClose) continue;

      candidates.push({
        symbol:      s.symbol,
        companyName: s.symbol,          // NSE batch doesn't include company name
        sector:      "NSE",
        price:       Number(price.toFixed(2)),
        changePct:   Number(changePct.toFixed(2)),
        volume:      Math.round(volume),
        dayHigh:     Number(dayHigh.toFixed(2)),
        dayLow:      Number(dayLow.toFixed(2)),
        high52w:     Number(yearHigh.toFixed(2)),
        low52w:      Number(yearLow.toFixed(2)),
        _score:      changePct * Math.log1p(volume), // log-scale volume to avoid mega-caps dominating
      });
    }

    const topMovers = candidates
      .sort((a, b) => b._score - a._score)
      .slice(0, 20)
      .map(({ _score, ...rest }) => rest);

    CACHE.movers = { value: topMovers, expiresAt: Date.now() + 4 * 60_000 };
    logger.info(`Computed ${topMovers.length} live top movers from Nifty 500`);
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
 * First checks the Nifty 500 cache; falls back to individual NSE quote API.
 *
 * @param {string[]} symbols - NSE symbols (e.g. ["RELIANCE", "TCS"])
 * @returns {Promise<Object>} { RELIANCE: 1381.60, TCS: 3421.00, ... }
 */
async function getCurrentPrices(symbols) {
  if (!symbols || symbols.length === 0) return {};

  try {
    // Try to serve from the Nifty 500 batch cache first (much faster)
    let stockMap = {};
    if (isFresh(CACHE.nifty500)) {
      for (const s of CACHE.nifty500.value) {
        stockMap[s.symbol] = Number((s.lastPrice || 0).toFixed(2));
      }
    }

    const result   = {};
    const missing  = [];
    for (const sym of symbols) {
      if (stockMap[sym] !== undefined) {
        result[sym] = stockMap[sym];
      } else {
        missing.push(sym);
      }
    }

    // For any holdings not in Nifty 500 cache, call individual endpoint
    await Promise.all(
      missing.map(async (symbol) => {
        try {
          const data  = await nseGet(`/api/quote-equity?symbol=${encodeURIComponent(symbol)}`);
          result[symbol] = Number((data?.priceInfo?.lastPrice || 0).toFixed(2));
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

module.exports = { getMarketOverview, getTopMovers, getCurrentPrices };
