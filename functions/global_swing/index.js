/**
 * global_swing/index.js
 * =======================
 * ARJUN GLOBAL SWING — hourly cycle orchestrator.
 *
 * This is the single entry point called by the Firebase Cloud Functions
 * scheduler every hour. It coordinates all steps in the correct order.
 *
 * CYCLE SEQUENCE:
 *  ① Read portfolio state from Firestore
 *  ② Fetch market mood for all 4 markets (India/US/Germany/Japan) in parallel
 *  ③ Determine which are OPEN + BULLISH → only these get new buy candidates
 *  ④ Fetch live prices for current holdings (NSE for India, EODHD for rest)
 *  ⑤ Update unrealised P&L on all holdings
 *  ⑥ Auto-enforce hard stop-loss (−7%) in CODE — does not wait for Claude
 *  ⑦ Fetch top movers from BULLISH open markets (from pre-configured watchlists)
 *  ⑧ Fetch 30-day OHLCV + compute RSI/EMA/52W for candidates + holdings
 *  ⑨ Increment daysHeld (once per calendar day)
 *  ⑩ Ask Claude for trading decision (no web search — structured data only)
 *  ⑪ Validate each proposed trade (code-level gates in trade_validator.js)
 *  ⑫ Execute valid trades (paper mode; IBKR-ready interface in trade_executor.js)
 *  ⑬ Recalculate total portfolio value in INR
 *  ⑭ Save portfolio state + hourly snapshot + AI log to Firestore
 *
 * MARKETS COVERED (for Indians via LRS scheme):
 *   🇮🇳 India  (NSE)   09:15–15:30 IST
 *   🇯🇵 Japan  (TSE)   05:30–12:00 IST
 *   🇩🇪 Germany(XETRA) 13:30–22:00 IST
 *   🇺🇸 USA    (NYSE)  19:30–01:30 IST
 */

const logger = require("firebase-functions/logger");

// ── Data layer ────────────────────────────────────────────────
const { getLiveQuotes, getTopMovers, getLiveUsdInrRate } = require("./data/eodhd_live");
const { getBatchHistoricalCandles }         = require("./data/eodhd_history");
const { getNSELivePrices, getNSEBroadMovers } = require("./data/nse_live");
const { getDynamicTopMovers }               = require("./data/eodhd_screener");
const { clearEohdCache }                    = require("./data/eodhd_client");

// ── Analysis layer ────────────────────────────────────────────
const {
  getAllMarketMoods,
  selectBullishOpenMarkets,
  isMarketOpen,
} = require("./analysis/market_mood");
const { computeIndicators }                 = require("./analysis/technical");

// ── Trading layer ─────────────────────────────────────────────
const { getSwingDecision }                  = require("./trading/swing_brain");
const { validateBuy, validateSell }         = require("./trading/trade_validator");
const { executeBuy, executeSell }           = require("./trading/trade_executor");

// ── DB layer ──────────────────────────────────────────────────
const {
  getPortfolioState,
  savePortfolioState,
  recordSnapshot,
  recordAILog,
  updateHoldingsPnL,
  calcTotalValueINR,
} = require("./db/firestore_db");

// ── Config ────────────────────────────────────────────────────
const { MARKETS }  = require("./config/markets");
const R            = require("./config/trading_rules");

// ─────────────────────────────────────────────────────────────
// Main exported cycle function
// ─────────────────────────────────────────────────────────────

