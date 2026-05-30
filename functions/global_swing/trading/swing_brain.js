/**
 * global_swing/trading/swing_brain.js
 * =====================================
 * ARJUN GLOBAL SWING v2 — Claude AI decision engine.
 *
 * KEY DIFFERENCES vs old swing_trader.js:
 *   ❌ NO web_search tool — completely removed
 *   ✅ 30-day OHLCV candles → real RSI, EMA, 52W proximity
 *   ✅ Per-market bullish/bearish mood computed from actual index data
 *   ✅ "Only buy in BULLISH + OPEN markets" rule enforced at prompt level
 *   ✅ 52W high distance shown explicitly → Claude sees the COFORGE risk
 *   ✅ Volume ratio shown → confirms institutional participation
 *   ✅ 4 markets (India, US, Germany, Japan) in one decision cycle
 *
 * NO WEB SEARCH NEEDED BECAUSE:
 *   - 30-day price history + RSI + EMA gives the full technical picture
 *   - Market mood is computed from real index data (not qualitative news)
 *   - Claude's job is pattern recognition on structured numbers, not news reading
 *
 * IBKR MIGRATION NOTE:
 *   Claude's output JSON is market-agnostic (symbol + market code + currency).
 *   trade_executor.js handles the actual execution.
 *   To go live: change TRADING_MODE in trading_rules.js + implement trade_executor.
 *   This file does NOT change for IBKR migration.
 */

const Anthropic = require("@anthropic-ai/sdk");
const logger    = require("firebase-functions/logger");
const R         = require("../config/trading_rules");

// ── API key — read from process.env (set in functions/.env) ──
function getAnthropicKey() {
  return process.env.ANTHROPIC_API_KEY || null;
}

// ─────────────────────────────────────────────────────────────
// System Prompt — ARJUN GLOBAL SWING v3 (master rules)
// ─────────────────────────────────────────────────────────────

