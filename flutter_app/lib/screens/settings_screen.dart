/// screens/settings_screen.dart
/// ================================
/// App settings and control panel.
///
/// SECTIONS:
///   - Manual trigger: "Run one trading cycle now" (for testing)
///   - Reset portfolio: with confirmation dialog (market-closed only)
///   - App info: version, SEBI disclaimer
///
/// All actions call Cloud Functions via FirestoreService.
/// Feedback is shown via SnackBar with success/error states.

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:google_fonts/google_fonts.dart';

import '../services/firestore_service.dart';

class SettingsScreen extends ConsumerStatefulWidget {
  const SettingsScreen({super.key});

  @override
  ConsumerState<SettingsScreen> createState() => _SettingsScreenState();
}

class _SettingsScreenState extends ConsumerState<SettingsScreen> {
  bool _isTriggering      = false;
  bool _isResetting       = false;
  bool _isDummyTrading    = false;
  bool _isSwingTriggering = false;
  bool _isSwingResetting  = false;

  // ── Manual trigger ──────────────────────────────────────────
  Future<void> _runManualCycle() async {
    setState(() => _isTriggering = true);
    final result = await ref.read(firestoreServiceProvider).triggerManualCycle();
    if (!mounted) return;
    setState(() => _isTriggering = false);

    final success = result['success'] as bool? ?? false;
    if (success) {
      final r = result['result'] as Map? ?? {};
      _showSnack(
        '✅ Cycle done: ${r['status'] ?? 'completed'} · ₹${(r['portfolioValue'] ?? 0).toStringAsFixed(0)}',
        color: const Color(0xFF00C853),
      );
    } else {
      _showSnack('❌ ${result['error'] ?? 'Trigger failed'}', color: Colors.red);
    }
  }

