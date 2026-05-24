/// screens/ai_brain_screen.dart
/// ================================
/// Live feed of ARJUN's AI reasoning.
///
///   🌐 GLOBAL    — Hourly multi-market logs (India+US+Germany+Japan, EODHD data)
///
/// Each entry shows:
///   - Header chips: overall sentiment + portfolio health + open/bullish markets
///   - "ARJUN will watch for" card
///   - Terminal-style thought log with colour-coded reasoning steps
///
/// DATA:
///   Global swing: globalSwingAiLogsStream() — last 30 from global_swing_ai_logs

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:intl/intl.dart';
import 'package:timeago/timeago.dart' as timeago;

import '../models/ai_log.dart';
import '../services/firestore_service.dart';
import 'dashboard_screen.dart' show aiLogsProvider;

// ─────────────────────────────────────────────────────────────
// Global swing AI logs provider (multi-market, primary)
// ─────────────────────────────────────────────────────────────
final swingAiLogsProvider = StreamProvider<List<AILog>>((ref) {
  return ref.read(firestoreServiceProvider).globalSwingAiLogsStream();
});

// ─────────────────────────────────────────────────────────────
// AIBrainScreen — tabbed: Intraday | Swing
// ─────────────────────────────────────────────────────────────
class AIBrainScreen extends StatelessWidget {
  const AIBrainScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return DefaultTabController(
      length: 1, // intraday tab disabled
      child: Scaffold(
        backgroundColor: const Color(0xFF0D1117),
        appBar: AppBar(
          backgroundColor: const Color(0xFF0D1117),
          title: Row(
            children: [
              Text(
                'AI Brain',
                style: GoogleFonts.jetBrainsMono(
                  color: Colors.white,
                  fontSize: 16,
                  fontWeight: FontWeight.bold,
                ),
              ),
              const SizedBox(width: 8),
              Text(
                '— ARJUN\'s thoughts',
                style: GoogleFonts.jetBrainsMono(
                  color: Colors.grey.shade500,
                  fontSize: 12,
                ),
              ),
            ],
          ),
          bottom: PreferredSize(
            preferredSize: const Size.fromHeight(44),
            child: Container(
              margin: const EdgeInsets.fromLTRB(16, 0, 16, 8),
              height: 36,
              decoration: BoxDecoration(
                color: const Color(0xFF161B22),
                borderRadius: BorderRadius.circular(8),
              ),
              child: TabBar(
                indicator: BoxDecoration(
                  color: const Color(0xFF00FF88).withOpacity(0.12),
                  borderRadius: BorderRadius.circular(6),
                  border: Border.all(color: const Color(0xFF00FF88).withOpacity(0.35)),
                ),
                indicatorSize: TabBarIndicatorSize.tab,
                dividerColor: Colors.transparent,
                splashFactory: NoSplash.splashFactory,
                labelColor: const Color(0xFF00FF88),
                unselectedLabelColor: Colors.grey.shade500,
                labelStyle: GoogleFonts.jetBrainsMono(
                  fontSize: 11,
                  fontWeight: FontWeight.bold,
                ),
                unselectedLabelStyle: GoogleFonts.jetBrainsMono(fontSize: 11),
                tabs: const [
                  // Tab(text: '⚡  INTRADAY'), // intraday disabled
                  Tab(text: '🌐  GLOBAL'),
                ],
              ),
            ),
          ),
        ),
        body: const TabBarView(
          children: [
            // _IntradayLogsFeed(), // intraday disabled
            _SwingLogsFeed(),
          ],
        ),
      ),
    );
  }
}

// ─────────────────────────────────────────────────────────────
// Intraday log feed tab
// ─────────────────────────────────────────────────────────────
class _IntradayLogsFeed extends ConsumerWidget {
  const _IntradayLogsFeed();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final logsAsync = ref.watch(aiLogsProvider);

    return logsAsync.when(
      loading: () => const Center(
        child: CircularProgressIndicator(color: Color(0xFF00FF88)),
      ),
      error: (e, _) => Center(
        child: Text('Error: $e', style: const TextStyle(color: Colors.red)),
      ),
      data: (logs) {
        if (logs.isEmpty) return const _EmptyBrain(mode: 'intraday');

        final latest = logs.first;
        return Column(
          children: [
            _HeaderChips(log: latest),
            if (latest.nextFocus.isNotEmpty)
              _NextFocusCard(focus: latest.nextFocus, accentColor: const Color(0xFF1D6FEB)),
            Expanded(
              child: ListView.builder(
                padding: const EdgeInsets.only(top: 8, bottom: 24),
                itemCount: logs.length,
                itemBuilder: (_, i) => _LogEntry(log: logs[i], isSwing: false),
              ),
            ),
          ],
        );
      },
    );
  }
}

