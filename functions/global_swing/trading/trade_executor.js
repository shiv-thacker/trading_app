/**
 * global_swing/trading/trade_executor.js
 * =========================================
 * Executes validated trades — paper mode now, IBKR live when ready.
 *
 * ════════════════════════════════════════════════════════════
 * HOW TO GO LIVE WITH IBKR (step-by-step):
 * ════════════════════════════════════════════════════════════
 * 1. Set TRADING_MODE = "LIVE" in config/trading_rules.js
 * 2. Configure credentials:
 *    firebase functions:config:set ibkr.client_id="..." ibkr.account="..."
 * 3. Uncomment the IBKR section at the bottom of this file
 * 4. Install ibkr SDK: npm install @stoqey/ib
 * 5. For India (NSE): IBKR routes via NSE exchange automatically
 * 6. For US: IBKR Smart routing
 * 7. For Germany (XETRA): route to IBIS (IBKR's XETRA routing)
 * 8. For Japan (TSE): route to TSEJ
 * This file is the ONLY file that changes for going live.
 * All other files (swing_brain, validators, db) stay identical.
 * ════════════════════════════════════════════════════════════
 *
 * TRADE TYPES HANDLED:
 *   SWING_BUY          → New long position
 *   SWING_SELL         → Full exit (stop-loss, target, or Claude decision)
 *   SWING_TAKE_PROFIT  → Partial sell (half position at +8%)
 *   SWING_ROTATION     → Sell one position to fund another
 *   SWING_STOP_LOSS    → Auto-stop triggered by code (not Claude)
 *   SWING_TIME_STOP    → Exit due to time-stop (dead money rule)
 */

const { recordTrade, toINR } = require("../db/firestore_db");
const R               = require("../config/trading_rules");
const logger          = require("firebase-functions/logger");

// ── IBKR ADAPTER PLACEHOLDER ─────────────────────────────────
// Uncomment + implement this block when TRADING_MODE = "LIVE":
/*
const functions = require("firebase-functions");
const IBKR_CLIENT_ID = functions.config().ibkr?.client_id;
const IBKR_ACCOUNT   = functions.config().ibkr?.account;

async function ibkrPlaceOrder({ symbol, market, action, quantity, orderType = "MKT" }) {
  // Example using @stoqey/ib client (install separately):
  // const { IB } = require("@stoqey/ib");
  // const ib = new IB({ clientId: IBKR_CLIENT_ID, ... });
  // await ib.connect();
  // const contract = { symbol, exchange: IBKR_EXCHANGE_MAP[market], ... };
  // return await ib.placeOrder(IBKR_ACCOUNT, contract, { action, totalQuantity: quantity, orderType });
  throw new Error("IBKR ibkrPlaceOrder not yet implemented");
}

const IBKR_EXCHANGE_MAP = {
  NSE:   "NSE",     // India
  US:    "SMART",   // US auto-routing
  XETRA: "IBIS",   // IBKR's XETRA routing
  T:     "TSEJ",   // Tokyo Stock Exchange via IBKR
};
*/

// ─────────────────────────────────────────────────────────────

/**
 * Execute a BUY trade.
 * Paper mode: deducts cash + adds holding to portfolio (in-memory).
 * Call savePortfolioState() after this to persist.
 *
 * @param {Object} trade     - Validated trade from Claude + validator
 * @param {Object} portfolio - Current portfolio state (mutated in place)
 * @param {string} mood      - Market mood at entry ("BULLISH" | "NEUTRAL")
 * @returns {Promise<boolean>} true if executed successfully
 */
async function executeBuy(trade, portfolio, mood = "NEUTRAL") {
  if (R.TRADING_MODE === "LIVE") {
    // TODO: Implement IBKR live order → await ibkrPlaceOrder(trade);
    logger.warn("IBKR live mode not yet implemented — skipping BUY");
    return false;
  }

  // ── PAPER MODE ───────────────────────────────────────────────
  // Deduct from unified INR pool using the correct per-currency FX rate
  const costINR = toINR(trade.totalAmount, trade.currency || "USD", portfolio);
  portfolio.capitalINR = (portfolio.capitalINR || 0) - costINR;

  portfolio.holdings.push({
    symbol:            trade.symbol,
    market:            trade.market,
    country:           trade.country,
    currency:          trade.currency,
    quantity:          trade.quantity,
    avgBuyPrice:       trade.price,
    currentPrice:      trade.price,
    unrealizedPnl:     0,
    unrealizedPnlPct:  0,
    unrealizedPnlINR:  0,
    stopLoss:          trade.stopLoss  || Math.round(trade.price * (1 + R.STOP_LOSS_PCT / 100) * 100) / 100,
    target:            trade.target    || Math.round(trade.price * (1 + R.TAKE_PROFIT_FULL_PCT / 100) * 100) / 100,
    buyTimestamp:      Date.now(),
    daysHeld:          0,
    cyclesHeld:        0,
    marketMoodAtEntry: mood,
    tradeType:         trade.tradeType || "SWING_BUY",
  });

  await recordTrade({
    ...trade,
    action:              "BUY",
    pnl:                 0,
    pnlPct:              0,
    pnlINR:              0,
    daysHeld:            0,
    marketMoodAtEntry:   mood,
    portfolioValueAfter: portfolio.totalValueINR || 0,
  });

  logger.info(`✅ BUY: ${trade.quantity} × ${trade.symbol} @ ${trade.price} ${trade.currency} | mood=${mood}`);
  return true;
}

