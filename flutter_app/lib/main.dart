/// lib/main.dart
/// ==============
/// Flutter app entry point for AI Trader.
///
/// RESPONSIBILITIES:
///   - Initializes Firebase (FlutterFire)
///   - Shows disclaimer modal on first launch (SharedPreferences gate)
///   - Sets up Riverpod ProviderScope
///   - Applies dark trading-terminal theme (Google Fonts — JetBrains Mono)
///   - Hosts the bottom navigation shell with 4 tabs:
///       Dashboard | History | Portfolio | AI Brain
///   - Settings accessible via top-right gear icon
///
/// FIRST LAUNCH:
///   On first app open, a disclaimer modal is shown BEFORE the dashboard:
///   "Virtual simulator only. No real money. Not SEBI advice."
///   User must tap "I Understand" to proceed.
///   Stored in SharedPreferences so it only appears once.
///
/// THEME:
///   Background:  #0D1117  (GitHub dark)
///   Surface:     #161B22
///   Accent:      #00FF88  (terminal green)
///   Font:        JetBrains Mono (from google_fonts)

import 'package:firebase_core/firebase_core.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'firebase_options.dart';
import 'screens/ai_brain_screen.dart';
import 'screens/dashboard_screen.dart';
import 'screens/history_screen.dart';
import 'screens/portfolio_screen.dart';
import 'screens/settings_screen.dart';

// ─────────────────────────────────────────────────────────────
// App entry point
// ─────────────────────────────────────────────────────────────
void main() async {
  WidgetsFlutterBinding.ensureInitialized();

  // Force portrait orientation (trading terminal)
  await SystemChrome.setPreferredOrientations([
    DeviceOrientation.portraitUp,
    DeviceOrientation.portraitDown,
  ]);

  // Initialize Firebase
  await Firebase.initializeApp(options: DefaultFirebaseOptions.currentPlatform);

  // Status bar style — dark background
  SystemChrome.setSystemUIOverlayStyle(const SystemUiOverlayStyle(
    statusBarColor:            Colors.transparent,
    statusBarIconBrightness:   Brightness.light,
    statusBarBrightness:       Brightness.dark,
  ));

  runApp(
    const ProviderScope(
      child: AITraderApp(),
    ),
  );
}

// ─────────────────────────────────────────────────────────────
// Root app widget
// ─────────────────────────────────────────────────────────────
class AITraderApp extends StatelessWidget {
  const AITraderApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'AI Trader — ARJUN',
      debugShowCheckedModeBanner: false,
      theme: _buildTheme(),
      home: const _DisclaimerGate(),
    );
  }

  ThemeData _buildTheme() {
    const bg      = Color(0xFF0D1117);
    const surface = Color(0xFF161B22);
    const accent  = Color(0xFF00FF88);

    return ThemeData(
      useMaterial3: true,
      brightness: Brightness.dark,
      scaffoldBackgroundColor: bg,
      colorScheme: const ColorScheme.dark(
        primary:    accent,
        secondary:  accent,
        surface:    surface,
        background: bg,
        onPrimary:  Colors.black,
        onSurface:  Colors.white,
      ),
      textTheme: GoogleFonts.interTextTheme(ThemeData.dark().textTheme),
      appBarTheme: const AppBarTheme(
        backgroundColor:    bg,
        foregroundColor:    Colors.white,
        elevation:          0,
        centerTitle:        false,
        systemOverlayStyle: SystemUiOverlayStyle(
          statusBarIconBrightness: Brightness.light,
        ),
      ),
      bottomNavigationBarTheme: const BottomNavigationBarThemeData(
        backgroundColor:      surface,
        selectedItemColor:    accent,
        unselectedItemColor:  Color(0xFF6B7280),
        elevation:            0,
        type:                 BottomNavigationBarType.fixed,
      ),
      cardTheme: const CardThemeData(
        color:  surface,
        elevation: 0,
      ),
      dialogTheme: const DialogThemeData(
        backgroundColor: surface,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.all(Radius.circular(16)),
        ),
      ),
      snackBarTheme: const SnackBarThemeData(
        behavior: SnackBarBehavior.floating,
      ),
    );
  }
}

// ─────────────────────────────────────────────────────────────
// Disclaimer gate — shows modal on first launch
// ─────────────────────────────────────────────────────────────
class _DisclaimerGate extends StatefulWidget {
  const _DisclaimerGate();

  @override
  State<_DisclaimerGate> createState() => _DisclaimerGateState();
}

class _DisclaimerGateState extends State<_DisclaimerGate> {
  bool _loading = true;
  bool _showDisclaimer = false;

  @override
  void initState() {
    super.initState();
    _checkFirstLaunch();
  }

  Future<void> _checkFirstLaunch() async {
    final prefs = await SharedPreferences.getInstance();
    final seen  = prefs.getBool('disclaimer_seen') ?? false;
    setState(() {
      _showDisclaimer = !seen;
      _loading = false;
    });
  }

