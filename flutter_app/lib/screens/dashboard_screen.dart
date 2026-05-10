/// screens/dashboard_screen.dart
/// ================================
/// Main dashboard — the first screen after disclaimer.
///
/// LAYOUT (top to bottom):
///   1. Portfolio value (large headline)
///   2. P&L today (green/red with arrow indicator)
///   3. P&L total since inception
///   4. ARJUN status bar (pulsing dot + next cycle countdown)
///   5. Market index chips (horizontal scroll)
///   6. Current holdings cards (or "holding cash" empty state)
///   7. Intraday portfolio value chart (today's 5-min snapshots)
///
/// DATA SOURCES (all real-time Firestore streams):
///   - portfolioStream() for value and holdings
///   - snapshotsStream() for intraday chart
///   - aiLogsStream() for status bar text + market sentiment
///
/// Updates instantly when ARJUN trades — no manual refresh needed.

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:intl/intl.dart';

import '../models/ai_log.dart';
import '../models/portfolio.dart';
import '../services/firestore_service.dart';
import '../widgets/market_status_bar.dart';
import '../widgets/portfolio_chart.dart';

// ─────────────────────────────────────────────────────────────
// Riverpod stream providers — Intraday
// ─────────────────────────────────────────────────────────────

// Intraday providers kept for compilation — imported by portfolio_screen & ai_brain_screen.
// Not watched in the dashboard itself (swing is now primary).
final portfolioProvider = StreamProvider<Portfolio>((ref) {
  return ref.read(firestoreServiceProvider).portfolioStream();
});

final aiLogsProvider = StreamProvider<List<AILog>>((ref) {
  return ref.read(firestoreServiceProvider).aiLogsStream();
});

final snapshotsProvider = StreamProvider<List<Snapshot>>((ref) {
  return ref.read(firestoreServiceProvider).snapshotsStream();
});

// ─────────────────────────────────────────────────────────────
// Riverpod stream providers — Swing
// ─────────────────────────────────────────────────────────────

final swingPortfolioDashProvider = StreamProvider<Portfolio>((ref) {
  return ref.read(firestoreServiceProvider).swingPortfolioStream();
});

final swingAiLogsDashProvider = StreamProvider<List<AILog>>((ref) {
  return ref.read(firestoreServiceProvider).swingAiLogsStream();
});

// ─────────────────────────────────────────────────────────────
// DashboardScreen
// ─────────────────────────────────────────────────────────────
class DashboardScreen extends ConsumerWidget {
  const DashboardScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    // final portfolioAsync  = ref.watch(portfolioProvider);  // intraday — not used in dashboard
    // final logsAsync       = ref.watch(aiLogsProvider);     // intraday — not used in dashboard
    // final snapshotsAsync  = ref.watch(snapshotsProvider);  // intraday — not used in dashboard
    final swingPortfolioAsync = ref.watch(swingPortfolioDashProvider);
    final swingLogsAsync      = ref.watch(swingAiLogsDashProvider);

    final latestSwingLog  = swingLogsAsync.valueOrNull?.firstOrNull;
    final swingPortfolio  = swingPortfolioAsync.valueOrNull ?? Portfolio.empty();

