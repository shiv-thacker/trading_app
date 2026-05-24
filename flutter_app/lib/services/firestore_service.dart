/// services/firestore_service.dart
/// =================================
/// All Firestore read operations and Cloud Function calls for the Flutter app.
///
/// PURPOSE:
///   The Flutter app is READ-ONLY against Firestore (per security rules).
///   All writes happen server-side in Cloud Functions.
///   This service provides:
///     - Real-time streams for live UI updates (Firestore snapshots)
///     - One-time reads for initial data loads
///     - Cloud Function invocations (manual trigger, reset)
///
/// STREAMS (real-time, updates UI instantly when ARJUN trades):
///   portfolioStream()              → portfolio/state (intraday)
///   swingPortfolioStream()         → swing_portfolio/state (India swing)
///   globalSwingPortfolioStream()   → global_swing_portfolio/state (multi-market)
///   globalSwingTradesStream()      → global_swing_trades
///   globalSwingAiLogsStream()      → global_swing_ai_logs
///   globalSwingSnapshotsStream()   → global_swing_portfolio/state/snapshots
///
/// CLOUD FUNCTION CALLS:
///   triggerManualGlobalSwingCycle() → manualGlobalSwingTrigger
///   resetGlobalPortfolio()          → resetGlobalPortfolio
///
/// USAGE (with Riverpod):
///   The service is exposed as a Riverpod provider.
///   Screens consume streams via StreamProvider.

import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:cloud_functions/cloud_functions.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../models/ai_log.dart';
import '../models/portfolio.dart';
import '../models/trade.dart';

// ─────────────────────────────────────────────────────────────
// Riverpod Provider
// ─────────────────────────────────────────────────────────────

/// Global provider for FirestoreService — use this in all screens/widgets
final firestoreServiceProvider = Provider<FirestoreService>((ref) {
  return FirestoreService();
});

// ─────────────────────────────────────────────────────────────
// FirestoreService class
// ─────────────────────────────────────────────────────────────
class FirestoreService {
  final FirebaseFirestore _db = FirebaseFirestore.instance;
  final FirebaseFunctions _functions = FirebaseFunctions.instance;

  // ── Portfolio stream ──────────────────────────────────────

  /// Real-time stream of the portfolio/state document.
  /// Emits a new [Portfolio] every time ARJUN updates it (every 5 minutes).
  /// The Flutter Dashboard updates instantly without any polling.
  Stream<Portfolio> portfolioStream() {
    return _db
        .collection('portfolio')
        .doc('state')
        .snapshots()
        .map((snap) {
          if (!snap.exists) return Portfolio.empty();
          return Portfolio.fromFirestore(snap);
        });
  }

  // ── Trades stream ─────────────────────────────────────────

  /// Real-time stream of trade history.
  ///
  /// [filter] can be:
  ///   null     → all trades
  ///   "BUY"    → buy trades only
  ///   "SELL"   → sell trades only
  ///
  /// Ordered by timestamp descending (newest first).
  /// Limited to last 100 trades for performance.
  Stream<List<Trade>> tradesStream({String? filter}) {
    Query<Map<String, dynamic>> query = _db
        .collection('trades')
        .orderBy('timestampMs', descending: true)
        .limit(100);

    if (filter != null && filter.isNotEmpty) {
      query = query.where('action', isEqualTo: filter);
    }

    return query.snapshots().map(
      (snap) => snap.docs.map(Trade.fromFirestore).toList(),
    );
  }

  // ── AI Logs stream ────────────────────────────────────────

  /// Real-time stream of ARJUN's thinking logs.
  /// Returns the last 50 AI cycle logs, newest first.
  /// Displayed in the AI Brain screen.
  Stream<List<AILog>> aiLogsStream() {
    return _db
        .collection('ai_logs')
        .orderBy('timestampMs', descending: true)
        .limit(50)
        .snapshots()
        .map(
          (snap) => snap.docs.map(AILog.fromFirestore).toList(),
        );
  }

