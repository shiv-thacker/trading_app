/**
 * global_swing/analysis/market_mood.js
 * =======================================
 * Determines if each market is BULLISH, BEARISH, or NEUTRAL.
 * This drives the "invest only in bullish markets" strategy.
 *
 * HOW MOOD IS COMPUTED:
 *   Combined score = (5-day index trend × 60%) + (today's change × 40%)
 *   BULLISH  → score > threshold (set in trading_rules.js)
 *   BEARISH  → score < threshold
 *   NEUTRAL  → in between
 *
 *   India (NSE): Nifty 50 via NSE direct (real-time) + EODHD history
 *   Others:      EODHD /real-time/{indexSymbol} + EODHD history
 *
 * MARKET OPEN CHECK:
 *   Uses each exchange's local timezone (from markets.js).
 *   An exchange that is CLOSED cannot receive new positions.
 *   Mood is still computed for closed markets (useful for planning).
 */

const { getLiveIndex }          = require("../data/eodhd_live");
const { getNSENiftyIndex }      = require("../data/nse_live");
const { getHistoricalCandles }  = require("../data/eodhd_history");
const { MARKETS }               = require("../config/markets");
const R                         = require("../config/trading_rules");
const logger                    = require("firebase-functions/logger");

/**
 * Check if a given market (by code) is currently open.
 * Uses the exchange's local timezone and trading hours from markets.js.
 *
 * @param {string} marketCode - "NSE" | "US" | "XETRA" | "T"
 * @returns {boolean}
 */
function isMarketOpen(marketCode) {
  const market = MARKETS[marketCode];
  if (!market) return false;

  const now      = new Date();
  const options  = {
    timeZone: market.timezone,
    hour12:   false,
    weekday:  "short",
    hour:     "2-digit",
    minute:   "2-digit",
  };

  // toLocaleString in en-US with short weekday returns "Mon, 09:30"
  const localStr = now.toLocaleString("en-US", options);
  const parts    = localStr.split(", ");
  const weekday  = parts[0];                             // "Mon"
  const timePart = parts[1] || "00:00";
  const [hStr, mStr] = timePart.split(":");
  const localHour = parseInt(hStr, 10);
  const localMin  = parseInt(mStr, 10);
  const localMins = localHour * 60 + localMin;

  if (weekday === "Sat" || weekday === "Sun") return false;

  const [oh, om] = market.openTimeLocal.split(":").map(Number);
  const [ch, cm] = market.closeTimeLocal.split(":").map(Number);

  return localMins >= (oh * 60 + om) && localMins < (ch * 60 + cm);
}

/**
 * Compute the mood for a single market.
 * Fetches live index + 5-day history in parallel for speed.
 *
 * @param {string} marketCode
 * @returns {Promise<Object>} Full mood object with score, status, prices
 */
