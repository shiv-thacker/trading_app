/**
 * functions/index.js
 * ==================
 * Main Firebase Cloud Functions entry point — ARJUN's autonomous trading engine.
 *
 * PURPOSE:
 *   Orchestrates the full trading loop. Runs every 5 minutes via Cloud Scheduler.
 *   The Flutter app never trades directly — everything happens here server-side,
 *   even when the user's phone is completely off.
 *
 * CLOUD FUNCTIONS EXPORTED:
 *
 *   tradingLoop (Scheduled Function)
 *     - Triggers: every 5 minutes via Firebase Cloud Scheduler
 *     - Timezone: Asia/Kolkata (IST)
 *     - Only executes trading logic between 09:15 and 15:30 IST on weekdays
 *     - Outside market hours: logs MARKET_CLOSED and exits immediately
 *
 *   manualTrigger (HTTPS Callable)
 *     - Called by Flutter Settings screen → "Run one trading cycle now"
 *     - Runs one full trading cycle immediately for testing
 *     - Returns cycle result to Flutter caller
 *
 * TRADING CYCLE SEQUENCE (runTradingCycle):
 *   1. Market hours check → exit early if closed
 *   2. Read current portfolio from Firestore
 *   3. Fetch live NSE market overview (indices + mood)
 *   4. Fetch live top 20 momentum stocks from Nifty 500 (NEVER hardcoded)
 *   5. Update unrealized P&L on current holdings (real-time prices)
 *   6. Call Claude claude-sonnet-4-20250514 with live data → get trade decision
 *   7. Execute each trade: validate → update cash → update holdings
 *   8. Increment cyclesHeld counter on all holdings
 *   9. Recalculate total portfolio value
 *  10. Save portfolio state → record snapshot → record AI log
 *
 * CONFIG:
 *   firebase functions:config:set \
 *     anthropic.api_key="YOUR_CLAUDE_API_KEY"
 */

const functions = require("firebase-functions");
const admin     = require("firebase-admin");
const logger    = require("firebase-functions/logger");

// Initialize Firebase Admin SDK (only once across all functions)
if (!admin.apps.length) {
  admin.initializeApp();
}

const { getMarketOverview, getTopMovers, getCurrentPrices } = require("./market_data");
const { getTradeDecision }                                   = require("./claude_trader");
const {
  getPortfolioState,
  savePortfolioState,
  recordTrade,
  recordSnapshot,
  recordAILog,
  calculateUnrealizedPnL,
} = require("./firestore_manager");

// ── Swing trading modules ────────────────────────────────────
const { getSwingDecision } = require("./swing_trader");
const {
  getSwingPortfolioState,
  saveSwingPortfolioState,
  recordSwingTrade,
  recordSwingSnapshot,
  recordSwingAILog,
  calculateSwingUnrealizedPnL,
} = require("./swing_manager");

// ─────────────────────────────────────────────────────────────
// Market Hours Helpers
// ─────────────────────────────────────────────────────────────

/**
 * Returns current time as a Date object in IST.
 * (JavaScript Date is always UTC internally; we extract IST components
 * by formatting in Asia/Kolkata timezone)
 */
function getCurrentISTComponents() {
  const now = new Date();
  const istStr = now.toLocaleString("en-US", { timeZone: "Asia/Kolkata" });
  const istDate = new Date(istStr);
  return {
    hours:   istDate.getHours(),
    minutes: istDate.getMinutes(),
    day:     istDate.getDay(), // 0=Sun, 1=Mon, ..., 6=Sat
  };
}

/**
 * Returns true if the current IST time falls within NSE trading hours:
 *   Monday–Friday, 09:15 to 15:30 IST
 */
function isMarketOpen() {
  const { hours, minutes, day } = getCurrentISTComponents();

  // Weekend check (0=Sun, 6=Sat)
  if (day === 0 || day === 6) return false;

  // Convert to minutes-since-midnight for easy comparison
  const nowMins  = hours * 60 + minutes;
  const openMins = 9 * 60 + 15;   // 09:15
  const closeMins= 15 * 60 + 30;  // 15:30

  return nowMins >= openMins && nowMins < closeMins;
}

/**
 * Returns true if it is after 3:00 PM IST (time to close all positions)
 */
function isAfter3PM() {
  const { hours } = getCurrentISTComponents();
  return hours >= 15;
}

// ─────────────────────────────────────────────────────────────
// Trade Validation Helpers
// ─────────────────────────────────────────────────────────────

