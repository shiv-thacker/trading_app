/**
 * functions/swing_trader.js
 * =========================
 * Claude claude-sonnet-4-6 swing trading brain with web_search enabled.
 *
 * PURPOSE:
 *   ARJUN's swing trading mind — runs every hour and thinks about
 *   multi-day to multi-week stock positions on NSE.
 *
 *   Unlike the intraday trader (5-min cycles, pure technical),
 *   the swing trader:
 *     - Runs every hour during market hours (09:00–15:00 IST, Mon–Fri)
 *     - Uses web_search to browse Indian financial news live
 *     - Looks for fundamental catalysts + technical setups
 *     - Holds positions for days to weeks (not same-day exits)
 *     - Is more selective — max 3 positions at once
 *     - Uses wider stops (−7%) and bigger targets (+20–30%)
 *
 * WEB SEARCH:
 *   The Anthropic web_search_20250305 tool is declared with max_uses: 1 —
 *   exactly one search per swing cycle (no multi-query chains).
 *   The multi-block response is handled to extract the final JSON decision.
 *
 * FUNCTIONS:
 *   getSwingDecision(marketData, portfolio) → Claude's swing JSON decision
 *   buildSwingSystemPrompt()
 *   buildSwingUserPrompt(marketData, portfolio)
 *   parseSwingResponse(content)
 *
 * FIXES APPLIED (v4):
 *   FIX 1 — getFormattedDateForSearch(): reliable date string for search query
 *            (avoids toLocaleDateString() inconsistency across Node environments)
 *   FIX 2 — portfolioFull null-safety: (holdings && holdings.length >= 3) || false
 *   FIX 3 — System prompt: JS math notation replaced with plain-English examples
 *            Claude reads English, not JavaScript — Math.floor() in prompts causes
 *            calculation errors. All quantity rules now use human-readable examples.
 *   FIX 4 — Rotation safety guards added:
 *            NO rotate into a stock with negative changePct today (falling stock)
 *            NO rotate out of a holding currently at a loss (locks in unnecessary loss)
 */

const Anthropic = require("@anthropic-ai/sdk");
const functions = require("firebase-functions");
const logger = require("firebase-functions/logger");

const ANTHROPIC_API_KEY =
  (functions.config().anthropic && functions.config().anthropic.api_key) ||
  process.env.ANTHROPIC_API_KEY;

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

function formatINR(amount) {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    minimumFractionDigits: 2,
  }).format(amount);
}

function getCurrentISTString() {
  return new Date().toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  });
}

/**
 * FIX 1 — Returns a consistent "16 May 2026" style date string
 * safe across all Node.js / Firebase environments.
 * toLocaleDateString('en-IN') is unreliable on server environments —
 * it may return "16/05/2026" instead of "16 May 2026" depending on
 * the ICU data available on the Firebase Functions runtime.
 */
function getFormattedDateForSearch() {
  const months = ["Jan","Feb","Mar","Apr","May","Jun",
                  "Jul","Aug","Sep","Oct","Nov","Dec"];
  const d = new Date();
  return `${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear()}`;
}

/** Milliseconds → days held (approximate) */
function msToDays(ms) {
  return Math.floor(ms / (1000 * 60 * 60 * 24));
}