    return Scaffold(
      backgroundColor: const Color(0xFF0D1117),
      body: RefreshIndicator(
        color: const Color(0xFF00FF88),
        backgroundColor: const Color(0xFF161B22),
        onRefresh: () async {
          // ref.invalidate(portfolioProvider);   // intraday — disabled
          // ref.invalidate(aiLogsProvider);      // intraday — disabled
          // ref.invalidate(snapshotsProvider);   // intraday — disabled
          ref.invalidate(swingPortfolioDashProvider);
          ref.invalidate(swingAiLogsDashProvider);
        },
        child: CustomScrollView(
          slivers: [
            // ── App bar ─────────────────────────────────────
            SliverAppBar(
              backgroundColor: const Color(0xFF0D1117),
              pinned: true,
              expandedHeight: 0,
              title: Row(
                children: [
                  Container(
                    padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                    decoration: BoxDecoration(
                      color: const Color(0xFF00FF88).withOpacity(0.1),
                      borderRadius: BorderRadius.circular(6),
                      border: Border.all(
                        color: const Color(0xFF00FF88).withOpacity(0.3),
                      ),
                    ),
                    child: Text(
                      'ARJUN',
                      style: GoogleFonts.jetBrainsMono(
                        color: const Color(0xFF00FF88),
                        fontSize: 13,
                        fontWeight: FontWeight.bold,
                      ),
                    ),
                  ),
                  const SizedBox(width: 10),
                  Text(
                    'AI Trader',
                    style: GoogleFonts.jetBrainsMono(
                      color: Colors.white,
                      fontSize: 16,
                      fontWeight: FontWeight.bold,
                    ),
                  ),
                ],
              ),
              actions: [
                if (latestSwingLog != null)
                  Padding(
                    padding: const EdgeInsets.only(right: 16),
                    child: _SentimentChip(sentiment: latestSwingLog.marketSentiment),
                  ),
              ],
            ),

            SliverToBoxAdapter(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  // ── Swing portfolio value headline ────────
                  _PortfolioValueSection(portfolio: swingPortfolio),

                  // ── Swing status bar ──────────────────────
                  MarketStatusBar(cycleStatus: latestSwingLog?.cycleStatus),

                  // ── Swing market sentiment ────────────────
                  if (latestSwingLog != null)
                    _MarketSentimentBanner(log: latestSwingLog),

                  const SizedBox(height: 20),

                  // ── Swing holdings ────────────────────────
                  Padding(
                    padding: const EdgeInsets.symmetric(horizontal: 16),
                    child: Text(
                      'CURRENT HOLDINGS',
                      style: GoogleFonts.jetBrainsMono(
                        color: Colors.grey.shade500,
                        fontSize: 11,
                        letterSpacing: 1.5,
                      ),
                    ),
                  ),
                  const SizedBox(height: 10),
                  _HoldingsList(portfolio: swingPortfolio),

                  // ── Intraday chart (disabled) ─────────────
                  // const SizedBox(height: 24),
                  // Padding(
                  //   padding: const EdgeInsets.symmetric(horizontal: 16),
                  //   child: Text(
                  //     "TODAY'S PERFORMANCE",
                  //     style: GoogleFonts.jetBrainsMono(
                  //       color: Colors.grey.shade500,
                  //       fontSize: 11,
                  //       letterSpacing: 1.5,
                  //     ),
                  //   ),
                  // ),
                  // const SizedBox(height: 12),
                  // Padding(
                  //   padding: const EdgeInsets.symmetric(horizontal: 16),
                  //   child: PortfolioChart(
                  //     snapshots:       _todaySnapshots(snapshots),
                  //     startingCapital: portfolio.startingCapital,
                  //     isIntraday:      true,
                  //     height:          180,
                  //   ),
                  // ),

                  // ── Swing secondary card (disabled — swing is now primary) ──
                  // _SwingSection(
                  //   portfolio: swingPortfolio,
                  //   latestLog: latestSwingLog,
                  // ),

                  const SizedBox(height: 32),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }

  /// Filters snapshots to only today's data for the intraday chart
  List<Snapshot> _todaySnapshots(List<Snapshot> all) {
    final now   = DateTime.now();
    final today = DateTime(now.year, now.month, now.day);
    return all.where((s) => s.timestamp.isAfter(today)).toList();
  }
}

// ─────────────────────────────────────────────────────────────
// Portfolio Value Header Section
// ─────────────────────────────────────────────────────────────
class _PortfolioValueSection extends StatelessWidget {
  final Portfolio portfolio;
  const _PortfolioValueSection({required this.portfolio});

  @override
  Widget build(BuildContext context) {
    final pnlTotal   = portfolio.totalPnl;
    final pnlPct     = portfolio.totalPnlPct;
    final isProfit   = pnlTotal >= 0;
    final pnlColor   = isProfit ? const Color(0xFF00C853) : const Color(0xFFFF3B30);
    final pnlIcon    = isProfit ? '▲' : '▼';

    return Padding(
      padding: const EdgeInsets.fromLTRB(20, 20, 20, 16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            'PORTFOLIO VALUE',
            style: GoogleFonts.jetBrainsMono(
              color: Colors.grey.shade500,
              fontSize: 10,
              letterSpacing: 2,
            ),
          ),
          const SizedBox(height: 6),

          // Large value display
          Text(
            _formatINR(portfolio.totalValue),
            style: GoogleFonts.jetBrainsMono(
              color: Colors.white,
              fontSize: 32,
              fontWeight: FontWeight.bold,
              letterSpacing: -0.5,
            ),
          ),

          const SizedBox(height: 8),

          // P&L row
          Row(
            children: [
              Text(
                pnlIcon,
                style: TextStyle(color: pnlColor, fontSize: 12),
              ),
              const SizedBox(width: 4),
              Text(
                '${isProfit ? '+' : ''}${_formatINR(pnlTotal)}',
                style: GoogleFonts.jetBrainsMono(
                  color: pnlColor,
                  fontSize: 14,
                  fontWeight: FontWeight.bold,
                ),
              ),
              const SizedBox(width: 8),
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                decoration: BoxDecoration(
                  color: pnlColor.withOpacity(0.12),
                  borderRadius: BorderRadius.circular(4),
                ),
                child: Text(
                  '${isProfit ? '+' : ''}${pnlPct.toStringAsFixed(2)}%',
                  style: GoogleFonts.jetBrainsMono(
                    color: pnlColor,
                    fontSize: 11,
                    fontWeight: FontWeight.bold,
                  ),
                ),
              ),
              const Spacer(),
              Column(
                crossAxisAlignment: CrossAxisAlignment.end,
                children: [
                  Text(
                    'Cash',
                    style: TextStyle(
                      color: Colors.grey.shade500,
                      fontSize: 10,
                    ),
                  ),
                  Text(
                    _formatINR(portfolio.cash),
                    style: GoogleFonts.jetBrainsMono(
                      color: Colors.white70,
                      fontSize: 13,
                    ),
                  ),
                ],
              ),
            ],
          ),
        ],
      ),
    );
  }
}

// ─────────────────────────────────────────────────────────────
// Holdings List
// ─────────────────────────────────────────────────────────────
class _HoldingsList extends StatelessWidget {
  final Portfolio portfolio;
  const _HoldingsList({required this.portfolio});