/**
 * Validates a BUY trade against portfolio limits before executing.
 *
 * Checks:
 *   - Max 5 holdings at once
 *   - Not already holding this stock
 *   - Enough cash (trade amount + ₹800 reserve)
 *   - Trade amount ≤ 35% of available cash
 *   - Trade amount ≤ 35% of total portfolio value
 *
 * @param {Object} trade     - Trade object from Claude's decision
 * @param {Object} portfolio - Current portfolio state
 * @returns {boolean}
 */
function canBuy(trade, portfolio) {
  const { cash, totalValue, holdings } = portfolio;
  const CASH_RESERVE    = 800;
  const MAX_HOLDINGS    = 5;
  const MAX_CASH_PCT    = 0.35;
  const MAX_PORTF_PCT   = 0.35;

  if (holdings.length >= MAX_HOLDINGS) {
    logger.info(`BUY blocked: already at max holdings (${MAX_HOLDINGS})`);
    return false;
  }

  if (holdings.some((h) => h.symbol === trade.symbol)) {
    logger.info(`BUY blocked: already holding ${trade.symbol}`);
    return false;
  }

  const needed = trade.totalAmount + CASH_RESERVE;
  if (cash < needed) {
    logger.info(`BUY blocked: insufficient cash (need ₹${needed.toFixed(0)}, have ₹${cash.toFixed(0)})`);
    return false;
  }

  if (trade.totalAmount > cash * MAX_CASH_PCT) {
    logger.info(`BUY blocked: trade exceeds 35% of available cash`);
    return false;
  }

  if (trade.totalAmount > totalValue * MAX_PORTF_PCT) {
    logger.info(`BUY blocked: trade exceeds 35% of portfolio value`);
    return false;
  }

  return true;
}

// ─────────────────────────────────────────────────────────────
// Core Trading Cycle
// ─────────────────────────────────────────────────────────────

/**
 * Full autonomous trading cycle — runs every 5 minutes.
 *
 * This is the heart of ARJUN. The sequence is:
 *   market check → read DB → fetch live data → ask Claude → execute → save
 *
 * All errors are caught and logged. The cycle NEVER throws — it always
 * writes a log to Firestore so the Flutter app shows meaningful status.
 *
 * @returns {Promise<Object>} Cycle result summary
 */
