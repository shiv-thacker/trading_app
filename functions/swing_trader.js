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
- Up 20–30% from your buy price (take profit — book at least partial gains)
- Thesis broken: news contradicts the reason you bought (use your one search result to verify)
- Position held more than 20 trading days with no meaningful progress (time stop)
- Stock underperforming the Nifty consistently for 5+ days

MARKET CONDITIONS:
- Nifty in strong uptrend (above 200 DMA, consecutive weekly gains): aggressive — seek entries
- Nifty in correction (below 200 DMA or >10% off high): defensive — only sell, no new buys
- FII selling: cautious — avoid new positions until trend stabilises
- Budget/policy event approaching: reduce position size, hedge with cash

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
  const holdingSymbols = holdings.map((h) => h.symbol).join(", ") || "none";

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

NSE TOP MOVERS TODAY (${topMovers.length} stocks for reference):
${JSON.stringify(topMoversClean.slice(0, 15), null, 2)}

YOUR TASK THIS CYCLE:

You may call web_search at most ONCE (max_uses: 1). Combine everything into a single search query, e.g.:
  "NSE India stock market news today ${holdingSymbols !== "none" ? "holdings " + holdingSymbols : ""} Nifty sector flows"
Use the results to: (a) review whether to hold or sell current positions, (b) judge if any top-mover above merits a swing BUY.

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
    "Running one web search (combined query for India markets + holdings)...",
    "Cross-checking search results with live NSE data above...",
    "Final swing decision being made..."
  ]
}

Valid values:
  action:          "BUY" | "SELL" | "WAIT"
  confidence:      "HIGH" | "MEDIUM" | "LOW"
  tradeType:       "SWING_MOMENTUM" | "SWING_BREAKOUT" | "SWING_REVERSAL" | "SWING_STOP_LOSS" | "SWING_TAKE_PROFIT" | "SWING_NEWS" | "SWING_TIME_STOP"
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
    (b) => b.type === "tool_use" && b.name === "web_search"
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