  @override
  Widget build(BuildContext context) {
    if (portfolio.holdings.isEmpty) {
      return Container(
        margin: const EdgeInsets.symmetric(horizontal: 16),
        padding: const EdgeInsets.all(24),
        decoration: BoxDecoration(
          color: const Color(0xFF161B22),
          borderRadius: BorderRadius.circular(12),
          border: Border.all(color: Colors.white.withOpacity(0.06)),
        ),
        child: Center(
          child: Column(
            children: [
              Text('💰', style: const TextStyle(fontSize: 32)),
              const SizedBox(height: 12),
              Text(
                'ARJUN is holding cash',
                style: GoogleFonts.jetBrainsMono(
                  color: Colors.white70,
                  fontSize: 14,
                  fontWeight: FontWeight.bold,
                ),
              ),
              const SizedBox(height: 4),
              Text(
                'Waiting for the right opportunity...',
                style: TextStyle(color: Colors.grey.shade500, fontSize: 12),
              ),
            ],
          ),
        ),
      );
    }

    return Column(
      children: portfolio.holdings.map((h) => _HoldingCard(holding: h)).toList(),
    );
  }
}

// ─────────────────────────────────────────────────────────────
// Holding Card
// ─────────────────────────────────────────────────────────────
class _HoldingCard extends StatelessWidget {
  final Holding holding;
  const _HoldingCard({required this.holding});

  @override
  Widget build(BuildContext context) {
    final isProfit = holding.isProfit;
    final pnlColor = isProfit ? const Color(0xFF00C853) : const Color(0xFFFF3B30);

    return Container(
      margin: const EdgeInsets.symmetric(horizontal: 16, vertical: 5),
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: const Color(0xFF161B22),
        borderRadius: BorderRadius.circular(12),
        border: Border.all(
          color: pnlColor.withOpacity(0.2),
        ),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          // Header
          Row(
            children: [
              Text(
                holding.symbol,
                style: GoogleFonts.jetBrainsMono(
                  color: Colors.white,
                  fontSize: 15,
                  fontWeight: FontWeight.bold,
                ),
              ),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  holding.companyName,
                  style: TextStyle(color: Colors.grey.shade500, fontSize: 11),
                  overflow: TextOverflow.ellipsis,
                ),
              ),
              // Unrealized P&L
              Text(
                '${isProfit ? '+' : ''}${_formatINR(holding.unrealizedPnl)}',
                style: GoogleFonts.jetBrainsMono(
                  color: pnlColor,
                  fontSize: 13,
                  fontWeight: FontWeight.bold,
                ),
              ),
            ],
          ),
          const SizedBox(height: 8),