  // ── Reset portfolio ─────────────────────────────────────────
  Future<void> _resetPortfolio() async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (_) => AlertDialog(
        backgroundColor: const Color(0xFF161B22),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
        title: Text(
          'Reset Portfolio?',
          style: GoogleFonts.jetBrainsMono(
            color: Colors.white,
            fontWeight: FontWeight.bold,
          ),
        ),
        content: Text(
          'This will reset ARJUN to ₹10,000 and permanently delete all trade history, AI logs, and snapshots.\n\nOnly possible when market is closed.',
          style: TextStyle(color: Colors.grey.shade400, fontSize: 13, height: 1.5),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: Text('Cancel', style: TextStyle(color: Colors.grey.shade500)),
          ),
          ElevatedButton(
            style: ElevatedButton.styleFrom(
              backgroundColor: const Color(0xFFFF3B30),
              foregroundColor: Colors.white,
              shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
            ),
            onPressed: () => Navigator.pop(context, true),
            child: const Text('Reset Everything'),
          ),
        ],
      ),
    );

    if (confirmed != true) return;

    setState(() => _isResetting = true);
    final result = await ref.read(firestoreServiceProvider).resetPortfolio();
    if (!mounted) return;
    setState(() => _isResetting = false);

    final success = result['success'] as bool? ?? false;
    if (success) {
      _showSnack('✅ Portfolio reset to ₹10,000', color: const Color(0xFF00C853));
    } else {
      _showSnack('❌ ${result['error'] ?? 'Reset failed'}', color: Colors.red);
    }
  }

  // ── Dummy trade test (works even when market is closed) ─────
  Future<void> _runDummyTradeTest() async {
    setState(() => _isDummyTrading = true);
    final action = DateTime.now().millisecond.isEven ? 'BUY' : 'SELL';
    final result = await ref
        .read(firestoreServiceProvider)
        .runDummyTradeTest(action: action);
    if (!mounted) return;
    setState(() => _isDummyTrading = false);

    final success = result['success'] as bool? ?? false;
    if (success) {
      _showSnack(
        '✅ Dummy $action test recorded (works outside market hours)',
        color: const Color(0xFF00C853),
      );
    } else {
      _showSnack('❌ ${result['error'] ?? 'Dummy trade test failed'}', color: Colors.red);
    }
  }

  // ── Swing manual trigger ────────────────────────────────────
  Future<void> _runSwingCycle() async {
    setState(() => _isSwingTriggering = true);
    final result = await ref.read(firestoreServiceProvider).triggerManualSwingCycle();
    if (!mounted) return;
    setState(() => _isSwingTriggering = false);

    final success = result['success'] as bool? ?? false;
    if (success) {
      final r = result['result'] as Map? ?? {};
      final webUsed = r['webSearchUsed'] == true ? ' · 🔍 web search' : '';
      _showSnack(
        '✅ Swing cycle done: ${r['status'] ?? 'completed'}$webUsed · ₹${(r['portfolioValue'] ?? 0).toStringAsFixed(0)}',
        color: const Color(0xFF7C4DFF),
      );
    } else {
      _showSnack('❌ ${result['error'] ?? 'Swing trigger failed'}', color: Colors.red);
    }
  }

  // ── Swing reset ─────────────────────────────────────────────
  Future<void> _resetSwingPortfolio() async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (_) => AlertDialog(
        backgroundColor: const Color(0xFF161B22),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
        title: Text(
          'Reset Swing Portfolio?',
          style: GoogleFonts.jetBrainsMono(
            color: Colors.white,
            fontWeight: FontWeight.bold,
          ),
        ),
        content: Text(
          'This will reset the swing portfolio to ₹10,000 and delete all swing trade history, AI logs, and snapshots.\n\nOnly possible when market is closed.',
          style: TextStyle(color: Colors.grey.shade400, fontSize: 13, height: 1.5),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: Text('Cancel', style: TextStyle(color: Colors.grey.shade500)),
          ),
          ElevatedButton(
            style: ElevatedButton.styleFrom(
              backgroundColor: const Color(0xFF7C4DFF),
              foregroundColor: Colors.white,
              shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
            ),
            onPressed: () => Navigator.pop(context, true),
            child: const Text('Reset Swing'),
          ),
        ],
      ),
    );

    if (confirmed != true) return;

    setState(() => _isSwingResetting = true);
    final result = await ref.read(firestoreServiceProvider).resetSwingPortfolio();
    if (!mounted) return;
    setState(() => _isSwingResetting = false);

    final success = result['success'] as bool? ?? false;
    if (success) {
      _showSnack('✅ Swing portfolio reset to ₹10,000', color: const Color(0xFF7C4DFF));
    } else {
      _showSnack('❌ ${result['error'] ?? 'Swing reset failed'}', color: Colors.red);
    }
  }

  void _showSnack(String msg, {required Color color}) {
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(
          msg,
          style: GoogleFonts.jetBrainsMono(fontSize: 12),
        ),
        backgroundColor: color.withOpacity(0.9),
        behavior: SnackBarBehavior.floating,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
        duration: const Duration(seconds: 4),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: const Color(0xFF0D1117),
      appBar: AppBar(
        backgroundColor: const Color(0xFF0D1117),
        title: Text(
          'Settings',
          style: GoogleFonts.jetBrainsMono(
            color: Colors.white,
            fontSize: 16,
            fontWeight: FontWeight.bold,
          ),
        ),
      ),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          // ── ARJUN Control (intraday — disabled) ────────────
          // _SectionHeader(label: 'ARJUN CONTROL'),
          // const SizedBox(height: 8),

          // _SettingsCard(
          //   children: [
          //     _ActionTile(
          //       icon: Icons.play_circle_outline_rounded,
          //       iconColor: const Color(0xFF00FF88),
          //       title: 'Run one trading cycle now',
          //       subtitle: 'Manually trigger ARJUN — useful for testing',
          //       loading: _isTriggering,
          //       onTap: _runManualCycle,
          //     ),
          //     Divider(color: Colors.white.withOpacity(0.06)),
          //     _ActionTile(
          //       icon: Icons.bug_report_rounded,
          //       iconColor: const Color(0xFF4FC3F7),
          //       title: 'Run dummy buy/sell test',
          //       subtitle: 'Executes synthetic trade even if market is closed',
          //       subtitle2: 'No portfolio cash/holdings change',
          //       loading: _isDummyTrading,
          //       onTap: _runDummyTradeTest,
          //     ),
          //     Divider(color: Colors.white.withOpacity(0.06)),
          //     _ActionTile(
          //       icon: Icons.restart_alt_rounded,
          //       iconColor: const Color(0xFFFF3B30),
          //       title: 'Reset portfolio',
          //       subtitle: 'Reset to ₹10,000 and clear all history',
          //       subtitle2: 'Only available when market is closed',
          //       loading: _isResetting,
          //       onTap: _resetPortfolio,
          //       destructive: true,
          //     ),
          //   ],
          // ),

          // ── Swing Trading Control (hidden for production) ───
          // _SectionHeader(label: 'SWING TRADING CONTROL'),
          // const SizedBox(height: 8),
          //
          // _SettingsCard(
          //   children: [
          //     _ActionTile(
          //       icon: Icons.travel_explore_rounded,
          //       iconColor: const Color(0xFF7C4DFF),
          //       title: 'Run one swing cycle now',
          //       subtitle: 'Manually trigger swing AI — uses web search',
          //       subtitle2: 'Browses Indian financial news live via Claude',
          //       loading: _isSwingTriggering,
          //       onTap: _runSwingCycle,
          //     ),
          //     Divider(color: Colors.white.withOpacity(0.06)),
          //     _ActionTile(
          //       icon: Icons.restart_alt_rounded,
          //       iconColor: const Color(0xFF7C4DFF).withOpacity(0.8),
          //       title: 'Reset swing portfolio',
          //       subtitle: 'Reset swing to ₹10,000 and clear swing history',
          //       subtitle2: 'Only available when market is closed',
          //       loading: _isSwingResetting,
          //       onTap: _resetSwingPortfolio,
          //       destructive: false,
          //     ),
          //   ],
          // ),
          //
          // const SizedBox(height: 24),

          // ── About ──────────────────────────────────────────
          _SectionHeader(label: 'ABOUT'),
          const SizedBox(height: 8),

          _SettingsCard(
            children: [
              _InfoTile(
                icon: Icons.psychology_alt_rounded,
                label: 'AI Model',
                value: 'Claude claude-sonnet-4-20250514',
              ),
              Divider(color: Colors.white.withOpacity(0.06)),
              _InfoTile(
                icon: Icons.bar_chart_rounded,
                label: 'Data Source',
                value: 'NSE via yfinance (Nifty 500)',
              ),
              // Divider(color: Colors.white.withOpacity(0.06)),
              // _InfoTile(
              //   icon: Icons.schedule_rounded,
              //   label: 'Intraday Cycle',
              //   value: 'Every 5 min, 09:15–15:30 IST',
              // ),
              Divider(color: Colors.white.withOpacity(0.06)),
              _InfoTile(
                icon: Icons.access_time_rounded,
                label: 'Swing Cycle',
                value: 'Every hour, 09:00–15:00 IST',
              ),
              Divider(color: Colors.white.withOpacity(0.06)),
              _InfoTile(
                icon: Icons.account_balance_wallet_rounded,
                label: 'Capital',
                value: '₹10,000 swing',
              ),
              Divider(color: Colors.white.withOpacity(0.06)),
              _InfoTile(
                icon: Icons.info_outline_rounded,
                label: 'Version',
                value: '1.0.2',
              ),
            ],
          ),

          const SizedBox(height: 24),

          // ── Disclaimer ────────────────────────────────────
          Container(
            padding: const EdgeInsets.all(16),
            decoration: BoxDecoration(
              color: const Color(0xFFFFA726).withOpacity(0.05),
              borderRadius: BorderRadius.circular(12),
              border: Border.all(color: const Color(0xFFFFA726).withOpacity(0.2)),
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    const Icon(Icons.warning_amber_rounded,
                        color: Color(0xFFFFA726), size: 16),
                    const SizedBox(width: 8),
                    Text(
                      'DISCLAIMER',
                      style: GoogleFonts.jetBrainsMono(
                        color: const Color(0xFFFFA726),
                        fontSize: 11,
                        fontWeight: FontWeight.bold,
                        letterSpacing: 1,
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 10),
                Text(
                  'AI Trader is a virtual trading simulator for educational purposes only. '
                  'No real money is involved. All trades are simulated with virtual ₹10,000. '
                  'This is NOT investment advice and is NOT regulated by SEBI. '
                  'Past simulated performance does not indicate future real returns. '
                  'Do NOT make real investment decisions based on this app.',
                  style: TextStyle(
                    color: Colors.grey.shade400,
                    fontSize: 11,
                    height: 1.5,
                  ),
                ),
              ],
            ),
          ),

          const SizedBox(height: 16),

          Center(
            child: Text(
              'Built with Flutter + Firebase + Claude AI',
              style: TextStyle(color: Colors.grey.shade700, fontSize: 11),
            ),
          ),
        ],
      ),
    );
  }
}

