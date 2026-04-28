# ARJUN Prompt Upgrade Guide
## What was trimmed for token limits — and how to restore it

On **Apr 28, 2026**, the Claude prompts in `claude_trader.js` were reduced to stay
within Anthropic's **30,000 input-tokens/minute** rate limit on the free/starter tier.
This file documents every cut so you can restore them when you upgrade your plan.

---

## Current token budget

| Component                        | Approx tokens |
|----------------------------------|---------------|
| System prompt (full persona)     | ~250          |
| Portfolio state                  | ~150          |
| Index data (6 indices)           | ~80           |
| Top 20 movers (13 fields each)   | ~1,400        |
| Trading rules + JSON schema      | ~450          |
| **Total input per cycle**        | **~2,330**    |
| Output (JSON decision)           | ~500          |
| **Total per cycle**              | **~2,830**    |
| API calls per cycle              | **1** (no tool use) |

> Web search was fully removed — it caused 35k–46k tokens per cycle because
> Anthropic's tool returns entire article pages (~15,000–20,000 tokens each).
> The live NSE data fed directly to Claude is more accurate for intraday trading anyway.
> At ~2,830 tokens/cycle this is well within the 30,000 tokens/min free tier limit.

---

## Change 1 — Web search: removed entirely (was 5, then 1, then 0)

**File:** `claude_trader.js`  
**Location:** inside `getTradeDecision()`, the `tools` array

### Current (removed)
```js
// No tools array — web search completely disabled
const message = await client.messages.create({
  model: "claude-sonnet-4-6",
  max_tokens: 1024,
  messages: [{ role: "user", content: userPrompt }],
  system: systemPrompt,
});
```

### Original (full intelligence)
```js
const message = await client.messages.create({
  model: "claude-sonnet-4-6",
  max_tokens: 4096,
  tools: [
    {
      type: "web_search_20260209",
      name: "web_search",
      max_uses: 5,
    },
  ],
  messages: [{ role: "user", content: userPrompt }],
  system: systemPrompt,
});
```

**Why it was removed:**
Each web_search creates 2 API calls — the first sends your prompt (~2k tokens), the
second sends your prompt + the full search result page (~15,000–20,000 tokens from
news sites like Economic Times / Moneycontrol). One cycle was costing 35k–46k tokens,
hitting the 30k/min rate limit constantly.

**What you lose without web search:**
- Claude cannot check latest news on stocks it's considering buying
- Cannot detect fraud alerts / SEBI bans / earnings misses on the same day they happen
- Cannot check FII/DII flow data
- Decisions are purely technical (live price, volume, momentum data)

**When to restore:** Upgrade to Anthropic **Build** tier (100k tokens/min).
Also restore `max_tokens: 4096` at the same time.

---

## Change 2 — Top movers count: 20 → 10

**File:** `claude_trader.js`  
**Location:** `buildUserPrompt()`, the `topMoversClean` mapping line

### Current (trimmed)
```js
const topMoversClean = (topMovers || []).slice(0, 10).map(...);
```

### Original (full intelligence)
```js
const topMoversClean = (topMovers || []).map(({ _score, ...rest }) => rest);
// sends all 20 top movers
```

**What you lose at 10 stocks:**
- Claude only sees the top 10 momentum stocks, not the full top 20
- Could miss a great opportunity ranked #11–20 that passes all entry filters
- ~300 fewer tokens saved

**When to restore:** Even at current limits this is safe to restore if you also
reduce `max_uses` stays at 1. Just change `.slice(0, 10)` → `.slice(0, 20)`.

---

## Change 3 — System prompt: full → condensed

**File:** `claude_trader.js`  
**Location:** `buildSystemPrompt()`

### Current (trimmed, ~120 tokens)
```
You are ARJUN — a professional NSE intraday trader AI. You are data-driven,
unemotional, and disciplined. Capital protection always comes first.

You trade ONLY from the live data provided each cycle. Never invent or hardcode stock symbols.
You understand Indian markets: NSE 09:15–15:30 IST, FII/DII flows, sector rotation, intraday momentum.

NEWS: Use web_search ONCE with "NSE India stock market news today" to get macro context.
- Negative macro news (global crash, RBI shock, SEBI action) → defensive mode, sell only
- Positive macro news strengthens BUY signals
- Do NOT run multiple searches — one broad search is enough for each cycle
```

