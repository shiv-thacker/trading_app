/**
 * functions/firestore_manager.js
 * ==============================
 * All Firestore read/write operations for the ARJUN trading engine.
 *
 * PURPOSE:
 *   Single source of truth for all database interactions. The trading
 *   loop (index.js) only calls these functions — never raw Firestore ops.
 *
 * FIRESTORE COLLECTIONS:
 *
 *   portfolio/state          (single document)
 *     cash, totalValue, startingCapital, holdings[], lastUpdated
 *
 *   portfolio/snapshots      (sub-collection, one doc per 5-min cycle)
 *     timestamp, totalValue, cash, holdingsCount, pnlToday, pnlTotal
 *
 *   trades                   (collection, one doc per executed trade)
 *     timestamp, symbol, companyName, sector, action, quantity,
 *     price, totalAmount, pnl, pnlPct, reason, confidence,
 *     stopLoss, target, tradeType, marketSentiment, portfolioValueAfter
 *
 *   ai_logs                  (collection, one doc per cycle)
 *     timestamp, marketAnalysis, thoughts[], portfolioHealth,
 *     marketSentiment, nextFocus, tradeCount, cycleStatus
 *
 * FUNCTIONS:
 *   getPortfolioState()
 *   savePortfolioState(state)
 *   recordTrade(tradeData)
 *   recordSnapshot(portfolio)
 *   recordAILog(logData)
 *   calculateUnrealizedPnL(holdings, currentPrices)
 *   initializePortfolio()
 */

const admin = require("firebase-admin");
const logger = require("firebase-functions/logger");

// Firestore database reference (admin SDK initialized in index.js)
function db() {
  return admin.firestore();
}

// ─────────────────────────────────────────────────────────────
// Portfolio: Read
// ─────────────────────────────────────────────────────────────
/**
 * Reads the current portfolio state from Firestore.
 * Returns default starting values if document doesn't exist yet.
 *
 * @returns {Promise<Object>} Portfolio state document
 */
async function getPortfolioState() {
  try {
    const doc = await db().collection("portfolio").doc("state").get();

    if (!doc.exists) {
      logger.warn("portfolio/state not found — returning default starting state");
      return {
        cash: 10000,
        totalValue: 10000,
        startingCapital: 10000,
        holdings: [],
        lastUpdated: Date.now(),
      };
    }

    const data = doc.data();
    // Ensure holdings is always an array
    if (!Array.isArray(data.holdings)) data.holdings = [];
    return data;
  } catch (err) {
    logger.error("getPortfolioState failed:", err.message);
    throw err;
  }
}

// ─────────────────────────────────────────────────────────────
// Portfolio: Write
// ─────────────────────────────────────────────────────────────
/**
 * Saves the full portfolio state back to Firestore after each cycle.
 * Uses set() with merge:false to ensure complete state replacement.
 *
 * @param {Object} state - Updated portfolio state
 */
async function savePortfolioState(state) {
  try {
    await db()
      .collection("portfolio")
      .doc("state")
      .set({
        ...state,
        lastUpdated: admin.firestore.FieldValue.serverTimestamp(),
      });
    logger.info(`Portfolio saved. Cash: ₹${state.cash?.toFixed(2)}, Total: ₹${state.totalValue?.toFixed(2)}`);
  } catch (err) {
    logger.error("savePortfolioState failed:", err.message);
    throw err;
  }
}

// ─────────────────────────────────────────────────────────────
// Trades: Record
// ─────────────────────────────────────────────────────────────
/**
 * Records an executed trade to the trades collection.
 * Each BUY or SELL generates one document.
 *
 * @param {Object} tradeData - Trade details from trading loop
 */
async function recordTrade(tradeData) {
  try {
    const doc = {
      timestamp:           admin.firestore.FieldValue.serverTimestamp(),
      timestampMs:         Date.now(),
      symbol:              tradeData.symbol || "",
      companyName:         tradeData.companyName || "",
      sector:              tradeData.sector || "",
      action:              tradeData.action || "",
      quantity:            tradeData.quantity || 0,
      price:               tradeData.price || 0,
      totalAmount:         tradeData.totalAmount || 0,
      pnl:                 tradeData.pnl || 0,
      pnlPct:              tradeData.pnlPct || 0,
      reason:              tradeData.reason || "",
      confidence:          tradeData.confidence || "LOW",
      stopLoss:            tradeData.stopLoss || 0,
      target:              tradeData.target || 0,
      tradeType:           tradeData.tradeType || "MOMENTUM",
      marketSentiment:     tradeData.marketSentiment || "NEUTRAL",
      portfolioValueAfter: tradeData.portfolioValueAfter || 0,
    };
    const ref = await db().collection("trades").add(doc);
    logger.info(`Trade recorded: ${tradeData.action} ${tradeData.symbol} @ ₹${tradeData.price} [${ref.id}]`);
  } catch (err) {
    logger.error("recordTrade failed:", err.message);
    // Non-critical — don't throw, just log
  }
}

