/**
 * global_swing/analysis/market_mood.js
 * =======================================
 * Determines if each market is BULLISH, BEARISH, or NEUTRAL.
 * This drives the "invest only in bullish markets" strategy.
 *
 * HOW MOOD IS COMPUTED (3-signal blend):
 *
 *   Market OPEN:
 *     score = (5-day index trend × 50%) + (today's live % × 30%) + (news sentiment × 20%)
 *
 *   Market CLOSED (pre-market / after-hours):
 *     score = (5-day index trend × 65%) + (news sentiment × 35%)
 *     → "today %" is stale when closed, so we lean on sentiment instead
 *
 *   BULLISH  → score > threshold (set in trading_rules.js)
 *   BEARISH  → score < threshold
 *   NEUTRAL  → in between
 *
 * SENTIMENT SOURCE:
 *   EODHD /api/sentiments endpoint — 3 proxy stocks per market averaged.
 *   Returns a normalized -1 to +1 score from news + social media.
 *   Cached 1 hour. Non-fatal if unavailable (falls back to price-only).
 *
 *   India (NSE): Reliance, TCS, HDFC Bank
 *   USA:         SPY ETF, Apple, Microsoft
 *   Germany:     SAP, Siemens, BMW
 *   Japan:       Toyota, Sony, SoftBank
 *
 * MARKET OPEN CHECK:
 *   Uses each exchange's local timezone (from markets.js).
 *   An exchange that is CLOSED cannot receive new positions.
 *   Mood is still computed for closed markets (useful for planning).
 */

const { getLiveIndex, getAllMarketSentiments } = require("../data/eodhd_live");
const { getNSENiftyIndex }                    = require("../data/nse_live");
const { getHistoricalCandles }                = require("../data/eodhd_history");
const { MARKETS }                             = require("../config/markets");
const R                                       = require("../config/trading_rules");
const logger                                  = require("firebase-functions/logger");

/**
 * Check if a given market (by code) is currently open.
 * Uses the exchange's local timezone and trading hours from markets.js.
 *
 * Uses Intl.DateTimeFormat.formatToParts() — NOT toLocaleString() string parsing.
 * toLocaleString() output format varies across Node.js versions and Linux ICU builds
 * (e.g. "Mon, 09:30" vs "Mon 09:30"), causing unreliable comma-split parsing on GCP.
 * formatToParts() returns named tokens directly, works on all runtimes.
 *
 * @param {string} marketCode - "NSE" | "US" | "XETRA" | "T"
 * @returns {boolean}
 */
function isMarketOpen(marketCode) {
  const market = MARKETS[marketCode];
  if (!market) return false;

  const now       = new Date();
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: market.timezone,
    weekday:  "short",
    hour:     "2-digit",
    minute:   "2-digit",
    hour12:   false,
  });

  // formatToParts gives unambiguous named tokens — no string parsing needed
  const partsArr = formatter.formatToParts(now);
  const get      = (type) => partsArr.find(p => p.type === type)?.value ?? "";

  const weekday  = get("weekday");                      // "Mon" | "Sat" | "Sun" ...
  const localHour = parseInt(get("hour"),   10);        // 0–23
  const localMin  = parseInt(get("minute"), 10);        // 0–59
  const localMins = localHour * 60 + localMin;

  if (weekday === "Sat" || weekday === "Sun") return false;

  const [oh, om] = market.openTimeLocal.split(":").map(Number);
  const [ch, cm] = market.closeTimeLocal.split(":").map(Number);

  const isOpen = localMins >= (oh * 60 + om) && localMins < (ch * 60 + cm);

  // Japan TSE has a lunch break 11:30–12:30 JST — no trading during that window
  if (isOpen && marketCode === "T") {
    const lunchStart = 11 * 60 + 30;
    const lunchEnd   = 12 * 60 + 30;
    if (localMins >= lunchStart && localMins < lunchEnd) return false;
  }

  return isOpen;
}

/**
 * Compute the mood for a single market.
 * Blends 5-day price trend + today's live % + news sentiment into one score.
 *
 * When the market is CLOSED, "today %" is stale so we use sentiment instead:
 *   OPEN  → 50% 5d trend + 30% today % + 20% sentiment
 *   CLOSED→ 65% 5d trend + 35% sentiment
 *
 * @param {string}      marketCode - "NSE" | "US" | "XETRA" | "T"
 * @param {number|null} sentiment  - Pre-fetched sentiment (-1 to +1), or null
 * @returns {Promise<Object>} Full mood object with score, status, prices
 */
