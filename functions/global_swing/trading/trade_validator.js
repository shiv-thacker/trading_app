/**
 * global_swing/trading/trade_validator.js
 * ==========================================
 * Hard code-level validation for every trade before execution.
 *
 * WHY CODE-LEVEL (not just prompt instructions):
 *   Claude's prompt can be ignored or misunderstood in edge cases.
 *   These validators are ABSOLUTE — they run after Claude proposes a trade.
 *   If any check fails, the trade is silently skipped and logged.
 *
 * RULES ENFORCED HERE:
 *   ① Max 5 total holdings (across all markets)
 *   ② Max 2 holdings per market (concentration risk)
 *   ③ No duplicate symbol
 *   ④ No re-buy within NO_REBUY_DAYS days of a profitable sell
 *   ⑤ Sufficient cash after trade + reserve
 *   ⑥ Position size ≤ 25% of total portfolio
 *   ⑦ 52W high proximity guard — pctBelow52wHigh must be ≥ 3% (THE COFORGE RULE)
 *   ⑧ RSI guard — not overbought (> 68) or falling knife (< 40)
 *   ⑨ Market mood guard — no new buys in BEARISH market
 */

const R      = require("../config/trading_rules");
const logger = require("firebase-functions/logger");

/**
 * Validate a proposed BUY trade against all portfolio rules.
 *
 * @param {Object} trade        - Trade proposal from Claude
 * @param {Object} portfolio    - Current portfolio state
 * @param {Object} indicators   - Technical indicators for the stock (from technical.js)
 * @param {string} marketMood   - "BULLISH" | "NEUTRAL" | "BEARISH"
 * @returns {{ ok: boolean, reason: string }}
 */
function validateBuy(trade, portfolio, indicators = {}, marketMood = "NEUTRAL") {
  const { holdings = [], inrCash = 0, usdCash = 0, totalValueINR = 0, recentSells = [] } = portfolio;

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

  // ④ Re-buy cooldown (profitable exits only) ─────────────────
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

  // ⑤ Cash reserve check ──────────────────────────────────────
  const isINR    = trade.currency === "INR";
  const reserve  = isINR ? R.MIN_CASH_RESERVE_INR : R.MIN_CASH_RESERVE_USD;
  const cashAvail = isINR ? inrCash : usdCash;

  if (cashAvail - trade.totalAmount < reserve) {
    return {
      ok:     false,
      reason: `Insufficient cash (need ${trade.totalAmount.toFixed(2)} + ${reserve} reserve; have ${cashAvail.toFixed(2)} ${trade.currency})`,
    };
  }

  // ⑥ Position size cap ───────────────────────────────────────
  const tradeINR = isINR
    ? trade.totalAmount
    : trade.totalAmount * (portfolio.usdInrRate || 83.5);

  if (tradeINR > totalValueINR * R.MAX_POSITION_PCT) {
    return {
      ok:     false,
      reason: `Trade ₹${tradeINR.toFixed(0)} exceeds ${R.MAX_POSITION_PCT * 100}% of portfolio (₹${totalValueINR.toFixed(0)})`,
    };
  }

  // ⑦ 52-week high proximity — THE COFORGE RULE ────────────────
  const pctBelow = indicators.pctBelow52wHigh ?? 100;
  if (pctBelow < R.MAX_52W_HIGH_DIST_PCT) {
    return {
      ok:     false,
      reason: `${trade.symbol} only ${pctBelow.toFixed(1)}% below 52W high — too close to resistance (need ≥${R.MAX_52W_HIGH_DIST_PCT}%)`,
    };
  }

  // ⑧ RSI guard ────────────────────────────────────────────────
  const rsi = indicators.rsi ?? 50;
  if (rsi > R.MAX_RSI_ENTRY) {
    return { ok: false, reason: `RSI ${rsi} > ${R.MAX_RSI_ENTRY} — overbought` };
  }
  if (rsi < R.MIN_RSI_ENTRY) {
    return { ok: false, reason: `RSI ${rsi} < ${R.MIN_RSI_ENTRY} — falling knife` };
  }

  // ⑨ Market mood guard ────────────────────────────────────────
  if (marketMood === "BEARISH") {
    return { ok: false, reason: `${trade.market} is BEARISH — no new positions allowed` };
  }

  logger.info(`validateBuy: ✅ ${trade.symbol} passed all checks`);
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
