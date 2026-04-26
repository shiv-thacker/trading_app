/// models/ai_log.dart
/// ===================
/// Data model for a single ARJUN AI thinking cycle log.
///
/// Maps to a document in the Firestore `ai_logs` collection.
/// One document is created every 5-minute trading cycle.
/// Displayed in the "AI Brain" screen in the Flutter app.
///
/// Fields:
///   id              → Firestore document ID
///   timestampMs     → Unix epoch ms of this cycle
///   marketAnalysis  → Claude's 2-3 sentence market summary
///   thoughts        → Array of ARJUN's timestamped reasoning steps
///   portfolioHealth → "STRONG" | "OK" | "WEAK"
///   marketSentiment → "BULLISH" | "BEARISH" | "NEUTRAL" | "VOLATILE"
///   nextFocus       → What ARJUN will watch for next cycle
///   tradeCount      → Number of trades executed this cycle
///   cycleStatus     → "TRADED" | "WAITED" | "MARKET_CLOSED"

import 'package:cloud_firestore/cloud_firestore.dart';

class AILog {
  final String id;
  final int timestampMs;
  final String marketAnalysis;
  final List<String> thoughts;
  final String portfolioHealth;   // "STRONG" | "OK" | "WEAK"
  final String marketSentiment;   // "BULLISH" | "BEARISH" | "NEUTRAL" | "VOLATILE"
  final String nextFocus;
  final int tradeCount;
  final String cycleStatus;       // "TRADED" | "WAITED" | "MARKET_CLOSED"

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
  });

  DateTime get timestamp => DateTime.fromMillisecondsSinceEpoch(timestampMs);

  /// Whether this cycle executed any trades
  bool get hasTraded => cycleStatus == 'TRADED';

  /// Whether this was a market-closed cycle
  bool get isMarketClosed => cycleStatus == 'MARKET_CLOSED';

  factory AILog.fromFirestore(DocumentSnapshot doc) {
    final d = doc.data() as Map<String, dynamic>? ?? {};

    final thoughtsRaw = d['thoughts'] as List<dynamic>? ?? [];
    final thoughts = thoughtsRaw.map((t) => t.toString()).toList();

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
    );
  }
}
