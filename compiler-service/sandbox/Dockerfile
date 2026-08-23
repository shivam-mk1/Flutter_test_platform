# =============================================================================
# sandbox/Dockerfile
# Flutter sandbox image for the exam platform.
#
# Build:
#   docker build \
#     --build-arg FLUTTER_VERSION=3.24.5 \
#     -t exam-platform/flutter-sandbox:v1 \
#     ./sandbox
#
# Security properties at runtime (enforced by worker, NOT by this Dockerfile):
#   - Non-root user (sandbox)
#   - No network access (NetworkMode: none)
#   - Memory limit (SANDBOX_MEMORY_MB)
#   - CPU limit (SANDBOX_NANO_CPUS)
#   - PID limit (SANDBOX_PIDS)
#   - CapDrop ALL + no-new-privileges
#   - Tmpfs at /tmp and /home/sandbox (sized, bounded)
#   - Workspace bind-mounted read-write (needed for .dart_tool/ from pub get)
#
# Writable locations at runtime:
#   /tmp              — tmpfs, 1777 world-writable (Flutter config, HOME)
#   /home/sandbox     — tmpfs (kept as mount point, not used as HOME)
#   /workspace        — bind-mount, rw   (student files + .dart_tool/)
#   /usr/local/flutter/bin/cache — rw by sandbox user (lockfile + Dart snapshots)
# =============================================================================

ARG FLUTTER_VERSION=3.24.5

# Use ubuntu:22.04 — the Flutter team's recommended CI base for Linux.
# Do NOT use dart:sdk-only images; flutter requires the full toolchain.
FROM ubuntu:22.04 AS base

ARG FLUTTER_VERSION
ENV FLUTTER_VERSION=${FLUTTER_VERSION}
ENV FLUTTER_HOME=/usr/local/flutter
ENV PATH=${FLUTTER_HOME}/bin:${FLUTTER_HOME}/bin/cache/dart-sdk/bin:${PATH}

# Suppress interactive prompts during apt
ENV DEBIAN_FRONTEND=noninteractive
ENV TZ=UTC

# ── System dependencies ───────────────────────────────────────────────────────
# Keep to a minimum — no build tools (clang/cmake/ninja) needed for analyze-only.
# libglib2.0-0 and libdbus-1-3 are required by the Dart VM on Ubuntu 22.04.
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    git \
    unzip \
    xz-utils \
    ca-certificates \
    libglib2.0-0 \
    libdbus-1-3 \
    && rm -rf /var/lib/apt/lists/*

# ── Flutter SDK ───────────────────────────────────────────────────────────────
# Pin an explicit version — never use 'latest'. The tag is in the image name (v1).
# To upgrade Flutter: bump FLUTTER_VERSION build-arg and rebuild the image.
RUN curl -fsSL \
    "https://storage.googleapis.com/flutter_infra_release/releases/stable/linux/flutter_linux_${FLUTTER_VERSION}-stable.tar.xz" \
    | tar -xJ -C /usr/local && \
    # Ensure Flutter directory is owned by root (not sandbox user)
    chown -R root:root ${FLUTTER_HOME} && \
    # Lock Flutter version — prevent accidental upgrades inside the image
    touch ${FLUTTER_HOME}/version

# ── Create non-root sandbox user ──────────────────────────────────────────────
# All student code runs as this user. Never run as root.
RUN groupadd -r sandbox && \
    useradd -r -g sandbox -m -d /home/sandbox -s /sbin/nologin sandbox

# ── Configure Flutter (as root, system-wide) ──────────────────────────────────
# Disable all analytics, telemetry, and crash reporting.
# Use --system so git configuration lives in /etc/gitconfig (accessible by sandbox user).
RUN git config --system --add safe.directory '*' && \
    git config --system --add safe.directory ${FLUTTER_HOME} && \
    flutter config --no-analytics && \
    flutter config --no-cli-animations && \
    # Suppress Flutter welcome and first-run prompts
    flutter --version

# ── Pre-seed the pub cache ─────────────────────────────────────────────────────
# Run flutter pub get during IMAGE BUILD (network is available).
# The cache is seeded to /exam-pub-cache (not the sandbox user's home dir).
# At runtime, PUB_CACHE=/exam-pub-cache and NetworkMode=none, so packages
# must already be present here.
#
# /exam-pub-cache is in the image layer → read-only at runtime (ReadonlyRootfs).
# flutter pub get --offline reads from here but does NOT need to write to it.
ENV PUB_CACHE=/exam-pub-cache
RUN mkdir -p /exam-pub-cache

WORKDIR /exam-setup
COPY packages/pubspec.yaml ./pubspec.yaml

# Run pub get as root so the cache lands in /exam-pub-cache (owned by root → read-only at runtime)
# Using --no-example to suppress example project creation
RUN flutter pub get 2>&1 || true
# Verify packages are cached
RUN ls /exam-pub-cache/hosted 2>/dev/null || echo "WARNING: pub cache may be empty"

# ── Pre-warm Flutter/Dart toolchain caches ────────────────────────────────────
# This compiles the Dart SDK snapshots so the first analyze is fast.
# flutter precache downloads the web SDK artifacts needed for web target awareness.
RUN flutter precache --web 2>&1 || true

# ── Fix Flutter cache directory permissions ───────────────────────────────────
# All files under /usr/local/flutter/bin/cache/ are created by root during build.
# Flutter opens /usr/local/flutter/bin/cache/lockfile for writing on EVERY startup.
# Without write permission for the sandbox user, Flutter crashes before pub get.
#
# We give the sandbox user write access to bin/cache/ and pre-create the lockfile.
# This does NOT affect security: the sandbox has no network, no capabilities,
# and is a non-root user — it can only modify its own Flutter cache copy.
RUN chown -R sandbox:sandbox /usr/local/flutter/bin/cache/ && \
    touch /usr/local/flutter/bin/cache/lockfile && \
    chmod 664 /usr/local/flutter/bin/cache/lockfile

# ── Per-job entrypoint script ─────────────────────────────────────────────────
COPY run.sh /usr/local/bin/sandbox-run
RUN chmod +x /usr/local/bin/sandbox-run && \
    chown root:root /usr/local/bin/sandbox-run

# ── Workspace directory ───────────────────────────────────────────────────────
# Created here so it exists in the image layer.
# At runtime, the worker bind-mounts student files here (read-write).
RUN mkdir -p /workspace && chown sandbox:sandbox /workspace

# ── Final security configuration ─────────────────────────────────────────────
# Switch to non-root user for the container runtime default.
USER sandbox

# Set HOME to /tmp at runtime.
# Docker mounts /home/sandbox tmpfs as root-owned (mode 755), so sandbox can't
# write there. /tmp is 1777 (world-writable). Flutter writes its config here.
# Docker mounts /home/sandbox tmpfs as root-owned (mode 755), so the sandbox
# user can't write there. /tmp is 1777 (world-writable) and works for Flutter config.
ENV HOME=/tmp
ENV PUB_CACHE=/exam-pub-cache

WORKDIR /workspace

# The actual Cmd is set by the worker per-job.
# This CMD is a fallback that runs the analysis script.
CMD ["/usr/local/bin/sandbox-run"]