async function getMarketMood(marketCode) {
  const market = MARKETS[marketCode];
  if (!market) throw new Error(`Unknown market code: ${marketCode}`);

  const isOpen        = isMarketOpen(marketCode);
  let   todayChangePct  = 0;
  let   fiveDayChangePct = 0;
  let   indexPrice      = 0;

  // ── Fetch live index + 5-day history in parallel ─────────────
  const [liveResult, historyResult] = await Promise.allSettled([
    // Live index — India tries NSE first
    (async () => {
      if (marketCode === "NSE" && market.useNSELiveFallback) {
        const nseData = await getNSENiftyIndex();
        if (nseData && nseData.price > 0) return nseData;
      }
      return await getLiveIndex(market.indexSymbol);
    })(),

    // 5-day trend from EOD history
    getHistoricalCandles(market.indexSymbol),
  ]);

  // Process live result
  if (liveResult.status === "fulfilled" && liveResult.value) {
    const live = liveResult.value;
    todayChangePct = Number((live.changePct || 0).toFixed(2));
    indexPrice     = Number((live.price     || 0).toFixed(2));
  } else {
    logger.warn(`Market mood: live index unavailable for ${marketCode}`);
  }

  // Process 5-day history
  if (historyResult.status === "fulfilled" && Array.isArray(historyResult.value)) {
    const candles = historyResult.value;
    if (candles.length >= 6) {
      const slice  = candles.slice(-6); // 6 candles → 5 daily changes
      const oldest = Number(slice[0].close);
      const newest = Number(slice[slice.length - 1].close);
      if (oldest > 0) {
        fiveDayChangePct = Math.round(((newest - oldest) / oldest) * 100 * 100) / 100;
      }
    }
  } else {
    logger.warn(`Market mood: history unavailable for ${marketCode}`);
  }

  // ── Score and classify ───────────────────────────────────────
  // Weight: 60% from 5-day trend + 40% from today's move
  const score = Math.round(
    (fiveDayChangePct * 0.60 + todayChangePct * 0.40) * 100
  ) / 100;

  let mood;
  if (fiveDayChangePct >= R.BULLISH_INDEX_5D_PCT || todayChangePct >= R.BULLISH_TODAY_PCT * 2) {
    mood = "BULLISH";
  } else if (fiveDayChangePct <= R.BEARISH_INDEX_5D_PCT || todayChangePct <= R.BEARISH_TODAY_PCT * 2) {
    mood = "BEARISH";
  } else {
    mood = "NEUTRAL";
  }

  logger.info(
    `Market mood [${market.flag} ${marketCode}]: ${mood} | ` +
    `today=${todayChangePct > 0 ? "+" : ""}${todayChangePct}% | ` +
    `5d=${fiveDayChangePct > 0 ? "+" : ""}${fiveDayChangePct}% | ` +
    `open=${isOpen}`
  );

  return {
    marketCode,
    name:             market.name,
    flag:             market.flag,
    country:          market.country,
    currency:         market.currency,
    isOpen,
    mood,
    indexSymbol:      market.indexSymbol,
    indexPrice,
    todayChangePct,
    fiveDayChangePct,
    score,
  };
}

/**
 * Evaluate all configured markets and return their mood objects.
 * Runs all 4 markets in parallel (faster than sequential).
 *
 * @returns {Promise<Object>} Map: { NSE: {...}, US: {...}, XETRA: {...}, T: {...} }
 */
async function getAllMarketMoods() {
  const codes   = Object.keys(MARKETS);
  const settled = await Promise.allSettled(codes.map(code => getMarketMood(code)));

  const moods = {};
  for (const r of settled) {
    if (r.status === "fulfilled" && r.value) {
      moods[r.value.marketCode] = r.value;
    } else {
      logger.warn("Market mood fetch failed for one market:", r.reason?.message);
    }
  }
  return moods;
}

/**
 * From the full mood map, return only markets that are OPEN AND BULLISH.
 * These are the ONLY markets where new BUY positions are allowed.
 * Sorted descending by score (strongest bull market first).
 *
 * @param {Object} moods - Output of getAllMarketMoods()
 * @returns {Array}      - Array of mood objects for open+bullish markets
 */
function selectBullishOpenMarkets(moods) {
  return Object.values(moods)
    .filter(m => m.isOpen && m.mood === "BULLISH")
    .sort((a, b) => b.score - a.score);
}

/**
 * Rank ALL markets by mood score (strongest first).
 * Used in prompts so ARJUN compares India vs Japan vs Germany vs USA every cycle.
 *
 * @param {Object} moods - Output of getAllMarketMoods()
 * @returns {Array}      - All mood objects sorted by score descending
 */
function rankAllMarkets(moods) {
  return Object.values(moods).sort((a, b) => b.score - a.score);
}

module.exports = {
  getMarketMood,
  getAllMarketMoods,
  selectBullishOpenMarkets,
  rankAllMarkets,
  isMarketOpen,
};