async function getMarketMood(marketCode, sentiment = null) {
  const market = MARKETS[marketCode];
  if (!market) throw new Error(`Unknown market code: ${marketCode}`);

  const isOpen          = isMarketOpen(marketCode);
  let   todayChangePct  = 0;
  let   fiveDayChangePct = 0;
  let   indexPrice      = 0;

  // ── Fetch live index + 5-day history in parallel ─────────────
  const [liveResult, historyResult] = await Promise.allSettled([
    (async () => {
      if (marketCode === "NSE" && market.useNSELiveFallback) {
        const nseData = await getNSENiftyIndex();
        if (nseData && nseData.price > 0) return nseData;
      }
      return await getLiveIndex(market.indexSymbol);
    })(),
    getHistoricalCandles(market.indexSymbol),
  ]);

  if (liveResult.status === "fulfilled" && liveResult.value) {
    const live = liveResult.value;
    todayChangePct = Number((live.changePct || 0).toFixed(2));
    indexPrice     = Number((live.price     || 0).toFixed(2));
  } else {
    logger.warn(`Market mood: live index unavailable for ${marketCode}`);
  }

  if (historyResult.status === "fulfilled" && Array.isArray(historyResult.value)) {
    const candles = historyResult.value;
    if (candles.length >= 6) {
      const slice  = candles.slice(-6);
      const oldest = Number(slice[0].close);
      const newest = Number(slice[slice.length - 1].close);
      if (oldest > 0) {
        fiveDayChangePct = Math.round(((newest - oldest) / oldest) * 100 * 100) / 100;
      }
    }
  } else {
    logger.warn(`Market mood: history unavailable for ${marketCode}`);
  }

  // ── 3-signal score ────────────────────────────────────────────
  // Sentiment is on a -1..+1 scale; price % is on a -5..+5 typical range.
  // Normalise sentiment to the same rough scale: multiply by 5 so ±1 sentiment
  // contributes roughly the same weight as a ±5% price move.
  const sentimentScaled = typeof sentiment === "number" ? sentiment * 5 : null;
  const hasSentiment    = sentimentScaled !== null;

  let score;
  if (isOpen) {
    // OPEN: live data + sentiment
    const w5d   = hasSentiment ? R.MOOD_WEIGHT_5D_OPEN        : 0.60;
    const wDay  = hasSentiment ? R.MOOD_WEIGHT_TODAY_OPEN      : 0.40;
    const wSent = hasSentiment ? R.MOOD_WEIGHT_SENTIMENT_OPEN  : 0;
    score = Math.round(
      (fiveDayChangePct * w5d + todayChangePct * wDay + (sentimentScaled || 0) * wSent) * 100
    ) / 100;
  } else {
    // CLOSED: "today %" is stale — lean on sentiment for the dynamic portion
    const w5d   = hasSentiment ? R.MOOD_WEIGHT_5D_CLOSED        : 1.0;
    const wSent = hasSentiment ? R.MOOD_WEIGHT_SENTIMENT_CLOSED  : 0;
    score = Math.round(
      (fiveDayChangePct * w5d + (sentimentScaled || 0) * wSent) * 100
    ) / 100;
  }

  // ── Classify ─────────────────────────────────────────────────
  // Primary signal: 5-day trend
  // Secondary: today % (if open) or sentiment (if closed) can flip a borderline neutral
  const sentimentPositive = hasSentiment && sentiment  >  R.SENTIMENT_BULLISH_THRESHOLD;
  const sentimentNegative = hasSentiment && sentiment  <  R.SENTIMENT_BEARISH_THRESHOLD;

  let mood;
  if (fiveDayChangePct >= R.BULLISH_INDEX_5D_PCT) {
    mood = "BULLISH";
  } else if (fiveDayChangePct <= R.BEARISH_INDEX_5D_PCT) {
    mood = "BEARISH";
  } else if (isOpen && todayChangePct >= R.BULLISH_TODAY_PCT * 2) {
    mood = "BULLISH";
  } else if (isOpen && todayChangePct <= R.BEARISH_TODAY_PCT * 2) {
    mood = "BEARISH";
  } else if (sentimentPositive) {
    // Market closed or neutral price trend — positive news tips it bullish
    mood = "BULLISH";
  } else if (sentimentNegative) {
    mood = "BEARISH";
  } else {
    mood = "NEUTRAL";
  }

  const sentimentLabel = hasSentiment
    ? `sentiment=${sentiment > 0 ? "+" : ""}${sentiment.toFixed(3)}`
    : "sentiment=n/a";

  logger.info(
    `Market mood [${market.flag} ${marketCode}]: ${mood} | ` +
    `today=${todayChangePct > 0 ? "+" : ""}${todayChangePct}% | ` +
    `5d=${fiveDayChangePct > 0 ? "+" : ""}${fiveDayChangePct}% | ` +
    `${sentimentLabel} | score=${score} | open=${isOpen}`
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
    sentiment:        hasSentiment ? sentiment : null,
    score,
  };
}

/**
 * Evaluate all configured markets and return their mood objects.
 * Fetches EODHD sentiment for all 4 markets in ONE batch call first,
 * then runs all 4 market mood calculations in parallel (with sentiment passed in).
 *
 * @returns {Promise<Object>} Map: { NSE: {...}, US: {...}, XETRA: {...}, T: {...} }
 */
async function getAllMarketMoods() {
  // Fetch sentiment for all 4 markets in one API call (non-fatal)
  let sentiments = {};
  try {
    sentiments = await getAllMarketSentiments();
  } catch (err) {
    logger.warn("Sentiment batch fetch failed — proceeding without sentiment:", err.message);
  }

  const codes   = Object.keys(MARKETS);
  const settled = await Promise.allSettled(
    codes.map(code => getMarketMood(code, sentiments[code] ?? null))
  );

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