          // Price info
          Row(
            children: [
              Text(
                '${holding.quantity} × ₹${holding.currentPrice.toStringAsFixed(2)}',
                style: GoogleFonts.jetBrainsMono(
                  color: Colors.white70,
                  fontSize: 12,
                ),
              ),
              const Spacer(),
              Text(
                '${isProfit ? '+' : ''}${holding.unrealizedPnlPct.toStringAsFixed(2)}%',
                style: GoogleFonts.jetBrainsMono(
                  color: pnlColor,
                  fontSize: 11,
                ),
              ),
            ],
          ),
          const SizedBox(height: 8),

          // Stop loss and target badges
          Row(
            children: [
              _LevelBadge(
                label: 'SL',
                value: holding.stopLoss,
                color: const Color(0xFFFF3B30),
              ),
              const SizedBox(width: 8),
              _LevelBadge(
                label: 'TGT',
                value: holding.target,
                color: const Color(0xFF00C853),
              ),
              const Spacer(),
              Text(
                '${holding.minutesHeld} min held',
                style: TextStyle(color: Colors.grey.shade600, fontSize: 10),
              ),
            ],
          ),
        ],
      ),
    );
  }
}

class _LevelBadge extends StatelessWidget {
  final String label;
  final double value;
  final Color color;
  const _LevelBadge({required this.label, required this.value, required this.color});

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
      decoration: BoxDecoration(
        color: color.withOpacity(0.1),
        borderRadius: BorderRadius.circular(4),
        border: Border.all(color: color.withOpacity(0.3)),
      ),
      child: Text(
        '$label: ₹${value.toStringAsFixed(1)}',
        style: GoogleFonts.jetBrainsMono(
          color: color,
          fontSize: 10,
        ),
      ),
    );
  }
}

// ─────────────────────────────────────────────────────────────
// Market Sentiment Banner
// ─────────────────────────────────────────────────────────────
class _MarketSentimentBanner extends StatelessWidget {
  final AILog log;
  const _MarketSentimentBanner({required this.log});

  @override
  Widget build(BuildContext context) {
    final sentimentColor = _sentimentColor(log.marketSentiment);
    return Container(
      margin: const EdgeInsets.fromLTRB(16, 12, 16, 0),
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: const Color(0xFF161B22),
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: Colors.white.withOpacity(0.06)),
      ),
      child: Row(
        children: [
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
            decoration: BoxDecoration(
              color: sentimentColor.withOpacity(0.15),
              borderRadius: BorderRadius.circular(6),
              border: Border.all(color: sentimentColor.withOpacity(0.4)),
            ),
            child: Text(
              log.marketSentiment,
              style: GoogleFonts.jetBrainsMono(
                color: sentimentColor,
                fontSize: 10,
                fontWeight: FontWeight.bold,
              ),
            ),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Text(
              log.marketAnalysis.isNotEmpty
                  ? log.marketAnalysis
                  : 'Monitoring live market conditions...',
              style: TextStyle(
                color: Colors.grey.shade400,
                fontSize: 11,
                height: 1.4,
              ),
              maxLines: 2,
              overflow: TextOverflow.ellipsis,
            ),
          ),
        ],
      ),
    );
  }

  Color _sentimentColor(String s) {
    switch (s) {
      case 'BULLISH':  return const Color(0xFF00C853);
      case 'BEARISH':  return const Color(0xFFFF3B30);
      case 'VOLATILE': return const Color(0xFFFFA726);
      default:         return const Color(0xFF607D8B);
    }
  }
}

// ─────────────────────────────────────────────────────────────
// Sentiment chip (app bar)
// ─────────────────────────────────────────────────────────────
class _SentimentChip extends StatelessWidget {
  final String sentiment;
  const _SentimentChip({required this.sentiment});

  @override
  Widget build(BuildContext context) {
    final color = _color(sentiment);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
      decoration: BoxDecoration(
        color: color.withOpacity(0.1),
        borderRadius: BorderRadius.circular(6),
        border: Border.all(color: color.withOpacity(0.4)),
      ),
      child: Text(
        sentiment,
        style: GoogleFonts.jetBrainsMono(
          color: color,
          fontSize: 10,
          fontWeight: FontWeight.bold,
        ),
      ),
    );
  }

  Color _color(String s) {
    switch (s) {
      case 'BULLISH':  return const Color(0xFF00C853);
      case 'BEARISH':  return const Color(0xFFFF3B30);
      case 'VOLATILE': return const Color(0xFFFFA726);
      default:         return const Color(0xFF607D8B);
    }
  }
}