async function runTradingCycle() {
  logger.info("=== ARJUN Trading Cycle Started ===");

  // ── STEP 1: Market hours check ─────────────────────────────
  if (!isMarketOpen()) {
    const { hours, minutes, day } = getCurrentISTComponents();
    logger.info(`Market closed. IST: ${hours}:${String(minutes).padStart(2, "0")}, day: ${day}`);

    await recordAILog({
      timestamp:       Date.now(),
      marketAnalysis:  "Market is closed. NSE trading hours are 09:15–15:30 IST, Monday–Friday.",
      thoughts:        [`Market closed. Current IST: ${hours}:${String(minutes).padStart(2,"0")}.`, "Next session opens at 09:15 IST on the next trading day."],
      portfolioHealth: "OK",
      marketSentiment: "NEUTRAL",
      nextFocus:       "Wait for market to open at 09:15 IST.",
      tradeCount:      0,
      cycleStatus:     "MARKET_CLOSED",
    });

    return { status: "MARKET_CLOSED" };
  }

  // ── STEP 2: Read current portfolio ─────────────────────────
  let portfolio;
  try {
    portfolio = await getPortfolioState();
    logger.info(`Portfolio: cash=₹${portfolio.cash?.toFixed(0)}, holdings=${portfolio.holdings?.length}`);
  } catch (err) {
    logger.error("Failed to read portfolio:", err.message);
    return { status: "ERROR", error: err.message };
  }

  // ── STEP 3: Fetch live market data ─────────────────────────
  let marketOverview, topMovers;
  try {
    [marketOverview, topMovers] = await Promise.all([
      getMarketOverview(),
      getTopMovers(),
    ]);
    logger.info(`Market: Nifty ${marketOverview.nifty50?.changePct}%, mood=${marketOverview.marketMood}, top movers=${topMovers.length}`);
  } catch (err) {
    logger.error("Failed to fetch market data:", err.message);
    await recordAILog({
      timestamp:       Date.now(),
      marketAnalysis:  `Market data fetch failed: ${err.message}`,
      thoughts:        [`Error fetching live data: ${err.message}`],
      portfolioHealth: "OK",
      marketSentiment: "NEUTRAL",
      nextFocus:       "Retry next cycle.",
      tradeCount:      0,
      cycleStatus:     "WAITED",
    });
    return { status: "ERROR", error: err.message };
  }

  // ── STEP 4: Update unrealized P&L on current holdings ──────
  if (portfolio.holdings.length > 0) {
    try {
      const symbols       = portfolio.holdings.map((h) => h.symbol);
      const currentPrices = await getCurrentPrices(symbols);
      portfolio.holdings  = calculateUnrealizedPnL(portfolio.holdings, currentPrices);
      logger.info(`Updated prices for ${symbols.length} holdings`);
    } catch (err) {
      logger.warn("Could not update holding prices (non-fatal):", err.message);
      // Continue with stale prices — don't abort cycle
    }
  }

  // ── STEP 5: Call Claude for trade decision ──────────────────
  let decision;
  try {
    decision = await getTradeDecision(
      { marketOverview, topMovers },
      portfolio
    );
    logger.info(`Claude decision: ${decision.trades?.length} trades, sentiment=${decision.marketSentiment}`);
  } catch (err) {
    logger.error("Claude call failed:", err.message);
    decision = {
      market_analysis: `AI error: ${err.message}`,
      trades:          [],
      portfolioHealth: "OK",
      nextFocus:       "Retry next cycle.",
      marketSentiment: "NEUTRAL",
      aiThoughts:      [`AI error: ${err.message}`],
    };
  }

  // ── STEP 6: Execute trade decisions ────────────────────────
  const executedTrades = [];

  for (const trade of decision.trades || []) {

    // Skip after-3PM new buys (close-of-day rule)
    if (trade.action === "BUY" && isAfter3PM()) {
      logger.info(`BUY ${trade.symbol} skipped — after 3:00 PM IST`);
      continue;
    }

    if (trade.action === "BUY") {
      if (canBuy(trade, portfolio)) {
        // Deduct cash
        portfolio.cash -= trade.totalAmount;

        // Add to holdings
        portfolio.holdings.push({
          symbol:        trade.symbol,
          companyName:   trade.companyName || trade.symbol,
          sector:        trade.sector || "Unknown",
          quantity:      trade.quantity,
          avgBuyPrice:   trade.price,
          currentPrice:  trade.price,
          unrealizedPnl: 0,
          unrealizedPnlPct: 0,
          buyTimestamp:  Date.now(),
          stopLoss:      trade.stopLoss || trade.price * 0.93,
          target:        trade.target   || trade.price * 1.15,
          cyclesHeld:    0,
        });

        // Record trade to Firestore
        await recordTrade({
          ...trade,
          marketSentiment:     decision.marketSentiment,
          portfolioValueAfter: portfolio.totalValue,
        });

        executedTrades.push({ action: "BUY", symbol: trade.symbol });
        logger.info(`BUY executed: ${trade.symbol} × ${trade.quantity} @ ₹${trade.price}`);
      }

    } else if (trade.action === "SELL") {
      const holding = portfolio.holdings.find((h) => h.symbol === trade.symbol);

      if (holding) {
        // Calculate realized P&L
        const sellAmount = trade.price * holding.quantity;
        const pnl        = (trade.price - holding.avgBuyPrice) * holding.quantity;
        const pnlPct     = ((trade.price - holding.avgBuyPrice) / holding.avgBuyPrice) * 100;

        // Add proceeds to cash
        portfolio.cash += sellAmount;

        // Remove holding
        portfolio.holdings = portfolio.holdings.filter(
          (h) => h.symbol !== trade.symbol
        );

        // Record trade to Firestore
        await recordTrade({
          ...trade,
          quantity:            holding.quantity,
          totalAmount:         sellAmount,
          pnl:                 Math.round(pnl * 100) / 100,
          pnlPct:              Math.round(pnlPct * 100) / 100,
          marketSentiment:     decision.marketSentiment,
          portfolioValueAfter: portfolio.totalValue,
        });

        executedTrades.push({ action: "SELL", symbol: trade.symbol, pnl });
        logger.info(`SELL executed: ${trade.symbol} × ${holding.quantity} @ ₹${trade.price}, P&L: ₹${pnl.toFixed(2)}`);
      } else {
        logger.warn(`SELL ${trade.symbol} skipped — not in holdings`);
      }
    }
    // WAIT actions require no execution
  }

  // ── STEP 7: Increment cyclesHeld for all holdings ──────────
  portfolio.holdings = portfolio.holdings.map((h) => ({
    ...h,
    cyclesHeld: (h.cyclesHeld || 0) + 1,
  }));

  // ── STEP 8: Recalculate total portfolio value ───────────────
  const holdingsValue = portfolio.holdings.reduce(
    (sum, h) => sum + (h.currentPrice * h.quantity),
    0
  );
  portfolio.totalValue = Math.round((portfolio.cash + holdingsValue) * 100) / 100;

  // ── STEP 9: Persist everything to Firestore ─────────────────
  try {
    await savePortfolioState(portfolio);
    await recordSnapshot(portfolio);
    await recordAILog({
      timestamp:       Date.now(),
      marketAnalysis:  decision.market_analysis,
      thoughts:        decision.aiThoughts || [],
      portfolioHealth: decision.portfolioHealth,
      marketSentiment: decision.marketSentiment,
      nextFocus:       decision.nextFocus,
      tradeCount:      executedTrades.length,
      cycleStatus:     executedTrades.length > 0 ? "TRADED" : "WAITED",
    });
  } catch (err) {
    logger.error("Failed to save cycle results:", err.message);
  }

  logger.info(`=== Cycle complete. Trades: ${executedTrades.length}, Portfolio: ₹${portfolio.totalValue} ===`);

  return {
    status:         executedTrades.length > 0 ? "TRADED" : "WAITED",
    tradesExecuted: executedTrades.length,
    portfolioValue: portfolio.totalValue,
    sentiment:      decision.marketSentiment,
  };
}

