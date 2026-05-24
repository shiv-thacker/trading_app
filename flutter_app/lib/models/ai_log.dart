/// models/ai_log.dart
/// ===================
/// Data model for a single ARJUN AI thinking cycle log.
///
/// Supports both old India-only swing logs AND new global multi-market logs.
///
/// Fields:
///   id              → Firestore document ID
///   timestampMs     → Unix epoch ms of this cycle
///   marketAnalysis  → Claude's 2-3 sentence market summary
///   thoughts        → Array of ARJUN's reasoning steps
///   portfolioHealth → "STRONG" | "OK" | "WEAK"
///   marketSentiment → Overall mood: "BULLISH" | "BEARISH" | "NEUTRAL" | "VOLATILE"
///   nextFocus       → What ARJUN will watch for next cycle
///   tradeCount      → Number of trades executed this cycle
///   cycleStatus     → "TRADED" | "WAITED" | "ALL_MARKETS_CLOSED"
///
/// Global swing extra fields:
///   openMarkets     → Markets that were open this cycle (e.g. ["India", "USA"])
///   bullishMarkets  → Markets deemed bullish (e.g. ["India"])
///   bearishMarkets  → Markets deemed bearish
///   chosenMarket    → Market ARJUN chose to focus on this cycle

import 'package:cloud_firestore/cloud_firestore.dart';

class AILog {
  final String id;
  final int timestampMs;
  final String marketAnalysis;
  final List<String> thoughts;
  final String portfolioHealth;
  final String marketSentiment;
  final String nextFocus;
  final int tradeCount;
  final String cycleStatus;

  // ── Global swing fields (new) ──────────────────────────────
  final List<String> openMarkets;
  final List<String> bullishMarkets;
  final List<String> bearishMarkets;
  final String chosenMarket;

  const AILog({
    required this.id,
    required this.timestampMs,
    required this.marketAnalysis,
    required this.thoughts,
    required this.portfolioHealth,
    required this.marketSentiment,
    required this.nextFocus,
    required this.tradeCount,
    required this.cycleStatus,
    this.openMarkets    = const [],
    this.bullishMarkets = const [],
    this.bearishMarkets = const [],
    this.chosenMarket   = '',
  });

  DateTime get timestamp => DateTime.fromMillisecondsSinceEpoch(timestampMs);

  bool get hasTraded => cycleStatus == 'TRADED';

  bool get isMarketClosed => cycleStatus == 'ALL_MARKETS_CLOSED' || cycleStatus == 'MARKET_CLOSED';

  bool get isGlobal => openMarkets.isNotEmpty || chosenMarket.isNotEmpty;

  /// Flag emoji for the chosen market
  String get chosenMarketFlag {
    switch (chosenMarket) {
      case 'India':   return '🇮🇳';
      case 'USA':     return '🇺🇸';
      case 'Germany': return '🇩🇪';
      case 'Japan':   return '🇯🇵';
      default:        return '';
    }
  }

  factory AILog.fromFirestore(DocumentSnapshot doc) {
    final d = doc.data() as Map<String, dynamic>? ?? {};

    final thoughtsRaw = d['thoughts'] as List<dynamic>? ?? [];
    final thoughts = thoughtsRaw.map((t) => t.toString()).toList();

    List<String> toStringList(dynamic raw) =>
        (raw as List<dynamic>? ?? []).map((e) => e.toString()).toList();

    return AILog(
      id:              doc.id,
      timestampMs:     (d['timestampMs'] as num?)?.toInt() ??
                       (d['timestamp'] as Timestamp?)?.millisecondsSinceEpoch ??
                       0,
      marketAnalysis:  d['marketAnalysis']  as String? ?? '',
      thoughts:        thoughts,
      portfolioHealth: d['portfolioHealth'] as String? ?? 'OK',
      marketSentiment: d['marketSentiment'] as String? ?? 'NEUTRAL',
      nextFocus:       d['nextFocus']       as String? ?? '',
      tradeCount:      (d['tradeCount']     as num?)?.toInt() ?? 0,
      cycleStatus:     d['cycleStatus']     as String? ?? 'WAITED',
      openMarkets:     toStringList(d['openMarkets']),
      bullishMarkets:  toStringList(d['bullishMarkets']),
      bearishMarkets:  toStringList(d['bearishMarkets']),
      chosenMarket:    d['chosenMarket']    as String? ?? '',
    );
  }
}