// ─────────────────────────────────────────────────────────────
// Swing Portfolio Section (Dashboard)
// ─────────────────────────────────────────────────────────────
class _SwingSection extends StatelessWidget {
  final Portfolio portfolio;
  final AILog? latestLog;

  const _SwingSection({required this.portfolio, this.latestLog});

  @override
  Widget build(BuildContext context) {
    final pnlTotal = portfolio.totalPnl;
    final pnlPct   = portfolio.totalPnlPct;
    final isProfit = pnlTotal >= 0;
    final pnlColor = isProfit ? const Color(0xFF00C853) : const Color(0xFFFF3B30);

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        // Section header
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 16),
          child: Row(
            children: [
              Text(
                '📈 SWING TRADING',
                style: GoogleFonts.jetBrainsMono(
                  color: Colors.grey.shade500,
                  fontSize: 11,
                  letterSpacing: 1.5,
                ),
              ),
              const SizedBox(width: 8),
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                decoration: BoxDecoration(
                  color: const Color(0xFF7C4DFF).withOpacity(0.12),
                  borderRadius: BorderRadius.circular(4),
                  border: Border.all(color: const Color(0xFF7C4DFF).withOpacity(0.3)),
                ),
                child: Text(
                  'HOURLY · WEB SEARCH',
                  style: GoogleFonts.jetBrainsMono(
                    color: const Color(0xFF7C4DFF),
                    fontSize: 8,
                    fontWeight: FontWeight.bold,
                  ),
                ),
              ),
            ],
          ),
        ),
        const SizedBox(height: 10),

        // Swing portfolio card
        Container(
          margin: const EdgeInsets.symmetric(horizontal: 16),
          padding: const EdgeInsets.all(14),
          decoration: BoxDecoration(
            color: const Color(0xFF161B22),
            borderRadius: BorderRadius.circular(12),
            border: Border.all(
              color: const Color(0xFF7C4DFF).withOpacity(0.2),
            ),
          ),
          child: Column(
            children: [
              // Value + P&L row
              Row(
                crossAxisAlignment: CrossAxisAlignment.end,
                children: [
                  Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        'SWING VALUE',
                        style: GoogleFonts.jetBrainsMono(
                          color: Colors.grey.shade600,
                          fontSize: 9,
                          letterSpacing: 1,
                        ),
                      ),
                      const SizedBox(height: 3),
                      Text(
                        _formatINR(portfolio.totalValue),
                        style: GoogleFonts.jetBrainsMono(
                          color: Colors.white,
                          fontSize: 20,
                          fontWeight: FontWeight.bold,
                        ),
                      ),
                    ],
                  ),
                  const Spacer(),
                  Column(
                    crossAxisAlignment: CrossAxisAlignment.end,
                    children: [
                      Text(
                        '${isProfit ? '+' : ''}${_formatINR(pnlTotal)}',
                        style: GoogleFonts.jetBrainsMono(
                          color: pnlColor,
                          fontSize: 13,
                          fontWeight: FontWeight.bold,
                        ),
                      ),
                      Container(
                        padding: const EdgeInsets.symmetric(horizontal: 5, vertical: 2),
                        decoration: BoxDecoration(
                          color: pnlColor.withOpacity(0.1),
                          borderRadius: BorderRadius.circular(4),
                        ),
                        child: Text(
                          '${isProfit ? '+' : ''}${pnlPct.toStringAsFixed(2)}%',
                          style: GoogleFonts.jetBrainsMono(
                            color: pnlColor,
                            fontSize: 10,
                            fontWeight: FontWeight.bold,
                          ),
                        ),
                      ),
                    ],
                  ),
                ],
              ),

              const SizedBox(height: 12),

              // Stats row
              Row(
                children: [
                  _SwingStatChip(
                    label: 'POSITIONS',
                    value: '${portfolio.holdings.length}/3',
                    color: const Color(0xFF7C4DFF),
                  ),
                  const SizedBox(width: 8),
                  _SwingStatChip(
                    label: 'CASH',
                    value: _formatINR(portfolio.cash),
                    color: const Color(0xFF607D8B),
                  ),
                  const Spacer(),
                  if (latestLog != null) ...[
                    Container(
                      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                      decoration: BoxDecoration(
                        color: _sentimentColor(latestLog!.marketSentiment).withOpacity(0.1),
                        borderRadius: BorderRadius.circular(6),
                        border: Border.all(
                          color: _sentimentColor(latestLog!.marketSentiment).withOpacity(0.3),
                        ),
                      ),
                      child: Text(
                        latestLog!.marketSentiment,
                        style: GoogleFonts.jetBrainsMono(
                          color: _sentimentColor(latestLog!.marketSentiment),
                          fontSize: 10,
                          fontWeight: FontWeight.bold,
                        ),
                      ),
                    ),
                  ],
                ],
              ),

              // Latest swing log analysis
              if (latestLog != null && latestLog!.marketAnalysis.isNotEmpty) ...[
                const SizedBox(height: 10),
                Container(
                  width: double.infinity,
                  padding: const EdgeInsets.all(10),
                  decoration: BoxDecoration(
                    color: Colors.black.withOpacity(0.25),
                    borderRadius: BorderRadius.circular(6),
                    border: Border.all(color: Colors.white.withOpacity(0.04)),
                  ),
                  child: Text(
                    latestLog!.marketAnalysis,
                    style: TextStyle(
                      color: Colors.grey.shade400,
                      fontSize: 11,
                      height: 1.4,
                    ),
                    maxLines: 3,
                    overflow: TextOverflow.ellipsis,
                  ),
                ),
              ],

              // Swing holdings (compact)
              if (portfolio.holdings.isNotEmpty) ...[
                const SizedBox(height: 10),
                ...portfolio.holdings.map((h) => _SwingHoldingRow(holding: h)),
              ] else ...[
                const SizedBox(height: 8),
                Text(
                  'No swing positions — watching for multi-day setups...',
                  style: TextStyle(color: Colors.grey.shade600, fontSize: 11),
                ),
              ],
            ],
          ),
        ),
      ],
    );
  }

  Color _sentimentColor(String s) {
    switch (s) {
      case 'BULLISH':  return const Color(0xFF00C853);
      case 'BEARISH':  return const Color(0xFFFF3B30);
      case 'VOLATILE': return const Color(0xFFFFA726);
      default:         return const Color(0xFF607D8B);
    }
  }
}