// ─────────────────────────────────────────────────────────────
// FUNCTION 1: tradingLoop — Scheduled every 5 minutes
// ─────────────────────────────────────────────────────────────
/**
 * Scheduled Cloud Function — runs every 5 minutes on weekdays,
 * between 09:00 and 15:55 IST only.
 * Market-hours guard still enforces actual trade window (09:15–15:30 IST),
 * so any out-of-window trigger exits safely.
 *
 * Firebase Blaze plan required for Cloud Scheduler.
 * Timezone: Asia/Kolkata (IST)
 */
exports.tradingLoop = functions
  .runWith({
    timeoutSeconds: 540,   // 9 minutes max (Cloud Function limit)
    memory: "512MB",       // Needed for market data processing
  })
  .pubsub
  .schedule("*/5 9-15 * * 1-5")
  .timeZone("Asia/Kolkata")
  .onRun(async () => {
    try {
      await runTradingCycle();
    } catch (err) {
      logger.error("Unhandled error in tradingLoop:", err);
    }
    return null;
  });

// ─────────────────────────────────────────────────────────────
// FUNCTION 2: manualTrigger — HTTPS Callable from Flutter
// ─────────────────────────────────────────────────────────────
/**
 * HTTPS Callable Cloud Function triggered by the Flutter app.
 * Used in Settings screen: "Run one trading cycle now" (for testing).
 *
 * Flutter usage:
 *   final result = await FirebaseFunctions.instance
 *     .httpsCallable('manualTrigger')
 *     .call();
 *
 * Returns the cycle result to the Flutter caller.
 */
exports.manualTrigger = functions
  .runWith({
    timeoutSeconds: 540,
    memory: "512MB",
  })
  .https
  .onCall(async (data, context) => {
    logger.info("Manual trigger called from Flutter app");
    try {
      const result = await runTradingCycle();
      return { success: true, result };
    } catch (err) {
      logger.error("manualTrigger error:", err);
      return { success: false, error: err.message };
    }
  });

// ─────────────────────────────────────────────────────────────
// FUNCTION 3: resetPortfolio — HTTPS Callable (Settings screen)
// ─────────────────────────────────────────────────────────────
/**
 * Resets ARJUN to ₹10,000 and clears all trading history.
 * Only executes when market is closed (safety guard).
 *
 * Clears: trades collection, ai_logs collection, portfolio/snapshots,
 * then re-initializes portfolio/state to ₹10,000.
 */
exports.resetPortfolio = functions
  .runWith({ timeoutSeconds: 120 })
  .https
  .onCall(async (data, context) => {
    logger.info("Portfolio reset requested");

    // Safety: only allow reset when market is closed
    if (isMarketOpen()) {
      return {
        success: false,
        error: "Cannot reset during market hours. Please try after 15:30 IST.",
      };
    }

    try {
      const db = admin.firestore();
      const batch = db.batch();

      // Delete all trades
      const trades = await db.collection("trades").get();
      trades.docs.forEach((doc) => batch.delete(doc.ref));

      // Delete all ai_logs
      const logs = await db.collection("ai_logs").get();
      logs.docs.forEach((doc) => batch.delete(doc.ref));

      // Delete all snapshots
      const snapshots = await db
        .collection("portfolio")
        .doc("state")
        .collection("snapshots")
        .get();
      snapshots.docs.forEach((doc) => batch.delete(doc.ref));

      await batch.commit();

      // Re-initialize portfolio
      await db.collection("portfolio").doc("state").set({
        cash:            10000,
        totalValue:      10000,
        startingCapital: 10000,
        holdings:        [],
        lastUpdated:     admin.firestore.FieldValue.serverTimestamp(),
      });

      logger.info("Portfolio reset to ₹10,000");
      return { success: true, message: "Portfolio reset to ₹10,000 successfully." };
    } catch (err) {
      logger.error("resetPortfolio failed:", err.message);
      return { success: false, error: err.message };
    }
  });