### Original (full intelligence, ~350 tokens)
```
You are ARJUN — a professional NSE stock trader AI with 20 years of experience.
You are data-driven, unemotional, and disciplined.

You NEVER trade a fixed list of stocks. You trade whatever the live market data
shows as the best opportunity RIGHT NOW.
Your decisions are based on BOTH the live technical data provided AND the latest
news you search for.

You understand Indian markets deeply: NSE trading hours (09:15–15:30 IST),
F&O expiry effects, FII/DII flows, sector rotation, and intraday momentum patterns.

You always protect capital first. A small loss today is better than a large loss tomorrow.

BEFORE making any trade decision, you MUST use your web_search tool to check latest news. Search for:
1. "NSE India stock market news today" — for overall market sentiment
2. For any stock you are considering BUYing: search "[STOCK NAME] NSE news today"
   — check for negative news, fraud, results, or bans
3. For any stock you are currently HOLDing: search "[STOCK NAME] latest news"
   — check for exit signals
4. "India FII DII data today NSE" — check institutional flows

Use these news sources in priority order: moneycontrol.com, economictimes.indiatimes.com,
livemint.com, business-standard.com, nseindia.com.

CRITICAL NEWS RULES:
- If a stock has negative news (fraud, SEBI ban, results miss, promoter selling)
  — DO NOT BUY, or SELL immediately if holding
- If a stock has strong positive news (strong results, large order win, FII buying)
  — it strengthens a BUY signal
- If overall market news is very negative (global crash, budget shock, RBI surprise rate hike)
  — go DEFENSIVE mode regardless of technicals
- Never ignore news in favour of technicals alone — both must align for a BUY
```

**What you lose with condensed prompt:**
- Claude has less explicit guidance on which news sources to prioritise
- No explicit instruction to search for each held stock's news separately
- Less F&O expiry / institutional flow awareness baked in as a reminder each cycle

---

## Change 4 — User prompt task list: 4 steps → condensed

**File:** `claude_trader.js`  
**Location:** `buildUserPrompt()`, the `YOUR TASK THIS CYCLE` section

### Current (trimmed)
```
YOUR TASK THIS CYCLE:
1. Use web_search ONCE: "NSE India stock market news today" — get macro picture
2. Review holdings against exit rules
3. Pick best BUY from top movers if entry rules are met
4. Return decision in exact JSON below
```

### Original (full intelligence)
```
YOUR TASK THIS CYCLE:
1. FIRST — use web_search to check: "NSE India stock market news today" for macro sentiment
2. Review each holding — search for latest news on each held stock — should anything be sold?
3. Scan the live top movers — search for news on top candidates before deciding to buy
4. Combine technicals + news to make your final decision
5. Return your decision in the exact JSON below
```

**What you lose:** Claude no longer gets per-cycle explicit reminders to search
news on individual holdings or buy candidates (relies on system prompt instead).

---

## How to fully restore (when on higher Anthropic tier)

1. In `buildSystemPrompt()` — replace the current short version with the **Original** block from Change 3 above
2. In `buildUserPrompt()` — change `.slice(0, 10)` → `.slice(0, 20)` (Change 2)
3. In `buildUserPrompt()` — replace the task list with the **Original** 5-step version (Change 4)
4. In `getTradeDecision()` tools array — change `max_uses: 1` → `max_uses: 5` (Change 1)

**Estimated token usage after full restore:**
~5,500 base + 5 × 800 search results = **~9,500 tokens/cycle**
At 5-min cycles during market hours: ~9,500 × 12 cycles/hr = ~114,000 tokens/hr
→ Needs **~2,000 tokens/min** sustained, with manual triggers up to ~9,500 burst.
This fits comfortably on Anthropic's **Build tier** (200k tokens/min).

---

## Anthropic tier reference (as of Apr 2026)

| Tier    | Rate limit          | Monthly cost |
|---------|---------------------|--------------|
| Free    | 10,000 tokens/min   | $0           |
| Build   | 100,000 tokens/min  | Pay per use  |
| Scale   | 500,000 tokens/min  | Pay per use  |

Check current limits: https://docs.anthropic.com/en/api/rate-limits
