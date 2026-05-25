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
 * UNIFIED CAPITAL DESIGN:
 *   capitalINR : single pool of money in ₹ — used for ALL markets.
 *
 *   When buying India stock  : deduct ₹amount directly from capitalINR.
 *   When buying US/DE/JP stock: deduct (USD_price × qty × usdInrRate) from capitalINR.
 *   When selling any stock   : add proceeds converted back to ₹ at live rate.
 *
 *   This means ARJUN decides how much of the ₹1,00,000 to put in which
 *   country each cycle — no pre-assigned per-country wallet.
 *
 * CAPITAL RECOMMENDATION:
 *   capitalINR: 100000  (₹1,00,000 total — invest wherever is most bullish)
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
  startingCapital:   100000,   // ₹1,00,000 total capital
  capitalINR:        100000,   // Available cash in ₹ (unified pool — all markets)
  usdInrRate:        84.0,     // Live USD/INR rate — updated each cycle from EODHD
  eurInrRate:        90.0,     // Live EUR/INR rate — for XETRA positions
  jpyInrRate:        0.58,     // Live JPY/INR rate — for Japan (TSE) positions
  totalValueINR:     100000,   // capitalINR + all open positions (recalculated every cycle)
  holdings:          [],
  recentSells:       [],       // Tracks recently sold symbols (for NO_REBUY_DAYS rule)
  lastDaysHeldDate:  null,     // Used to increment daysHeld once per calendar day
  lastUpdated:       null,
};

// ─────────────────────────────────────────────────────────────
// Portfolio: Read
// ─────────────────────────────────────────────────────────────

/**
 * Read the current portfolio state from Firestore.
 * Returns DEFAULT_PORTFOLIO if no document exists yet (first run).
 * Migrates legacy cash / dual-wallet fields on read.
 *
 * @returns {Promise<Object>} Portfolio state object
 */
/**
 * Normalize any legacy portfolio format into the unified capitalINR model.
 * Handles old docs that still have cash: 10000, inrCash/usdCash split wallets, etc.
 */
function normalizePortfolio(data) {
  const starting  = data.startingCapital || 100000;
  const rate      = data.usdInrRate || 84.0;
  const legacyCash = data.cash || 0;

  // Build unified capitalINR from whatever fields exist
  if (!data.capitalINR || data.capitalINR <= 0) {
    if (data.inrCash > 0 || data.usdCash > 0) {
      data.capitalINR = (data.inrCash || 0) + (data.usdCash || 0) * rate;
    } else if (legacyCash > 0 && legacyCash < starting * 0.5 && starting >= 50000) {
      // Stale ₹10k cash field with ₹1L starting capital — ignore legacy cash
      data.capitalINR = starting;
    } else if (legacyCash > 0) {
      data.capitalINR = legacyCash;
    } else {
      data.capitalINR = starting;
    }
  }

  if (!Array.isArray(data.holdings))    data.holdings    = [];
  if (!Array.isArray(data.recentSells)) data.recentSells = [];

  data.baseCurrency    = data.baseCurrency || "INR";
  data.startingCapital = starting;
  data.usdInrRate      = rate;
  data.totalValueINR   = calcTotalValueINR(data);

  // Drop legacy fields so they never get re-saved
  delete data.cash;
  delete data.totalValue;
  delete data.inrCash;
  delete data.usdCash;

  return data;
}

async function getPortfolioState() {
  try {
    const doc = await db().collection("global_swing_portfolio").doc("state").get();

    if (!doc.exists) {
      logger.warn("global_swing_portfolio/state not found — initializing with defaults (₹1,00,000)");
      return { ...DEFAULT_PORTFOLIO, lastUpdated: Date.now() };
    }

    return normalizePortfolio(doc.data());

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
  // Write only the canonical fields — never spread stale legacy keys (cash, inrCash, etc.)
    const clean = normalizePortfolio({ ...state });
    await db()
      .collection("global_swing_portfolio")
      .doc("state")
      .set({
        baseCurrency:     clean.baseCurrency,
        startingCapital:  clean.startingCapital,
        capitalINR:       clean.capitalINR,
        usdInrRate:       clean.usdInrRate,
        totalValueINR:    clean.totalValueINR,
        holdings:         clean.holdings,
        recentSells:      clean.recentSells || [],
        lastDaysHeldDate: clean.lastDaysHeldDate || null,
        lastUpdated:      admin.firestore.FieldValue.serverTimestamp(),
      });

    logger.info(
      `Portfolio saved — Capital: ₹${(state.capitalINR || 0).toFixed(0)}, ` +
      `Total: ₹${(state.totalValueINR || 0).toFixed(0)}, ` +
      `Rate: ₹${(state.usdInrRate || 84).toFixed(2)}/$, ` +
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
        capitalINR:    portfolio.capitalINR    || 0,
        usdInrRate:    portfolio.usdInrRate    || 84.0,
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
 * Returns the INR equivalent of an amount in a given currency.
 * Supports INR, USD, EUR, JPY using live rates stored in portfolio.
 */
function toINR(amount, currency, portfolio) {
  if (currency === "INR") return amount;
  if (currency === "USD") return amount * (portfolio.usdInrRate || 84.0);
  if (currency === "EUR") return amount * (portfolio.eurInrRate || 90.0);
  if (currency === "JPY") return amount * (portfolio.jpyInrRate || 0.58);
  // Unknown currency: fall back to USD rate with a warning
  return amount * (portfolio.usdInrRate || 84.0);
}

/**
 * Apply latest prices to holdings and update unrealised P&L.
 * Uses per-currency FX rates (USD/EUR/JPY→INR) stored in portfolio.
 *
 * @param {Array}  holdings    - Current holdings array
 * @param {Object} priceMap    - { "TCS.NSE": 3520, "AAPL.US": 309.5, "7203.T": 3026 }
 * @param {number} usdInrRate  - Kept for backward-compat; prefer portfolio object
 * @param {Object} [portfolio] - Full portfolio (for EUR/JPY rates); optional
 * @returns {Array}            - Updated holdings array
 */
function updateHoldingsPnL(holdings, priceMap, usdInrRate = 84.0, portfolio = null) {
  if (!holdings || holdings.length === 0) return [];
  if (!priceMap || Object.keys(priceMap).length === 0) return holdings;

  // Build a minimal portfolio-like object if full portfolio not passed
  const fxContext = portfolio || { usdInrRate, eurInrRate: 90.0, jpyInrRate: 0.58 };

  return holdings.map(h => {
    const latest = priceMap[h.symbol];
    if (!latest || latest <= 0) return h;

    const unrealizedPnl    = (latest - h.avgBuyPrice) * h.quantity;
    const unrealizedPnlPct = ((latest - h.avgBuyPrice) / h.avgBuyPrice) * 100;
    const unrealizedPnlINR = toINR(unrealizedPnl, h.currency || "USD", fxContext);

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
 * Includes: available capitalINR + all open position values converted to INR.
 *
 * @param {Object} portfolio - Portfolio state with updated holdings
 * @returns {number}         - Total value in INR
 */
function calcTotalValueINR(portfolio) {
  const { capitalINR = 0, holdings = [] } = portfolio;

  let total = capitalINR;

  for (const h of holdings) {
    const posValue = (h.currentPrice || h.avgBuyPrice) * h.quantity;
    const posINR   = toINR(posValue, h.currency || "USD", portfolio);
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
  toINR,
};
