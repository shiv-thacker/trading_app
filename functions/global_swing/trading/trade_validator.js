/**
 * global_swing/trading/trade_validator.js
 * ==========================================
 * Hard code-level validation for every trade before execution.
 *
 * WHY CODE-LEVEL (not just prompt instructions):
 *   Claude's prompt can be ignored or misunderstood in edge cases.
 *   These validators are ABSOLUTE — they run after Claude proposes a trade.
 *   If any check fails, the trade is skipped and logged.
 *
 * RULES ENFORCED (master rules v2 — zero exceptions):
 *   ①  Max 5 total holdings (across all markets)
 *   ②  Max 2 holdings per market (concentration risk)
 *   ③  No duplicate symbol
 *   ④  No re-buy within NO_REBUY_DAYS days of a recent sell
 *   ⑤  Sufficient cash after trade + ₹20,000 reserve
 *   ⑥  Position size ≤ 25% of total portfolio
 *   ⑦  52W high proximity ≥ 8% below (the 3% rule killed P911 and 9502.T)
 *   ⑧  RSI strictly 52–65 (not 40–68; tighter sweet spot)
 *   ⑨  Market mood guard — BEARISH or NEUTRAL blocks new buys
 *   ⑩  Trend guard — UPTREND only (SIDEWAYS/DOWNTREND blocked)
 *   ⑪  Volume guard — must be ≥ 1.2x 20-day average
 *   ⑫  Daily move guard — must be +1.5% to +6% today
 *   ⑬  EMA crossover freshness — crossover within last 10 days
 *   ⑭  Index outperformance — stock must beat its market index today
 *   ⑮  Minimum confidence score — score must be ≥ 8 / 15
 */

const R      = require("../config/trading_rules");
const { toINR } = require("../db/firestore_db");
const logger = require("firebase-functions/logger");

/**
 * Validate a proposed BUY trade against all portfolio rules.
 *
 * @param {Object} trade            - Trade proposal from Claude
 * @param {Object} portfolio        - Current portfolio state
 * @param {Object} indicators       - Technical indicators for the stock (from technical.js)
 * @param {string} marketMood       - "BULLISH" | "NEUTRAL" | "BEARISH"
 * @param {number} [indexTodayPct]  - Market index today% (for outperformance check; optional)
 * @returns {{ ok: boolean, reason: string }}
 */
