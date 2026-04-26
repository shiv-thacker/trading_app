# AI Trader — Original Project Specification Prompt

> This file preserves the exact specification prompt used to build this project.
> Saved for reference, future onboarding, and AI context when making changes.

## Current Implementation Notes (Apr 2026)

- Runtime architecture is now Firebase-only (no Python/Render dependency in production flow).
- Live market data is fetched directly by `functions/market_data.js` from Yahoo/NSE sources.
- `functions/claude_trader.js` now enables Anthropic `web_search_20250305` so ARJUN can check latest news before deciding.
- The original prompt below is intentionally kept unchanged for historical reference.

---

You are building "AI Trader" — a Flutter mobile app + Firebase backend 
where an AI named ARJUN autonomously trades Indian NSE stocks 24/7 with 
₹10,000 virtual money. The user's phone can be fully closed — Firebase 
handles everything.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
CRITICAL RULE — NO HARDCODED STOCKS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
ARJUN never trades a fixed list of stocks.
Every single cycle he:
1. Fetches LIVE top gainers from NSE via yfinance API
2. Sends that live data to Claude Sonnet AI
3. Claude decides which stocks to trade based on real data
4. No stock symbol is ever hardcoded anywhere in the codebase

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
COMPLETE PROJECT STRUCTURE TO BUILD
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

ai_trader/
├── flutter_app/              ← Flutter mobile app
│   ├── lib/
│   │   ├── main.dart
│   │   ├── firebase_options.dart
│   │   ├── screens/
│   │   │   ├── dashboard_screen.dart
│   │   │   ├── history_screen.dart
│   │   │   ├── portfolio_screen.dart
│   │   │   ├── ai_brain_screen.dart
│   │   │   └── settings_screen.dart
│   │   ├── models/
│   │   │   ├── trade.dart
│   │   │   ├── portfolio.dart
│   │   │   └── ai_log.dart
│   │   ├── services/
│   │   │   └── firestore_service.dart
│   │   └── widgets/
│   │       ├── portfolio_chart.dart
│   │       ├── trade_card.dart
│   │       └── market_status_bar.dart
│   └── pubspec.yaml
│
├── functions/                ← Firebase Cloud Functions (Node.js)
│   ├── index.js              ← Main trading engine
│   ├── market_data.js        ← Fetches NSE data via yfinance API
│   ├── claude_trader.js      ← Calls Claude Sonnet AI
│   ├── firestore_manager.js  ← Reads/writes Firestore
│   └── package.json
│
└── firestore.rules

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
PART 1 — FIREBASE CLOUD FUNCTIONS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

FILE: functions/index.js

Create two Firebase Cloud Functions:

FUNCTION 1: tradingLoop
- Trigger: Firebase Cloud Scheduler — runs every 5 minutes
- Schedule: "every 5 minutes"
- Timezone: "Asia/Kolkata"
- Only runs between 09:15 and 15:30 IST on weekdays
- Outside market hours: writes a "MARKET_CLOSED" log to Firestore
  and exits immediately

FUNCTION 2: manualTrigger  
- Trigger: HTTPS callable
- Allows Flutter app to manually trigger one trading cycle
- Used for testing

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
FILE: functions/market_data.js
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

This file fetches LIVE data from a Python microservice hosted on 
Render.com (free tier). The Cloud Function calls these endpoints:

BASE_URL = stored in Firebase environment config as MARKET_API_URL

async function getMarketOverview()
  GET {BASE_URL}/market-overview
  Returns: { nifty50, niftyBank, niftyIT, niftyPharma, 
             niftyAuto, niftyEnergy, marketMood }

async function getTopMovers()
  GET {BASE_URL}/top-movers
  Returns: array of top 20 NSE stocks by momentum RIGHT NOW
  Each stock: { symbol, companyName, sector, price, changePct,
                volume, avgVolume, volumeRatio, rsi, 
                ma5, ma10, ma20, high52w, low52w, 
                dayHigh, dayLow }
  NOTE: This list changes every call — it's live market data
  NEVER return hardcoded stocks here