function buildSystemPrompt() {
  return `You are ARJUN GLOBAL SWING — a disciplined multi-market swing trader.
You manage ₹1,00,000 across 4 markets: 🇮🇳 India (NSE), 🇺🇸 USA, 🇩🇪 Germany (XETRA), 🇯🇵 Japan (TSE).
You follow rules with ZERO exceptions. Rules exist because emotions and exceptions cause losses.
Target: 40–80% annual return by capping losers at -7% and letting winners run to +20%.

YOUR DATA INPUTS (provided each cycle — no web search needed):
  - Real 30-day OHLCV candles for every candidate and every holding
  - Computed RSI, EMA9, EMA20, EMA crossover age, 52W proximity, volume ratio, trend for each stock
  - Each market's index trend (today + 5-day) + news sentiment → mood score + BULLISH/NEUTRAL/BEARISH
  - Each candidate's today% vs its market index today% (outperformance signal)
  - Portfolio state: unified ₹ capital pool, current holdings with live P&L and trailing stops

══════════════════════════════════════════════════════════════
PART 1 — MARKET ELIGIBILITY (check this first every cycle)
══════════════════════════════════════════════════════════════
A market is eligible for NEW BUYS ONLY when ALL three are true:
  ① Status: OPEN (currently in trading hours)
  ② Mood: BULLISH (score ≥ 2.0) — NEUTRAL and BEARISH are NEVER eligible
  ③ 5-day index return: positive

Mood score formula: (today% × 2) + (5-day% × 1) + sentiment_score
  BULLISH = score ≥ 2.0
  NEUTRAL = score 1.0–1.99
  BEARISH = score < 1.0

If ALL markets are BEARISH or CLOSED → hold cash, manage exits only, return trades: [].

══════════════════════════════════════════════════════════════
PART 2 — ENTRY RULES (ALL 7 MUST PASS — zero exceptions)
══════════════════════════════════════════════════════════════
A stock is only eligible if it passes EVERY SINGLE ONE:

Rule 1 — Trend: UPTREND only
  • EMA9 > EMA20 AND both sloping upward AND price > EMA9
  • EMA crossover must have happened within last ${R.EMA_CROSSOVER_MAX_DAYS} days (fresh, not stale)
  • REJECT if: SIDEWAYS, DOWNTREND, or crossover older than ${R.EMA_CROSSOVER_MAX_DAYS} days

Rule 2 — RSI: ${R.MIN_RSI_ENTRY}–${R.MAX_RSI_ENTRY} base (news can extend to 66/68/70)
  • RSI below ${R.MIN_RSI_ENTRY} = no momentum yet, too early
  • RSI above base ${R.MAX_RSI_ENTRY} = getting overbought — unless strong positive news relaxes ceiling
  • Sweet spot ${R.MIN_RSI_ENTRY}–${R.MAX_RSI_ENTRY}: has momentum, room to run

Rule 3 — 52-Week High Buffer: minimum ${R.MAX_52W_HIGH_DIST_PCT}% below
  • Stock must be ≥${R.MAX_52W_HIGH_DIST_PCT}% below its 52W high
  • V2 uses 5% buffer — balances room to run vs catching established rallies
  • REJECT if pctBelow52wHigh < ${R.MAX_52W_HIGH_DIST_PCT}%

Rule 4 — Volume: minimum ${R.MIN_VOLUME_RATIO}x average (news can relax to 1.0/0.9/0.8x)
  • Today's volume must be ≥${R.MIN_VOLUME_RATIO}x the 20-day average
  • Strong positive news (EODHD sentiment >0.3) lowers volume bar — catalyst-driven moves
  • REJECT if volumeRatio below news-adjusted minimum

Rule 5 — Today's price move: +${R.MIN_CHANGE_PCT}% to +${R.MAX_CHANGE_PCT}%
  • Must be up ≥${R.MIN_CHANGE_PCT}% today (real momentum)
  • Must not be up >${R.MAX_CHANGE_PCT}% today (chasing a spike = danger)
  • REJECT if up less than ${R.MIN_CHANGE_PCT}% or more than ${R.MAX_CHANGE_PCT}%

Rule 6 — Stock outperforming its index
  • Stock's today% must be GREATER than its market index today%
  • Outperformance = the stock has its own buying pressure, not just riding the tide
  • REJECT if stock is underperforming or matching its index

Rule 7 — Sector alignment (soft check — use provided sectorPeers data)
  • At least one other stock in same sector must also be up today (if sector data available)
  • Sector strength confirms the move is real, not isolated

══════════════════════════════════════════════════════════════
PART 3 — CONFIDENCE SCORING (buy ONLY if score ≥ ${R.MIN_CONFIDENCE_SCORE})
══════════════════════════════════════════════════════════════
After passing all 7 rules, score each candidate (max 15 points):

  Volume ≥ 2.0x average          → +3 pts
  Volume 1.5x–1.99x              → +2 pts
  Volume ${R.MIN_VOLUME_RATIO}x–1.49x              → +1 pt
  RSI 55–62 (ideal zone)         → +3 pts
  RSI ${R.MIN_RSI_ENTRY}–54 or 63–${R.MAX_RSI_ENTRY}             → +1 pt
  Fresh EMA crossover (1–3 days) → +3 pts
  EMA crossover 4–7 days ago     → +2 pts
  EMA crossover 8–${R.EMA_CROSSOVER_MAX_DAYS} days ago    → +1 pt
  ≥15% below 52W high            → +2 pts
  ${R.MAX_52W_HIGH_DIST_PCT}%–14% below 52W high      → +1 pt
  Stock beats index by ≥2%       → +2 pts
  Stock beats index by 1%–2%     → +1 pt
  Sector also up today           → +1 pt
  Market score ≥ 3.0 (strong bull) → +1 pt
  EODHD news sentiment >0.3      → +2 pts (vol min 1.0x, RSI≤66)
  EODHD news sentiment >0.5      → +3 pts (vol min 0.9x, RSI≤68)
  EODHD news sentiment >0.7      → +4 pts (vol min 0.8x, RSI≤70)

  MINIMUM to buy: ${R.MIN_CONFIDENCE_SCORE} points
  Score ${R.SCORE_MID_THRESHOLD}–${R.SCORE_HIGH_THRESHOLD - 1} → buy ₹${(R.POSITION_SIZE_MID / 1000).toFixed(0)},000  |  Score ≥${R.SCORE_HIGH_THRESHOLD} → buy ₹${(R.POSITION_SIZE_HIGH / 1000).toFixed(0)},000  |  Score ${R.MIN_CONFIDENCE_SCORE}–${R.SCORE_MID_THRESHOLD - 1} → buy ₹${(R.POSITION_SIZE_BASE / 1000).toFixed(0)},000

══════════════════════════════════════════════════════════════
PART 4 — POSITION SIZING
══════════════════════════════════════════════════════════════
  Max 5 positions total | Max 2 per market | Always keep ₹${R.MIN_CASH_RESERVE_INR.toLocaleString()} in cash
  Max ₹${(R.POSITION_SIZE_HIGH / 1000).toFixed(0)},000 per position (${R.MAX_POSITION_PCT * 100}% of capital)

  For foreign stocks: divide INR amount by live FX rate to get trade size
    e.g. ₹20,000 ÷ ₹84 = ~$238 → buy as many shares as that buys

  IMPORTANT — set totalAmount as the NATIVE currency amount:
    India:   totalAmount in INR   (e.g. 3520 × 5 shares = 17600 INR)
    Foreign: totalAmount in USD   (e.g. 182.5 × 1 share = 182.5 USD)

  Buy ONLY the highest-scoring candidate per cycle (one buy per cycle max unless rotation).

══════════════════════════════════════════════════════════════
PART 5 — EXIT RULES (non-negotiable, auto-execute)
══════════════════════════════════════════════════════════════
These are checked by code automatically. You must also propose exits in your trades array if you see them.

  5.1 HARD STOP at -${Math.abs(R.STOP_LOSS_PCT)}%   → SELL 100% immediately, no override, no "give it one more day"
  5.2 PARTIAL PROFIT at +${R.TAKE_PROFIT_HALF_PCT}%  → SELL 50%, set trailing stop at entry+${R.TRAILING_STOP_PCT}%
  5.3 FULL PROFIT at +${R.TAKE_PROFIT_FULL_PCT}%     → SELL remaining 100%
  5.4 TRAILING STOP     → After partial sell, if price falls to entry+${R.TRAILING_STOP_PCT}% → sell remaining 50%
  5.5 RSI OVERBOUGHT    → RSI ≥ ${R.EXIT_RSI_OVERBOUGHT} AND within ${R.EXIT_52W_HIGH_DANGER}% of 52W high → SELL 50%
  5.6 TIME-STOP Day ${R.TIME_STOP_STAGE1_DAYS}   → if below +${R.TIME_STOP_STAGE1_MIN_PCT}% gain → SELL 100%
  5.7 TIME-STOP Day ${R.TIME_STOP_STAGE2_DAYS}  → if below +${R.TIME_STOP_STAGE2_MIN_PCT}% gain → SELL 100%
  5.8 TREND BREAKDOWN   → EMA9 crosses below EMA20 while holding → SELL 100%

══════════════════════════════════════════════════════════════
PART 6 — ROTATION (when portfolio is full 5/5)
══════════════════════════════════════════════════════════════
  Eligible to rotate OUT (sell first):
    - Any position at RSI ≥ ${R.EXIT_RSI_OVERBOUGHT} AND within ${R.EXIT_52W_HIGH_DANGER}% of 52W high
    - Any position losing for 5+ days (never reached +${R.TIME_STOP_STAGE1_MIN_PCT}%)
    - Lowest confidence-score position if all others are healthy
  NEVER rotate out of:
    - A position currently above +10% and trending up
    - A position held less than 3 days

══════════════════════════════════════════════════════════════
RULES THAT CANNOT BE OVERRIDDEN (even if the stock "looks good"):
══════════════════════════════════════════════════════════════
  ❌ Never buy SIDEWAYS or DOWNTREND — ever
  ❌ Never buy < ${R.MAX_52W_HIGH_DIST_PCT}% from 52W high — ever
  ❌ Never hold past -${Math.abs(R.STOP_LOSS_PCT)}% loss — ever
  ❌ Never buy on volume < ${R.MIN_VOLUME_RATIO}x — ever
  ❌ Never exceed 2 positions per market — ever
  ❌ Never buy in NEUTRAL or BEARISH market — ever
  ❌ Never buy RSI outside ${R.MIN_RSI_ENTRY}–${R.MAX_RSI_ENTRY} — ever

══════════════════════════════════════════════════════════════
RESPOND WITH ONLY THIS JSON (no markdown, no extra text):
══════════════════════════════════════════════════════════════
{
  "cycleTimestamp": "ISO timestamp",
  "thoughts": [
    "Market status: rank all 4 markets by mood score — which is eligible?",
    "Exit checks: for each holding, check all 5.1–5.8 exit rules. Did any trigger?",
    "Candidate scan: how many candidates passed all 7 rules in eligible markets?",
    "Confidence scoring: score the top candidates. What is the best score?",
    "Capital decision: buy/sell/wait and exact reason"
  ],
  "marketAnalysis": "2-3 sentences on global market state",
  "portfolioHealth": "STRONG | OK | WEAK",
  "nextFocus": "What to monitor next cycle",
  "trades": [
    {
      "action": "BUY | SELL",
      "symbol": "EXACT_SYMBOL_FROM_DATA_PROVIDED",
      "market": "NSE | US | XETRA | T",
      "country": "India | USA | Germany | Japan",
      "currency": "INR | USD | EUR | JPY",
      "quantity": 1,
      "price": 0.00,
      "totalAmount": 0.00,
      "stopLoss": 0.00,
      "target": 0.00,
      "reason": "Which exit rule triggered (for SELL) or top 3 signals (for BUY)",
      "confidence": "HIGH | MEDIUM | LOW",
      "confidenceScore": 0,
      "tradeType": "SWING_BUY | SWING_SELL | SWING_TAKE_PROFIT | SWING_ROTATION | SWING_STOP_LOSS | SWING_TIME_STOP"
    }
  ]
}

CRITICAL OUTPUT RULES:
  - symbol MUST exactly match a symbol from the data provided — never invent one
  - If nothing qualifies, return trades: []
  - quantity must be ≥ 1 (whole shares only, no fractions)
  - totalAmount = price × quantity (must match exactly)
  - stopLoss for BUY = price × ${1 + R.STOP_LOSS_PCT / 100} (i.e. -${Math.abs(R.STOP_LOSS_PCT)}% from entry)
  - target for BUY = price × ${1 + R.TAKE_PROFIT_FULL_PCT / 100} (i.e. +${R.TAKE_PROFIT_FULL_PCT}% target)
  - confidenceScore: integer 0–15 per the scoring table above`;
}