// ─────────────────────────────────────────────────────────────
// Swing log feed tab
// ─────────────────────────────────────────────────────────────
class _SwingLogsFeed extends ConsumerWidget {
  const _SwingLogsFeed();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final logsAsync = ref.watch(swingAiLogsProvider);

    return logsAsync.when(
      loading: () => const Center(
        child: CircularProgressIndicator(color: Color(0xFF7C4DFF)),
      ),
      error: (e, _) => Center(
        child: Text('Error: $e', style: const TextStyle(color: Colors.red)),
      ),
      data: (logs) {
        if (logs.isEmpty) return const _EmptyBrain(mode: 'global');

        final latest = logs.first;
        return Column(
          children: [
            _HeaderChips(log: latest, isSwing: true),
            if (latest.nextFocus.isNotEmpty)
              _NextFocusCard(focus: latest.nextFocus, accentColor: const Color(0xFF00C853)),
            Expanded(
              child: ListView.builder(
                padding: const EdgeInsets.only(top: 8, bottom: 24),
                itemCount: logs.length,
                itemBuilder: (_, i) => _LogEntry(log: logs[i], isSwing: true),
              ),
            ),
          ],
        );
      },
    );
  }
}

// ─────────────────────────────────────────────────────────────
// Header chips (sentiment + portfolio health)
// ─────────────────────────────────────────────────────────────
class _HeaderChips extends StatelessWidget {
  final AILog log;
  final bool isSwing;
  const _HeaderChips({required this.log, this.isSwing = false});

  String _marketFlag(String name) {
    switch (name) {
      case 'India':   return '🇮🇳';
      case 'USA':     return '🇺🇸';
      case 'Germany': return '🇩🇪';
      case 'Japan':   return '🇯🇵';
      default:        return '🌐';
    }
  }

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.fromLTRB(16, 12, 16, 8),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              _Chip(
                label: log.marketSentiment,
                color: _sentimentColor(log.marketSentiment),
                prefix: '📊 ',
              ),
              const SizedBox(width: 10),
              _Chip(
                label: log.portfolioHealth,
                color: _healthColor(log.portfolioHealth),
                prefix: '💼 ',
              ),
              // EODHD data chip (replaces WEB SEARCH)
              if (isSwing) ...[
                const SizedBox(width: 10),
                _Chip(
                  label: 'EODHD',
                  color: const Color(0xFF00BCD4),
                  prefix: '📡 ',
                ),
              ],
              const Spacer(),
              Text(
                timeago.format(log.timestamp),
                style: TextStyle(color: Colors.grey.shade600, fontSize: 11),
              ),
            ],
          ),
          // Global market breakdown (open + bullish)
          if (log.isGlobal) ...[
            const SizedBox(height: 8),
            SingleChildScrollView(
              scrollDirection: Axis.horizontal,
              child: Row(
                children: [
                  if (log.openMarkets.isNotEmpty) ...[
                    Text(
                      'Open: ',
                      style: TextStyle(color: Colors.grey.shade600, fontSize: 10),
                    ),
                    ...log.openMarkets.map((m) => Padding(
                      padding: const EdgeInsets.only(right: 4),
                      child: Text(
                        _marketFlag(m),
                        style: const TextStyle(fontSize: 14),
                      ),
                    )),
                    const SizedBox(width: 12),
                  ],
                  if (log.bullishMarkets.isNotEmpty) ...[
                    Text(
                      '📈 Bullish: ',
                      style: TextStyle(color: const Color(0xFF00C853).withOpacity(0.8), fontSize: 10),
                    ),
                    ...log.bullishMarkets.map((m) => Padding(
                      padding: const EdgeInsets.only(right: 4),
                      child: Text(
                        '${_marketFlag(m)} $m',
                        style: const TextStyle(
                          color: Color(0xFF00C853),
                          fontSize: 10,
                          fontWeight: FontWeight.bold,
                        ),
                      ),
                    )),
                  ],
                  if (log.chosenMarket.isNotEmpty) ...[
                    const SizedBox(width: 12),
                    Container(
                      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                      decoration: BoxDecoration(
                        color: const Color(0xFF7C4DFF).withOpacity(0.15),
                        borderRadius: BorderRadius.circular(4),
                        border: Border.all(color: const Color(0xFF7C4DFF).withOpacity(0.4)),
                      ),
                      child: Text(
                        '🎯 ${_marketFlag(log.chosenMarket)} ${log.chosenMarket}',
                        style: const TextStyle(
                          color: Color(0xFF7C4DFF),
                          fontSize: 10,
                          fontWeight: FontWeight.bold,
                        ),
                      ),
                    ),
                  ],
                ],
              ),
            ),
          ],
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

  Color _healthColor(String h) {
    switch (h) {
      case 'STRONG': return const Color(0xFF00C853);
      case 'WEAK':   return const Color(0xFFFF3B30);
      default:       return const Color(0xFFFFA726);
    }
  }
}