// ─────────────────────────────────────────────────────────────
// Swing Trade Validation
// ─────────────────────────────────────────────────────────────

/**
 * Validates a swing BUY trade against swing portfolio limits.
 * More conservative than intraday — max 3 holdings, 40% caps.
 */
function canSwingBuy(trade, portfolio) {
  const { cash, totalValue, holdings } = portfolio;
  const CASH_RESERVE  = 1000;
  const MAX_HOLDINGS  = 3;
  const MAX_CASH_PCT  = 0.40;
  const MAX_PORTF_PCT = 0.40;

  if (holdings.length >= MAX_HOLDINGS) {
    logger.info(`SWING BUY blocked: already at max holdings (${MAX_HOLDINGS})`);
    return false;
  }

  if (holdings.some((h) => h.symbol === trade.symbol)) {
    logger.info(`SWING BUY blocked: already holding ${trade.symbol}`);
    return false;
  }

  const needed = trade.totalAmount + CASH_RESERVE;
  if (cash < needed) {
    logger.info(`SWING BUY blocked: insufficient cash (need ₹${needed.toFixed(0)}, have ₹${cash.toFixed(0)})`);
    return false;
  }

  if (trade.totalAmount > cash * MAX_CASH_PCT) {
    logger.info(`SWING BUY blocked: trade exceeds 40% of available cash`);
    return false;
  }

  if (trade.totalAmount > totalValue * MAX_PORTF_PCT) {
    logger.info(`SWING BUY blocked: trade exceeds 40% of portfolio value`);
    return false;
  }

  return true;
}

// ─────────────────────────────────────────────────────────────
// Core Swing Trading Cycle
// ─────────────────────────────────────────────────────────────

/**
 * Full swing trading cycle — runs every hour.
 *
 * Unlike intraday, this cycle runs 24/7 for analysis but only executes
 * trades during NSE market hours (09:15–15:30 IST).
 * Web search gives Claude live Indian financial news context.
 */