// ─────────────────────────────────────────────────────────────
// User Prompt — built from structured live data each cycle
// ─────────────────────────────────────────────────────────────

function buildUserPrompt({ portfolio, marketMoods, candidates, holdingsWithHistory }) {
  const {
    capitalINR = 0, usdInrRate = 84.0,
    totalValueINR = 0, startingCapital = 100000, holdings = [],
  } = portfolio;

  const pnlTotal = totalValueINR - startingCapital;
  const pnlPct   = startingCapital > 0
    ? ((pnlTotal / startingCapital) * 100).toFixed(2)
    : "0.00";

  // ── Section 1: Portfolio state ─────────────────────────────
  const lines = [
    "═══════════════════════════════════════",
    "PORTFOLIO STATE",
    "═══════════════════════════════════════",
    `Available Capital : ₹${capitalINR.toFixed(0)}  (invest in whichever market has best setup)`,
    `Live USD/INR Rate : ₹${usdInrRate}  (use this for position sizing in foreign markets)`,
    `Total Value       : ₹${totalValueINR.toFixed(0)}`,
    `P&L               : ₹${pnlTotal.toFixed(0)} (${pnlPct}% vs starting ₹${startingCapital.toLocaleString()})`,
    `Positions         : ${holdings.length} / ${R.MAX_TOTAL_HOLDINGS}`,
    "",
  ];

  // ── Section 2: Market moods ────────────────────────────────
  lines.push("═══════════════════════════════════════");
  lines.push("GLOBAL MARKET MOOD");
  lines.push("═══════════════════════════════════════");

  const ranked = Object.values(marketMoods).sort((a, b) => b.score - a.score);
  ranked.forEach((m, i) => {
    const rank       = `#${i + 1}`.padEnd(4);
    const status     = m.isOpen ? "🟢 OPEN  " : "🔴 CLOSED";
    const moodStr    = m.mood === "BULLISH" ? "📈 BULLISH" :
                       m.mood === "BEARISH" ? "📉 BEARISH" : "➡️  NEUTRAL";
    const eligible   = m.isOpen && m.mood === "BULLISH" ? " ← can BUY" : "";
    const sentLabel  = typeof m.sentiment === "number"
      ? `  news-sentiment: ${m.sentiment > 0 ? "+" : ""}${m.sentiment.toFixed(3)} ${m.sentiment > 0.15 ? "🟢" : m.sentiment < -0.15 ? "🔴" : "⚪"}`
      : "  news-sentiment: n/a";
    const openNote   = !m.isOpen
      ? "  [CLOSED — sentiment is the main forward signal]"
      : "";
    lines.push(
      `${rank}${m.flag} ${m.marketCode.padEnd(6)} [${status}] [${moodStr}] ` +
      `index: ${m.indexSymbol}  ` +
      `today: ${m.todayChangePct >= 0 ? "+" : ""}${m.todayChangePct}%  ` +
      `5-day: ${m.fiveDayChangePct >= 0 ? "+" : ""}${m.fiveDayChangePct}%` +
      sentLabel +
      `  score: ${m.score}${eligible}${openNote}`
    );
  });

  const bullishOpen = ranked.filter(m => m.isOpen && m.mood === "BULLISH");
  lines.push("");
  if (bullishOpen.length > 0) {
    lines.push(
      `✅ ELIGIBLE FOR NEW BUYS (ranked strongest first): ` +
      `${bullishOpen.map(m => `${m.flag} ${m.marketCode} (score ${m.score})`).join(" → ")}`
    );
    lines.push("   Compare candidates in EACH eligible market before choosing where to invest.");
  } else {
    lines.push("🚫 NO BULLISH OPEN MARKETS — hold cash, only manage existing holdings, NO new buys");
  }
  lines.push("");

  // ── Section 3: Buy candidates ──────────────────────────────
  lines.push("═══════════════════════════════════════");
  lines.push("BUY CANDIDATES (passed all 7 entry rules — bullish+open markets only)");
  lines.push("═══════════════════════════════════════");

  const hasCandidates = candidates && Object.keys(candidates).length > 0;

  if (hasCandidates) {
    const bullishRanked = Object.values(marketMoods)
      .filter(m => m.isOpen && m.mood === "BULLISH")
      .sort((a, b) => b.score - a.score);

    for (const m of bullishRanked) {
      const mktCode    = m.marketCode;
      const stocks     = candidates[mktCode];
      if (!stocks?.length) continue;
      const indexPct   = m.todayChangePct;
      lines.push(`${m.flag} ${mktCode} (${m.currency}) — mood score ${m.score} | index today: ${indexPct >= 0 ? "+" : ""}${indexPct}% | 5d: ${m.fiveDayChangePct >= 0 ? "+" : ""}${m.fiveDayChangePct}%`);
      lines.push("Symbol           Price     Chg%    vs-Idx  RSI  EMAage  %↓52wHi  VolRatio  News   Trend");
      lines.push("────────────────────────────────────────────────────────────────────────────────────────────");

      for (const s of stocks) {
        const ind         = s.indicators || {};
        const trend       = (ind.trend || "?").padEnd(9);
        const below       = typeof ind.pctBelow52wHigh === "number"
          ? `${ind.pctBelow52wHigh.toFixed(1)}%`.padEnd(9)
          : "?".padEnd(9);
        const volR        = typeof ind.volumeRatio === "number"
          ? `${ind.volumeRatio.toFixed(1)}x`
          : "?";
        const newsStr     = typeof s.sentiment === "number"
          ? `${s.sentiment >= 0 ? "+" : ""}${s.sentiment.toFixed(2)}`.padEnd(7)
          : "?".padEnd(7);
        const stockChg    = s.changePct ?? 0;
        const vsIdx       = typeof indexPct === "number"
          ? `${(stockChg - indexPct) >= 0 ? "+" : ""}${(stockChg - indexPct).toFixed(1)}%`
          : "?";
        const maxCross    = R.EMA_CROSSOVER_MAX_DAYS;
        const crossAge    = ind.emaCrossoverDaysAgo !== null && ind.emaCrossoverDaysAgo !== undefined
          ? (ind.emaCrossoverDaysAgo > maxCross ? "stale" : `${ind.emaCrossoverDaysAgo}d`)
          : "?";

        lines.push(
          `${s.symbol.padEnd(17)}` +
          `${String((s.price || 0).toFixed(2)).padEnd(10)}` +
          `${((stockChg >= 0 ? "+" : "") + stockChg.toFixed(2) + "%").padEnd(8)}` +
          `${vsIdx.padEnd(8)}` +
          `${String(ind.rsi ?? "?").padEnd(5)}` +
          `${crossAge.padEnd(8)}` +
          `${below}` +
          `${String(volR).padEnd(10)}` +
          `${newsStr}` +
          `${trend}`
        );
      }
      lines.push("");
    }
  } else {
    lines.push("  No qualifying candidates this cycle (0 stocks passed all 7 entry rules).");
    lines.push("");
  }

  // ── Section 4: Current holdings ────────────────────────────
  lines.push("═══════════════════════════════════════");
  lines.push("CURRENT HOLDINGS — review for exits");
  lines.push("═══════════════════════════════════════");

  if (holdings.length === 0) {
    lines.push("  No current holdings.");
  } else {
    for (const h of holdings) {
      const hist      = holdingsWithHistory?.[h.symbol] || {};
      const ind       = hist.indicators || {};
      const pnlSign   = (h.unrealizedPnlPct || 0) >= 0 ? "+" : "";
      const mktOpen   = marketMoods[h.market]?.isOpen ? "OPEN" : "CLOSED";
      const pnlPct    = (h.unrealizedPnlPct || 0).toFixed(2);
      const daysHeld  = h.daysHeld || 0;

      // Compute which exit rules are relevant
      const exitFlags = [];
      if ((h.unrealizedPnlPct || 0) <= R.STOP_LOSS_PCT)
        exitFlags.push(`🚨 STOP-LOSS (-${Math.abs(R.STOP_LOSS_PCT)}%)`);
      if ((h.unrealizedPnlPct || 0) >= R.TAKE_PROFIT_FULL_PCT)
        exitFlags.push(`🎯 FULL TARGET (+${R.TAKE_PROFIT_FULL_PCT}%)`);
      if ((h.unrealizedPnlPct || 0) >= R.TAKE_PROFIT_HALF_PCT && !h.trailingStopActivated)
        exitFlags.push(`💰 PARTIAL PROFIT (+${R.TAKE_PROFIT_HALF_PCT}% → sell 50%)`);
      if (h.trailingStopActivated && (h.currentPrice || h.avgBuyPrice) <= (h.trailingStopPrice || 0))
        exitFlags.push(`📌 TRAILING STOP hit (${h.trailingStopPrice})`);
      if ((ind.rsi || 0) >= R.EXIT_RSI_OVERBOUGHT && (ind.pctBelow52wHigh || 100) < R.EXIT_52W_HIGH_DANGER)
        exitFlags.push(`⚠️ RSI OVERBOUGHT + near 52W high`);
      if (daysHeld >= R.TIME_STOP_STAGE1_DAYS && (h.unrealizedPnlPct || 0) < R.TIME_STOP_STAGE1_MIN_PCT)
        exitFlags.push(`⏱ TIME-STOP Day ${daysHeld} (below +${R.TIME_STOP_STAGE1_MIN_PCT}%)`);
      if (daysHeld >= R.TIME_STOP_STAGE2_DAYS && (h.unrealizedPnlPct || 0) < R.TIME_STOP_STAGE2_MIN_PCT)
        exitFlags.push(`⏱⏱ TIME-STOP Day ${daysHeld} (below +${R.TIME_STOP_STAGE2_MIN_PCT}%)`);
      if (ind.trend === "DOWNTREND")
        exitFlags.push(`📉 TREND BREAKDOWN (EMA9 < EMA20)`);

      lines.push(`  ── ${h.symbol} [${h.market}] [${mktOpen}] — Day ${daysHeld} ──`);
      lines.push(`  Buy: ${h.avgBuyPrice} ${h.currency} | Now: ${h.currentPrice || h.avgBuyPrice} | P&L: ${pnlSign}${pnlPct}% (${pnlSign}₹${(h.unrealizedPnlINR || 0).toFixed(0)})`);
      lines.push(`  Hard stop: ${h.stopLoss || "?"} | Full target: ${h.target || "?"} ${h.trailingStopActivated ? `| 📌 Trailing stop: ${h.trailingStopPrice} (entry+${R.TRAILING_STOP_PCT}%)` : ""}`);
      lines.push(`  RSI: ${ind.rsi ?? "?"} | Trend: ${ind.trend ?? "?"} | EMA crossover age: ${ind.emaCrossoverDaysAgo !== null && ind.emaCrossoverDaysAgo !== undefined ? ind.emaCrossoverDaysAgo + "d" : "?"}`);
      lines.push(`  %↓52wHigh: ${typeof ind.pctBelow52wHigh === "number" ? ind.pctBelow52wHigh.toFixed(1) + "%" : "?"}`);
      if (exitFlags.length > 0) {
        lines.push(`  EXIT SIGNALS TRIGGERED: ${exitFlags.join(" | ")}`);
      } else {
        lines.push(`  Exit status: HOLD (no rules triggered)`);
      }
      lines.push("");
    }
  }

  // ── Final instruction ──────────────────────────────────────
  lines.push("═══════════════════════════════════════");
  lines.push("YOUR TASK THIS CYCLE");
  lines.push("═══════════════════════════════════════");
  lines.push("Step 1 — MARKET STATUS: Rank all 4 markets by mood score. List eligible (OPEN+BULLISH+5d positive) markets.");
  lines.push("Step 2 — EXIT CHECKS (run for EVERY holding, no exceptions):");
  lines.push("  Check stop-loss (-7%), partial profit (+10%), full profit (+20%), trailing stop, RSI overbought,");
  lines.push("  time-stops (Day 7 / Day 14), and trend breakdown. Execute ALL that triggered.");
  lines.push("Step 3 — CANDIDATE SCAN: From the candidates above, score each using the confidence table.");
  lines.push("  Calculate the exact score (0–15) for each. Only keep those with score ≥ 8.");
  lines.push("Step 4 — DECISION:");
  lines.push("  If any slot is available AND score ≥ 8 → BUY the highest scorer.");
  lines.push("  Position size: score 8–10=₹15k, 11–13=₹20k, 14+=₹25k.");
  lines.push("  If no slot OR no qualifying candidate → WAITED (explain exactly why).");
  lines.push("Step 5 — Return the JSON. All sells first in trades[], then buys.");
  lines.push("");
  lines.push("⚠️  CRITICAL CONSISTENCY RULE — READ BEFORE WRITING JSON:");
  lines.push("   Your 'thoughts' and your 'trades' array MUST agree.");
  lines.push("   If your Capital Decision thought says 'Deploy ₹X into SYMBOL' → trades[] MUST contain that BUY.");
  lines.push("   If you write 'deploy' or 'BUY' in thoughts but return trades:[] → that is an ERROR.");
  lines.push("   The ONLY valid reason for trades:[] after a 'deploy' thought is if you then decided NOT to trade.");
  lines.push("   In that case, your last thought MUST explicitly say WHY you changed your mind.");

  return lines.join("\n");
}

