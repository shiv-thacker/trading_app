/// screens/history_screen.dart
/// =============================
/// Trade history screen — shows all trades ARJUN has executed.
///
/// FEATURES:
///   - Filter tabs: ALL | BUY | SELL
///   - Real-time updates via Firestore stream
///   - Each trade shows: symbol, company, timestamp, price × qty,
///     P&L (for SELL), AI reason, trade type badge, confidence badge
///   - Empty state when no trades yet
///
/// DATA: tradesStream() from FirestoreService

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:google_fonts/google_fonts.dart';

import '../models/trade.dart';
import '../services/firestore_service.dart';
import '../widgets/trade_card.dart';

// ─────────────────────────────────────────────────────────────
// Providers
// ─────────────────────────────────────────────────────────────

final _filterProvider = StateProvider<String?>((ref) => null); // null = ALL

final _tradesFilteredProvider = StreamProvider.family<List<Trade>, String?>((ref, filter) {
  return ref.read(firestoreServiceProvider).tradesStream(filter: filter);
});

// ─────────────────────────────────────────────────────────────
// HistoryScreen
// ─────────────────────────────────────────────────────────────
class HistoryScreen extends ConsumerWidget {
  const HistoryScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final filter = ref.watch(_filterProvider);
    final tradesAsync = ref.watch(_tradesFilteredProvider(filter));

    return Scaffold(
      backgroundColor: const Color(0xFF0D1117),
      appBar: AppBar(
        backgroundColor: const Color(0xFF0D1117),
        title: Text(
          'Trade History',
          style: GoogleFonts.jetBrainsMono(
            color: Colors.white,
            fontSize: 16,
            fontWeight: FontWeight.bold,
          ),
        ),
        bottom: PreferredSize(
          preferredSize: const Size.fromHeight(48),
          child: _FilterTabs(
            current: filter,
            onChanged: (f) => ref.read(_filterProvider.notifier).state = f,
          ),
        ),
      ),
      body: tradesAsync.when(
        loading: () => const Center(
          child: CircularProgressIndicator(color: Color(0xFF00FF88)),
        ),
        error: (e, _) => Center(
          child: Text(
            'Error loading trades: $e',
            style: const TextStyle(color: Colors.redAccent),
          ),
        ),
        data: (trades) {
          if (trades.isEmpty) {
            return _EmptyState(filter: filter);
          }

          return Column(
            children: [
              // Summary bar
              _SummaryBar(trades: trades, filter: filter),
              // Trade list
              Expanded(
                child: ListView.builder(
                  padding: const EdgeInsets.only(top: 8, bottom: 24),
                  itemCount: trades.length,
                  itemBuilder: (_, i) => TradeCard(trade: trades[i]),
                ),
              ),
            ],
          );
        },
      ),
    );
  }
}

// ─────────────────────────────────────────────────────────────
// Filter tab bar
// ─────────────────────────────────────────────────────────────
class _FilterTabs extends StatelessWidget {
  final String? current;
  final ValueChanged<String?> onChanged;

  const _FilterTabs({required this.current, required this.onChanged});

  @override
  Widget build(BuildContext context) {
    final tabs = [
      (label: 'ALL',  value: null),
      (label: 'BUY',  value: 'BUY'),
      (label: 'SELL', value: 'SELL'),
    ];

    return Container(
      height: 40,
      margin: const EdgeInsets.fromLTRB(16, 0, 16, 8),
      decoration: BoxDecoration(
        color: const Color(0xFF161B22),
        borderRadius: BorderRadius.circular(8),
      ),
      child: Row(
        children: tabs.map((tab) {
          final isSelected = current == tab.value;
          return Expanded(
            child: GestureDetector(
              onTap: () => onChanged(tab.value),
              child: AnimatedContainer(
                duration: const Duration(milliseconds: 200),
                margin: const EdgeInsets.all(4),
                decoration: BoxDecoration(
                  color: isSelected ? const Color(0xFF00FF88).withOpacity(0.15) : null,
                  borderRadius: BorderRadius.circular(6),
                  border: isSelected
                      ? Border.all(color: const Color(0xFF00FF88).withOpacity(0.4))
                      : null,
                ),
                child: Center(
                  child: Text(
                    tab.label,
                    style: GoogleFonts.jetBrainsMono(
                      color: isSelected ? const Color(0xFF00FF88) : Colors.grey.shade500,
                      fontSize: 12,
                      fontWeight: isSelected ? FontWeight.bold : FontWeight.normal,
                    ),
                  ),
                ),
              ),
            ),
          );
        }).toList(),
      ),
    );
  }
}