async function runSwingTradingCycle() {
  logger.info("=== ARJUN Swing Trading Cycle Started ===");

  // Stagger swing vs intraday — both fire at :15 past the hour.
  // A 20-second delay ensures swing hits NSE after intraday has already
  // warmed up the session, preventing simultaneous 403s at 9:15 AM.
  await new Promise((res) => setTimeout(res, 20000));

  // ── STEP 1: Read swing portfolio ────────────────────────────
  let portfolio;
  try {
    portfolio = await getSwingPortfolioState();
    logger.info(`Swing portfolio: cash=₹${portfolio.cash?.toFixed(0)}, holdings=${portfolio.holdings?.length}`);
  } catch (err) {
    logger.error("Failed to read swing portfolio:", err.message);
    return { status: "ERROR", error: err.message };
  }

  // ── STEP 2: Fetch live market data ──────────────────────────
  let marketOverview, topMovers;
  try {
    [marketOverview, topMovers] = await Promise.all([
      getMarketOverview(),
      getTopMovers(),
    ]);
    logger.info(`Swing market: Nifty ${marketOverview.nifty50?.changePct}%, mood=${marketOverview.marketMood}`);
  } catch (err) {
    logger.error("Swing failed to fetch market data:", err.message);
    await recordSwingAILog({
      timestamp:       Date.now(),
      marketAnalysis:  `Market data fetch failed: ${err.message}`,
      thoughts:        [`Error fetching live data: ${err.message}`],
      portfolioHealth: "OK",
      marketSentiment: "NEUTRAL",
      nextFocus:       "Retry next hourly cycle.",
      tradeCount:      0,
      cycleStatus:     "WAITED",
      webSearchUsed:   false,
    });
    return { status: "ERROR", error: err.message };
  }

  // ── STEP 3: Update unrealized P&L on swing holdings ─────────
  if (portfolio.holdings.length > 0) {
    try {
      const symbols       = portfolio.holdings.map((h) => h.symbol);
      const currentPrices = await getCurrentPrices(symbols);
      portfolio.holdings  = calculateSwingUnrealizedPnL(portfolio.holdings, currentPrices);
      logger.info(`Swing: updated prices for ${symbols.length} holdings`);
    } catch (err) {
      logger.warn("Swing: could not update holding prices (non-fatal):", err.message);
    }
  }

  // ── STEP 3b: Auto-enforce stop-loss for swing holdings ──────
  // If any holding is down ≥7% from buy price, force a SELL regardless of Claude.
  // This prevents a stock from bleeding further while Claude keeps holding.
  if (isMarketOpen() && portfolio.holdings.length > 0) {
    const autoSells = portfolio.holdings.filter((h) => {
      const pnlPct = ((h.currentPrice - h.avgBuyPrice) / h.avgBuyPrice) * 100;
      return pnlPct <= -7;
    });

    for (const h of autoSells) {
      const sellAmount = h.currentPrice * h.quantity;
      const pnl        = (h.currentPrice - h.avgBuyPrice) * h.quantity;
      const pnlPct     = ((h.currentPrice - h.avgBuyPrice) / h.avgBuyPrice) * 100;
      const holdDays   = Math.floor((Date.now() - (h.buyTimestamp || Date.now())) / (1000 * 60 * 60 * 24));

      portfolio.cash += sellAmount;
      portfolio.holdings = portfolio.holdings.filter((x) => x.symbol !== h.symbol);

      await recordSwingTrade({
        action:              "SELL",
        symbol:              h.symbol,
        companyName:         h.companyName,
        sector:              h.sector,
        quantity:            h.quantity,
        price:               h.currentPrice,
        totalAmount:         sellAmount,
        pnl:                 Math.round(pnl * 100) / 100,
        pnlPct:              Math.round(pnlPct * 100) / 100,
        reason:              `Auto stop-loss triggered: stock down ${pnlPct.toFixed(1)}% from buy price ₹${h.avgBuyPrice}`,
        confidence:          "HIGH",
        tradeType:           "SWING_STOP_LOSS",
        marketSentiment:     "NEUTRAL",
        portfolioValueAfter: portfolio.totalValue,
        holdDays,
        newsContext:         "",
      });

      logger.warn(`SWING AUTO STOP-LOSS: ${h.symbol} sold @ ₹${h.currentPrice} (down ${pnlPct.toFixed(1)}%), P&L: ₹${pnl.toFixed(2)}`);
    }
  }

  // ── STEP 4: Call Claude with web_search for swing decision ──
  let decision;
  let webSearchUsed = false;
  try {
    const result = await getSwingDecision(
      { marketOverview, topMovers },
      portfolio
    );
    decision      = result.decision;
    webSearchUsed = result.webSearchUsed;
    logger.info(`Swing Claude: ${decision.trades?.length} trades, sentiment=${decision.marketSentiment}, webSearch=${webSearchUsed}`);
  } catch (err) {
    logger.error("Swing Claude call failed:", err.message);
    decision = {
      market_analysis: `Swing AI error: ${err.message}`,
      trades:          [],
      portfolioHealth: "OK",
      nextFocus:       "Retry next cycle.",
      marketSentiment: "NEUTRAL",
      aiThoughts:      [`Swing AI error: ${err.message}`],
    };
  }

  // ── STEP 5: Execute swing trades (only during market hours) ─
  const executedTrades = [];
  const marketOpen = isMarketOpen();

  for (const trade of decision.trades || []) {

    if (trade.action === "BUY") {
      if (!marketOpen) {
        logger.info(`SWING BUY ${trade.symbol} skipped — market is closed`);
        continue;
      }

      if (canSwingBuy(trade, portfolio)) {
        portfolio.cash -= trade.totalAmount;

        portfolio.holdings.push({
          symbol:           trade.symbol,
          companyName:      trade.companyName  || trade.symbol,
          sector:           trade.sector       || "Unknown",
          quantity:         trade.quantity,
          avgBuyPrice:      trade.price,
          currentPrice:     trade.price,
          unrealizedPnl:    0,
          unrealizedPnlPct: 0,
          buyTimestamp:     Date.now(),
          stopLoss:         trade.stopLoss     || trade.price * 0.93,
          target:           trade.target       || trade.price * 1.22,
          cyclesHeld:       0,
        });

        await recordSwingTrade({
          ...trade,
          marketSentiment:     decision.marketSentiment,
          portfolioValueAfter: portfolio.totalValue,
          newsContext:         trade.newsContext || "",
        });

        executedTrades.push({ action: "BUY", symbol: trade.symbol });
        logger.info(`SWING BUY executed: ${trade.symbol} × ${trade.quantity} @ ₹${trade.price}`);
      }

    } else if (trade.action === "SELL") {
      const holding = portfolio.holdings.find((h) => h.symbol === trade.symbol);

      if (holding) {
        if (!marketOpen) {
          logger.info(`SWING SELL ${trade.symbol} skipped — market is closed (will retry next open)`);
          continue;
        }

        const sellAmount = trade.price * holding.quantity;
        const pnl        = (trade.price - holding.avgBuyPrice) * holding.quantity;
        const pnlPct     = ((trade.price - holding.avgBuyPrice) / holding.avgBuyPrice) * 100;
        const holdDays   = Math.floor((Date.now() - (holding.buyTimestamp || Date.now())) / (1000 * 60 * 60 * 24));

        portfolio.cash += sellAmount;
        portfolio.holdings = portfolio.holdings.filter((h) => h.symbol !== trade.symbol);

        await recordSwingTrade({
          ...trade,
          quantity:            holding.quantity,
          totalAmount:         sellAmount,
          pnl:                 Math.round(pnl * 100) / 100,
          pnlPct:              Math.round(pnlPct * 100) / 100,
          marketSentiment:     decision.marketSentiment,
          portfolioValueAfter: portfolio.totalValue,
          holdDays,
          newsContext:         trade.newsContext || "",
        });

        executedTrades.push({ action: "SELL", symbol: trade.symbol, pnl });
        logger.info(`SWING SELL executed: ${trade.symbol} × ${holding.quantity} @ ₹${trade.price}, P&L: ₹${pnl.toFixed(2)}, days held: ${holdDays}`);
      } else {
        logger.warn(`SWING SELL ${trade.symbol} skipped — not in holdings`);
      }
    }
  }

  // ── STEP 6: Increment cyclesHeld for all swing holdings ─────
  portfolio.holdings = portfolio.holdings.map((h) => ({
    ...h,
    cyclesHeld: (h.cyclesHeld || 0) + 1,
  }));

  // ── STEP 7: Recalculate total portfolio value ────────────────
  const holdingsValue = portfolio.holdings.reduce(
    (sum, h) => sum + (h.currentPrice * h.quantity),
    0
  );
  portfolio.totalValue = Math.round((portfolio.cash + holdingsValue) * 100) / 100;

  // ── STEP 8: Persist to Firestore ────────────────────────────
  try {
    await saveSwingPortfolioState(portfolio);
    await recordSwingSnapshot(portfolio);
    await recordSwingAILog({
      timestamp:       Date.now(),
      marketAnalysis:  decision.market_analysis,
      thoughts:        decision.aiThoughts || [],
      portfolioHealth: decision.portfolioHealth,
      marketSentiment: decision.marketSentiment,
      nextFocus:       decision.nextFocus,
      tradeCount:      executedTrades.length,
      cycleStatus:     executedTrades.length > 0 ? "TRADED" : (marketOpen ? "WAITED" : "ANALYSING"),
      webSearchUsed,
    });
  } catch (err) {
    logger.error("Failed to save swing cycle results:", err.message);
  }

  logger.info(`=== Swing cycle complete. Trades: ${executedTrades.length}, Portfolio: ₹${portfolio.totalValue}, webSearch: ${webSearchUsed} ===`);

  return {
    status:         executedTrades.length > 0 ? "TRADED" : "WAITED",
    tradesExecuted: executedTrades.length,
    portfolioValue: portfolio.totalValue,
    sentiment:      decision.marketSentiment,
    webSearchUsed,
  };
}

