# Firebase-Only Setup (No Python, No Render)

This setup runs the project using only:
- Firebase (Firestore + Cloud Functions + Scheduler)
- Flutter app
- Anthropic API key

No local Python, no uv, no Render deployment is required.

## 1) Prerequisites

- Node.js 18+
- Firebase CLI (`npm i -g firebase-tools`)
- Flutter SDK
- FlutterFire CLI (`dart pub global activate flutterfire_cli`)
- A Firebase project on Blaze plan (Scheduler requires Blaze)

## 2) Configure Firebase project

From project root:

```bash
cd /Users/abc/Projects/stock_market/ai_trader
firebase login
firebase use --add
```

If not initialized before:

```bash
firebase init functions firestore
```

When asked:
- Functions language: JavaScript
- Functions source: `functions`
- Use existing files (do not overwrite)

## 3) Set required env config

Only Anthropic key is required now:

```bash
firebase functions:config:set anthropic.api_key="YOUR_ANTHROPIC_API_KEY"
```

Verify:

```bash
firebase functions:config:get
```

## 4) Install function dependencies and deploy backend

```bash
cd functions
npm install
cd ..
firebase deploy --only firestore:rules,functions
```

## 5) Seed Firestore initial portfolio state

In Firebase Console -> Firestore:
- Collection: `portfolio`
- Document: `state`

Create fields:

```json
{
  "cash": 10000,
  "totalValue": 10000,
  "startingCapital": 10000,
  "holdings": []
}
```

Also add:
- `lastUpdated` as Firestore timestamp

## 6) Configure and run Flutter app

```bash
cd flutter_app
flutter pub get
flutterfire configure
flutter run
```

## 7) Test one cycle

In the app:
1. Open Settings
2. Tap **Run one trading cycle now**

Then verify in Firestore:
- `ai_logs` has a new document
- `portfolio/state/snapshots` has a new document
- `trades` may have entries (or none if AI returns WAIT)

## Notes

- The market data is now fetched directly in Cloud Functions from Yahoo/NSE sources.
- The `market_api/` folder is no longer required for runtime.
- Keep Scheduler timezone as `Asia/Kolkata`.
- Claude web search is enabled in `functions/claude_trader.js` and can check latest market news each cycle.
- `max_uses` controls maximum web searches per cycle (current value: `5`).
- Yahoo prices are usually close to live exchange prices, but slight delay/variance can happen and is normal in paper-trading setups.
