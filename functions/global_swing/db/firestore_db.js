/**
 * global_swing/db/firestore_db.js
 * ==================================
 * All Firestore operations for the global swing portfolio.
 *
 * FIRESTORE COLLECTIONS (new — separate from old India-only swing):
 *   global_swing_portfolio/state         ← Portfolio with multi-currency wallets
 *   global_swing_portfolio/state/snapshots ← Hourly value snapshots
 *   global_swing_trades                  ← One doc per executed trade (all markets)
 *   global_swing_ai_logs                 ← One doc per cycle decision
 *
 * MULTI-CURRENCY DESIGN:
 *   inrCash : ₹ — used for India (NSE) trades
 *   usdCash : $ — used for ALL foreign trades (US, Germany, Japan)
 *
 *   Why USD for Germany/Japan paper trades?
 *     - Germany trades are in EUR, Japan in JPY, but for paper simulation
 *       we track them in USD (approximate). IBKR handles the real FX on live.
 *     - This keeps portfolio math simple: just 2 wallets instead of 4.
 *
 * CAPITAL RECOMMENDATION (set this once in Firestore manually, or let
 * the system auto-init with DEFAULT_PORTFOLIO below):
 *   inrCash: 50000  (₹50,000 for India trades)
 *   usdCash: 600    ($600 ≈ ₹50,000 at ₹83.5/$ for foreign trades)
 *   Total:   ₹1,00,000
 *
 * IBKR MIGRATION:
 *   For live trading, portfolio state (cash, holdings) would be read
 *   from IBKR account balances, not Firestore. Only trade logs +
 *   AI logs would remain in Firestore for history/audit.
 *   This file would then become read-only for portfolio state.
 */

const admin  = require("firebase-admin");
const logger = require("firebase-functions/logger");

function db() { return admin.firestore(); }

// ── Default starting portfolio (used when Firestore doc doesn't exist yet) ──
const DEFAULT_PORTFOLIO = {
  baseCurrency:      "INR",
  startingCapital:   100000,  // ₹1,00,000 total recommended capital
  inrCash:           50000,   // ₹50,000 for India (NSE) trades
  usdCash:           600.00,  // $600 for US + Germany + Japan trades
  usdInrRate:        83.5,    // Updated each cycle via EODHD FOREX endpoint
  totalValueINR:     100000,  // Recalculated every cycle
  holdings:          [],
  recentSells:       [],      // Tracks recently sold symbols (for NO_REBUY_DAYS rule)
  lastDaysHeldDate:  null,    // Used to increment daysHeld once per calendar day
  lastUpdated:       null,
};

// ─────────────────────────────────────────────────────────────
// Portfolio: Read
// ─────────────────────────────────────────────────────────────

/**
 * Read the current portfolio state from Firestore.
 * Returns DEFAULT_PORTFOLIO if no document exists yet (first run).
 *
 * @returns {Promise<Object>} Portfolio state object
 */
