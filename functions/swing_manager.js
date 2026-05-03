/**
 * functions/swing_manager.js
 * ==========================
 * All Firestore read/write operations for the ARJUN swing trading portfolio.
 *
 * PURPOSE:
 *   Mirror of firestore_manager.js but targeting swing-trading-specific
 *   Firestore collections. Swing positions are held for days to weeks, so
 *   they live in completely separate collections from the intraday portfolio.
 *
 * FIRESTORE COLLECTIONS:
 *
 *   swing_portfolio/state          (single document)
 *     cash, totalValue, startingCapital, holdings[], lastUpdated
 *
 *   swing_portfolio/state/snapshots (sub-collection, one doc per hour)
 *     timestamp, totalValue, cash, holdingsCount, pnlTotal
 *
 *   swing_trades                   (collection, one doc per executed trade)
 *     timestamp, symbol, companyName, sector, action, quantity,
 *     price, totalAmount, pnl, pnlPct, reason, confidence,
 *     stopLoss, target, tradeType, marketSentiment, portfolioValueAfter,
 *     holdDays, newsContext
 *
 *   swing_ai_logs                  (collection, one doc per hourly cycle)
 *     timestamp, marketAnalysis, thoughts[], portfolioHealth,
 *     marketSentiment, nextFocus, tradeCount, cycleStatus, webSearchUsed
 *
 * FUNCTIONS:
 *   getSwingPortfolioState()
 *   saveSwingPortfolioState(state)
 *   recordSwingTrade(tradeData)
 *   recordSwingSnapshot(portfolio)
 *   recordSwingAILog(logData)
 *   calculateSwingUnrealizedPnL(holdings, currentPrices)
 */

const admin = require("firebase-admin");
const logger = require("firebase-functions/logger");

function db() {
  return admin.firestore();
}

// ─────────────────────────────────────────────────────────────
// Swing Portfolio: Read
// ─────────────────────────────────────────────────────────────
/**
 * Reads the current swing portfolio state from Firestore.
 * Returns default ₹10,000 if document doesn't exist yet.
 */
async function getSwingPortfolioState() {
  try {
    const doc = await db().collection("swing_portfolio").doc("state").get();

    if (!doc.exists) {
      logger.warn("swing_portfolio/state not found — returning default starting state");
      return {
        cash:            10000,
        totalValue:      10000,
        startingCapital: 10000,
        holdings:        [],
        lastUpdated:     Date.now(),
      };
    }

    const data = doc.data();
    if (!Array.isArray(data.holdings)) data.holdings = [];
    return data;
  } catch (err) {
    logger.error("getSwingPortfolioState failed:", err.message);
    throw err;
  }
}

// ─────────────────────────────────────────────────────────────
// Swing Portfolio: Write
// ─────────────────────────────────────────────────────────────
async function saveSwingPortfolioState(state) {
  try {
    await db()
      .collection("swing_portfolio")
      .doc("state")
      .set({
        ...state,
        lastUpdated: admin.firestore.FieldValue.serverTimestamp(),
      });
    logger.info(`Swing portfolio saved. Cash: ₹${state.cash?.toFixed(2)}, Total: ₹${state.totalValue?.toFixed(2)}`);
  } catch (err) {
    logger.error("saveSwingPortfolioState failed:", err.message);
    throw err;
  }
}

// ─────────────────────────────────────────────────────────────
// Swing Trades: Record
// ─────────────────────────────────────────────────────────────
async function recordSwingTrade(tradeData) {
  try {
    const doc = {
      timestamp:           admin.firestore.FieldValue.serverTimestamp(),
      timestampMs:         Date.now(),
      symbol:              tradeData.symbol         || "",
      companyName:         tradeData.companyName    || "",
      sector:              tradeData.sector         || "",
      action:              tradeData.action         || "",
      quantity:            tradeData.quantity       || 0,
      price:               tradeData.price          || 0,
      totalAmount:         tradeData.totalAmount    || 0,
      pnl:                 tradeData.pnl            || 0,
      pnlPct:              tradeData.pnlPct         || 0,
      reason:              tradeData.reason         || "",
      confidence:          tradeData.confidence     || "LOW",
      stopLoss:            tradeData.stopLoss       || 0,
      target:              tradeData.target         || 0,
      tradeType:           tradeData.tradeType      || "SWING",
      marketSentiment:     tradeData.marketSentiment || "NEUTRAL",
      portfolioValueAfter: tradeData.portfolioValueAfter || 0,
      // Swing-specific fields
      holdDays:            tradeData.holdDays       || 0,
      newsContext:         tradeData.newsContext    || "",
    };
    const ref = await db().collection("swing_trades").add(doc);
    logger.info(`Swing trade recorded: ${tradeData.action} ${tradeData.symbol} @ ₹${tradeData.price} [${ref.id}]`);
  } catch (err) {
    logger.error("recordSwingTrade failed:", err.message);
    // Non-critical — don't throw
  }
}