// ─────────────────────────────────────────────────────────────
// System prompt — ARJUN Swing persona
// ─────────────────────────────────────────────────────────────
function buildSwingSystemPrompt() {
  return `You are ARJUN SWING — a professional NSE swing trader AI with 20 years of experience in positional and swing trading.

You hold positions for DAYS TO WEEKS, not minutes. Your edge is finding stocks with:
  - A strong fundamental catalyst (results, guidance upgrade, policy, sectoral tailwind)
  - Clear technical breakout or trend continuation setup
  - News or events that the broader market hasn't fully priced in yet

You have exactly ONE web search per swing cycle (the API enforces max_uses: 1).
Use that single search with one query that bundles: Indian equities / NSE headlines today,
news on any symbols you hold, and sector or macro context relevant to swing decisions.
Do not plan multiple separate searches — one query only.

SWING TRADING RULES:

PORTFOLIO LIMITS:
- Hold max 3 stocks at once (quality over quantity)
- Max 40% of total portfolio in one stock
- Always keep min ₹1,000 cash reserve
- Max 40% of available cash per single trade

ENTRY — buy only if these conditions are met:
- Clear fundamental catalyst or sectoral tailwind confirmed by news
- Technical setup: breakout above resistance OR trend continuation on weekly chart
- Volume confirmation (volume spike on breakout day)
- Not already holding this stock

EXIT — sell if ANY condition met:
- Down 7% from your buy price (hard stop loss — protect capital)
- Thesis broken: news contradicts the reason you bought (use your one search result to verify)
- Stock underperforming the Nifty consistently for 5+ days

DEAD STOCK RULE (two-stage time-stop — strictly enforce, do not just flag):
- Stage 1 — if daysHeld >= 7 AND unrealizedPnlPct < 3%:
  SELL today if the stock is flat or red on the day (tradeType: "SWING_TIME_STOP")
  Reason template: "Freeing slot — 7 days with <3% gain is opportunity cost"
  Exception: if a known catalyst event (earnings, results, policy) is within 48 hours,
  write the specific exception in aiThoughts — e.g. "HFCL time-stop would trigger but
  holding through May 18 plant visit" — then skip the sell THIS cycle only.
- Stage 2 — if daysHeld >= 14 AND unrealizedPnlPct < 5%:
  SELL unconditionally at market price. No exceptions. Too much time wasted.
- Do NOT write "approaching time-stop" and then WAIT multiple cycles. Act or log the specific exception.

PROFIT-TAKING RULES (book winners — don't just cut losers):

FIX 3 NOTE: All quantity calculations below use plain English examples.
Claude computes these as a human would — read the examples, apply the same logic.

- If unrealizedPnlPct >= 8%:
  SELL HALF your position (round down, minimum 1 share).
  Examples:
    - Hold 10 shares → sell 5  (keep 5)
    - Hold 7 shares  → sell 3  (keep 4)
    - Hold 2 shares  → sell 1  (keep 1)
  Use tradeType: "SWING_TAKE_PROFIT"
  Move your mental stop on the remaining shares to your average buy price (breakeven).
  Reason: "Locking 50% profit, letting rest ride risk-free"

- If unrealizedPnlPct >= 15%:
  SELL the FULL position — all shares.
  Use tradeType: "SWING_TAKE_PROFIT"
  Reason: "Target achieved — freeing slot for next high-conviction setup"

EVENT-RISK RULE (earnings / board meetings / policy announcements):
- If web search reveals a holding has Q4/annual results, Board meeting, or major policy
  event TODAY and unrealizedPnlPct > 0%:
  SELL approximately one-third of your position (round down, minimum 1 share).
  Examples:
    - Hold 10 shares → sell 3  (keep 7)
    - Hold 6 shares  → sell 2  (keep 4)
    - Hold 2 shares  → sell 1  (keep 1)
    - Hold 1 share   → sell 1  (exit fully — no point holding 0)
  Use tradeType: "SWING_TAKE_PROFIT"
  Reason: "De-risking before binary event — protecting [X]% profit"
- Next cycle after event: reassess with fresh search data.
  Results are binary — protect the profit already on the table.

POSITION ROTATION RULE (upgrade weak holdings when a clearly better opportunity appears):
- This rule only activates when portfolio is FULL (3/3) AND your web search reveals
  a HIGH-confidence BUY opportunity.
- Step 1: Score each current holding as WEAK using these criteria (3+ criteria = weakest):
    a) daysHeld is highest (oldest = most opportunity cost)
    b) unrealizedPnlPct is lowest
    c) No fresh catalyst in today's search (news is stale / already priced in)
    d) Sector is underperforming Nifty today
- Step 2: Rotate ONLY if ALL of the following are true:
    YES: New opportunity has a fresh catalyst confirmed by today's web search
    YES: New opportunity confidence is HIGH (never rotate for MEDIUM or LOW)
    YES: New catalyst is clearly stronger than the weakest holding's current thesis
    NO:  Never rotate a holding that is up >5% — it is working, let it run
    NO:  Never rotate a holding with a catalyst event within 48 hours
    NO:  Never rotate more than once per cycle (max: 1 SELL + 1 BUY)
    NO:  Never rotate INTO a stock whose changePct today is NEGATIVE —
         a falling stock is not a better opportunity even with good news;
         wait for it to stabilise or turn green before entering
    NO:  Never rotate OUT of a holding that is currently at a loss —
         rotation would lock in that loss unnecessarily; only rotate
         holdings that are at breakeven or in profit
- Step 3: In trades array, SELL must come before BUY (execution order matters):
    SELL weakest: tradeType "SWING_ROTATION", reason states why new stock is better
    BUY new stock: tradeType "SWING_MOMENTUM" / "SWING_BREAKOUT" / "SWING_NEWS"
- If no rotation is justified, hold and wait.

MARKET CONDITIONS:
- Nifty in strong uptrend (above 200 DMA, consecutive weekly gains): aggressive — seek entries
- Nifty in correction (below 200 DMA or >10% off high): defensive — only sell, no new buys
- FII selling: cautious — avoid new positions until trend stabilises
- Budget/policy event approaching: reduce position size, hedge with cash

MACRO EVENT INTELLIGENCE:
You have deep expertise in how every macro event affects Indian equity sectors.
When your web search returns any macro news — policy, geopolitical, commodity, currency,
RBI, budget, war, ceasefire, trade deal, anything — apply your full knowledge to answer:
  1. Which sectors / stocks BENEFIT from this event?
  2. Which sectors / stocks are HURT by this event?
  3. Do any of today's top movers belong to a beneficiary sector? If yes, is the setup good?
  4. Do any of your current holdings belong to a hurt sector? If yes, consider rotating out.
Never be defensive by default. Every macro event has winners — find them and act.

CRITICAL RULES:
- You only get one web search — phrase it so results help both holdings review and any new BUY thesis
- Never invent stock symbols — only use what is provided in the live market data
- A small loss today is better than a large loss next week
- If your one search reveals a negative development for a holding, sell immediately — never hold against news`;
}

