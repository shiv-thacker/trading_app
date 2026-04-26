"""
DEPRECATED: market_api/main.py
==============================

This Python service is no longer used.

The project now runs in Firebase-only mode:
  - Cloud Functions fetch market data directly in Node.js
  - No Render deployment
  - No local Python or uv setup required

See:
  docs/FIREBASE_ONLY_SETUP.md

This file is intentionally kept as a placeholder for historical reference.
"""

if __name__ == "__main__":
    print(
        "This service is deprecated. Use Firebase-only setup in "
        "docs/FIREBASE_ONLY_SETUP.md"
    )