  // ── Snapshots stream ──────────────────────────────────────

  /// Real-time stream of portfolio value snapshots.
  /// Used to draw the historical portfolio value chart.
  /// Returns up to 200 snapshots (covers ~16 hours of 5-min intervals).
  Stream<List<Snapshot>> snapshotsStream() {
    return _db
        .collection('portfolio')
        .doc('state')
        .collection('snapshots')
        .orderBy('timestampMs', descending: false)
        .limit(200)
        .snapshots()
        .map(
          (snap) => snap.docs.map(Snapshot.fromFirestore).toList(),
        );
  }

  // ── One-time reads ────────────────────────────────────────

  /// One-time read of today's snapshots only (for intraday chart on Dashboard).
  Future<List<Snapshot>> getTodaySnapshots() async {
    final today = DateTime.now();
    final startOfDay = DateTime(today.year, today.month, today.day);

    final snap = await _db
        .collection('portfolio')
        .doc('state')
        .collection('snapshots')
        .where('timestampMs',
            isGreaterThanOrEqualTo: startOfDay.millisecondsSinceEpoch)
        .orderBy('timestampMs', descending: false)
        .get();

    return snap.docs.map(Snapshot.fromFirestore).toList();
  }

  // ── Latest AI log (for Dashboard status bar) ──────────────

  /// Fetches the single most recent AI log document.
  /// Used to show current market sentiment on the Dashboard.
  Future<AILog?> getLatestAILog() async {
    try {
      final snap = await _db
          .collection('ai_logs')
          .orderBy('timestampMs', descending: true)
          .limit(1)
          .get();

      if (snap.docs.isEmpty) return null;
      return AILog.fromFirestore(snap.docs.first);
    } catch (_) {
      return null;
    }
  }

  // ── Cloud Function calls ──────────────────────────────────

  /// Calls the manualTrigger Cloud Function to run one trading cycle immediately.
  /// Used by Settings screen → "Run one trading cycle now" button.
  ///
  /// Returns a map with { success: bool, result: {...} }
  Future<Map<String, dynamic>> triggerManualCycle() async {
    try {
      final callable = _functions.httpsCallable('manualTrigger');
      final result = await callable.call();
      return Map<String, dynamic>.from(result.data as Map);
    } on FirebaseFunctionsException catch (e) {
      return {'success': false, 'error': e.message};
    } catch (e) {
      return {'success': false, 'error': e.toString()};
    }
  }

  /// Calls the resetPortfolio Cloud Function.
  /// Only works when market is closed.
  /// Clears all trades, logs, snapshots, and resets portfolio to ₹10,000.
  Future<Map<String, dynamic>> resetPortfolio() async {
    try {
      final callable = _functions.httpsCallable('resetPortfolio');
      final result = await callable.call();
      return Map<String, dynamic>.from(result.data as Map);
    } on FirebaseFunctionsException catch (e) {
      return {'success': false, 'error': e.message};
    } catch (e) {
      return {'success': false, 'error': e.toString()};
    }
  }

  /// Calls runDummyTradeTest Cloud Function.
  /// Writes a synthetic BUY/SELL trade even if market is closed.
  /// Does not modify the real portfolio.
  Future<Map<String, dynamic>> runDummyTradeTest({required String action}) async {
    try {
      final callable = _functions.httpsCallable('runDummyTradeTest');
      final result = await callable.call({'action': action});
      return Map<String, dynamic>.from(result.data as Map);
    } on FirebaseFunctionsException catch (e) {
      return {'success': false, 'error': e.message};
    } catch (e) {
      return {'success': false, 'error': e.toString()};
    }
  }

  // ── Utility ───────────────────────────────────────────────

