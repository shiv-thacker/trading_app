/**
 * functions/claude_trader.js
 * ==========================
 * Calls Claude claude-sonnet-4-6 via Anthropic API to make all trade decisions.
 *
 * PURPOSE:
 *   ARJUN's "brain." Every 5 minutes this module sends Claude:
 *     - Live NSE market overview (index levels + mood)
 *     - Live top 20 momentum stocks fetched RIGHT NOW from NSE
 *     - Current portfolio state (holdings, cash, P&L)
 *     - Web search capability — Claude browses Indian financial news live
 *   Claude returns a structured JSON decision with trades to execute.
 *
 * FUNCTIONS:
 *   getTradeDecision(marketData, portfolio) → Claude's JSON decision
 *   buildSystemPrompt()                     → ARJUN persona system prompt
 *   buildUserPrompt(marketData, portfolio)  → Dynamic prompt with live data
 *   parseClaudeResponse(content)            → Safe JSON parse with fallback
 *
 * CONFIG:
 *   ANTHROPIC_API_KEY is read from Firebase environment config:
 *     firebase functions:config:set anthropic.api_key="sk-ant-..."
 *
 * CRITICAL RULES:
 *   - Claude model MUST be claude-sonnet-4-6
 *   - The prompt NEVER contains hardcoded stock symbols
 *   - All stock symbols in the prompt come from live topMovers data
 *   - Parse errors NEVER crash the trading loop — returns WAIT decision
 *   - web_search tool is enabled — Claude can browse Indian financial news live
 */

const Anthropic = require("@anthropic-ai/sdk");
const functions = require("firebase-functions");
const logger = require("firebase-functions/logger");

// Anthropic client (API key from Firebase environment config)
const ANTHROPIC_API_KEY =
  (functions.config().anthropic && functions.config().anthropic.api_key) ||
  process.env.ANTHROPIC_API_KEY;

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

/**
 * Format a number as Indian currency string (₹1,23,456.78)
 */
function formatINR(amount) {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    minimumFractionDigits: 2,
  }).format(amount);
}

/**
 * Get current IST time string formatted for prompt
 */