// ─────────────────────────────────────────────────────────────
// FUNCTION 4: runDummyTradeTest — HTTPS Callable (Settings screen)
// ─────────────────────────────────────────────────────────────
/**
 * Executes a synthetic BUY or SELL test trade even when market is closed.
 * This is a pipeline health-check only (callable → Firestore write → app UI).
 * It does NOT modify the real portfolio holdings/cash.
 */
exports.runDummyTradeTest = functions
  .runWith({ timeoutSeconds: 120 })
  .https
  .onCall(async (data, context) => {
    const requestedAction = String(data?.action || "").toUpperCase();
    const action = requestedAction === "SELL" ? "SELL" : "BUY";
    const symbol = "DUMMYTEST";
    const price = 123.45;
    const quantity = 5;
    const totalAmount = Number((price * quantity).toFixed(2));

    logger.info(`Dummy trade test requested. Action=${action}`);

    try {
      await recordTrade({
        action,
        symbol,
        companyName: "Dummy Test Instrument",
        sector: "Test",
        quantity,
        price,
        totalAmount,
        reason: "Manual dummy trade test from Settings screen.",
        confidence: "LOW",
        stopLoss: action === "BUY" ? 115 : 0,
        target: action === "BUY" ? 135 : 0,
        tradeType: "MOMENTUM",
        marketSentiment: "NEUTRAL",
        portfolioValueAfter: 0,
      });

      await recordAILog({
        timestamp: Date.now(),
        marketAnalysis: "Dummy trade pipeline test executed manually from app settings.",
        thoughts: [
          `Synthetic ${action} recorded for ${symbol}.`,
          "This test bypasses market-hours guard intentionally.",
          "No portfolio cash/holdings were modified.",
        ],
        portfolioHealth: "OK",
        marketSentiment: "NEUTRAL",
        nextFocus: "Confirm logs and trade history render correctly in app UI.",
        tradeCount: 1,
        cycleStatus: "WAITED",
      });

      return {
        success: true,
        message: `Dummy ${action} trade recorded successfully.`,
        trade: { action, symbol, quantity, price, totalAmount },
      };
    } catch (err) {
      logger.error("runDummyTradeTest failed:", err.message);
      return { success: false, error: err.message };
    }
  });