  /// Returns the total realized P&L from all intraday SELL trades.
  Future<double> getTotalRealizedPnL() async {
    try {
      final snap = await _db
          .collection('trades')
          .where('action', isEqualTo: 'SELL')
          .get();

      double total = 0;
      for (final doc in snap.docs) {
        final d = doc.data();
        total += (d['pnl'] as num?)?.toDouble() ?? 0;
      }
      return total;
    } catch (_) {
      return 0;
    }
  }

  // ══════════════════════════════════════════════════════════
  // SWING TRADING — Separate collections
  // ══════════════════════════════════════════════════════════

  // ── Swing Portfolio stream ────────────────────────────────

  /// Real-time stream of the swing_portfolio/state document.
  Stream<Portfolio> swingPortfolioStream() {
    return _db
        .collection('swing_portfolio')
        .doc('state')
        .snapshots()
        .map((snap) {
          if (!snap.exists) return Portfolio.empty();
          return Portfolio.fromFirestore(snap);
        });
  }

  // ── Swing Trades stream ───────────────────────────────────

  /// Real-time stream of swing trade history.
  /// [filter] can be null (all), "BUY", or "SELL".
  Stream<List<Trade>> swingTradesStream({String? filter}) {
    Query<Map<String, dynamic>> query = _db
        .collection('swing_trades')
        .orderBy('timestampMs', descending: true)
        .limit(100);

    if (filter != null && filter.isNotEmpty) {
      query = query.where('action', isEqualTo: filter);
    }

    return query.snapshots().map(
      (snap) => snap.docs.map(Trade.fromFirestore).toList(),
    );
  }

  // ── Swing AI Logs stream ──────────────────────────────────

  /// Real-time stream of swing AI hourly logs (last 30).
  Stream<List<AILog>> swingAiLogsStream() {
    return _db
        .collection('swing_ai_logs')
        .orderBy('timestampMs', descending: true)
        .limit(30)
        .snapshots()
        .map(
          (snap) => snap.docs.map(AILog.fromFirestore).toList(),
        );
  }

  // ── Swing Snapshots stream ────────────────────────────────

  /// Real-time stream of swing portfolio value snapshots (hourly).
  Stream<List<Snapshot>> swingSnapshotsStream() {
    return _db
        .collection('swing_portfolio')
        .doc('state')
        .collection('snapshots')
        .orderBy('timestampMs', descending: false)
        .limit(200)
        .snapshots()
        .map(
          (snap) => snap.docs.map(Snapshot.fromFirestore).toList(),
        );
  }

  // ── Swing realized P&L ────────────────────────────────────

  Future<double> getSwingRealizedPnL() async {
    try {
      final snap = await _db
          .collection('swing_trades')
          .where('action', isEqualTo: 'SELL')
          .get();

      double total = 0;
      for (final doc in snap.docs) {
        final d = doc.data();
        total += (d['pnl'] as num?)?.toDouble() ?? 0;
      }
      return total;
    } catch (_) {
      return 0;
    }
  }

  // ── Swing Cloud Function calls ────────────────────────────

  /// Manually trigger one swing trading cycle (for testing).
  Future<Map<String, dynamic>> triggerManualSwingCycle() async {
    try {
      final callable = _functions.httpsCallable('manualSwingTrigger');
      final result = await callable.call();
      return Map<String, dynamic>.from(result.data as Map);
    } on FirebaseFunctionsException catch (e) {
      return {'success': false, 'error': e.message};
    } catch (e) {
      return {'success': false, 'error': e.toString()};
    }
  }

  /// Reset swing portfolio to ₹10,000. Only works when market is closed.
  Future<Map<String, dynamic>> resetSwingPortfolio() async {
    try {
      final callable = _functions.httpsCallable('resetSwingPortfolio');
      final result = await callable.call();
      return Map<String, dynamic>.from(result.data as Map);
    } on FirebaseFunctionsException catch (e) {
      return {'success': false, 'error': e.message};
    } catch (e) {
      return {'success': false, 'error': e.toString()};
    }
  }