function getCurrentISTString() {
  return new Date().toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

// ─────────────────────────────────────────────────────────────
// System prompt — ARJUN's persona
// ─────────────────────────────────────────────────────────────
function buildSystemPrompt() {
  return `You are ARJUN — a professional NSE stock trader AI with 20 years of experience. You are data-driven, unemotional, and disciplined.

You NEVER trade a fixed list of stocks. You trade whatever the live market data shows as the best opportunity RIGHT NOW.
You understand Indian markets deeply: NSE trading hours (09:15–15:30 IST), F&O expiry effects, FII/DII flows, sector rotation, and intraday momentum patterns.

You always protect capital first. A small loss today is better than a large loss tomorrow.

You make all decisions purely from the live real-time NSE data provided each cycle — price, volume, momentum, and index levels. This data is fetched directly from NSE and is more accurate and timely than any external source for intraday decisions.

CRITICAL RULES:
- Never invent or hardcode stock symbols — only trade what appears in the live top movers data
- Volume ratio (volumeRatio) above 1.5x is a strong confirmation signal — prioritise it
- Price above ma50 confirms the stock is in an uptrend — required for BUY
- A stock near its 52-week high (price > 90% of high52w) is in breakout territory — high conviction
- Price above VWAP is stronger BUY confirmation
- EMA9 > EMA21 confirms short-term trend strength; prefer these stocks
- Price near pivotS1 can be a good entry zone
- Avoid fresh BUY very close to pivotR1 due to near-term resistance
- If EMA9 > EMA21 AND price > MA50: strong uptrend — prefer these stocks
- If price > 95% of high52w: breakout territory — high conviction
- If volumeRatio > 2x: exceptional liquidity — strong signal
- If price > PP and R1 is nearby: wait, too much resistance ahead
- If price > PP and R1 is far: good room to run — valid entry
- Never ignore the Nifty 50 trend — if it is down >1%, go defensive regardless of individual signals`;
}

// ─────────────────────────────────────────────────────────────
// User prompt — built dynamically each cycle with live data
// ─────────────────────────────────────────────────────────────
/**
 * Builds the full user prompt string injected with live market data.
 *
 * @param {Object} marketData - { marketOverview, topMovers }
 * @param {Object} portfolio  - { cash, totalValue, startingCapital, holdings }
 * @returns {string} Full prompt string
 */
function buildUserPrompt(marketData, portfolio) {
  const { marketOverview, topMovers } = marketData;
  const { cash, totalValue, startingCapital, holdings } = portfolio;

  // Calculate P&L
  const pnlTotal = totalValue - startingCapital;
  const pnlPct   = ((pnlTotal / startingCapital) * 100).toFixed(2);

  // Format holdings for prompt
  const holdingsStr =
    holdings && holdings.length > 0
      ? JSON.stringify(holdings, null, 2)
      : "  (No current holdings — fully in cash)";

  // All 20 top movers with full trading-relevant fields
  const topMoversClean = (topMovers || []).map(({ symbol, companyName, sector, price, changePct, volume, avgVolume, volumeRatio, ma50, vwap, ema9, ema21, dayHigh, dayLow, high52w, low52w, pivotPP, pivotR1, pivotS1 }) => ({
    symbol, companyName, sector,
    price, changePct,
    volume, avgVolume, volumeRatio,
    ma50, vwap, ema9, ema21,
    dayHigh, dayLow, high52w, low52w,
    pivotPP, pivotR1, pivotS1,
  }));
  const topMoversStr = JSON.stringify(topMoversClean, null, 2);

  // Index data
  const n50    = marketOverview.nifty50    || {};
  const nBank  = marketOverview.niftyBank  || {};
  const nIT    = marketOverview.niftyIT    || {};
  const nPh    = marketOverview.niftyPharma|| {};
  const nAuto  = marketOverview.niftyAuto  || {};
  const nEn    = marketOverview.niftyEnergy|| {};

  return `CURRENT TIME: ${getCurrentISTString()} IST

YOUR PORTFOLIO STATE:
- Available cash: ${formatINR(cash)}
- Total portfolio value: ${formatINR(totalValue)}
- Starting capital: ${formatINR(startingCapital)}
- Total P&L: ${formatINR(pnlTotal)} (${pnlPct}%)
- Current holdings:
${holdingsStr}

LIVE MARKET RIGHT NOW:
- Nifty 50:     ${n50.price || 0}  (${n50.changePct || 0}%)
- Nifty Bank:   ${nBank.price || 0} (${nBank.changePct || 0}%)
- Nifty IT:     ${nIT.price || 0}  (${nIT.changePct || 0}%)
- Nifty Pharma: ${nPh.price || 0}  (${nPh.changePct || 0}%)
- Nifty Auto:   ${nAuto.price || 0} (${nAuto.changePct || 0}%)
- Nifty Energy: ${nEn.price || 0}  (${nEn.changePct || 0}%)
- Market mood:  ${marketOverview.marketMood || "NEUTRAL"}

TODAY'S LIVE TOP MOVERS FROM NSE (fetched right now — ${topMovers.length} stocks):
${topMoversStr}

These are the stocks with real momentum at this exact moment.
Analyse them and pick the best opportunity — or wait if nothing qualifies.

YOUR STRICT TRADING RULES:

PORTFOLIO LIMITS:
- Hold max 5 stocks at once
- Max 35% of total portfolio in one stock
- Always keep min ₹800 cash reserve
- Max 35% of available cash per single trade

ENTRY — buy only if ALL conditions met:
- Stock up >1.5% today
- Volume > 1.5x its 10-day average
- EMA9 > EMA21
- Price > MA50
- Sector index is positive today
- Not already holding this stock

EXIT — sell if ANY condition met:
- Down 7% from your buy price (stop loss)
- Up 15% from your buy price (take profit)
- RSI above 78 (overbought)
- Reversed more than 3% from day high
- Flat for 3 consecutive cycles (15 minutes)

MARKET CONDITIONS:
- Nifty down >1%: defensive mode — only sell, no new buys
- Nifty up >0.5%: normal — look for entries
- Nifty up >1.5%: aggressive — chase momentum
- After 3:00 PM IST: close all positions, no new buys

YOUR TASK THIS CYCLE:
1. Assess the market mood from Nifty 50 change% and sector indices
2. Review each current holding against the exit rules — should anything be sold?
3. Scan all top movers — check changePct, volumeRatio, ma50, and 52w position for each
4. Pick the best BUY opportunity if ALL entry conditions are met, otherwise wait
5. Return your decision in the exact JSON below

Respond ONLY with this JSON, no extra text, no markdown:
{
  "market_analysis": "2-3 sentences describing what the market is doing now",
  "trades": [
    {
      "action": "BUY",
      "symbol": "LIVE_NSE_SYMBOL_FROM_DATA_ABOVE",
      "companyName": "Company Name",
      "sector": "Sector",
      "quantity": 10,
      "price": 287.50,
      "totalAmount": 2875.00,
      "reason": "3-4 sentences: signal seen, technicals, risk, expectation",
      "confidence": "HIGH",
      "stopLoss": 267.00,
      "target": 330.00,
      "tradeType": "MOMENTUM"
    }
  ],
  "portfolioHealth": "STRONG",
  "nextFocus": "What to watch in the next 5 minutes",
  "marketSentiment": "BULLISH",
  "aiThoughts": [
    "Scanning ${topMovers.length} live top movers from NSE...",
    "Nifty at ${n50.changePct || 0}% — assessing market conditions",
    "Checking each candidate against entry criteria...",
    "Final decision being made..."
  ]
}

Valid values:
  action:        "BUY" | "SELL" | "WAIT"
  confidence:    "HIGH" | "MEDIUM" | "LOW"
  tradeType:     "MOMENTUM" | "REVERSAL" | "STOP_LOSS" | "TAKE_PROFIT" | "DEFENSIVE"
  portfolioHealth: "STRONG" | "OK" | "WEAK"
  marketSentiment: "BULLISH" | "BEARISH" | "NEUTRAL" | "VOLATILE"

IMPORTANT:
- Symbol in trades MUST come from the live top movers data provided above
- Never invent a symbol — only use what is in the live data
- If nothing qualifies, return trades as empty array []
- For WAIT actions, still include the action field but no other trade fields needed`;
}

// ─────────────────────────────────────────────────────────────
// Extract final text from Claude content blocks
// ─────────────────────────────────────────────────────────────
/**
 * When web_search tool is used, Claude returns multiple content blocks
 * (text + tool_use + tool_result + final text). We extract all text blocks
 * and find the JSON decision in the last one.
 *
 * @param {Array} contentBlocks - message.content array from Claude API
 * @returns {string} The final text response from Claude
 */
function extractTextFromContent(contentBlocks) {
  if (!Array.isArray(contentBlocks)) {
    return typeof contentBlocks === "string" ? contentBlocks : "";
  }

  // Collect all text blocks (the last text block is always the final decision)
  const textBlocks = contentBlocks
    .filter((block) => block.type === "text")
    .map((block) => block.text || "");

  // Return the last text block (final response after web searches)
  return textBlocks[textBlocks.length - 1] || "";
}

// ─────────────────────────────────────────────────────────────
// Parse Claude response safely
// ─────────────────────────────────────────────────────────────
/**
 * Safely parses Claude's JSON response.
 * Handles both plain text and multi-block responses (when web_search is used).
 * If parsing fails for any reason, returns a safe WAIT decision
 * so the trading loop never crashes.
 *
 * @param {string|Array} responseContent - Raw text or content blocks from Claude
 * @returns {Object} Parsed decision object
 */
function parseClaudeResponse(responseContent) {
  try {
    // Extract plain text from content blocks (handles web_search multi-block response)
    const responseText = Array.isArray(responseContent)
      ? extractTextFromContent(responseContent)
      : (responseContent || "");

    // Strip any accidental markdown fences
    const cleaned = responseText
      .replace(/```json\s*/gi, "")
      .replace(/```\s*/gi, "")
      .trim();

    // Find JSON object in the text (in case Claude added text before/after)
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("No JSON object found in response");

    const parsed = JSON.parse(jsonMatch[0]);

    // Validate required fields
    if (!parsed.trades || !Array.isArray(parsed.trades)) {
      parsed.trades = [];
    }
    if (!parsed.marketSentiment) parsed.marketSentiment = "NEUTRAL";
    if (!parsed.portfolioHealth) parsed.portfolioHealth = "OK";
    if (!parsed.market_analysis)  parsed.market_analysis = "Market data received.";
    if (!parsed.aiThoughts || !Array.isArray(parsed.aiThoughts)) {
      parsed.aiThoughts = ["Cycle completed."];
    }
    if (!parsed.nextFocus) parsed.nextFocus = "Monitor existing positions.";

    return parsed;
  } catch (err) {
    logger.error("Failed to parse Claude response:", err.message);
    const preview = Array.isArray(responseContent)
      ? JSON.stringify(responseContent).substring(0, 500)
      : responseContent?.substring(0, 500);
    logger.error("Raw response was:", preview);

    // Safe fallback — WAIT decision
    return {
      market_analysis: "Parse error — waiting this cycle.",
      trades: [],
      portfolioHealth: "OK",
      nextFocus: "Retry next cycle.",
      marketSentiment: "NEUTRAL",
      aiThoughts: [`Parse error: ${err.message}. Waiting this cycle.`],
    };
  }
}

// ─────────────────────────────────────────────────────────────
// Main function: getTradeDecision
// ─────────────────────────────────────────────────────────────
/**
 * Calls Claude claude-sonnet-4-20250514 with live market data and portfolio state,
 * returns a structured trade decision.
 *
 * @param {Object} marketData - { marketOverview, topMovers }
 * @param {Object} portfolio  - Portfolio state from Firestore
 * @returns {Promise<Object>} Claude's trade decision
 */
async function getTradeDecision(marketData, portfolio) {
  if (!ANTHROPIC_API_KEY) {
    logger.error("ANTHROPIC_API_KEY not set in Firebase config");
    return parseClaudeResponse(""); // Returns safe WAIT
  }

  const client = new Anthropic.default({ apiKey: ANTHROPIC_API_KEY });

  const systemPrompt = buildSystemPrompt();
  const userPrompt   = buildUserPrompt(marketData, portfolio);

  logger.info("Calling Claude claude-sonnet-4-6 with web_search enabled...");

  try {
    const message = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 2048,
      messages: [
        { role: "user", content: userPrompt },
      ],
      system: systemPrompt,
    });

    logger.info(`Claude responded with ${message.content.length} content block(s), stop_reason: ${message.stop_reason}`);

    // Pass full content blocks — parser handles multi-block web_search responses
    return parseClaudeResponse(message.content);
  } catch (err) {
    logger.error("Claude API call failed:", err.message);
    // Return safe WAIT — never crash the trading loop
    return {
      market_analysis: `Claude API error: ${err.message}`,
      trades: [],
      portfolioHealth: "OK",
      nextFocus: "Retry next cycle.",
      marketSentiment: "NEUTRAL",
      aiThoughts: [`API error: ${err.message}. Skipping this cycle.`],
    };
  }
}

module.exports = {
  getTradeDecision,
  buildSystemPrompt,
  buildUserPrompt,
  parseClaudeResponse,
};