// ─────────────────────────────────────────────────────────────
// Summary bar
// ─────────────────────────────────────────────────────────────
class _SummaryBar extends StatelessWidget {
  final List<Trade> trades;
  final String? filter;

  const _SummaryBar({required this.trades, required this.filter});

  @override
  Widget build(BuildContext context) {
    // Calculate totals
    final sells = trades.where((t) => t.action == 'SELL').toList();
    final totalPnl = sells.fold(0.0, (s, t) => s + t.pnl);
    final winners  = sells.where((t) => t.pnl > 0).length;
    final total    = sells.length;
    final winRate  = total > 0 ? (winners / total * 100) : 0.0;

    return Container(
      margin: const EdgeInsets.fromLTRB(16, 4, 16, 0),
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
      decoration: BoxDecoration(
        color: const Color(0xFF161B22),
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: Colors.white.withOpacity(0.06)),
      ),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.spaceAround,
        children: [
          _Stat(label: 'TRADES', value: '${trades.length}'),
          _Divider(),
          _Stat(
            label: 'REALIZED P&L',
            value: '${totalPnl >= 0 ? '+' : ''}₹${totalPnl.toStringAsFixed(0)}',
            valueColor: totalPnl >= 0 ? const Color(0xFF00C853) : const Color(0xFFFF3B30),
          ),
          _Divider(),
          _Stat(
            label: 'WIN RATE',
            value: total > 0 ? '${winRate.toStringAsFixed(0)}%' : '--',
            valueColor: winRate > 50 ? const Color(0xFF00C853) : const Color(0xFFFF3B30),
          ),
        ],
      ),
    );
  }
}

class _Stat extends StatelessWidget {
  final String label;
  final String value;
  final Color? valueColor;

  const _Stat({required this.label, required this.value, this.valueColor});

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        Text(
          value,
          style: GoogleFonts.jetBrainsMono(
            color: valueColor ?? Colors.white,
            fontSize: 14,
            fontWeight: FontWeight.bold,
          ),
        ),
        const SizedBox(height: 2),
        Text(
          label,
          style: TextStyle(color: Colors.grey.shade600, fontSize: 9),
        ),
      ],
    );
  }
}

class _Divider extends StatelessWidget {
  @override
  Widget build(BuildContext context) {
    return Container(
      width: 1,
      height: 28,
      color: Colors.white.withOpacity(0.06),
    );
  }
}

// ─────────────────────────────────────────────────────────────
// Empty state
// ─────────────────────────────────────────────────────────────
class _EmptyState extends StatelessWidget {
  final String? filter;
  const _EmptyState({this.filter});

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          Text('📊', style: const TextStyle(fontSize: 48)),
          const SizedBox(height: 16),
          Text(
            filter == null
                ? 'No trades yet'
                : 'No ${filter!.toLowerCase()} trades yet',
            style: const TextStyle(
              color: Colors.white70,
              fontSize: 16,
              fontWeight: FontWeight.bold,
            ),
          ),
          const SizedBox(height: 8),
          Text(
            'ARJUN will execute trades when opportunities arise',
            style: TextStyle(color: Colors.grey.shade500, fontSize: 12),
          ),
        ],
      ),
    );
  }
}