  // ══════════════════════════════════════════════════════════
  // GLOBAL SWING — Multi-market (India + US + Germany + Japan)
  // Collections: global_swing_portfolio, global_swing_trades, global_swing_ai_logs
  // ══════════════════════════════════════════════════════════

  /// Real-time stream of the global_swing_portfolio/state document.
  /// Supports multi-currency: inrCash + usdCash + totalValueINR.
  Stream<Portfolio> globalSwingPortfolioStream() {
    return _db
        .collection('global_swing_portfolio')
        .doc('state')
        .snapshots()
        .map((snap) {
          if (!snap.exists) return Portfolio.emptyGlobal();
          return Portfolio.fromFirestore(snap);
        });
  }

  /// Real-time stream of global swing trade history.
  /// [filter] can be null (all), "BUY", or "SELL".
  Stream<List<Trade>> globalSwingTradesStream({String? filter}) {
    Query<Map<String, dynamic>> query = _db
        .collection('global_swing_trades')
        .orderBy('timestampMs', descending: true)
        .limit(100);

    if (filter != null && filter.isNotEmpty) {
      query = query.where('action', isEqualTo: filter);
    }

    return query.snapshots().map(
      (snap) => snap.docs.map(Trade.fromFirestore).toList(),
    );
  }

  /// Real-time stream of global swing AI hourly logs (last 30).
  Stream<List<AILog>> globalSwingAiLogsStream() {
    return _db
        .collection('global_swing_ai_logs')
        .orderBy('timestampMs', descending: true)
        .limit(30)
        .snapshots()
        .map(
          (snap) => snap.docs.map(AILog.fromFirestore).toList(),
        );
  }

  /// Real-time stream of global swing portfolio value snapshots (hourly).
  Stream<List<Snapshot>> globalSwingSnapshotsStream() {
    return _db
        .collection('global_swing_portfolio')
        .doc('state')
        .collection('snapshots')
        .orderBy('timestampMs', descending: false)
        .limit(200)
        .snapshots()
        .map(
          (snap) => snap.docs.map(Snapshot.fromFirestore).toList(),
        );
  }

  /// Total realized P&L (in INR) from all global swing SELL trades.
  Future<double> getGlobalSwingRealizedPnL() async {
    try {
      final snap = await _db
          .collection('global_swing_trades')
          .where('action', isEqualTo: 'SELL')
          .get();

      double total = 0;
      for (final doc in snap.docs) {
        final d = doc.data();
        // Use pnlINR for foreign trades; pnl for INR trades
        final currency = d['currency'] as String? ?? 'INR';
        if (currency == 'INR') {
          total += (d['pnl'] as num?)?.toDouble() ?? 0;
        } else {
          total += (d['pnlINR'] as num?)?.toDouble() ?? 0;
        }
      }
      return total;
    } catch (_) {
      return 0;
    }
  }

  /// Manually trigger one global swing trading cycle (for testing).
  Future<Map<String, dynamic>> triggerManualGlobalSwingCycle() async {
    try {
      final callable = _functions.httpsCallable('manualGlobalSwingTrigger');
      final result = await callable.call();
      return Map<String, dynamic>.from(result.data as Map);
    } on FirebaseFunctionsException catch (e) {
      return {'success': false, 'error': e.message};
    } catch (e) {
      return {'success': false, 'error': e.toString()};
    }
  }

  /// Reset global portfolio to ₹50,000 INR + \$600 USD.
  Future<Map<String, dynamic>> resetGlobalPortfolio() async {
    try {
      final callable = _functions.httpsCallable('resetGlobalPortfolio');
      final result = await callable.call();
      return Map<String, dynamic>.from(result.data as Map);
    } on FirebaseFunctionsException catch (e) {
      return {'success': false, 'error': e.message};
    } catch (e) {
      return {'success': false, 'error': e.toString()};
    }
  }
}