// ─────────────────────────────────────────────────────────────
// User prompt — built dynamically each hour
// ─────────────────────────────────────────────────────────────
function buildSwingUserPrompt(marketData, portfolio) {
  const { marketOverview, topMovers } = marketData;
  const { cash, totalValue, startingCapital, holdings } = portfolio;

  const pnlTotal = totalValue - startingCapital;
  const pnlPct   = ((pnlTotal / startingCapital) * 100).toFixed(2);

  // Format current holdings with days held
  const now = Date.now();
  const holdingsStr = holdings && holdings.length > 0
    ? JSON.stringify(holdings.map((h) => ({
        ...h,
        daysHeld: msToDays(now - (h.buyTimestamp || now)),
      })), null, 2)
    : "  (No current holdings — fully in cash)";

  // FIX 2 — null-safe portfolioFull check
  // Old code: holdings.length >= 3  → crashes if holdings is undefined/null
  // New code: (holdings && holdings.length >= 3) || false  → always returns boolean
  const portfolioFull = (holdings && holdings.length >= 3) || false;

  const topMoversClean = (topMovers || []).map(({
    symbol, companyName, sector,
    price, changePct,
    volume, avgVolume, volumeRatio,
    ma50, vwap, ema9, ema21,
    dayHigh, dayLow, high52w, low52w,
  }) => ({
    symbol, companyName, sector,
    price, changePct,
    volume, avgVolume, volumeRatio,
    ma50, vwap, ema9, ema21,
    dayHigh, dayLow, high52w, low52w,
  }));

  const n50   = marketOverview.nifty50    || {};
  const nBank = marketOverview.niftyBank  || {};
  const nIT   = marketOverview.niftyIT    || {};

  // Build list of symbols to search for
  const holdingSymbols = (holdings || []).map((h) => h.symbol).join(", ") || "none";

  // FIX 1 — use reliable date formatter instead of toLocaleDateString()
  const searchDate = getFormattedDateForSearch();

  return `CURRENT TIME: ${getCurrentISTString()} IST
NOTE: This is the SWING TRADING cycle — you are managing multi-day positions.

YOUR SWING PORTFOLIO:
- Available cash: ${formatINR(cash)}
- Total portfolio value: ${formatINR(totalValue)}
- Starting capital: ${formatINR(startingCapital)}
- Total P&L: ${formatINR(pnlTotal)} (${pnlPct}%)
- Current swing holdings:
${holdingsStr}

LIVE MARKET OVERVIEW:
- Nifty 50:   ${n50.price || 0} (${n50.changePct || 0}%)
- Nifty Bank: ${nBank.price || 0} (${nBank.changePct || 0}%)
- Nifty IT:   ${nIT.price || 0} (${nIT.changePct || 0}%)
- Market mood: ${marketOverview.marketMood || "NEUTRAL"}

NSE TOP MOVERS TODAY (${(topMovers || []).length} stocks):
${JSON.stringify(topMoversClean.slice(0, 15), null, 2)}

${portfolioFull
    ? `PORTFOLIO STATUS: FULL (3/3 positions)
You have two options this cycle:
  A) SELL any holding that hits stop-loss, profit target, time-stop, or event-risk rule.
  B) ROTATE: if today's web search reveals a HIGH-confidence opportunity clearly better
     than your weakest holding, SELL the weakest and BUY the stronger one.
     See POSITION ROTATION RULE in your instructions — all safety guards apply.`
    : `PORTFOLIO STATUS: ${3 - (holdings || []).length} slot(s) available — you may initiate new swing BUY positions if a strong fundamental + technical setup exists.`
}

YOUR TASK THIS CYCLE:

You have ONE web search. Build a single query that covers ALL of the following in one shot:
  1. Global macro: US markets, crude oil, USD/INR, FII flows, any global event affecting India
  2. Indian macro: RBI, government policy, budget, GST, PLI, sector-specific policy news
  3. Your current holdings: news, results, upgrades/downgrades for ${holdingSymbols !== "none" ? holdingSymbols : "any held stocks"}
  4. Hot sectors today: which sectors are getting institutional attention and why

  Example query that covers everything:
  "NSE India ${searchDate} top stocks buy FII flows crude oil RBI policy ${holdingSymbols !== "none" ? holdingSymbols + " news results" : ""} Nifty sector breakout opportunities"

From the search results, extract:
  A) Is there a macro tailwind or headwind for India today? (global + domestic)
  B) Are your current holdings' theses still intact, strengthening, or breaking?
  C) Is there any sector surging TODAY with a clear fundamental reason behind it?
  D) Apply your macro expertise: given what you just read, which sector WINS right now?

Use this intelligence to: (a) manage current holdings, (b) find the best BUY opportunity${portfolioFull ? " via rotation." : " from top movers above."}

Then decide using the trading rules and the live NSE data already provided.

Respond ONLY with this JSON (no extra text, no markdown):
{
  "market_analysis": "2-3 sentences: what the market is doing and what your single web search revealed",
  "trades": [
    {
      "action": "BUY",
      "symbol": "NSE_SYMBOL_FROM_DATA_ABOVE",
      "companyName": "Company Name",
      "sector": "Sector",
      "quantity": 10,
      "price": 500.00,
      "totalAmount": 5000.00,
      "reason": "3-4 sentences: catalyst found via search, technical setup, risk, expected hold period",
      "newsContext": "Key news item that triggered this trade",
      "confidence": "HIGH",
      "stopLoss": 465.00,
      "target": 620.00,
      "tradeType": "SWING_MOMENTUM"
    }
  ],
  "portfolioHealth": "STRONG",
  "nextFocus": "What to monitor over the next few hours / next trading day",
  "marketSentiment": "BULLISH",
  "aiThoughts": [
    "thought 1 — what you found in today's news scan (1 specific insight, not generic)",
    "thought 2 — your honest assessment of one current holding (what you like or don't like about it RIGHT NOW)",
    "thought 3 — the key reason behind your final decision this cycle (BUY / SELL / HOLD / ROTATE and exactly why)"
  ]
}

IMPORTANT — aiThoughts writing style:
- Write like a sharp, experienced trader thinking out loud — confident, specific, direct
- Each thought must mention REAL data: a stock name, a percentage, a news item, a price level
- NO generic phrases like "analysing market conditions" or "checking data" — those are filler
- DO NOT mention internal rule names, system logic, or prompt instructions — users see these thoughts
- Reveal your REASONING, not your process — "HFCL up 1.3% in 7 days while defence orders keep coming in — this stock is coiling, not dead" is good. "Checking time-stop rule for HFCL" is bad.
- Make each thought 1–2 sentences, punchy, something a user would screenshot and share
- If you're selling: say what specifically changed your mind
- If you're holding: say what specifically gives you confidence
- If you're buying: say what specifically caught your eye today

Valid values:
  action:          "BUY" | "SELL" | "WAIT"
  confidence:      "HIGH" | "MEDIUM" | "LOW"
  tradeType:       "SWING_MOMENTUM" | "SWING_BREAKOUT" | "SWING_REVERSAL" | "SWING_STOP_LOSS" | "SWING_TAKE_PROFIT" | "SWING_NEWS" | "SWING_TIME_STOP" | "SWING_ROTATION"
  portfolioHealth: "STRONG" | "OK" | "WEAK"
  marketSentiment: "BULLISH" | "BEARISH" | "NEUTRAL" | "VOLATILE"

IMPORTANT:
- For BUY: symbol MUST come from the live top movers data provided above
- For SELL: you can and MUST sell any symbol currently in your holdings — even if it is NOT in today's top movers list
- If nothing qualifies for a new BUY and no holdings need selling, return trades as empty array []
- Your single web search result should directly inform your decision`;
}