// ─────────────────────────────────────────────────────────────
// Section header
// ─────────────────────────────────────────────────────────────
class _SectionHeader extends StatelessWidget {
  final String label;
  const _SectionHeader({required this.label});

  @override
  Widget build(BuildContext context) {
    return Text(
      label,
      style: GoogleFonts.jetBrainsMono(
        color: Colors.grey.shade500,
        fontSize: 10,
        letterSpacing: 2,
      ),
    );
  }
}

// ─────────────────────────────────────────────────────────────
// Settings card container
// ─────────────────────────────────────────────────────────────
class _SettingsCard extends StatelessWidget {
  final List<Widget> children;
  const _SettingsCard({required this.children});

  @override
  Widget build(BuildContext context) {
    return Container(
      decoration: BoxDecoration(
        color: const Color(0xFF161B22),
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: Colors.white.withOpacity(0.06)),
      ),
      child: Column(children: children),
    );
  }
}

// ─────────────────────────────────────────────────────────────
// Action tile (with loading state)
// ─────────────────────────────────────────────────────────────
class _ActionTile extends StatelessWidget {
  final IconData icon;
  final Color iconColor;
  final String title;
  final String subtitle;
  final String? subtitle2;
  final bool loading;
  final VoidCallback onTap;
  final bool destructive;