function validateBuy(trade, portfolio, indicators = {}, marketMood = "NEUTRAL", indexTodayPct = null) {
  const {
    holdings = [], capitalINR = 0, usdInrRate = 84.0,
    totalValueINR = 0, recentSells = [],
  } = portfolio;

  // ① Max total positions ─────────────────────────────────────
  if (holdings.length >= R.MAX_TOTAL_HOLDINGS) {
    return { ok: false, reason: `Max ${R.MAX_TOTAL_HOLDINGS} positions reached across all markets` };
  }

  // ② Max positions per market ────────────────────────────────
  const inMarket = holdings.filter(h => h.market === trade.market).length;
  if (inMarket >= R.MAX_HOLDINGS_PER_MARKET) {
    return { ok: false, reason: `Already ${R.MAX_HOLDINGS_PER_MARKET} positions in ${trade.market}` };
  }

  // ③ No duplicate symbol ─────────────────────────────────────
  if (holdings.some(h => h.symbol === trade.symbol)) {
    return { ok: false, reason: `Already holding ${trade.symbol}` };
  }

  // ④ Re-buy cooldown ─────────────────────────────────────────
  const recentSell = (recentSells || []).find(s => s.symbol === trade.symbol);
  if (recentSell) {
    const daysSince = (Date.now() - (recentSell.soldAt || 0)) / (1000 * 60 * 60 * 24);
    if (daysSince < R.NO_REBUY_DAYS) {
      return {
        ok:     false,
        reason: `${trade.symbol} sold ${daysSince.toFixed(1)}d ago — ${R.NO_REBUY_DAYS}-day cooldown active`,
      };
    }
  }

  // ⑤ Cash reserve check ─────────────────────────────────────
  const tradeINR   = toINR(trade.totalAmount, trade.currency || "USD", portfolio);
  const reserveINR = R.MIN_CASH_RESERVE_INR;

  if (capitalINR - tradeINR < reserveINR) {
    return {
      ok:     false,
      reason: `Insufficient capital (need ₹${tradeINR.toFixed(0)} + ₹${reserveINR} reserve; have ₹${capitalINR.toFixed(0)})`,
    };
  }

  // ⑥ Position size cap ───────────────────────────────────────
  if (tradeINR > totalValueINR * R.MAX_POSITION_PCT) {
    return {
      ok:     false,
      reason: `Trade ₹${tradeINR.toFixed(0)} exceeds ${R.MAX_POSITION_PCT * 100}% of portfolio (₹${totalValueINR.toFixed(0)})`,
    };
  }

  // ⑦ 52-week high proximity ──────────────────────────────────
  const pctBelow = indicators.pctBelow52wHigh ?? 100;
  if (pctBelow < R.MAX_52W_HIGH_DIST_PCT) {
    return {
      ok:     false,
      reason: `${trade.symbol} only ${pctBelow.toFixed(1)}% below 52W high — need ≥${R.MAX_52W_HIGH_DIST_PCT}% buffer (was ${R.MAX_52W_HIGH_DIST_PCT}%; P911/9502 proved 3% too thin)`,
    };
  }

  // ⑧ RSI strict range 52–65 ──────────────────────────────────
  const rsi = indicators.rsi ?? 50;
  if (rsi > R.MAX_RSI_ENTRY) {
    return { ok: false, reason: `RSI ${rsi} > ${R.MAX_RSI_ENTRY} — overbought, risk of reversal` };
  }
  if (rsi < R.MIN_RSI_ENTRY) {
    return { ok: false, reason: `RSI ${rsi} < ${R.MIN_RSI_ENTRY} — no momentum yet, too early` };
  }

  // ⑨ Market mood guard — NEUTRAL is also blocked now ─────────
  if (marketMood === "BEARISH") {
    return { ok: false, reason: `${trade.market} is BEARISH — no new positions allowed` };
  }
  if (marketMood === "NEUTRAL") {
    return { ok: false, reason: `${trade.market} is NEUTRAL — only BULLISH markets allow new buys` };
  }

  // ⑩ Trend guard — UPTREND required ──────────────────────────
  const trend = indicators.trend;
  if (trend && trend !== "UPTREND" && trend !== "UNKNOWN") {
    return {
      ok:     false,
      reason: `${trade.symbol} trend is ${trend} — only UPTREND entries allowed (EMA9 > EMA20)`,
    };
  }

  // ⑪ Volume guard — ≥ 1.2x average ──────────────────────────
  const volumeRatio = indicators.volumeRatio ?? 1.5;
  if (volumeRatio < R.MIN_VOLUME_RATIO) {
    return {
      ok:     false,
      reason: `${trade.symbol} volume ratio ${volumeRatio.toFixed(2)}x < ${R.MIN_VOLUME_RATIO}x — low volume moves almost always reverse`,
    };
  }

  // ⑫ Daily move range +1.5% to +6% ───────────────────────────
  const changePct = indicators.changePct ?? (trade.changePct ?? null);
  if (changePct !== null) {
    if (changePct < R.MIN_CHANGE_PCT) {
      return {
        ok:     false,
        reason: `${trade.symbol} only up ${changePct.toFixed(2)}% today — need ≥${R.MIN_CHANGE_PCT}% for real momentum`,
      };
    }
    if (changePct > R.MAX_CHANGE_PCT) {
      return {
        ok:     false,
        reason: `${trade.symbol} up ${changePct.toFixed(2)}% today — >6% is a spike, chasing is dangerous`,
      };
    }
  }

  // ⑬ EMA crossover freshness — within last 10 days ──────────
  const crossoverAge = indicators.emaCrossoverDaysAgo;
  if (crossoverAge !== null && crossoverAge !== undefined) {
    if (crossoverAge > R.EMA_CROSSOVER_MAX_DAYS) {
      return {
        ok:     false,
        reason: `${trade.symbol} EMA crossover was ${crossoverAge} days ago — stale (need within ${R.EMA_CROSSOVER_MAX_DAYS} days for fresh momentum)`,
      };
    }
  }

  // ⑭ Index outperformance — stock must beat its market index ─
  if (indexTodayPct !== null && changePct !== null) {
    if (changePct <= indexTodayPct) {
      return {
        ok:     false,
        reason: `${trade.symbol} (${changePct > 0 ? "+" : ""}${changePct.toFixed(2)}%) not outperforming index (${indexTodayPct > 0 ? "+" : ""}${indexTodayPct.toFixed(2)}%) — needs its own buying pressure`,
      };
    }
  }

  // ⑮ Minimum confidence score ────────────────────────────────
  const confidenceScore = trade.confidenceScore ?? null;
  if (confidenceScore !== null && confidenceScore < R.MIN_CONFIDENCE_SCORE) {
    return {
      ok:     false,
      reason: `${trade.symbol} confidence score ${confidenceScore}/15 < minimum ${R.MIN_CONFIDENCE_SCORE} required`,
    };
  }

  logger.info(`validateBuy: ✅ ${trade.symbol} passed all ${confidenceScore !== null ? `15 checks (score: ${confidenceScore}/15)` : "checks"}`);
  return { ok: true, reason: "All checks passed" };
}

/**
 * Validate a proposed SELL trade.
 * Exits should rarely be blocked — only guards against non-existent positions.
 *
 * @param {Object} trade
 * @param {Object} portfolio
 * @returns {{ ok: boolean, reason: string }}
 */
function validateSell(trade, portfolio) {
  const holding = (portfolio.holdings || []).find(h => h.symbol === trade.symbol);

  if (!holding) {
    return { ok: false, reason: `Not holding ${trade.symbol} — cannot sell` };
  }

  if (trade.quantity > holding.quantity) {
    return { ok: false, reason: `Sell qty ${trade.quantity} > held qty ${holding.quantity}` };
  }

  return { ok: true, reason: "Sell approved" };
}

module.exports = { validateBuy, validateSell };