class _Chip extends StatelessWidget {
  final String label;
  final Color color;
  final String prefix;

  const _Chip({required this.label, required this.color, this.prefix = ''});

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
      decoration: BoxDecoration(
        color: color.withOpacity(0.12),
        borderRadius: BorderRadius.circular(20),
        border: Border.all(color: color.withOpacity(0.35)),
      ),
      child: Text(
        '$prefix$label',
        style: GoogleFonts.jetBrainsMono(
          color: color,
          fontSize: 11,
          fontWeight: FontWeight.bold,
        ),
      ),
    );
  }
}

// ─────────────────────────────────────────────────────────────
// Next focus card
// ─────────────────────────────────────────────────────────────
class _NextFocusCard extends StatelessWidget {
  final String focus;
  final Color accentColor;
  const _NextFocusCard({required this.focus, required this.accentColor});

  @override
  Widget build(BuildContext context) {
    return Container(
      margin: const EdgeInsets.fromLTRB(16, 0, 16, 12),
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: const Color(0xFF1A2332),
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: accentColor.withOpacity(0.25)),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Text('🔭 ', style: TextStyle(fontSize: 14)),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  'ARJUN will watch for:',
                  style: GoogleFonts.jetBrainsMono(
                    color: accentColor,
                    fontSize: 10,
                    letterSpacing: 0.5,
                  ),
                ),
                const SizedBox(height: 4),
                Text(
                  focus,
                  style: TextStyle(
                    color: Colors.grey.shade300,
                    fontSize: 12,
                    height: 1.4,
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

// ─────────────────────────────────────────────────────────────
// Log entry (shared by intraday and swing)
// ─────────────────────────────────────────────────────────────
class _LogEntry extends StatelessWidget {
  final AILog log;
  final bool isSwing;
  const _LogEntry({required this.log, required this.isSwing});

  @override
  Widget build(BuildContext context) {
    final statusColor = _statusColor(log.cycleStatus, isSwing);
    final statusIcon  = _statusIcon(log.cycleStatus, isSwing);

    return Container(
      margin: const EdgeInsets.symmetric(horizontal: 16, vertical: 5),
      decoration: BoxDecoration(
        color: const Color(0xFF161B22),
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: statusColor.withOpacity(0.15)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          // Entry header
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
            decoration: BoxDecoration(
              color: statusColor.withOpacity(0.05),
              borderRadius: const BorderRadius.vertical(top: Radius.circular(10)),
              border: Border(bottom: BorderSide(color: statusColor.withOpacity(0.1))),
            ),
            child: Row(
              children: [
                Text(statusIcon, style: const TextStyle(fontSize: 13)),
                const SizedBox(width: 6),
                _StatusBadge(status: log.cycleStatus, color: statusColor),
                if (log.tradeCount > 0) ...[
                  const SizedBox(width: 6),
                  Text(
                    '${log.tradeCount} trade${log.tradeCount > 1 ? 's' : ''}',
                    style: GoogleFonts.jetBrainsMono(
                      color: const Color(0xFF00C853),
                      fontSize: 10,
                    ),
                  ),
                ],
                // Swing: show cycle frequency label
                if (isSwing) ...[
                  const SizedBox(width: 6),
                  Container(
                    padding: const EdgeInsets.symmetric(horizontal: 5, vertical: 2),
                    decoration: BoxDecoration(
                      color: const Color(0xFF7C4DFF).withOpacity(0.1),
                      borderRadius: BorderRadius.circular(4),
                      border: Border.all(color: const Color(0xFF7C4DFF).withOpacity(0.3)),
                    ),
                    child: Text(
                      'HOURLY',
                      style: GoogleFonts.jetBrainsMono(
                        color: const Color(0xFF7C4DFF),
                        fontSize: 8,
                        fontWeight: FontWeight.bold,
                      ),
                    ),
                  ),
                ],
                const Spacer(),
                Text(
                  DateFormat('dd MMM HH:mm').format(log.timestamp),
                  style: GoogleFonts.jetBrainsMono(
                    color: Colors.grey.shade600,
                    fontSize: 10,
                  ),
                ),
              ],
            ),
          ),

          // Market analysis
          if (log.marketAnalysis.isNotEmpty)
            Padding(
              padding: const EdgeInsets.fromLTRB(12, 10, 12, 6),
              child: Text(
                log.marketAnalysis,
                style: TextStyle(
                  color: Colors.grey.shade300,
                  fontSize: 12,
                  height: 1.4,
                ),
              ),
            ),

          // Thought lines (terminal-style)
          if (log.thoughts.isNotEmpty)
            Container(
              margin: const EdgeInsets.fromLTRB(12, 4, 12, 12),
              padding: const EdgeInsets.all(10),
              decoration: BoxDecoration(
                color: Colors.black.withOpacity(0.3),
                borderRadius: BorderRadius.circular(6),
                border: Border.all(color: Colors.white.withOpacity(0.04)),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: log.thoughts.map((thought) => Padding(
                  padding: const EdgeInsets.symmetric(vertical: 1.5),
                  child: Text(
                    '> $thought',
                    style: GoogleFonts.jetBrainsMono(
                      color: _thoughtColor(thought, isSwing),
                      fontSize: 10.5,
                      height: 1.4,
                    ),
                  ),
                )).toList(),
              ),
            ),
        ],
      ),
    );
  }

  Color _statusColor(String s, bool swing) {
    switch (s) {
      case 'TRADED':             return const Color(0xFF00C853);
      case 'ANALYSING':          return swing ? const Color(0xFF7C4DFF) : const Color(0xFF607D8B);
      case 'MARKET_CLOSED':      return const Color(0xFF607D8B);
      case 'ALL_MARKETS_CLOSED': return const Color(0xFF607D8B);
      default:                   return const Color(0xFFFFA726);
    }
  }

  String _statusIcon(String s, bool swing) {
    switch (s) {
      case 'TRADED':             return '⚡';
      case 'ANALYSING':          return '🔍';
      case 'MARKET_CLOSED':      return '🌙';
      case 'ALL_MARKETS_CLOSED': return '🌙';
      default:                   return swing ? '📊' : '👁';
    }
  }

  Color _thoughtColor(String thought, bool isSwing) {
    if (thought.contains('BUY') || thought.contains('✓') || thought.contains('executed')) {
      return const Color(0xFF00C853);
    }
    if (thought.contains('SELL') || thought.contains('stop loss') || thought.contains('take profit')) {
      return const Color(0xFFFFA726);
    }
    if (thought.contains('✗') || thought.contains('skip') || thought.contains('error')) {
      return const Color(0xFFEF5350).withOpacity(0.8);
    }
    if (thought.contains('BULLISH') || thought.contains('bullish')) {
      return const Color(0xFF00C853).withOpacity(0.9);
    }
    if (thought.contains('BEARISH') || thought.contains('bearish')) {
      return const Color(0xFFFF3B30).withOpacity(0.9);
    }
    if (thought.contains('Scanning') || thought.contains('Checking') || thought.contains('EODHD')) {
      return const Color(0xFF00BCD4).withOpacity(0.9);
    }
    if (thought.contains('India') || thought.contains('NSE')) {
      return const Color(0xFFFF9800).withOpacity(0.9);
    }
    if (thought.contains('USA') || thought.contains('US market')) {
      return const Color(0xFF1D6FEB).withOpacity(0.9);
    }
    return Colors.grey.shade400;
  }
}

class _StatusBadge extends StatelessWidget {
  final String status;
  final Color color;
  const _StatusBadge({required this.status, required this.color});

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
      decoration: BoxDecoration(
        color: color.withOpacity(0.12),
        borderRadius: BorderRadius.circular(4),
        border: Border.all(color: color.withOpacity(0.3)),
      ),
      child: Text(
        status,
        style: GoogleFonts.jetBrainsMono(
          color: color,
          fontSize: 9,
          fontWeight: FontWeight.bold,
        ),
      ),
    );
  }
}

// ─────────────────────────────────────────────────────────────
// Empty state
// ─────────────────────────────────────────────────────────────
class _EmptyBrain extends StatelessWidget {
  final String mode;
  const _EmptyBrain({required this.mode});

  @override
  Widget build(BuildContext context) {
    final isGlobal = mode == 'global';
    return Center(
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          Text(
            isGlobal ? '🌐' : '🧠',
            style: const TextStyle(fontSize: 56),
          ),
          const SizedBox(height: 20),
          Text(
            isGlobal ? 'Global engine awakening...' : 'ARJUN is awakening...',
            style: GoogleFonts.jetBrainsMono(
              color: Colors.white70,
              fontSize: 16,
              fontWeight: FontWeight.bold,
            ),
          ),
          const SizedBox(height: 8),
          Text(
            isGlobal
                ? 'Scanning 🇮🇳 🇺🇸 🇩🇪 🇯🇵 markets...\nFirst hourly logs will appear here'
                : 'First trading cycle logs will appear here',
            style: TextStyle(color: Colors.grey.shade500, fontSize: 12),
            textAlign: TextAlign.center,
          ),
        ],
      ),
    );
  }
}