async function runGlobalSwingCycle() {
  const cycleStart = Date.now();
  logger.info("═══════════════════════════════════════════════");
  logger.info("  ARJUN Global Swing Cycle — START");
  logger.info("═══════════════════════════════════════════════");

  // Fresh cycle → clear stale EODHD cache
  clearEohdCache();

  // ── ① Read portfolio + fetch live USD/INR rate ──────────────
  let portfolio;
  try {
    portfolio = await getPortfolioState();

    // Update to live FX rate every cycle (non-fatal if it fails)
    const liveRate = await getLiveUsdInrRate();
    portfolio.usdInrRate = liveRate;

    logger.info(
      `Portfolio: ₹${(portfolio.capitalINR || 0).toFixed(0)} available | ` +
      `${portfolio.holdings?.length} holdings | ` +
      `USD/INR: ₹${liveRate}`
    );
  } catch (err) {
    logger.error("Cannot read portfolio — aborting cycle:", err.message);
    return { cycleStatus: "ERROR", error: err.message };
  }

  // ── ② Market moods (all 4 markets in parallel) ──────────────
  let marketMoods;
  try {
    marketMoods = await getAllMarketMoods();
    const summary = Object.values(marketMoods)
      .map(m => `${m.flag}${m.marketCode}:${m.mood[0]}${m.isOpen ? "O" : "C"}`)
      .join(" │ ");
    logger.info(`Market moods: ${summary}`);
  } catch (err) {
    logger.error("Market mood fetch failed — aborting:", err.message);
    await recordAILog({
      cycleStatus: "ERROR", tradeCount: 0,
      marketAnalysis: `Mood fetch error: ${err.message}`,
      thoughts: [`Error: ${err.message}`], portfolioHealth: "OK",
      nextFocus: "Retry next hour.",
    });
    return { cycleStatus: "ERROR", error: err.message };
  }

  const bullishOpen = selectBullishOpenMarkets(marketMoods);
  const openMarkets = Object.keys(marketMoods).filter(c => marketMoods[c].isOpen);

  const rankedSummary = bullishOpen.length > 0
    ? bullishOpen.map(m => `${m.flag}${m.marketCode}(${m.score})`).join(" → ")
    : "none — hold cash";
  logger.info(`Open markets: [${openMarkets.join(", ")}] | Bullish rank: ${rankedSummary}`);

  // ── ③ Live prices for current holdings ──────────────────────
  if (portfolio.holdings.length > 0) {
    try {
      const holdSymbols   = portfolio.holdings.map(h => h.symbol);
      const indiaSymbols  = holdSymbols.filter(s => s.endsWith(".NSE"));
      const foreignSymbols = holdSymbols.filter(s => !s.endsWith(".NSE"));

      let priceMap = {};

      // India: try NSE (real-time), fall back to EODHD (delayed)
      if (indiaSymbols.length > 0) {
        const nsePrices = await getNSELivePrices(indiaSymbols);
        Object.assign(priceMap, nsePrices);
        // EODHD fallback for any symbols NSE didn't return
        const missing = indiaSymbols.filter(s => !priceMap[s]);
        if (missing.length > 0) {
          const eohdFallback = await getLiveQuotes(missing);
          for (const [sym, q] of Object.entries(eohdFallback)) {
            priceMap[sym] = q.price;
          }
        }
      }

      // Foreign (US / Germany / Japan): always EODHD
      if (foreignSymbols.length > 0) {
        const foreignPrices = await getLiveQuotes(foreignSymbols);
        for (const [sym, q] of Object.entries(foreignPrices)) {
          priceMap[sym] = q.price;
        }
      }

      portfolio.holdings = updateHoldingsPnL(
        portfolio.holdings, priceMap, portfolio.usdInrRate || 84.0
      );
      logger.info(`Updated prices for ${Object.keys(priceMap).length}/${holdSymbols.length} holdings`);

    } catch (err) {
      logger.warn("Holdings price update failed (non-fatal):", err.message);
    }
  }

  // ── ④ Auto-enforce hard stop-loss (−7%) in CODE ──────────────
  // This runs BEFORE Claude so the portfolio is clean when Claude decides.
  const autoStopSymbols = [];
  for (const h of [...portfolio.holdings]) {
    // Only enforce stops in open markets
    if (!isMarketOpen(h.market)) continue;

    const pnlPct = h.unrealizedPnlPct ?? 0;
    if (pnlPct <= R.STOP_LOSS_PCT) {
      logger.warn(`AUTO STOP-LOSS: ${h.symbol} at ${pnlPct.toFixed(2)}% — selling now`);
      await executeSell(
        {
          symbol:     h.symbol,
          quantity:   h.quantity,
          price:      h.currentPrice || h.avgBuyPrice,
          tradeType:  "SWING_STOP_LOSS",
          reason:     `Auto stop-loss: down ${pnlPct.toFixed(1)}% from buy price ${h.avgBuyPrice}`,
          confidence: "HIGH",
        },
        portfolio,
        portfolio.usdInrRate || 84.0
      );
      autoStopSymbols.push(h.symbol);
    }
  }

  // Recalc after auto-stops
  portfolio.totalValueINR = calcTotalValueINR(portfolio);

  // ── ⑤ Top movers from BULLISH open markets ──────────────────
  // PRIMARY: scan the full exchange dynamically each cycle.
  //   India  → NSE free API  (full Nifty 500, 500 stocks, 0 EODHD credits)
  //   US/DE/JP → EODHD Screener (full exchange scan, $29.99 plan)
  //
  // FALLBACK: if primary scanner unavailable → use expanded watchlist.
  //
  const candidates = {}; // { "NSE": [{symbol, price, changePct, indicators}], ... }

  for (const mood of bullishOpen) {
    const market = MARKETS[mood.marketCode];
    if (!market) continue;

    try {
      let movers = [];

      if (mood.marketCode === "NSE") {
        // ── India: NSE free API scans full Nifty 500 ──────────────
        movers = await getNSEBroadMovers(R.MIN_CHANGE_PCT, 200000, 25);

        if (movers.length === 0) {
          // Fallback: NSE API blocked (GCP 403) → use watchlist
          logger.warn("NSE broad scan returned 0 — falling back to watchlist");
          movers = await getTopMovers(market.watchlist, R.MIN_CHANGE_PCT, 15);
        }
      } else {
        // ── US / Germany / Japan: EODHD Screener (full exchange) ──
        movers = await getDynamicTopMovers(mood.marketCode, R.MIN_CHANGE_PCT, 25);

        if (movers.length === 0) {
          // Fallback: screener unavailable → use expanded watchlist
          logger.warn(`${mood.marketCode} screener returned 0 — falling back to watchlist`);
          movers = await getTopMovers(market.watchlist, R.MIN_CHANGE_PCT, 15);
        }
      }

      if (movers.length === 0) continue;

      logger.info(
        `${mood.flag} ${mood.marketCode}: scanning ${movers.length} movers ` +
        `(from full ${mood.marketCode === "NSE" ? "Nifty 500" : "exchange"} scan)`
      );

      // Fetch 30-day OHLCV for candidates (needed for technical indicators)
      const candleMap = await getBatchHistoricalCandles(movers.map(m => m.symbol));

      const withIndicators = movers.map(m => ({
        ...m,
        market:     mood.marketCode,
        currency:   market.currency,
        indicators: computeIndicators(candleMap[m.symbol] || [], m.volume || 0),
      }));

      // Pre-filter before sending to Claude (reduces prompt size + noise)
      // Log how many stocks each filter removes so we can diagnose "0 candidates" cycles
      const tooOverbought = withIndicators.filter(s => s.indicators.rsi > R.MAX_RSI_ENTRY).length;
      const fallingKnife  = withIndicators.filter(s => s.indicators.rsi < R.MIN_RSI_ENTRY).length;
      const near52wHigh   = withIndicators.filter(s => s.indicators.pctBelow52wHigh < R.MAX_52W_HIGH_DIST_PCT).length;

      logger.info(
        `${mood.flag} ${mood.marketCode} filter breakdown: ` +
        `${withIndicators.length} movers → ` +
        `RSI overbought (>${R.MAX_RSI_ENTRY}): ${tooOverbought} removed, ` +
        `RSI falling knife (<${R.MIN_RSI_ENTRY}): ${fallingKnife} removed, ` +
        `near 52W high (<${R.MAX_52W_HIGH_DIST_PCT}%): ${near52wHigh} removed`
      );

      const filtered = withIndicators.filter(s => {
        const ind = s.indicators;
        return (
          ind.rsi >= R.MIN_RSI_ENTRY &&
          ind.rsi <= R.MAX_RSI_ENTRY &&
          ind.pctBelow52wHigh >= R.MAX_52W_HIGH_DIST_PCT
        );
      });

      if (filtered.length > 0) {
        // Cap at 12 per market for Claude's prompt size
        candidates[mood.marketCode] = filtered.slice(0, 12);
        logger.info(
          `${mood.flag} ${mood.marketCode} candidates: ` +
          `${filtered.length} qualified → ${candidates[mood.marketCode].length} sent to Claude`
        );
      } else {
        logger.warn(
          `${mood.flag} ${mood.marketCode}: 0 candidates survived filters — ` +
          `market may be overextended (stocks near 52W highs after strong rally)`
        );
      }

    } catch (err) {
      logger.warn(`Candidate scan failed for ${mood.marketCode}: ${err.message}`);
    }
  }

  // ── ⑥ 30-day history for current holdings ───────────────────
  // Holdings need history for exit-signal indicators (RSI, trend, 52W).
  const holdingsWithHistory = {};

  if (portfolio.holdings.length > 0) {
    try {
      const holdSymbols = portfolio.holdings.map(h => h.symbol);
      const candleMap   = await getBatchHistoricalCandles(holdSymbols);

      for (const h of portfolio.holdings) {
        const candles   = candleMap[h.symbol] || [];
        holdingsWithHistory[h.symbol] = {
          candles,
          indicators: computeIndicators(candles, 0),
        };
      }
    } catch (err) {
      logger.warn("Holdings history fetch failed (non-fatal):", err.message);
    }
  }

  // ── ⑦ Increment daysHeld (once per calendar day) ────────────
  const todayDate = new Date().toISOString().split("T")[0];
  if (portfolio.lastDaysHeldDate !== todayDate) {
    portfolio.holdings = portfolio.holdings.map(h => ({
      ...h,
      daysHeld:   (h.daysHeld   || 0) + 1,
      cyclesHeld: (h.cyclesHeld || 0) + 1,
    }));
    portfolio.lastDaysHeldDate = todayDate;
  } else {
    // Increment cyclesHeld every hour but daysHeld only daily
    portfolio.holdings = portfolio.holdings.map(h => ({
      ...h,
      cyclesHeld: (h.cyclesHeld || 0) + 1,
    }));
  }

  // ── ⑧ Claude decision ────────────────────────────────────────
  let decision;
  try {
    decision = await getSwingDecision({
      portfolio,
      marketMoods,
      candidates,
      holdingsWithHistory,
    });
    logger.info(
      `Claude: ${decision.trades?.length || 0} trades proposed | ` +
      `health=${decision.portfolioHealth}`
    );
  } catch (err) {
    logger.error("Claude decision failed:", err.message);
    decision = {
      trades:          [],
      portfolioHealth: "OK",
      marketAnalysis:  `Claude error: ${err.message}`,
      thoughts:        [`Error: ${err.message}`],
      nextFocus:       "Retry next cycle.",
    };
  }

  // ── ⑨ Validate + execute trades ─────────────────────────────
  let tradesExecuted     = 0;
  let rotationsThisCycle = 0;

  for (const trade of (decision.trades || [])) {
    // Gate: market must be open right now for execution
    if (!isMarketOpen(trade.market)) {
      logger.info(`Skip ${trade.action} ${trade.symbol}: ${trade.market} is currently closed`);
      continue;
    }

    if (trade.action === "BUY") {
      // Enforce rotation limit
      if (trade.tradeType === "SWING_ROTATION" && rotationsThisCycle >= R.MAX_ROTATIONS_PER_CYCLE) {
        logger.info(`Rotation limit reached — skipping BUY ${trade.symbol}`);
        continue;
      }

      // Get pre-computed indicators for this symbol
      const candidateStock = (candidates[trade.market] || []).find(c => c.symbol === trade.symbol);
      const indicators     = candidateStock?.indicators || {};
      const marketMood     = marketMoods[trade.market]?.mood || "NEUTRAL";

      const { ok, reason } = validateBuy(trade, portfolio, indicators, marketMood);
      if (!ok) {
        logger.info(`BUY blocked [${trade.symbol}]: ${reason}`);
        continue;
      }

      const executed = await executeBuy(trade, portfolio, marketMood);
      if (executed) {
        tradesExecuted++;
        if (trade.tradeType === "SWING_ROTATION") rotationsThisCycle++;
      }

    } else if (trade.action === "SELL") {
      const { ok, reason } = validateSell(trade, portfolio);
      if (!ok) {
        logger.info(`SELL blocked [${trade.symbol}]: ${reason}`);
        continue;
      }

      const executed = await executeSell(trade, portfolio, portfolio.usdInrRate || 84.0);
      if (executed) tradesExecuted++;
    }
  }

  // ── ⑩ Recalculate total value ────────────────────────────────
  portfolio.totalValueINR = calcTotalValueINR(portfolio);

  // ── ⑪ Save to Firestore ──────────────────────────────────────
  try {
    await savePortfolioState(portfolio);
    await recordSnapshot(portfolio);
  } catch (err) {
    logger.error("Failed to persist portfolio:", err.message);
  }

  // ── ⑫ Record AI log ──────────────────────────────────────────
  const cycleStatus = tradesExecuted > 0 ? "TRADED" : "WAITED";
  const elapsed     = ((Date.now() - cycleStart) / 1000).toFixed(1);

  await recordAILog({
    timestamp:       Date.now(),
    cycleStatus,
    tradeCount:      tradesExecuted + autoStopSymbols.length,
    marketsAnalyzed: Object.keys(marketMoods),
    bullishMarkets:  bullishOpen.map(m => m.marketCode),
    openMarkets,
    marketAnalysis:  decision.marketAnalysis  || "",
    thoughts:        decision.thoughts        || [],
    portfolioHealth: decision.portfolioHealth || "OK",
    nextFocus:       decision.nextFocus       || "",
  });

  logger.info("═══════════════════════════════════════════════");
  logger.info(`  ARJUN Global Swing: ${cycleStatus} | ${tradesExecuted} Claude trades | ${autoStopSymbols.length} auto-stops | ${elapsed}s`);
  logger.info(`  Portfolio: ₹${(portfolio.totalValueINR || 0).toFixed(0)} | Cash: ₹${(portfolio.capitalINR || 0).toFixed(0)} | P&L: ₹${((portfolio.totalValueINR || 0) - (portfolio.startingCapital || 100000)).toFixed(0)}`);
  logger.info("═══════════════════════════════════════════════");

  return { cycleStatus, tradesExecuted };
}

module.exports = { runGlobalSwingCycle };