async function getCurrentPrices(symbols: string[])
  GET {BASE_URL}/prices?symbols=SYMBOL1,SYMBOL2,...
  Returns current prices for stocks ARJUN currently holds
  Used to check stop loss and take profit levels

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
FILE: functions/claude_trader.js  
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function getTradeDecision(marketData, portfolio)

Calls Claude claude-sonnet-4-20250514 via Anthropic API.
API key stored in Firebase environment config as ANTHROPIC_API_KEY.

Build the prompt dynamically using LIVE data passed in:

SYSTEM PROMPT:
"""
You are ARJUN — a professional NSE stock trader AI with 20 years 
of experience. You are data-driven, unemotional, and disciplined.

You NEVER trade a fixed list of stocks. You trade whatever the 
live market data shows as the best opportunity RIGHT NOW.
Your decisions are based 100% on the data provided to you each cycle.
"""

USER PROMPT (built dynamically every cycle):
"""
CURRENT TIME: {currentTimeIST}

YOUR PORTFOLIO STATE:
- Available cash: ₹{cash}
- Total portfolio value: ₹{totalValue}  
- Today's P&L: ₹{pnlToday} ({pnlPct}%)
- Current holdings:
{holdingsJSON}
  (symbol, qty, avgBuyPrice, currentPrice, unrealizedPnl, unrealizedPnlPct)

LIVE MARKET RIGHT NOW:
- Nifty 50: {nifty50Price} ({nifty50Change}%)
- Nifty Bank: {niftyBankChange}%
- Nifty IT: {niftyITChange}%
- Nifty Pharma: {niftyPharmaChange}%
- Nifty Auto: {niftyAutoChange}%
- Nifty Energy: {niftyEnergyChange}%
- Market mood: {marketMood}

TODAY'S LIVE TOP MOVERS FROM NSE (fetched right now):
{topMoversJSON}
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
- RSI between 45 and 70
- Price above both 5-day and 10-day moving average
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
1. Review each holding — should anything be sold?
2. Scan the live top movers — is there a qualifying buy?
3. Return your decision in the exact JSON below

Respond ONLY with this JSON, no extra text, no markdown:
{
  "market_analysis": "2-3 sentences describing what market is doing now",
  "trades": [
    {
      "action": "BUY" | "SELL" | "WAIT",
      "symbol": "LIVE_NSE_SYMBOL_FROM_DATA",
      "quantity": 10,
      "price": 287.50,
      "totalAmount": 2875.00,
      "reason": "3-4 sentences: signal seen, technicals, risk, expectation",
      "confidence": "HIGH" | "MEDIUM" | "LOW",
      "stopLoss": 267.00,
      "target": 330.00,
      "tradeType": "MOMENTUM" | "REVERSAL" | "STOP_LOSS" | "TAKE_PROFIT" | "DEFENSIVE"
    }
  ],
  "portfolioHealth": "STRONG" | "OK" | "WEAK",
  "nextFocus": "What to watch in the next 5 minutes",
  "marketSentiment": "BULLISH" | "BEARISH" | "NEUTRAL" | "VOLATILE",
  "aiThoughts": [
    "09:32:01 — Scanning 20 live top movers from NSE...",
    "09:32:02 — Nifty up 0.8%, moderate bullish conditions",
    "09:32:03 — {SYMBOL}: RSI 54, volume 2.3x avg, sector +1.2% ✓",
    "09:32:04 — {SYMBOL}: RSI 76 overbought, skip ✗",
    "09:32:05 — Decision: BUY {SYMBOL} — HIGH confidence"
  ]
}

IMPORTANT: 
- Symbol in trades MUST come from the live top movers data provided
- Never invent a symbol — only use what is in the live data above
- If nothing qualifies, return trades as empty array []
"""

Parse Claude's JSON response. 
If parsing fails, log the error and return a WAIT decision.
Never crash the trading loop on a parse error.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
FILE: functions/firestore_manager.js
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Firestore collections:

portfolio/state (single document):
{
  cash: 10000,
  totalValue: 10000,
  startingCapital: 10000,
  holdings: [],        ← array of current stock positions
  lastUpdated: timestamp
}

portfolio/snapshots (sub-collection):
One document every 5 minutes:
{
  timestamp, totalValue, cash, holdingsCount, pnlToday, pnlTotal
}