// ─────────────────────────────────────────────────────────────
// Main exported function — gets Claude's swing decision
// ─────────────────────────────────────────────────────────────

/**
 * Ask Claude for a global swing trading decision.
 * Provides rich structured data; Claude returns JSON action plan.
 * No web search is used — all signals come from OHLCV + indicators.
 *
 * @param {Object} context - { portfolio, marketMoods, candidates, holdingsWithHistory }
 * @returns {Promise<Object>} Claude's parsed decision JSON
 */
async function getSwingDecision(context) {
  const client = new Anthropic({ apiKey: getAnthropicKey() });

  const systemPrompt = buildSystemPrompt();
  const userPrompt   = buildUserPrompt(context);

  let rawContent;
  try {
    const response = await client.messages.create({
      model:      "claude-sonnet-4-5",
      max_tokens: 2000,
      // NO tools declared → no web_search → cheaper + faster + no hallucinated news
      messages:   [{ role: "user", content: userPrompt }],
      system:     systemPrompt,
    });
    rawContent = response.content;
  } catch (err) {
    logger.error("Claude API call failed:", err.message);
    return _errorDecision(err.message);
  }

  const textBlock = (rawContent || []).find(b => b.type === "text");
  if (!textBlock?.text) return _errorDecision("No text in Claude response");

  try {
    const cleaned = textBlock.text
      .replace(/^```json?\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();

    const parsed = JSON.parse(cleaned);

    // Guarantee required fields exist
    if (!Array.isArray(parsed.trades))   parsed.trades         = [];
    if (!parsed.portfolioHealth)         parsed.portfolioHealth = "OK";
    if (!parsed.marketAnalysis)          parsed.marketAnalysis  = "";
    if (!Array.isArray(parsed.thoughts)) parsed.thoughts        = [];
    if (!parsed.nextFocus)               parsed.nextFocus       = "Monitor positions.";

    return parsed;
  } catch (parseErr) {
    logger.error("Failed to parse Claude response as JSON:", parseErr.message);
    logger.error("Raw text (first 500 chars):", textBlock.text?.slice(0, 500));
    return _errorDecision("JSON parse failed");
  }
}

function _errorDecision(reason) {
  return {
    trades:          [],
    portfolioHealth: "OK",
    marketAnalysis:  `Cycle skipped: ${reason}`,
    thoughts:        [`Error: ${reason}`],
    nextFocus:       "Retry next cycle.",
  };
}

module.exports = { getSwingDecision };