  Future<void> _acceptDisclaimer() async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setBool('disclaimer_seen', true);
    if (mounted) {
      setState(() => _showDisclaimer = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    if (_loading) {
      return const Scaffold(
        backgroundColor: Color(0xFF0D1117),
        body: Center(
          child: CircularProgressIndicator(color: Color(0xFF00FF88)),
        ),
      );
    }

    return Stack(
      children: [
        const _MainShell(),
        if (_showDisclaimer)
          _DisclaimerOverlay(onAccept: _acceptDisclaimer),
      ],
    );
  }
}

// ─────────────────────────────────────────────────────────────
// Disclaimer overlay modal
// ─────────────────────────────────────────────────────────────
class _DisclaimerOverlay extends StatelessWidget {
  final VoidCallback onAccept;
  const _DisclaimerOverlay({required this.onAccept});

  @override
  Widget build(BuildContext context) {
    return Container(
      color: Colors.black.withOpacity(0.85),
      child: Center(
        child: Container(
          margin: const EdgeInsets.all(24),
          padding: const EdgeInsets.all(28),
          decoration: BoxDecoration(
            color: const Color(0xFF161B22),
            borderRadius: BorderRadius.circular(20),
            border: Border.all(
              color: const Color(0xFFFFA726).withOpacity(0.4),
              width: 1.5,
            ),
          ),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const Text('⚠️', style: TextStyle(fontSize: 48)),
              const SizedBox(height: 16),
              Text(
                'IMPORTANT DISCLAIMER',
                style: GoogleFonts.jetBrainsMono(
                  color: const Color(0xFFFFA726),
                  fontSize: 14,
                  fontWeight: FontWeight.bold,
                  letterSpacing: 1,
                ),
              ),
              const SizedBox(height: 20),
              Text(
                'AI Trader is a VIRTUAL SIMULATOR only.',
                style: const TextStyle(
                  color: Colors.white,
                  fontSize: 15,
                  fontWeight: FontWeight.bold,
                ),
                textAlign: TextAlign.center,
              ),
              const SizedBox(height: 16),
              Text(
                '• No real money is involved\n'
                '• All ₹10,000 is virtual currency\n'
                '• This is NOT investment advice\n'
                '• NOT regulated or approved by SEBI\n'
                '• For educational / research use only\n'
                '• Past simulated results ≠ future returns',
                style: TextStyle(
                  color: Colors.grey.shade400,
                  fontSize: 13,
                  height: 1.7,
                ),
              ),
              const SizedBox(height: 24),
              SizedBox(
                width: double.infinity,
                child: ElevatedButton(
                  style: ElevatedButton.styleFrom(
                    backgroundColor: const Color(0xFF00FF88),
                    foregroundColor: Colors.black,
                    padding: const EdgeInsets.symmetric(vertical: 14),
                    shape: RoundedRectangleBorder(
                      borderRadius: BorderRadius.circular(10),
                    ),
                  ),
                  onPressed: onAccept,
                  child: Text(
                    'I UNDERSTAND — ENTER APP',
                    style: GoogleFonts.jetBrainsMono(
                      fontWeight: FontWeight.bold,
                      fontSize: 13,
                    ),
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

// ─────────────────────────────────────────────────────────────
// Main navigation shell (bottom navigation bar)
// ─────────────────────────────────────────────────────────────
class _MainShell extends StatefulWidget {
  const _MainShell();

  @override
  State<_MainShell> createState() => _MainShellState();
}

class _MainShellState extends State<_MainShell> {
  int _currentIndex = 0;

  static const _screens = [
    DashboardScreen(),
    HistoryScreen(),
    PortfolioScreen(),
    AIBrainScreen(),
  ];

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: const Color(0xFF0D1117),
      body: IndexedStack(
        index: _currentIndex,
        children: _screens,
      ),
      floatingActionButton: _currentIndex == 0
          ? FloatingActionButton.small(
              backgroundColor: const Color(0xFF1D6FEB),
              onPressed: () {
                Navigator.push(
                  context,
                  MaterialPageRoute(builder: (_) => const SettingsScreen()),
                );
              },
              child: const Icon(Icons.settings_rounded, size: 18, color: Colors.white),
            )
          : null,
      bottomNavigationBar: Container(
        decoration: BoxDecoration(
          border: Border(
            top: BorderSide(color: Colors.white.withOpacity(0.08)),
          ),
        ),
        child: BottomNavigationBar(
          currentIndex: _currentIndex,
          onTap: (i) => setState(() => _currentIndex = i),
          items: const [
            BottomNavigationBarItem(
              icon: Icon(Icons.dashboard_rounded),
              activeIcon: Icon(Icons.dashboard_rounded),
              label: 'Dashboard',
            ),
            BottomNavigationBarItem(
              icon: Icon(Icons.history_rounded),
              activeIcon: Icon(Icons.history_rounded),
              label: 'History',
            ),
            BottomNavigationBarItem(
              icon: Icon(Icons.pie_chart_rounded),
              activeIcon: Icon(Icons.pie_chart_rounded),
              label: 'Portfolio',
            ),
            BottomNavigationBarItem(
              icon: Icon(Icons.psychology_rounded),
              activeIcon: Icon(Icons.psychology_rounded),
              label: 'AI Brain',
            ),
          ],
        ),
      ),
    );
  }
}