trades (collection):
One document per trade:
{
  timestamp, symbol, companyName, sector,
  action, quantity, price, totalAmount,
  pnl, pnlPct, reason, confidence,
  stopLoss, target, tradeType,
  marketSentiment, portfolioValueAfter
}

ai_logs (collection):
One document per cycle:
{
  timestamp, marketAnalysis, thoughts: [],
  portfolioHealth, marketSentiment, nextFocus,
  tradeCount, cycleStatus: "TRADED" | "WAITED" | "MARKET_CLOSED"
}

Functions to implement:
- getPortfolioState() → reads portfolio/state
- savePortfolioState(state) → writes portfolio/state
- recordTrade(tradeData) → adds to trades collection
- recordSnapshot() → adds to portfolio/snapshots
- recordAILog(logData) → adds to ai_logs collection
- calculateUnrealizedPnL(holdings, currentPrices) → returns updated holdings

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
THE FULL TRADING LOOP (index.js)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Every 5 minutes, tradingLoop runs this exact sequence:

async function runTradingCycle() {

  // STEP 1: Market hours check
  const istTime = getCurrentISTTime()
  if (!isMarketOpen(istTime)) {
    await recordAILog({ cycleStatus: "MARKET_CLOSED", ... })
    return
  }

  // STEP 2: Read current portfolio from Firestore
  const portfolio = await getPortfolioState()

  // STEP 3: Fetch live market data (no hardcoded stocks)
  const marketOverview = await getMarketOverview()
  const topMovers = await getTopMovers()  // ← LIVE from NSE right now

  // STEP 4: Update unrealized P&L on current holdings
  if (portfolio.holdings.length > 0) {
    const symbols = portfolio.holdings.map(h => h.symbol)
    const currentPrices = await getCurrentPrices(symbols)
    portfolio.holdings = calculateUnrealizedPnL(
      portfolio.holdings, currentPrices
    )
  }

  // STEP 5: Ask Claude Sonnet what to do
  const decision = await getTradeDecision(
    { marketOverview, topMovers },
    portfolio
  )

  // STEP 6: Execute each trade decision
  for (const trade of decision.trades) {
    if (trade.action === "BUY") {
      // Validate: enough cash? under max holdings? under position limit?
      if (canBuy(trade, portfolio)) {
        portfolio.cash -= trade.totalAmount
        portfolio.holdings.push({...})
        await recordTrade({...})
      }
    }
    if (trade.action === "SELL") {
      // Find holding, calculate P&L, remove from portfolio
      ...
    }
  }

  // STEP 7: Increment cyclesHeld for all holdings
  // STEP 8: Recalculate total portfolio value
  // STEP 9: Save everything to Firestore
}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
PYTHON MICROSERVICE (market_api/main.py)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

FastAPI service on Render.com.
Fetches full Nifty 500 list from NSE archives CSV on startup.
/top-movers filters and ranks live stocks by momentum (changePct × volumeRatio).
Returns top 20 with RSI, EMA5/10/20, volume data, 52w high/low.
Cache: /top-movers 4 min, /market-overview 1 min, /prices no cache.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
PART 2 — FLUTTER APP
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Dark theme, trading terminal aesthetic.
5 screens: Dashboard, History, Portfolio, AI Brain, Settings.
All data from Firestore real-time streams.
Flutter NEVER calls Claude or market API directly.
Indian number formatting everywhere (₹1,23,456.78).
All timestamps in IST.
First launch disclaimer modal.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
FINAL RULES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

1. ZERO hardcoded stock symbols anywhere in the codebase
2. All stock decisions come from live NSE data → Claude Sonnet AI
3. Claude model: claude-sonnet-4-20250514
4. Flutter reads Firestore only — never calls Claude or market API directly
5. Cloud Function is the ONLY thing that trades
6. Handle all errors gracefully — trading loop must never crash
7. Indian number formatting everywhere (₹1,23,456.78)
8. Dark theme throughout Flutter app (trading terminal aesthetic)
9. All timestamps in IST (Asia/Kolkata)
10. First app launch: show disclaimer modal before dashboard
    "Virtual simulator only. No real money. Not SEBI advice."