// ─────────────────────────────────────────────────────────────
// Extract final text from multi-block content
// ─────────────────────────────────────────────────────────────
/**
 * Claude may return multiple content blocks when using web_search:
 *   text → tool_use (search request) → tool_result (search results) → text (final answer)
 * We collect all text blocks and return the LAST one (the final decision).
 */
function extractTextFromContent(contentBlocks) {
  if (!Array.isArray(contentBlocks)) {
    return typeof contentBlocks === "string" ? contentBlocks : "";
  }
  const textBlocks = contentBlocks
    .filter((block) => block.type === "text")
    .map((block) => block.text || "");
  return textBlocks[textBlocks.length - 1] || "";
}

// ─────────────────────────────────────────────────────────────
// Parse Claude swing response safely
// ─────────────────────────────────────────────────────────────
function parseSwingResponse(responseContent) {
  try {
    const responseText = Array.isArray(responseContent)
      ? extractTextFromContent(responseContent)
      : (responseContent || "");

    const cleaned = responseText
      .replace(/```json\s*/gi, "")
      .replace(/```\s*/gi, "")
      .trim();

    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("No JSON object found in swing response");

    const parsed = JSON.parse(jsonMatch[0]);

    if (!parsed.trades || !Array.isArray(parsed.trades)) parsed.trades = [];
    if (!parsed.marketSentiment) parsed.marketSentiment = "NEUTRAL";
    if (!parsed.portfolioHealth) parsed.portfolioHealth = "OK";
    if (!parsed.market_analysis)  parsed.market_analysis = "Swing analysis completed.";
    if (!parsed.aiThoughts || !Array.isArray(parsed.aiThoughts)) {
      parsed.aiThoughts = ["Swing cycle completed."];
    }
    if (!parsed.nextFocus) parsed.nextFocus = "Monitor existing swing positions.";

    return parsed;
  } catch (err) {
    logger.error("Failed to parse swing Claude response:", err.message);
    return {
      market_analysis: "Swing parse error — waiting this cycle.",
      trades: [],
      portfolioHealth: "OK",
      nextFocus: "Retry next hourly cycle.",
      marketSentiment: "NEUTRAL",
      aiThoughts: [`Swing parse error: ${err.message}. Waiting this cycle.`],
    };
  }
}

