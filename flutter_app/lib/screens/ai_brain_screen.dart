/// screens/ai_brain_screen.dart
/// ================================
/// Live feed of ARJUN's AI reasoning — shows what Claude is thinking.
///
/// LAYOUT:
///   - Header chips: market sentiment + portfolio health
///   - "Next ARJUN will watch for:" card (from latestLog.nextFocus)
///   - Scrollable log feed (newest at top):
///       Each ai_log entry:
///         ├── Market analysis paragraph
///         ├── Cycle status badge (TRADED / WAITED / MARKET_CLOSED)
///         ├── Timestamp
///         └── Individual thought lines:
///               "09:32:01 — Scanning 500 NSE stocks live..."
///               "09:32:03 — Found 23 qualifying candidates"
///               "09:32:05 — Decision: BUY SYMBOL — HIGH confidence"
///
/// DATA: aiLogsStream() — real-time, last 50 logs

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:intl/intl.dart';
import 'package:timeago/timeago.dart' as timeago;

import '../models/ai_log.dart';
import 'dashboard_screen.dart' show aiLogsProvider;

// ─────────────────────────────────────────────────────────────
// AIBrainScreen
// ─────────────────────────────────────────────────────────────
class AIBrainScreen extends ConsumerWidget {
  const AIBrainScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final logsAsync = ref.watch(aiLogsProvider);

    return Scaffold(
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
      ),
      body: logsAsync.when(
        loading: () => const Center(
          child: CircularProgressIndicator(color: Color(0xFF00FF88)),
        ),
        error: (e, _) => Center(
          child: Text('Error: $e', style: const TextStyle(color: Colors.red)),
        ),
        data: (logs) {
          if (logs.isEmpty) {
            return const _EmptyBrain();
          }

          final latest = logs.first;

          return Column(
            children: [
              // ── Header: sentiment + health chips ────────────
              _HeaderChips(log: latest),

              // ── "Next ARJUN will watch for" card ────────────
              if (latest.nextFocus.isNotEmpty)
                _NextFocusCard(focus: latest.nextFocus),

              // ── Log feed ─────────────────────────────────────
              Expanded(
                child: ListView.builder(
                  padding: const EdgeInsets.only(top: 8, bottom: 24),
                  itemCount: logs.length,
                  itemBuilder: (_, i) => _LogEntry(log: logs[i]),
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
// Header chips (sentiment + portfolio health)
// ─────────────────────────────────────────────────────────────
class _HeaderChips extends StatelessWidget {
  final AILog log;
  const _HeaderChips({required this.log});

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.fromLTRB(16, 12, 16, 8),
      child: Row(
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
          const Spacer(),
          Text(
            timeago.format(log.timestamp),
            style: TextStyle(color: Colors.grey.shade600, fontSize: 11),
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
  const _NextFocusCard({required this.focus});

  @override
  Widget build(BuildContext context) {
    return Container(
      margin: const EdgeInsets.fromLTRB(16, 0, 16, 12),
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: const Color(0xFF1A2332),
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: const Color(0xFF1D6FEB).withOpacity(0.25)),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text('🔭 ', style: const TextStyle(fontSize: 14)),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  'ARJUN will watch for:',
                  style: GoogleFonts.jetBrainsMono(
                    color: const Color(0xFF1D6FEB),
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
// Log entry
// ─────────────────────────────────────────────────────────────
class _LogEntry extends StatelessWidget {
  final AILog log;
  const _LogEntry({required this.log});

  @override
  Widget build(BuildContext context) {
    final statusColor = _statusColor(log.cycleStatus);
    final statusIcon  = _statusIcon(log.cycleStatus);

    return Container(
      margin: const EdgeInsets.symmetric(horizontal: 16, vertical: 5),
      decoration: BoxDecoration(
        color: const Color(0xFF161B22),
        borderRadius: BorderRadius.circular(10),
        border: Border.all(
          color: statusColor.withOpacity(0.15),
        ),
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
              border: Border(
                bottom: BorderSide(color: statusColor.withOpacity(0.1)),
              ),
            ),
            child: Row(
              children: [
                Text(statusIcon, style: const TextStyle(fontSize: 13)),
                const SizedBox(width: 6),
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                  decoration: BoxDecoration(
                    color: statusColor.withOpacity(0.12),
                    borderRadius: BorderRadius.circular(4),
                    border: Border.all(color: statusColor.withOpacity(0.3)),
                  ),
                  child: Text(
                    log.cycleStatus,
                    style: GoogleFonts.jetBrainsMono(
                      color: statusColor,
                      fontSize: 9,
                      fontWeight: FontWeight.bold,
                    ),
                  ),
                ),
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
                const Spacer(),
                Text(
                  DateFormat('HH:mm').format(log.timestamp),
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
                      color: _thoughtColor(thought),
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

  Color _statusColor(String s) {
    switch (s) {
      case 'TRADED':       return const Color(0xFF00C853);
      case 'MARKET_CLOSED':return const Color(0xFF607D8B);
      default:             return const Color(0xFFFFA726); // WAITED
    }
  }

  String _statusIcon(String s) {
    switch (s) {
      case 'TRADED':        return '⚡';
      case 'MARKET_CLOSED': return '🌙';
      default:              return '👁';
    }
  }

  Color _thoughtColor(String thought) {
    if (thought.contains('BUY') || thought.contains('✓') || thought.contains('executed')) {
      return const Color(0xFF00C853);
    }
    if (thought.contains('SELL') || thought.contains('stop loss') || thought.contains('take profit')) {
      return const Color(0xFFFFA726);
    }
    if (thought.contains('✗') || thought.contains('skip') || thought.contains('error')) {
      return const Color(0xFFEF5350).withOpacity(0.8);
    }
    if (thought.contains('Scanning') || thought.contains('Checking')) {
      return const Color(0xFF1D6FEB).withOpacity(0.9);
    }
    return Colors.grey.shade400;
  }
}

// ─────────────────────────────────────────────────────────────
// Empty state
// ─────────────────────────────────────────────────────────────
class _EmptyBrain extends StatelessWidget {
  const _EmptyBrain();

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          Text('🧠', style: const TextStyle(fontSize: 56)),
          const SizedBox(height: 20),
          Text(
            'ARJUN is awakening...',
            style: GoogleFonts.jetBrainsMono(
              color: Colors.white70,
              fontSize: 16,
              fontWeight: FontWeight.bold,
            ),
          ),
          const SizedBox(height: 8),
          Text(
            'First trading cycle logs will appear here',
            style: TextStyle(color: Colors.grey.shade500, fontSize: 12),
          ),
        ],
      ),
    );
  }
}