  const _ActionTile({
    required this.icon,
    required this.iconColor,
    required this.title,
    required this.subtitle,
    this.subtitle2,
    required this.loading,
    required this.onTap,
    this.destructive = false,
  });

  @override
  Widget build(BuildContext context) {
    return Material(
      color: Colors.transparent,
      child: InkWell(
        onTap: loading ? null : onTap,
        borderRadius: BorderRadius.circular(12),
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
          child: Row(
            children: [
              Container(
                width: 38,
                height: 38,
                decoration: BoxDecoration(
                  color: iconColor.withOpacity(0.1),
                  borderRadius: BorderRadius.circular(8),
                ),
                child: loading
                    ? Padding(
                        padding: const EdgeInsets.all(8),
                        child: CircularProgressIndicator(
                          strokeWidth: 2,
                          color: iconColor,
                        ),
                      )
                    : Icon(icon, color: iconColor, size: 20),
              ),
              const SizedBox(width: 14),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      title,
                      style: TextStyle(
                        color: destructive ? const Color(0xFFFF3B30) : Colors.white,
                        fontSize: 14,
                        fontWeight: FontWeight.w500,
                      ),
                    ),
                    Text(
                      subtitle,
                      style: TextStyle(color: Colors.grey.shade500, fontSize: 11),
                    ),
                    if (subtitle2 != null)
                      Text(
                        subtitle2!,
                        style: TextStyle(
                          color: const Color(0xFFFFA726).withOpacity(0.7),
                          fontSize: 10,
                        ),
                      ),
                  ],
                ),
              ),
              Icon(
                Icons.chevron_right_rounded,
                color: Colors.grey.shade700,
                size: 20,
              ),
            ],
          ),
        ),
      ),
    );
  }
}

// ─────────────────────────────────────────────────────────────
// Info tile (read-only)
// ─────────────────────────────────────────────────────────────
class _InfoTile extends StatelessWidget {
  final IconData icon;
  final String label;
  final String value;

  const _InfoTile({required this.icon, required this.label, required this.value});

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
      child: Row(
        children: [
          Icon(icon, color: Colors.grey.shade600, size: 18),
          const SizedBox(width: 12),
          Text(
            label,
            style: TextStyle(color: Colors.grey.shade500, fontSize: 13),
          ),
          const Spacer(),
          Text(
            value,
            style: GoogleFonts.jetBrainsMono(
              color: Colors.white70,
              fontSize: 12,
            ),
          ),
        ],
      ),
    );
  }
}