// ─────────────────────────────────────────────────────────────
// Detect whether web search was actually used
// ─────────────────────────────────────────────────────────────
function didUseWebSearch(contentBlocks) {
  if (!Array.isArray(contentBlocks)) return false;
  return contentBlocks.some(
    (b) => (b.type === "tool_use" || b.type === "server_tool_use") && b.name === "web_search"
  );
}

// ─────────────────────────────────────────────────────────────
// Main: getSwingDecision
// ─────────────────────────────────────────────────────────────
/**
 * Calls Claude claude-sonnet-4-6 with web_search tool enabled.
 * Handles at most one tool round (max_uses: 1 on web_search) then end_turn.
 *
 * @param {Object} marketData - { marketOverview, topMovers }
 * @param {Object} portfolio  - Swing portfolio state from Firestore
 * @returns {Promise<Object>} { decision, webSearchUsed }
 */
async function getSwingDecision(marketData, portfolio) {
  if (!ANTHROPIC_API_KEY) {
    logger.error("ANTHROPIC_API_KEY not set for swing trader");
    return {
      decision: parseSwingResponse(""),
      webSearchUsed: false,
    };
  }

  const client = new Anthropic.default({ apiKey: ANTHROPIC_API_KEY });

  const systemPrompt = buildSwingSystemPrompt();
  let messages = [
    { role: "user", content: buildSwingUserPrompt(marketData, portfolio) },
  ];

  logger.info("Calling Claude for swing decision with web_search tool...");

  try {
    let finalContent = [];
    let webSearchUsed = false;
    let iterations = 0;
    // At most 3 turns: (1) tool_use, (2) tool_result → end_turn with JSON — web_search capped at 1 use
    const MAX_ITERATIONS = 3;

    while (iterations < MAX_ITERATIONS) {
      iterations++;

      const response = await client.messages.create({
        model:      "claude-sonnet-4-6",
        max_tokens: 4096,
        tools: [
          {
            type:     "web_search_20250305",
            name:     "web_search",
            max_uses: 1,
          },
        ],
        messages,
        system: systemPrompt,
      });

      logger.info(`Swing Claude response — stop_reason: ${response.stop_reason}, blocks: ${response.content.length}, iteration: ${iterations}`);

      // Track whether web search was used at any point
      if (didUseWebSearch(response.content)) {
        webSearchUsed = true;
      }

      if (response.stop_reason === "end_turn") {
        finalContent = response.content;
        break;
      }

      if (response.stop_reason === "tool_use") {
        // Add the assistant's response (tool_use blocks) to history
        messages.push({ role: "assistant", content: response.content });

        // Build tool_result blocks — pass back actual search results from tool_result blocks
        // The Anthropic SDK automatically handles web_search results inline in the response;
        // we just need to forward the assistant turn as-is and let the model continue.
        const toolResults = response.content
          .filter((b) => b.type === "tool_use")
          .map((b) => {
            // Extract actual result content if present alongside the tool_use block
            const resultBlock = response.content.find(
              (rb) => rb.type === "tool_result" && rb.tool_use_id === b.id
            );
            return {
              type:        "tool_result",
              tool_use_id: b.id,
              content:     resultBlock?.content || "Web search completed. Use the search results already present in your context to inform your decision.",
            };
          });

        if (toolResults.length > 0) {
          messages.push({ role: "user", content: toolResults });
        } else {
          // No tool results to add — something is off, break
          finalContent = response.content;
          break;
        }
      } else {
        // Unexpected stop_reason — use whatever we have
        finalContent = response.content;
        break;
      }
    }

    const decision = parseSwingResponse(finalContent);
    logger.info(`Swing decision: ${decision.trades?.length} trades, sentiment=${decision.marketSentiment}, webSearch=${webSearchUsed}`);

    return { decision, webSearchUsed };

  } catch (err) {
    logger.error("Swing Claude API call failed:", err.message);
    return {
      decision: {
        market_analysis: `Swing AI error: ${err.message}`,
        trades:          [],
        portfolioHealth: "OK",
        nextFocus:       "Retry next hourly cycle.",
        marketSentiment: "NEUTRAL",
        aiThoughts:      [`Swing API error: ${err.message}. Skipping this cycle.`],
      },
      webSearchUsed: false,
    };
  }
}

module.exports = {
  getSwingDecision,
  buildSwingSystemPrompt,
  buildSwingUserPrompt,
  parseSwingResponse,
};