// ─────────────────────────────────────────────────────────────
// FUNCTION 5: swingLoop — Scheduled every hour
// ─────────────────────────────────────────────────────────────
/**
 * Runs the swing trading cycle every hour at :15 past the hour.
 * Claude uses web_search to browse Indian financial news.
 * Runs at 09:15, 10:15, 11:15, 12:15, 13:15, 14:15, 15:15 IST, Mon–Fri.
 * The intraday market-hours guard ensures trades only execute 09:15–15:30.
 */
exports.swingLoop = functions
  .runWith({
    timeoutSeconds: 540,
    memory: "512MB",
  })
  .pubsub
  .schedule("15 9-15 * * 1-5")
  .timeZone("Asia/Kolkata")
  .onRun(async () => {
    try {
      await runSwingTradingCycle();
    } catch (err) {
      logger.error("Unhandled error in swingLoop:", err);
    }
    return null;
  });

// ─────────────────────────────────────────────────────────────
// FUNCTION 6: manualSwingTrigger — HTTPS Callable from Flutter
// ─────────────────────────────────────────────────────────────
/**
 * Manually trigger one swing trading cycle from the Settings screen.
 * Useful for testing web search and swing logic without waiting an hour.
 */
exports.manualSwingTrigger = functions
  .runWith({
    timeoutSeconds: 540,
    memory: "512MB",
  })
  .https
  .onCall(async (data, context) => {
    logger.info("Manual swing trigger called from Flutter app");
    try {
      const result = await runSwingTradingCycle();
      return { success: true, result };
    } catch (err) {
      logger.error("manualSwingTrigger error:", err);
      return { success: false, error: err.message };
    }
  });

// ─────────────────────────────────────────────────────────────
// FUNCTION 7: resetSwingPortfolio — HTTPS Callable (Settings screen)
// ─────────────────────────────────────────────────────────────
/**
 * Resets the swing portfolio to ₹10,000 and clears all swing history.
 * Only executes when market is closed (safety guard).
 */
exports.resetSwingPortfolio = functions
  .runWith({ timeoutSeconds: 120 })
  .https
  .onCall(async (data, context) => {
    logger.info("Swing portfolio reset requested");

    if (isMarketOpen()) {
      return {
        success: false,
        error: "Cannot reset during market hours. Please try after 15:30 IST.",
      };
    }

    try {
      const db = admin.firestore();
      const batch = db.batch();

      // Delete all swing trades
      const trades = await db.collection("swing_trades").get();
      trades.docs.forEach((doc) => batch.delete(doc.ref));

      // Delete all swing ai_logs
      const logs = await db.collection("swing_ai_logs").get();
      logs.docs.forEach((doc) => batch.delete(doc.ref));

      // Delete all swing snapshots
      const snapshots = await db
        .collection("swing_portfolio")
        .doc("state")
        .collection("snapshots")
        .get();
      snapshots.docs.forEach((doc) => batch.delete(doc.ref));

      await batch.commit();

      // Re-initialize swing portfolio
      await db.collection("swing_portfolio").doc("state").set({
        cash:            10000,
        totalValue:      10000,
        startingCapital: 10000,
        holdings:        [],
        lastUpdated:     admin.firestore.FieldValue.serverTimestamp(),
      });

      logger.info("Swing portfolio reset to ₹10,000");
      return { success: true, message: "Swing portfolio reset to ₹10,000 successfully." };
    } catch (err) {
      logger.error("resetSwingPortfolio failed:", err.message);
      return { success: false, error: err.message };
    }
  });