async function getPortfolioState() {
  try {
    const doc = await db().collection("global_swing_portfolio").doc("state").get();

    if (!doc.exists) {
      logger.warn("global_swing_portfolio/state not found — initializing with defaults (₹1,00,000)");
      return { ...DEFAULT_PORTFOLIO, lastUpdated: Date.now() };
    }

    const data = doc.data();
    if (!Array.isArray(data.holdings))    data.holdings    = [];
    if (!Array.isArray(data.recentSells)) data.recentSells = [];
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
 * Save portfolio state to Firestore.
 * Called at the end of every cycle.
 *
 * @param {Object} state - Full portfolio state
 */
async function savePortfolioState(state) {
  try {
    await db()
      .collection("global_swing_portfolio")
      .doc("state")
      .set({
        ...state,
        lastUpdated: admin.firestore.FieldValue.serverTimestamp(),
      });

    logger.info(
      `Portfolio saved — INR: ₹${state.inrCash?.toFixed(0)}, ` +
      `USD: $${state.usdCash?.toFixed(2)}, ` +
      `Total: ₹${state.totalValueINR?.toFixed(0)}, ` +
      `Holdings: ${state.holdings?.length}`
    );
  } catch (err) {
    logger.error("savePortfolioState failed:", err.message);
    throw err;
  }
}

// ─────────────────────────────────────────────────────────────
// Snapshot: Hourly portfolio value record
// ─────────────────────────────────────────────────────────────

/**
 * Record a snapshot of current portfolio value (sub-collection).
 * Used for performance tracking / charting over time.
 *
 * @param {Object} portfolio
 */
async function recordSnapshot(portfolio) {
  try {
    const startingCapital = portfolio.startingCapital || 100000;
    const pnlTotal        = (portfolio.totalValueINR || 0) - startingCapital;
    const pnlPct          = startingCapital > 0
      ? Math.round((pnlTotal / startingCapital) * 10000) / 100
      : 0;

    await db()
      .collection("global_swing_portfolio")
      .doc("state")
      .collection("snapshots")
      .add({
        timestamp:     admin.firestore.FieldValue.serverTimestamp(),
        timestampMs:   Date.now(),
        totalValueINR: portfolio.totalValueINR || 0,
        inrCash:       portfolio.inrCash       || 0,
        usdCash:       portfolio.usdCash       || 0,
        usdInrRate:    portfolio.usdInrRate     || 83.5,
        holdingsCount: (portfolio.holdings || []).length,
        pnlTotal,
        pnlPct,
      });
  } catch (err) {
    logger.warn("recordSnapshot failed (non-critical):", err.message);
  }
}

// ─────────────────────────────────────────────────────────────
// Trade: Record one executed trade
// ─────────────────────────────────────────────────────────────

/**
 * Record a completed trade to the trades collection.
 * Both BUY and SELL are recorded. P&L is zero on BUY.
 *
 * @param {Object} tradeData
 */
async function recordTrade(tradeData) {
  try {
    await db().collection("global_swing_trades").add({
      timestamp:           admin.firestore.FieldValue.serverTimestamp(),
      timestampMs:         Date.now(),
      // Symbol + market identity
      symbol:              tradeData.symbol              || "",
      market:              tradeData.market              || "",
      country:             tradeData.country             || "",
      currency:            tradeData.currency            || "INR",
      // Trade details
      action:              tradeData.action              || "",
      quantity:            tradeData.quantity            || 0,
      price:               tradeData.price               || 0,
      totalAmount:         tradeData.totalAmount         || 0,
      // P&L (in position currency + INR equivalent)
      pnl:                 tradeData.pnl                 || 0,
      pnlPct:              tradeData.pnlPct              || 0,
      pnlINR:              tradeData.pnlINR              || 0,
      // Decision context
      reason:              tradeData.reason              || "",
      confidence:          tradeData.confidence          || "MEDIUM",
      tradeType:           tradeData.tradeType           || "SWING",
      stopLoss:            tradeData.stopLoss            || 0,
      target:              tradeData.target              || 0,
      daysHeld:            tradeData.daysHeld            || 0,
      marketMoodAtEntry:   tradeData.marketMoodAtEntry   || "",
      portfolioValueAfter: tradeData.portfolioValueAfter || 0,
      // IBKR live fields (null for paper trading)
      ibkrOrderId:         tradeData.ibkrOrderId         || null,
      ibkrFillPrice:       tradeData.ibkrFillPrice       || null,
    });
  } catch (err) {
    logger.warn("recordTrade failed (non-critical):", err.message);
  }
}

// ─────────────────────────────────────────────────────────────
// AI Log: Record one cycle's decision
// ─────────────────────────────────────────────────────────────

/**
 * Record Claude's analysis + decision for one cycle.
 * cycleStatus: "TRADED" | "WAITED" | "ERROR"
 *
 * @param {Object} logData
 */
async function recordAILog(logData) {
  try {
    await db().collection("global_swing_ai_logs").add({
      timestamp:       admin.firestore.FieldValue.serverTimestamp(),
      timestampMs:     logData.timestamp     || Date.now(),
      // Market context
      marketsAnalyzed: logData.marketsAnalyzed || [],
      bullishMarkets:  logData.bullishMarkets  || [],
      openMarkets:     logData.openMarkets     || [],
      // Decision
      cycleStatus:     logData.cycleStatus    || "WAITED",
      tradeCount:      logData.tradeCount     || 0,
      // Analysis
      marketAnalysis:  logData.marketAnalysis || "",
      thoughts:        logData.thoughts       || [],
      portfolioHealth: logData.portfolioHealth || "OK",
      nextFocus:       logData.nextFocus      || "",
      // webSearchUsed field deliberately omitted — feature removed
    });
  } catch (err) {
    logger.warn("recordAILog failed (non-critical):", err.message);
  }
}

// ─────────────────────────────────────────────────────────────
// P&L helpers
// ─────────────────────────────────────────────────────────────

/**
 * Apply latest prices to holdings and update unrealised P&L.
 * Also converts P&L to INR for unified portfolio display.
 *
 * @param {Array}  holdings    - Current holdings array
 * @param {Object} priceMap    - { "TCS.NSE": 3520, "AAPL.US": 309.5, ... }
 * @param {number} usdInrRate  - Current exchange rate for conversion
 * @returns {Array}            - Updated holdings array
 */
function updateHoldingsPnL(holdings, priceMap, usdInrRate = 83.5) {
  if (!holdings || holdings.length === 0) return [];
  if (!priceMap || Object.keys(priceMap).length === 0) return holdings;

  return holdings.map(h => {
    const latest = priceMap[h.symbol];
    if (!latest || latest <= 0) return h;

    const unrealizedPnl    = (latest - h.avgBuyPrice) * h.quantity;
    const unrealizedPnlPct = ((latest - h.avgBuyPrice) / h.avgBuyPrice) * 100;
    const unrealizedPnlINR = h.currency === "INR"
      ? unrealizedPnl
      : unrealizedPnl * usdInrRate;

    return {
      ...h,
      currentPrice:     Math.round(latest            * 100) / 100,
      unrealizedPnl:    Math.round(unrealizedPnl     * 100) / 100,
      unrealizedPnlPct: Math.round(unrealizedPnlPct  * 100) / 100,
      unrealizedPnlINR: Math.round(unrealizedPnlINR  * 100) / 100,
    };
  });
}

/**
 * Recalculate total portfolio value in INR.
 * Includes: INR cash + (USD cash × rate) + all position values.
 *
 * @param {Object} portfolio - Portfolio state with updated holdings
 * @returns {number}         - Total value in INR
 */
function calcTotalValueINR(portfolio) {
  const { inrCash = 0, usdCash = 0, usdInrRate = 83.5, holdings = [] } = portfolio;

  let total = inrCash + usdCash * usdInrRate;

  for (const h of holdings) {
    const posValue = (h.currentPrice || h.avgBuyPrice) * h.quantity;
    const posINR   = h.currency === "INR" ? posValue : posValue * usdInrRate;
    total += posINR;
  }

  return Math.round(total * 100) / 100;
}

module.exports = {
  getPortfolioState,
  savePortfolioState,
  recordSnapshot,
  recordTrade,
  recordAILog,
  updateHoldingsPnL,
  calcTotalValueINR,
};