/**
 * Execute a SELL trade (full or partial).
 * Paper mode: adds proceeds to cash + removes/reduces holding.
 *
 * @param {Object} trade       - Validated sell proposal
 * @param {Object} portfolio   - Current portfolio (mutated in place)
 * @param {number} usdInrRate  - For INR-equivalent P&L display
 * @returns {Promise<boolean>} true if executed successfully
 */
async function executeSell(trade, portfolio, usdInrRate = 83.5) {
  if (R.TRADING_MODE === "LIVE") {
    logger.warn("IBKR live mode not yet implemented — skipping SELL");
    return false;
  }

  const holding = portfolio.holdings.find(h => h.symbol === trade.symbol);
  if (!holding) return false;

  const sellQty   = trade.quantity;
  const sellPrice = trade.price;

  // P&L in position's native currency
  const pnl    = (sellPrice - holding.avgBuyPrice) * sellQty;
  const pnlPct = ((sellPrice - holding.avgBuyPrice) / holding.avgBuyPrice) * 100;
  // P&L in INR using correct per-currency FX rate
  const pnlINR = toINR(pnl, holding.currency || "USD", portfolio);

  const daysHeld = Math.floor(
    (Date.now() - (holding.buyTimestamp || Date.now())) / (1000 * 60 * 60 * 24)
  );

  // Add proceeds back to unified INR pool using correct FX rate
  const proceeds    = sellPrice * sellQty;
  const proceedsINR = toINR(proceeds, holding.currency || "USD", portfolio);
  portfolio.capitalINR = (portfolio.capitalINR || 0) + proceedsINR;

  if (sellQty >= holding.quantity) {
    // Full sell — remove from holdings
    portfolio.holdings = portfolio.holdings.filter(h => h.symbol !== holding.symbol);

    // Track profitable exits for NO_REBUY_DAYS cooldown
    if (pnlPct > 0) {
      if (!portfolio.recentSells) portfolio.recentSells = [];
      // Prune entries older than NO_REBUY_DAYS
      portfolio.recentSells = portfolio.recentSells.filter(
        s => (Date.now() - (s.soldAt || 0)) < R.NO_REBUY_DAYS * 24 * 60 * 60 * 1000
      );
      portfolio.recentSells.push({ symbol: holding.symbol, soldAt: Date.now() });
    }
  } else {
    // Partial sell — reduce quantity (e.g. SWING_TAKE_PROFIT at +8%)
    const idx = portfolio.holdings.findIndex(h => h.symbol === holding.symbol);
    portfolio.holdings[idx] = {
      ...holding,
      quantity: holding.quantity - sellQty,
    };
  }

  await recordTrade({
    symbol:              holding.symbol,
    market:              holding.market,
    country:             holding.country,
    currency:            holding.currency,
    action:              "SELL",
    quantity:            sellQty,
    price:               sellPrice,
    totalAmount:         proceeds,
    pnl:                 Math.round(pnl    * 100) / 100,
    pnlPct:              Math.round(pnlPct * 100) / 100,
    pnlINR:              Math.round(pnlINR * 100) / 100,
    reason:              trade.reason     || "",
    confidence:          trade.confidence || "MEDIUM",
    tradeType:           trade.tradeType  || "SWING_SELL",
    stopLoss:            holding.stopLoss || 0,
    target:              holding.target   || 0,
    daysHeld,
    marketMoodAtEntry:   holding.marketMoodAtEntry || "",
    portfolioValueAfter: portfolio.totalValueINR   || 0,
  });

  const sign = pnl >= 0 ? "+" : "";
  logger.info(
    `✅ SELL: ${sellQty} × ${trade.symbol} @ ${sellPrice} | ` +
    `P&L: ${sign}${pnl.toFixed(2)} ${holding.currency} (${sign}${pnlPct.toFixed(2)}%) | ` +
    `${daysHeld}d held | type=${trade.tradeType}`
  );
  return true;
}

module.exports = { executeBuy, executeSell };