// ─────────────────────────────────────────────────────────────
// Swing Snapshots: Record portfolio value every hour
// ─────────────────────────────────────────────────────────────
async function recordSwingSnapshot(portfolio) {
  try {
    const pnlTotal = (portfolio.totalValue || 0) - (portfolio.startingCapital || 10000);

    await db()
      .collection("swing_portfolio")
      .doc("state")
      .collection("snapshots")
      .add({
        timestamp:     admin.firestore.FieldValue.serverTimestamp(),
        timestampMs:   Date.now(),
        totalValue:    portfolio.totalValue    || 0,
        cash:          portfolio.cash          || 0,
        holdingsCount: (portfolio.holdings || []).length,
        pnlTotal,
      });
  } catch (err) {
    logger.error("recordSwingSnapshot failed:", err.message);
    // Non-critical — don't throw
  }
}

// ─────────────────────────────────────────────────────────────
// Swing AI Logs: Record cycle log
// ─────────────────────────────────────────────────────────────
/**
 * cycleStatus values:
 *   "TRADED"        → one or more trades were executed
 *   "WAITED"        → no qualifying setup found
 *   "ANALYSING"     → market closed but analysis was done
 */
async function recordSwingAILog(logData) {
  try {
    await db().collection("swing_ai_logs").add({
      timestamp:       admin.firestore.FieldValue.serverTimestamp(),
      timestampMs:     logData.timestamp    || Date.now(),
      marketAnalysis:  logData.marketAnalysis || "",
      thoughts:        logData.thoughts     || [],
      portfolioHealth: logData.portfolioHealth || "OK",
      marketSentiment: logData.marketSentiment || "NEUTRAL",
      nextFocus:       logData.nextFocus    || "",
      tradeCount:      logData.tradeCount   || 0,
      cycleStatus:     logData.cycleStatus  || "WAITED",
      webSearchUsed:   logData.webSearchUsed || false,
    });
    logger.info(`Swing AI log recorded: ${logData.cycleStatus}, ${logData.tradeCount || 0} trades, webSearch=${logData.webSearchUsed || false}`);
  } catch (err) {
    logger.error("recordSwingAILog failed:", err.message);
    // Non-critical — don't throw
  }
}

// ─────────────────────────────────────────────────────────────
// Unrealized P&L Calculator
// ─────────────────────────────────────────────────────────────
function calculateSwingUnrealizedPnL(holdings, currentPrices) {
  if (!holdings || holdings.length === 0) return [];
  if (!currentPrices || Object.keys(currentPrices).length === 0) return holdings;

  return holdings.map((holding) => {
    const latestPrice = currentPrices[holding.symbol];

    if (!latestPrice || latestPrice <= 0) {
      return holding;
    }

    const unrealizedPnl = (latestPrice - holding.avgBuyPrice) * holding.quantity;
    const unrealizedPnlPct =
      ((latestPrice - holding.avgBuyPrice) / holding.avgBuyPrice) * 100;

    return {
      ...holding,
      currentPrice:     latestPrice,
      unrealizedPnl:    Math.round(unrealizedPnl * 100) / 100,
      unrealizedPnlPct: Math.round(unrealizedPnlPct * 100) / 100,
    };
  });
}

module.exports = {
  getSwingPortfolioState,
  saveSwingPortfolioState,
  recordSwingTrade,
  recordSwingSnapshot,
  recordSwingAILog,
  calculateSwingUnrealizedPnL,
};
