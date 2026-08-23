#!/bin/sh
# sandbox/run.sh — baked into the image at /usr/local/bin/sandbox-run
#
# Executed per-job by the worker (via Docker Cmd override).
# Performs:
#   1. flutter pub get --offline   (resolves deps from pre-seeded cache)
#   2. flutter analyze             (static analysis — RUN is analyze-only, §2)
#
# Exit codes:
#   0  = analyze clean
#   1  = analyze found errors/warnings (flutter analyze default)
#   2  = pub get failed (dependency error — check pubspec.yaml allowlist)
#   Other = unexpected flutter error
#
# Phase markers are parsed by worker/src/parser.js to distinguish stages.
#
# NOTE: flutter build web is deliberately NOT run here.
# See §2 of the spec: build validation belongs at submit-time, not during RUN.
# Running flutter build web would add ~30-90s per job under exam time pressure.

# NOTE: do NOT use set -u here. WORKSPACE is injected via Docker Env config,
# but defensive handling below covers the case it is missing.

WORKSPACE="${WORKSPACE:-/workspace}"

# ── Git safe.directory workaround ────────────────────────────────────────────
# Flutter SDK lives at /usr/local/flutter (owned by root).
# The sandbox user is non-root. Git 2.35.2+ rejects cross-user directory access.
# /etc/gitconfig is set during image build (git config --system), but as a
# defense-in-depth, also set it here in the user-global config.
# Writing to ~/.gitconfig works because /home/sandbox is a tmpfs mount.
git config --global --add safe.directory '/usr/local/flutter' 2>/dev/null || true
git config --global --add safe.directory '*' 2>/dev/null || true

cd "$WORKSPACE" || { echo "ERROR: cannot cd to $WORKSPACE"; exit 1; }

# ── Step 1: Resolve dependencies offline ─────────────────────────────────────
echo "=== PHASE:pubget ==="
flutter pub get --offline 2>&1
PUBGET_EXIT=$?

if [ "$PUBGET_EXIT" -ne 0 ]; then
  echo ""
  echo "=== PUBGET_FAILED:${PUBGET_EXIT} ==="
  echo "Dependency resolution failed. The project may reference packages not in the"
  echo "approved exam allowlist, or the sandbox image may need to be rebuilt."
  exit 2
fi

# ── Step 2: Static analysis ───────────────────────────────────────────────────
echo ""
echo "=== PHASE:analyze ==="
flutter analyze 2>&1
ANALYZE_EXIT=$?

echo ""
echo "=== ANALYZE_EXIT:${ANALYZE_EXIT} ==="
exit "$ANALYZE_EXIT"