// ─────────────────────────────────────────────────────────────
// Snapshots: Record portfolio value every 5 min
// ─────────────────────────────────────────────────────────────
/**
 * Records a portfolio value snapshot to the portfolio/snapshots sub-collection.
 * Used by the Flutter app to draw the historical portfolio value chart.
 *
 * @param {Object} portfolio - Current portfolio state
 */
async function recordSnapshot(portfolio) {
  try {
    const pnlTotal = (portfolio.totalValue || 0) - (portfolio.startingCapital || 10000);

    await db()
      .collection("portfolio")
      .doc("state")
      .collection("snapshots")
      .add({
        timestamp:      admin.firestore.FieldValue.serverTimestamp(),
        timestampMs:    Date.now(),
        totalValue:     portfolio.totalValue || 0,
        cash:           portfolio.cash || 0,
        holdingsCount:  (portfolio.holdings || []).length,
        pnlTotal:       pnlTotal,
      });
  } catch (err) {
    logger.error("recordSnapshot failed:", err.message);
    // Non-critical — don't throw
  }
}

// ─────────────────────────────────────────────────────────────
// AI Logs: Record cycle log
// ─────────────────────────────────────────────────────────────
/**
 * Records ARJUN's thinking log for one trading cycle.
 * Displayed in the AI Brain screen in the Flutter app.
 *
 * cycleStatus values:
 *   "TRADED"       → one or more trades were executed
 *   "WAITED"       → no qualifying setup found
 *   "MARKET_CLOSED"→ outside 09:15–15:30 IST
 *
 * @param {Object} logData - Log data for this cycle
 */
async function recordAILog(logData) {
  try {
    await db().collection("ai_logs").add({
      timestamp:       admin.firestore.FieldValue.serverTimestamp(),
      timestampMs:     logData.timestamp || Date.now(),
      marketAnalysis:  logData.marketAnalysis || "",
      thoughts:        logData.thoughts || [],
      portfolioHealth: logData.portfolioHealth || "OK",
      marketSentiment: logData.marketSentiment || "NEUTRAL",
      nextFocus:       logData.nextFocus || "",
      tradeCount:      logData.tradeCount || 0,
      cycleStatus:     logData.cycleStatus || "WAITED",
    });
    logger.info(`AI log recorded: ${logData.cycleStatus}, ${logData.tradeCount || 0} trades`);
  } catch (err) {
    logger.error("recordAILog failed:", err.message);
    // Non-critical — don't throw
  }
}

// ─────────────────────────────────────────────────────────────
// P&L Calculator: Update unrealized P&L on holdings
// ─────────────────────────────────────────────────────────────
/**
 * Updates each holding's currentPrice and unrealized P&L using
 * freshly fetched prices. Called every cycle before asking Claude.
 *
 * @param {Array}  holdings      - Current portfolio holdings array
 * @param {Object} currentPrices - Map { SYMBOL: price } from getCurrentPrices()
 * @returns {Array} Updated holdings with current prices + unrealized P&L
 */
function calculateUnrealizedPnL(holdings, currentPrices) {
  if (!holdings || holdings.length === 0) return [];
  if (!currentPrices || Object.keys(currentPrices).length === 0) return holdings;

  return holdings.map((holding) => {
    const latestPrice = currentPrices[holding.symbol];

    if (!latestPrice || latestPrice <= 0) {
      // Price unavailable — keep last known price
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

// ─────────────────────────────────────────────────────────────
// Initialize Portfolio (first-time setup)
// ─────────────────────────────────────────────────────────────
/**
 * Creates the portfolio/state document with ₹10,000 starting capital.
 * Called only once when the app is first set up, or after a portfolio reset.
 * Safe to call multiple times — uses set() with merge:false.
 */
async function initializePortfolio() {
  try {
    await db().collection("portfolio").doc("state").set({
      cash:            10000,
      totalValue:      10000,
      startingCapital: 10000,
      holdings:        [],
      lastUpdated:     admin.firestore.FieldValue.serverTimestamp(),
    });
    logger.info("Portfolio initialized with ₹10,000 starting capital");
  } catch (err) {
    logger.error("initializePortfolio failed:", err.message);
    throw err;
  }
}

module.exports = {
  getPortfolioState,
  savePortfolioState,
  recordTrade,
  recordSnapshot,
  recordAILog,
  calculateUnrealizedPnL,
  initializePortfolio,
};
