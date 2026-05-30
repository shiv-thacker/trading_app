/**
 * global_swing/analysis/news_rules.js
 * Per-stock EODHD news sentiment → relaxed entry thresholds (V2).
 *
 * Strong positive news extends RSI ceiling and lowers volume bar so
 * catalyst-driven movers can pass the 7-rule filter.
 */

const R = require("../config/trading_rules");

/**
 * @param {number|null|undefined} sentiment  EODHD normalized score (-1..+1)
 * @returns {{ volumeMin: number, rsiMax: number, scoreBonus: number }}
 */
function getNewsAdjustedRules(sentiment) {
  if (typeof sentiment !== "number" || sentiment <= R.NEWS_SENTIMENT_MILD) {
    return {
      volumeMin:  R.MIN_VOLUME_RATIO,
      rsiMax:     R.MAX_RSI_ENTRY,
      scoreBonus: 0,
    };
  }
  if (sentiment > R.NEWS_SENTIMENT_VERY) {
    return { volumeMin: 0.8, rsiMax: 70, scoreBonus: 4 };
  }
  if (sentiment > R.NEWS_SENTIMENT_STRONG) {
    return { volumeMin: 0.9, rsiMax: 68, scoreBonus: 3 };
  }
  return { volumeMin: 1.0, rsiMax: 66, scoreBonus: 2 };
}

/**
 * Resolve today's sentiment for a symbol from the batch map.
 * @param {Object} sentimentMap  { "AAPL.US": 0.76, ... }
 * @param {string} symbol
 * @returns {number|null}
 */
function lookupStockSentiment(sentimentMap, symbol) {
  if (!sentimentMap || typeof sentimentMap[symbol] !== "number") return null;
  return sentimentMap[symbol];
}

/**
 * Apply V2 news-adjusted RSI/volume fields onto indicators.
 * @param {Object} indicators
 * @param {number|null} sentiment
 * @returns {Object}
 */
function applyNewsToIndicators(indicators, sentiment) {
  const newsAdj = getNewsAdjustedRules(sentiment);
  return {
    ...indicators,
    newsSentiment:  sentiment,
    newsScoreBonus: newsAdj.scoreBonus,
    maxRsiEntry:    newsAdj.rsiMax,
    minVolumeRatio: newsAdj.volumeMin,
  };
}

/**
 * All 7 entry rules with optional news-relaxed RSI/volume (V2).
 */
function passesEntryFilter(indicators, changePct, indexTodayPct, sentiment) {
  const newsAdj = getNewsAdjustedRules(sentiment);
  const ind     = indicators;
  const chg     = changePct ?? ind.changePct ?? 0;
  const age     = ind.emaCrossoverDaysAgo;

  if (ind.trend !== "UPTREND" && ind.trend !== "UNKNOWN") return false;
  if (age !== null && age !== undefined && age > R.EMA_CROSSOVER_MAX_DAYS) return false;
  if (ind.rsi < R.MIN_RSI_ENTRY || ind.rsi > newsAdj.rsiMax) return false;
  if (ind.pctBelow52wHigh < R.MAX_52W_HIGH_DIST_PCT) return false;
  if (ind.volumeRatio < newsAdj.volumeMin) return false;
  if (chg < R.MIN_CHANGE_PCT || chg > R.MAX_CHANGE_PCT) return false;
  if (typeof indexTodayPct === "number" && chg <= indexTodayPct) return false;
  return true;
}

module.exports = {
  getNewsAdjustedRules,
  lookupStockSentiment,
  applyNewsToIndicators,
  passesEntryFilter,
};
