# AI Trader — Project Documentation

**ARJUN** — An autonomous AI that trades Indian NSE stocks 24/7 with ₹10,000 virtual money.  
Built with Flutter (mobile app) + Firebase (backend) + Claude Sonnet AI + direct Yahoo/NSE market data (no Python service).

---

## Table of Contents
1. [Architecture Overview](#architecture-overview)
2. [Project Structure](#project-structure)
3. [File-by-File Reference](#file-by-file-reference)
4. [Data Flow](#data-flow)
5. [Firestore Schema](#firestore-schema)
6. [Environment Variables](#environment-variables)
7. [Deployment Guide](#deployment-guide)
8. [Trading Logic](#trading-logic)
9. [Key Design Decisions](#key-design-decisions)
10. [Troubleshooting](#troubleshooting)

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                     Flutter Mobile App                      │
│          Reads Firestore in real-time (READ ONLY)           │
│  Dashboard | History | Portfolio | AI Brain | Settings      │
└──────────────────────────┬──────────────────────────────────┘
                           │ Firestore real-time streams
                           ▼
┌─────────────────────────────────────────────────────────────┐
│                    Google Firestore                         │
│   portfolio/state  │  trades  │  ai_logs  │  snapshots      │
└──────────────────────────┬──────────────────────────────────┘
                           │ Admin SDK (read + write)
                           ▼
┌─────────────────────────────────────────────────────────────┐
│              Firebase Cloud Functions (Node.js)             │
│                                                             │
│  tradingLoop (every 5 min)    manualTrigger (HTTPS)         │
│  resetPortfolio (HTTPS)                                     │
│                                                             │
│  Step 1: Market hours check                                 │
│  Step 2: Read portfolio from Firestore                      │
│  Step 3: Fetch live data from Yahoo/NSE APIs ───────────┐  │
│  Step 4: Update P&L on holdings                         │  │
│  Step 5: Call Claude Sonnet AI + web_search tool ─┐    │  │
│  Step 6: Execute trades                             │    │  │
│  Step 7: Save everything to Firestore               │    │  │
└─────────────────────────────────────────────────────│────│──┘
                                                      │    │
                                          ┌───────────┘    │
                                          ▼                │
                              ┌─────────────────┐          │
                              │  Anthropic API  │          │
                              │ Claude Sonnet   │          │
                              │ (Trade Decision)│          │
                              └─────────────────┘          │
                                                           │
                                           ┌───────────────┘
                                           ▼
                              ┌─────────────────────────┐
                              │ Yahoo Finance Chart API  │
                              │ + NSE archive CSV list    │
                              │ (fetched by Node.js)      │
                              └─────────────────────────┘
```

---

## Project Structure

```
ai_trader/
│
├── flutter_app/                    ← Flutter mobile app (READ-ONLY Firestore)
│   ├── pubspec.yaml                → Flutter dependencies
│   └── lib/
│       ├── main.dart               → App entry, theme, navigation, disclaimer
│       ├── firebase_options.dart   → Firebase project config (run flutterfire configure)
│       │
│       ├── models/
│       │   ├── trade.dart          → Trade data model (Firestore ↔ Dart)
│       │   ├── portfolio.dart      → Portfolio + Holding + Snapshot models
│       │   └── ai_log.dart         → AILog model for AI Brain screen
│       │
│       ├── services/
│       │   └── firestore_service.dart → All Firestore streams + Cloud Function calls
│       │
│       ├── screens/
│       │   ├── dashboard_screen.dart  → Main screen: value, holdings, intraday chart
│       │   ├── history_screen.dart    → Trade history with BUY/SELL filter
│       │   ├── portfolio_screen.dart  → Pie chart, all-time chart, position details
│       │   ├── ai_brain_screen.dart   → Live ARJUN thought log feed
│       │   └── settings_screen.dart   → Manual trigger, reset, app info
│       │
│       └── widgets/
│           ├── market_status_bar.dart → Pulsing ARJUN status + countdown timer
│           ├── trade_card.dart        → Single trade display card
│           └── portfolio_chart.dart   → fl_chart line chart (intraday + all-time)
│
├── functions/                      ← Firebase Cloud Functions (Node.js)
│   ├── package.json                → Node.js dependencies
│   ├── index.js                    → Main trading engine (tradingLoop, manualTrigger)
│   ├── market_data.js              → HTTP client for Python market API
│   ├── claude_trader.js            → Claude Sonnet AI integration
│   └── firestore_manager.js        → All Firestore read/write operations
│
├── firestore.rules                 → Security rules (Flutter=read, Functions=write)
│
└── docs/
    ├── PROJECT_DOCS.md             → This file
    └── PROMPT.md                   → Original project specification prompt
```

---

## File-by-File Reference

### `functions/package.json`
Node.js 20 project. Key dependencies:
- `@anthropic-ai/sdk` — Claude API client
- `axios` — HTTP client for Yahoo/NSE endpoints
- `technicalindicators` — RSI/EMA calculations in Node.js
- `firebase-admin`, `firebase-functions` — Firebase SDK

---

### `functions/market_data.js`
**What it does:** Fetches live data directly in Node.js (Firebase-only backend).  
No Python or Render required.

| Function | Calls | Returns |
|---|---|---|
| `getMarketOverview()` | Yahoo chart API (indices) | Index prices + mood |
| `getTopMovers()` | NSE CSV universe + Yahoo chart API | Array of 20 live NSE stocks |
| `getCurrentPrices(symbols[])` | Yahoo chart API per symbol | `{ SYMBOL: price }` map |

Universe source: NSE `ind_nifty500list.csv` refreshed and cached in memory.  
All functions throw descriptive errors so the trading loop can catch and log them.

---

### `functions/claude_trader.js`
**What it does:** ARJUN's AI brain. Calls Claude claude-sonnet-4-20250514 with live market data.

| Function | Purpose |
|---|---|
| `buildSystemPrompt()` | Defines ARJUN's persona and enforces mandatory India-focused news checks before decisions. |
| `buildUserPrompt(marketData, portfolio)` | Builds the full prompt dynamically with live index data, live top movers, portfolio state, risk rules, and explicit web-search tasks. |
| `parseClaudeResponse(content)` | Safely parses Claude's JSON from both normal text responses and multi-block responses produced when tools are used. |
| `getTradeDecision(marketData, portfolio)` | Calls Claude with `web_search_20250305` tool enabled and returns structured decision with safe `WAIT` fallback on API/parse errors. |

**CRITICAL:** If Claude API fails for any reason, this function returns a WAIT decision. The trading loop continues without crashing.

---

### `functions/firestore_manager.js`
**What it does:** All Firestore database operations. Index.js never touches Firestore directly.

| Function | Collection | Operation |
|---|---|---|
| `getPortfolioState()` | `portfolio/state` | Read. Returns default ₹10,000 state if doc doesn't exist yet. |
| `savePortfolioState(state)` | `portfolio/state` | Write (full replace with server timestamp). |
| `recordTrade(tradeData)` | `trades` | Add new document per executed trade. |
| `recordSnapshot(portfolio)` | `portfolio/state/snapshots` | Add time-series data point. |
| `recordAILog(logData)` | `ai_logs` | Add cycle log. |
| `calculateUnrealizedPnL(holdings, prices)` | — | Pure function. Updates `currentPrice`, `unrealizedPnl`, `unrealizedPnlPct` on each holding. |
| `initializePortfolio()` | `portfolio/state` | Creates initial ₹10,000 document. |

All write functions use `try/catch` with `logger.error`. Non-critical writes (logs, snapshots) never throw — failures are logged but don't abort the trading cycle.

---

### `functions/index.js`
**What it does:** The main trading engine. Orchestrates the full autonomous cycle.

**Exported Cloud Functions:**

| Function | Trigger | Purpose |
|---|---|---|
| `tradingLoop` | Cloud Scheduler — every 5 min, IST | Full autonomous trading cycle |
| `manualTrigger` | HTTPS Callable | Triggered from Flutter Settings screen for testing |
| `resetPortfolio` | HTTPS Callable | Resets to ₹10,000 (market-closed only) |

**The 10-step trading cycle (`runTradingCycle`):**
1. **Market check** — Returns MARKET_CLOSED log if outside 09:15–15:30 IST, Mon–Fri
2. **Read portfolio** — Gets current state from Firestore
3. **Fetch live data** — Parallel: `getMarketOverview()` + `getTopMovers()` (LIVE NSE data via Yahoo/NSE)
4. **Update P&L** — Gets real-time prices for current holdings, recalculates unrealized P&L
5. **Ask Claude** — Sends live data to Claude claude-sonnet-4-20250514 with web search enabled, gets trade decisions
6. **Execute trades** — For each `BUY`: validates, deducts cash, adds holding. For each `SELL`: calculates P&L, adds proceeds, removes holding
7. **Increment cycles** — Adds 1 to `cyclesHeld` on all holdings
8. **Recalculate value** — `totalValue = cash + sum(currentPrice × quantity)`
9. **Save to Firestore** — Portfolio state + snapshot + AI log all written
10. **Done** — Flutter app sees updates instantly via real-time streams

**Validation in `canBuy(trade, portfolio)`:**
- Max 5 holdings at once
- Not already holding the symbol
- Enough cash (trade amount + ₹800 reserve)
- Trade ≤ 35% of available cash
- Trade ≤ 35% of total portfolio value

---

### `flutter_app/lib/main.dart`
**What it does:** App entry point.
- Initializes Firebase
- Shows disclaimer modal on first launch (SharedPreferences gate)
- Sets up Riverpod ProviderScope
- Applies dark trading-terminal theme (JetBrains Mono font)
- Bottom navigation with 4 tabs: Dashboard | History | Portfolio | AI Brain
- Settings accessible via FAB on Dashboard

---

### `flutter_app/lib/models/trade.dart`
**What it does:** Dart model for a single trade. Maps from Firestore document.  
Contains helpers: `pnlFormatted`, `pnlPctFormatted`, `isProfit`, `timestamp`.  
Includes `_formatINR()` helper for Indian number formatting (₹1,23,456.78).

---

### `flutter_app/lib/models/portfolio.dart`
**What it does:** Three models:
- `Holding` — one open stock position (symbol, qty, buy price, current price, P&L, SL, target)
- `Portfolio` — full portfolio state (cash, totalValue, holdings list). Computes `totalPnl`, `cashPct`, `canBuyMore`
- `Snapshot` — historical data point for charting

---

### `flutter_app/lib/models/ai_log.dart`
**What it does:** Dart model for one ARJUN thinking cycle. Maps from `ai_logs` Firestore collection.  
Fields: `cycleStatus` (TRADED/WAITED/MARKET_CLOSED), `thoughts[]`, `marketSentiment`, `portfolioHealth`, `nextFocus`.

---

### `flutter_app/lib/services/firestore_service.dart`
**What it does:** The ONLY class the Flutter app uses to interact with Firebase.

| Method | Type | Returns |
|---|---|---|
| `portfolioStream()` | Stream | Real-time `Portfolio` object |
| `tradesStream(filter?)` | Stream | Real-time `List<Trade>`, newest first |
| `aiLogsStream()` | Stream | Real-time `List<AILog>`, last 50 |
| `snapshotsStream()` | Stream | Real-time `List<Snapshot>`, last 200 |
| `getTodaySnapshots()` | Future | Today's snapshots only (intraday chart) |
| `getLatestAILog()` | Future | Most recent AI log |
| `triggerManualCycle()` | Future | Calls `manualTrigger` Cloud Function |
| `resetPortfolio()` | Future | Calls `resetPortfolio` Cloud Function |
| `getTotalRealizedPnL()` | Future | Sum of all SELL trade P&Ls |

Exposed as a Riverpod `Provider<FirestoreService>` — use `ref.read(firestoreServiceProvider)`.

---

### `flutter_app/lib/screens/dashboard_screen.dart`
**What it does:** Main screen. Shows live portfolio state.  
Real-time Riverpod stream providers: `portfolioProvider`, `aiLogsProvider`, `snapshotsProvider`.

Sections:
- **Portfolio value** — large headline with total P&L and cash
- **ARJUN status bar** — pulsing dot, status text, next cycle countdown
- **Market sentiment banner** — latest Claude analysis + sentiment chip
- **Holdings list** — each open position with P&L, SL, target badges
- **Intraday chart** — today's portfolio value (5-min snapshots)
- Pull-to-refresh invalidates all providers

---

### `flutter_app/lib/screens/history_screen.dart`
**What it does:** All trades ARJUN has executed.  
Filter tabs (ALL / BUY / SELL) using `StateProvider` for filter and `StreamProvider.family`.  
Summary bar shows trade count, realized P&L, win rate.  
Uses `TradeCard` widget for each trade.

---

### `flutter_app/lib/screens/portfolio_screen.dart`
**What it does:** Deep portfolio analysis.
- Allocation pie chart (fl_chart PieChart) — one segment per holding + cash segment
- All-time portfolio value line chart
- Each holding: price comparison, SL-to-target progress bar, unrealized P&L
- Stats summary: starting capital, current value, realized P&L, unrealized P&L, total P&L

---

### `flutter_app/lib/screens/ai_brain_screen.dart`
**What it does:** Live feed of ARJUN's thinking.  
Shows real-time `ai_logs` stream. Each entry shows:
- Cycle status badge (TRADED / WAITED / MARKET_CLOSED) with color coding
- Claude's market analysis paragraph
- Individual thought lines in terminal style (`> thought text`)
- Thought lines color-coded: green=BUY/profit, yellow=SELL/warning, red=error/skip, blue=scanning

Top header: current `marketSentiment` + `portfolioHealth` chips.  
"Next ARJUN will watch for" card from `nextFocus` field.

---

### `flutter_app/lib/screens/settings_screen.dart`
**What it does:** Control panel and app info.
- **Run one trading cycle now** — calls `manualTrigger` Cloud Function, shows result in SnackBar
- **Reset portfolio** — confirmation dialog → calls `resetPortfolio` Cloud Function (market-closed only)
- Info tiles: AI model, data source, trading cycle, starting capital, version
- SEBI disclaimer text

---

### `flutter_app/lib/widgets/market_status_bar.dart`
**What it does:** Animated ARJUN status bar displayed on Dashboard.  
Uses `AnimationController` with sine-wave curve for pulsing dot.  
`Timer.periodic(1 second)` for countdown to next trading cycle.  
Market-open check is done client-side using IST time calculation.

---

### `flutter_app/lib/widgets/trade_card.dart`
**What it does:** Visual card for one executed trade. Used in History screen.  
Color codes: BUY=blue border, SELL profitable=green border, SELL loss=red border.  
Shows: symbol, company, timeago, price × qty, P&L (SELL only), AI reason box, trade type badge, confidence badge.

---

### `flutter_app/lib/widgets/portfolio_chart.dart`
**What it does:** Reusable fl_chart `LineChart` widget.  
Two variants controlled by `isIntraday` flag.  
Features: gradient fill under line, dashed starting-capital reference line, touch tooltip.  
`_formatINRShort()` helper formats Y-axis values as `₹10.2K` or `₹1.23L`.

---

### `firestore.rules`
**What it does:** Firestore security rules.  
Flutter app (client SDK): READ allowed, WRITE blocked everywhere.  
Cloud Functions (Admin SDK): bypasses all rules — full read/write access.  
This prevents client-side trade manipulation while keeping the UI read-only.

---

## Data Flow

### Every 5-minute trading cycle:
```
Cloud Scheduler
    │
    ▼
tradingLoop() in index.js
    │
    ├─ 1. isMarketOpen()? → No → recordAILog(MARKET_CLOSED) → return
    │
    ├─ 2. getPortfolioState() ← Firestore
    │
    ├─ 3. Promise.all([
    │       getMarketOverview(),  ← Yahoo index endpoints
    │       getTopMovers()        ← NSE 500 universe + Yahoo candles (top 20 live)
    │     ])
    │
    ├─ 4. getCurrentPrices(holdings.symbols) ← Yahoo quotes
    │     calculateUnrealizedPnL(holdings, prices)
    │
    ├─ 5. getTradeDecision({ marketOverview, topMovers }, portfolio)
    │       └─ Claude claude-sonnet-4-20250514 via Anthropic API + web_search
    │              Returns: { trades[], aiThoughts[], marketSentiment, ... }
    │
    ├─ 6. Execute trades (BUY/SELL validation and portfolio mutation)
    │       └─ recordTrade() → Firestore for each executed trade
    │
    ├─ 7. Increment cyclesHeld on all holdings
    │
    ├─ 8. Recalculate totalValue
    │
    └─ 9. savePortfolioState() → Firestore
          recordSnapshot() → Firestore
          recordAILog() → Firestore
                │
                ▼
        Flutter app (real-time streams) updates UI instantly
```

---

## Firestore Schema

### `portfolio/state` (single document)
```json
{
  "cash": 8234.50,
  "totalValue": 10891.25,
  "startingCapital": 10000.00,
  "lastUpdated": "Timestamp",
  "holdings": [
    {
      "symbol": "RELIANCE",
      "companyName": "Reliance Industries Ltd",
      "sector": "Energy",
      "quantity": 2,
      "avgBuyPrice": 2847.50,
      "currentPrice": 2903.00,
      "unrealizedPnl": 111.00,
      "unrealizedPnlPct": 1.95,
      "buyTimestamp": 1714042800000,
      "stopLoss": 2647.50,
      "target": 3274.50,
      "cyclesHeld": 4
    }
  ]
}
```

### `portfolio/state/snapshots/{auto-id}` (sub-collection)
```json
{
  "timestamp": "Timestamp",
  "timestampMs": 1714042800000,
  "totalValue": 10891.25,
  "cash": 8234.50,
  "holdingsCount": 1,
  "pnlTotal": 891.25
}
```

### `trades/{auto-id}`
```json
{
  "timestamp": "Timestamp",
  "timestampMs": 1714042800000,
  "symbol": "RELIANCE",
  "companyName": "Reliance Industries Ltd",
  "sector": "Energy",
  "action": "BUY",
  "quantity": 2,
  "price": 2847.50,
  "totalAmount": 5695.00,
  "pnl": 0,
  "pnlPct": 0,
  "reason": "RSI 54, volume 2.3x avg, Nifty up 0.8%, sector +1.2%...",
  "confidence": "HIGH",
  "stopLoss": 2647.50,
  "target": 3274.50,
  "tradeType": "MOMENTUM",
  "marketSentiment": "BULLISH",
  "portfolioValueAfter": 10891.25
}
```

### `ai_logs/{auto-id}`
```json
{
  "timestamp": "Timestamp",
  "timestampMs": 1714042800000,
  "marketAnalysis": "Nifty up 0.8% with broad-based buying...",
  "thoughts": [
    "Scanning 20 live top movers from NSE...",
    "RELIANCE: RSI 54, vol 2.3x avg ✓",
    "Decision: BUY RELIANCE — HIGH confidence"
  ],
  "portfolioHealth": "STRONG",
  "marketSentiment": "BULLISH",
  "nextFocus": "Watch RELIANCE for momentum continuation above ₹2,900",
  "tradeCount": 1,
  "cycleStatus": "TRADED"
}
```

---

## Environment Variables

### Firebase Cloud Functions
Set these using Firebase CLI before deploying:
```bash
firebase functions:config:set anthropic.api_key="sk-ant-YOUR-KEY"
```

Access in Node.js:
```js
const functions = require('firebase-functions');
const ANTHROPIC_KEY = functions.config().anthropic.api_key;
```

---

## Deployment Guide

### Step 1: Create Firebase Project
1. Go to [Firebase Console](https://console.firebase.google.com)
2. Create new project
3. Enable Firestore Database (production mode)
4. Enable Cloud Functions (requires Blaze billing plan)
5. Enable Cloud Scheduler (included with Blaze)

### Step 2: Initialize Firestore
In Firebase Console → Firestore → Create document manually:
- Collection: `portfolio`, Document ID: `state`
- Fields: `cash: 10000`, `totalValue: 10000`, `startingCapital: 10000`, `holdings: []`

### Step 3: Deploy Firestore Rules
```bash
cd ai_trader
firebase deploy --only firestore:rules
```

### Step 4: Configure and Deploy Cloud Functions
```bash
cd functions
npm install

# Set environment config
firebase functions:config:set anthropic.api_key="YOUR_CLAUDE_API_KEY"

# Deploy
firebase deploy --only functions
```

### Step 5: Configure Flutter App
```bash
cd flutter_app

# Install FlutterFire CLI
dart pub global activate flutterfire_cli

# Generate firebase_options.dart (connects to your Firebase project)
flutterfire configure

# Install dependencies
flutter pub get

# Run
flutter run
```

### Step 6: Test End-to-End
1. Open app → tap Settings (gear icon)
2. Tap "Run one trading cycle now"
3. Go to Firebase Console → Firestore
4. Check `trades` and `ai_logs` collections for new documents
5. Dashboard should update within seconds

---

## Trading Logic

### ARJUN's Entry Rules (ALL must be true)
| Rule | Value |
|---|---|
| Stock change today | > +1.5% |
| Volume ratio | > 1.5× 10-day average |
| RSI (14-period) | Between 45 and 70 |
| Price vs EMA10 | Above EMA10 |
| Price vs EMA5 | Above EMA5 |
| Sector index | Positive today |
| Already holding | No |

### ARJUN's Exit Rules (ANY triggers sell)
| Rule | Value |
|---|---|
| Stop loss | Down 7% from buy price |
| Take profit | Up 15% from buy price |
| RSI overbought | RSI > 78 |
| Reversal | Down 3% from day high |
| Time stop | Flat for 3 consecutive cycles (15 min) |

### Market Condition Modes
| Nifty Condition | ARJUN Mode |
|---|---|
| Down > 1% | Defensive — only sell, no new buys |
| Up > 0.5% | Normal — look for entries |
| Up > 1.5% | Aggressive — chase momentum |
| After 3:00 PM IST | Close all positions, no new buys |

### Position Limits
| Limit | Value |
|---|---|
| Max holdings | 5 stocks at once |
| Max per stock | 35% of total portfolio value |
| Max per trade | 35% of available cash |
| Min cash reserve | ₹800 always kept |

---

## Key Design Decisions

### Why no hardcoded stocks?
ARJUN fetches the Nifty 500 list from NSE archives on startup and filters it live each cycle. This means:
- He reacts to emerging momentum — not yesterday's favorites
- Works correctly across market regimes (different sectors lead at different times)
- Cannot be gamed by knowing which stocks ARJUN always watches

### Why Firebase-only data pipeline?
Keeping market data in Node.js Cloud Functions removes an extra service, avoids Render cold starts, and simplifies deployment. ARJUN now fetches index/mover/price data directly from Yahoo/NSE sources.

### Why Flutter reads Firestore only?
- Security: Claude AI and market data APIs stay server-side
- Works offline: if phone connection drops mid-cycle, the trading continues
- No auth needed: Firestore rules are `allow read: true` (public virtual data)
- Flutter is just a real-time display — the source of truth is always Firestore

### Why Riverpod for state management?
- Stream providers auto-subscribe and auto-dispose
- No `setState` boilerplate
- Easy to invalidate (pull-to-refresh)
- Provider composition for derived state

---

## Troubleshooting

### Market data issues
1. Check Functions logs for Yahoo/NSE fetch errors or rate-limit responses.
2. Confirm outbound internet access is available for functions in your region.
3. Retry next cycle — failures are designed to degrade safely to WAIT.

### Cloud Functions not triggering
1. Verify Blaze billing plan is active (required for Cloud Scheduler)
2. Check Firebase Console → Functions → Logs
3. Ensure `anthropic.api_key` config is set: `firebase functions:config:get`
4. Test manually from Settings screen → "Run one trading cycle now"

### Flutter app shows empty data
1. Ensure `flutterfire configure` was run and `firebase_options.dart` is populated
2. Check Firestore has `portfolio/state` document
3. Check Firestore security rules are deployed

### Claude returning parse errors
1. Check `anthropic.api_key` config: `firebase functions:config:get`
2. Look in `ai_logs` — parse errors are logged as `WAITED` with error message in `thoughts[]`
3. The trading loop continues safely — parse errors never crash it

### Claude tool/web search behavior
1. Tool-enabled responses can contain multiple content blocks; parser handles this by reading the final text block.
2. `max_uses` limits how many web searches Claude can perform in one trading cycle.
3. If tool output is malformed or JSON parse fails, cycle safely records WAIT.