class _SwingStatChip extends StatelessWidget {
  final String label;
  final String value;
  final Color color;

  const _SwingStatChip({required this.label, required this.value, required this.color});

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
      decoration: BoxDecoration(
        color: color.withOpacity(0.08),
        borderRadius: BorderRadius.circular(6),
        border: Border.all(color: color.withOpacity(0.2)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            label,
            style: GoogleFonts.jetBrainsMono(
              color: color.withOpacity(0.7),
              fontSize: 8,
              letterSpacing: 0.5,
            ),
          ),
          Text(
            value,
            style: GoogleFonts.jetBrainsMono(
              color: Colors.white70,
              fontSize: 11,
              fontWeight: FontWeight.bold,
            ),
          ),
        ],
      ),
    );
  }
}

class _SwingHoldingRow extends StatelessWidget {
  final Holding holding;
  const _SwingHoldingRow({required this.holding});

  @override
  Widget build(BuildContext context) {
    final isProfit = holding.isProfit;
    final pnlColor = isProfit ? const Color(0xFF00C853) : const Color(0xFFFF3B30);

    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 3),
      child: Row(
        children: [
          Text(
            holding.symbol,
            style: GoogleFonts.jetBrainsMono(
              color: Colors.white,
              fontSize: 12,
              fontWeight: FontWeight.bold,
            ),
          ),
          const SizedBox(width: 8),
          Text(
            '${holding.daysHeld}d',
            style: TextStyle(color: Colors.grey.shade600, fontSize: 10),
          ),
          const Spacer(),
          Text(
            '${isProfit ? '+' : ''}${holding.unrealizedPnlPct.toStringAsFixed(2)}%',
            style: GoogleFonts.jetBrainsMono(
              color: pnlColor,
              fontSize: 12,
              fontWeight: FontWeight.bold,
            ),
          ),
          const SizedBox(width: 8),
          Text(
            '${isProfit ? '+' : ''}${_formatINR(holding.unrealizedPnl)}',
            style: GoogleFonts.jetBrainsMono(
              color: pnlColor,
              fontSize: 11,
            ),
          ),
        ],
      ),
    );
  }
}

// ─────────────────────────────────────────────────────────────
// Indian number format helper
// ─────────────────────────────────────────────────────────────
String _formatINR(double amount) {
  final formatter = NumberFormat.currency(
    locale: 'en_IN',
    symbol: '₹',
    decimalDigits: 2,
  );
  return formatter.format(amount);
}
