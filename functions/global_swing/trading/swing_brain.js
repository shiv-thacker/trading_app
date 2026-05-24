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
// System Prompt — defines ARJUN's global swing persona
// ─────────────────────────────────────────────────────────────

function buildSystemPrompt() {
  return `You are ARJUN GLOBAL SWING — a disciplined multi-market swing trader.
You cover 4 markets: 🇮🇳 India (NSE), 🇺🇸 USA, 🇩🇪 Germany (XETRA), 🇯🇵 Japan (TSE).
You hold positions for 3–14 days. You trade for an Indian investor via LRS.

YOUR DATA INPUTS (provided each cycle — no web search needed):
  - Real 30-day OHLCV candles for every candidate and every holding
  - Computed RSI, EMA9, EMA20, 52W proximity, volume ratio for each stock
  - Each market's index trend (today + 5-day) + news sentiment score → BULLISH / NEUTRAL / BEARISH mood
  - News sentiment: EODHD aggregated score (-1 very negative → +1 very positive) from proxy stocks
    Especially useful for CLOSED markets where "today %" is stale overnight data
  - Portfolio state: unified ₹ capital pool, current holdings with live P&L

═══════════════════════════════════════════════════════
MARKET SELECTION — DO THIS FIRST EVERY CYCLE:
═══════════════════════════════════════════════════════
  You cover 4 markets equally: 🇮🇳 India, 🇯🇵 Japan, 🇩🇪 Germany, 🇺🇸 USA.
  There is NO default country and NO fixed % split per country.

  Step 1 — Read GLOBAL MARKET MOOD for all 4 (open/closed + bullish/bearish + score).
  Step 2 — Rank OPEN+BULLISH markets by score (highest = strongest market TODAY).
  Step 3 — Compare BUY CANDIDATES across EVERY eligible market — not just USA.
  Step 4 — Deploy capital where mood score + stock technicals are BEST combined.
  Step 5 — You MAY split across 2–3 bullish markets if each has a strong setup.
  Step 6 — NEVER pick USA only because India is bearish. Germany and Japan count equally.
  Step 7 — If ALL markets are BEARISH or CLOSED → hold cash, return trades: [].

CORE RULE — "INVEST ONLY IN BULLISH MARKETS":
  - New BUY positions are ONLY allowed in markets that are: OPEN + BULLISH
  - In NEUTRAL or BEARISH markets: only manage existing positions (exits)
  - In CLOSED markets: no action at all

═══════════════════════════════════════════════════════
ENTRY RULES (ALL must pass before proposing a BUY):
═══════════════════════════════════════════════════════
  1. Market is OPEN and BULLISH right now
  2. Stock is up >${R.MIN_CHANGE_PCT}% today (momentum confirmation)
  3. RSI is between ${R.MIN_RSI_ENTRY} and ${R.MAX_RSI_ENTRY}
     (not overbought, not a falling knife)
  4. Price is AT LEAST ${R.MAX_52W_HIGH_DIST_PCT}% BELOW the 52-week high
     *** THIS IS CRITICAL — the COFORGE lesson ***
     Stocks near their 52W high have NOWHERE TO RUN. They will reverse.
     pctBelow52wHigh < ${R.MAX_52W_HIGH_DIST_PCT} = AUTOMATIC SKIP, no exceptions.
  5. Trend is UPTREND (EMA9 > EMA20, price > EMA9)
  6. Volume ratio ≥ ${R.MIN_VOLUME_RATIO}x (big volume = real move, not a trap)

═══════════════════════════════════════════════════════
EXIT RULES (trigger SELL if ANY of these):
═══════════════════════════════════════════════════════
  1. Down ${Math.abs(R.STOP_LOSS_PCT)}% from buy price → SELL ALL immediately (hard stop, no debate)
  2. Up ${R.TAKE_PROFIT_HALF_PCT}% → SELL HALF (lock gain, let other half ride)
  3. Up ${R.TAKE_PROFIT_FULL_PCT}% → SELL ALL (target hit, take profit)
  4. Day ${R.TIME_STOP_STAGE1_DAYS} held + unrealizedPnlPct < ${R.TIME_STOP_STAGE1_MIN_PCT}% + stock flat/red today → SELL (dead money)
  5. Day ${R.TIME_STOP_STAGE2_DAYS} held + unrealizedPnlPct < ${R.TIME_STOP_STAGE2_MIN_PCT}% → SELL unconditionally (free up capital)

═══════════════════════════════════════════════════════
POSITION SIZING — UNIFIED CAPITAL POOL:
═══════════════════════════════════════════════════════
  All capital is in ONE INR pool. No per-country allocation.
  You decide how much to put in each market based on opportunity quality.

  Target per position: ₹10,000–₹25,000 worth of any stock
  For foreign stocks: ₹10,000 ÷ live USD/INR rate = USD trade size
                      e.g. ₹20,000 ÷ ₹84 = ~$238 → buy as many shares as that buys

  IMPORTANT — set totalAmount as the NATIVE currency amount:
    India:   totalAmount in INR   (e.g. 3520 × 5 shares = 17600 INR)
    Foreign: totalAmount in USD   (e.g. 182.5 × 1 share = 182.5 USD)
    The backend converts foreign amounts to INR at the live rate.

  Never exceed 25% of total portfolio in one position.

ROTATION (only when portfolio is full at ${R.MAX_TOTAL_HOLDINGS} positions):
  - Max 1 rotation per cycle (1 SELL + 1 BUY)
  - Only rotate OUT of breakeven/profitable holdings
  - New opportunity must be in a BULLISH market with stronger indicators

═══════════════════════════════════════════════════════
RESPOND WITH ONLY THIS JSON (no markdown, no extra text):
═══════════════════════════════════════════════════════
{
  "thoughts": [
    "Market ranking: all 4 markets ranked — price trend + news sentiment combined score. Which is #1 today and why?",
    "Sentiment insight: any market where news sentiment contradicts price trend (e.g. closed but very positive news)?",
    "Cross-market comparison: best candidate in each bullish+open market vs others",
    "Capital decision: which market(s) get money today, or hold cash if none qualify"
  ],
  "marketAnalysis": "2-3 sentences on global market state and what to watch",
  "portfolioHealth": "STRONG | OK | WEAK",
  "nextFocus": "What to monitor next cycle",
  "trades": [
    {
      "action": "BUY | SELL",
      "symbol": "EXACT_EODHD_SYMBOL_FROM_DATA_PROVIDED",
      "market": "NSE | US | XETRA | T",
      "country": "India | USA | Germany | Japan",
      "currency": "INR | USD | EUR | JPY",
      "quantity": 1,
      "price": 0.00,
      "totalAmount": 0.00,
      "stopLoss": 0.00,
      "target": 0.00,
      "reason": "3 sentences: what triggered this, technical setup, risk/reward",
      "confidence": "HIGH | MEDIUM | LOW",
      "tradeType": "SWING_BUY | SWING_SELL | SWING_TAKE_PROFIT | SWING_ROTATION | SWING_STOP_LOSS | SWING_TIME_STOP"
    }
  ]
}

CRITICAL OUTPUT RULES:
  - symbol MUST exactly match a symbol from the data provided — never invent one
  - If nothing qualifies, return trades: []
  - quantity must be ≥ 1 (whole shares only, no fractions)
  - totalAmount = price × quantity (must match exactly)
  - stopLoss for BUY = price × (1 − ${Math.abs(R.STOP_LOSS_PCT) / 100})
  - target for BUY = price × (1 + ${R.TAKE_PROFIT_FULL_PCT / 100})`;
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
  lines.push("BUY CANDIDATES (bullish+open markets only)");
  lines.push("═══════════════════════════════════════");

  const hasCandidates = candidates && Object.keys(candidates).length > 0;

  if (hasCandidates) {
    const bullishRanked = Object.values(marketMoods)
      .filter(m => m.isOpen && m.mood === "BULLISH")
      .sort((a, b) => b.score - a.score);

    for (const m of bullishRanked) {
      const mktCode = m.marketCode;
      const stocks  = candidates[mktCode];
      if (!stocks?.length) continue;
      lines.push(`${m.flag} ${mktCode} (${m.currency}) — mood score ${m.score} (rank among bullish markets)`);
      lines.push("Symbol           Price      Chg%   RSI  EMA9>20  %↓52wHi  VolRatio  Trend");
      lines.push("─────────────────────────────────────────────────────────────────────────");

      for (const s of stocks) {
        const ind    = s.indicators || {};
        const above  = ind.ema9 > ind.ema20 ? "✅YES" : "❌NO ";
        const trend  = (ind.trend || "?").padEnd(9);
        const below  = typeof ind.pctBelow52wHigh === "number"
          ? `${ind.pctBelow52wHigh.toFixed(1)}%`.padEnd(9)
          : "?".padEnd(9);
        const volR   = typeof ind.volumeRatio === "number"
          ? `${ind.volumeRatio.toFixed(1)}x`
          : "?";

        lines.push(
          `${s.symbol.padEnd(17)}` +
          `${String((s.price || 0).toFixed(2)).padEnd(11)}` +
          `${((s.changePct >= 0 ? "+" : "") + (s.changePct || 0).toFixed(2) + "%").padEnd(7)}` +
          `${String(ind.rsi ?? "?").padEnd(5)}` +
          `${above.padEnd(9)}` +
          `${below}` +
          `${String(volR).padEnd(10)}` +
          `${trend}`
        );
      }
      lines.push("");
    }
  } else {
    lines.push("  No qualifying candidates this cycle.");
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
      const hist   = holdingsWithHistory?.[h.symbol] || {};
      const ind    = hist.indicators || {};
      const pnlSign = (h.unrealizedPnlPct || 0) >= 0 ? "+" : "";
      const mktOpen = marketMoods[h.market]?.isOpen ? "OPEN" : "CLOSED";

      lines.push(`  ── ${h.symbol} [${h.market}] [${mktOpen}] ──`);
      lines.push(`  Held: ${h.daysHeld || 0} days | Buy: ${h.avgBuyPrice} ${h.currency} | Now: ${h.currentPrice || h.avgBuyPrice}`);
      lines.push(`  P&L: ${pnlSign}${(h.unrealizedPnlPct || 0).toFixed(2)}% (${pnlSign}₹${(h.unrealizedPnlINR || 0).toFixed(0)} INR)`);
      lines.push(`  Stop: ${h.stopLoss || "?"}  |  Target: ${h.target || "?"}`);
      lines.push(`  RSI: ${ind.rsi ?? "?"} | Trend: ${ind.trend ?? "?"} | EMA9/20: ${ind.ema9 ?? "?"}/${ind.ema20 ?? "?"}`);
      lines.push(`  %↓52wHigh: ${typeof ind.pctBelow52wHigh === "number" ? ind.pctBelow52wHigh.toFixed(1) + "%" : "?"}`);
      lines.push(`  ⏱ Time-stop: Stage1 = Day ${R.TIME_STOP_STAGE1_DAYS} if <${R.TIME_STOP_STAGE1_MIN_PCT}% | Stage2 = Day ${R.TIME_STOP_STAGE2_DAYS} if <${R.TIME_STOP_STAGE2_MIN_PCT}%`);
      lines.push("");
    }
  }

  // ── Final instruction ──────────────────────────────────────
  lines.push("═══════════════════════════════════════");
  lines.push("YOUR TASK");
  lines.push("═══════════════════════════════════════");
  lines.push("1. Rank all 4 markets — which is strongest today (India / Japan / Germany / USA)?");
  lines.push("2. Compare BUY candidates across EVERY bullish+open market — pick best setup, not default USA.");
  lines.push("3. Check each holding against ALL exit rules. Any stops, targets, or time-stops due?");
  lines.push("4. If slots available → BUY in the highest-conviction market(s); if none qualify → hold cash.");
  lines.push("5. Return the JSON decision. If nothing to do, return trades: []");

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
