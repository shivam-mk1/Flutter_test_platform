# compiler-service — Flutter Project Validation Service

## Purpose

Validates student-submitted Flutter projects during live coding exams. Answers:

> **"Does this Flutter project pass `flutter analyze`?"**

It does **not** debug runtime behaviour, render UI, or determine correctness. The service exists to give students immediate, structured compiler feedback when they click **Run**.

---

## Architecture

```
Student
   │
   ├── RUN ──────────────────────────────────────────────────────────────┐
   │         POST /run { files, studentId, questionId, revision }        │
   │                  ↓                                                  │
   │            Compiler API (Express)                                   │
   │                  ↓                                                  │
   │            BullMQ / Redis                                           │
   │                  ↓                                                  │
   │            Worker (Dockerode)                                       │
   │                  ↓                                                  │
   │       Isolated Flutter Sandbox (Docker)                             │
   │            ├── flutter pub get --offline                            │
   │            └── flutter analyze  ← RUN is analyze-only, §2          │
   │                  ↓                                                  │
   │         Structured result (JSON)                                    │
   │                  ↓                                                  │
   │          GET /jobs/:id  ← client polls every ~2s                   │
   │                                                                     │
   └── SUBMIT ───────────────────────────────────────────────────────────┘
              POST /submit (Exam Backend — NOT this service)
                     ↓
              Exam Backend validates files (shared/validate.js)
                     ↓
              Immutable submission snapshot saved
```

### Key Design Decisions

#### §2 — RUN is `flutter analyze` only (no `flutter build web`)

`flutter build web` is roughly 10× slower than `flutter analyze` on a cold,
resource-capped sandbox (estimated 30–90 s vs 5–30 s). Under synchronized
exam conditions — hard time limit, 20+ students clicking Run at the same moment
— that latency is an unacceptable risk to exam time.

**Known gap**: A project can be analyze-clean and still fail to build (missing
assets, const evaluation failures, tree-shaking issues). This gap is accepted for
RUN. Build validation belongs at submit-time or post-submission evaluation, where
it is not blocking exam time.

#### §23a — Status Delivery: Polling

This version uses `GET /jobs/:id` polling (recommended: 2 s interval).

Rationale: `flutter analyze` takes 5–30 s, so 2 s poll lag is negligible.
Polling requires far fewer moving parts than SSE/WebSocket, which reduces
production risk. A cancelled job immediately reaches terminal state so the
frontend can stop polling the old job ID and start polling the new one.

Upgrade path: add SSE in a future version if sub-second status delivery is needed.

#### §29 — Auth Model: Option B (Exam Backend proxies)

The compiler service trusts a shared service-to-service API key (`X-Service-Key`
header). `studentId` and `questionId` in the request body are treated as
pre-verified by the Exam Backend.

The compiler service does **not** authenticate students independently.

---

## Stack

| Component | Technology |
|---|---|
| API | Express 5, BullMQ, ioredis |
| Worker | BullMQ Worker, Dockerode |
| Sandbox | Flutter SDK (pinned), Ubuntu 22.04 |
| Queue | Redis 7 |

---

## Directory Structure

```
compiler-service/
├── api/src/index.js          — Express API
├── api/src/rateLimit.js      — per-student rate limiter
├── worker/src/index.js       — BullMQ worker + Docker orchestration
├── worker/src/parser.js      — flutter analyze output → structured JSON
├── worker/src/tracker.js     — cancel-and-replace job tracker
├── shared/validate.js        — shared file validator (used by RUN + SUBMIT)
├── shared/pubspec.js         — server-controlled pubspec.yaml generator
├── sandbox/Dockerfile        — Flutter sandbox image
├── sandbox/run.sh            — per-job entrypoint script
├── sandbox/packages/         — package cache seeder (image build only)
├── Dockerfile.api            — API container image
├── Dockerfile.worker         — Worker container image
├── docker-compose.yml        — Local development compose file
├── .env.example              — All environment variables documented
└── tests/
    ├── unit/validate.test.js  — File validator unit tests
    ├── unit/parser.test.js    — Output parser unit tests
    ├── integration/run-api.test.js — API integration tests
    └── load-test.js           — 20-student load test
```

---

## Quick Start

### Prerequisites

- Docker Desktop running
- Node.js ≥ 20
- Redis (or use Docker Compose)

### 1. Build the Flutter sandbox image

```bash
npm run sandbox:build
# Equivalent: docker build -t exam-platform/flutter-sandbox:v1 ./sandbox
#
# This step requires internet access — it downloads Flutter SDK and pre-caches packages.
# The resulting image (~3–4 GB) contains the pinned Flutter SDK and all approved packages.
# Runtime containers have NO network access.
```

### 2. Configure environment

```bash
cp .env.example .env
# Edit .env — at minimum set COMPILER_SERVICE_API_KEY to a real secret
```

### 3. Start services

**Option A — Docker Compose (recommended):**
```bash
docker compose up -d
```

**Option B — local development:**
```bash
# Terminal 1: Redis
docker run -d --name redis -p 6379:6379 redis:7-alpine

# Terminal 2: API
npm run dev:api     # listens on :5000

# Terminal 3: Worker
npm run dev:worker
```

---

## API Reference

### `POST /run` — Submit project for validation

**Headers:**
```
X-Service-Key: <COMPILER_SERVICE_API_KEY>
Content-Type: application/json
```

**Request body:**
```json
{
  "studentId":  "student-123",
  "questionId": "q-flutter-1",
  "revision":   17,
  "files": [
    { "path": "lib/main.dart",         "content": "import 'package:flutter/material.dart'; ..." },
    { "path": "lib/screens/home.dart", "content": "..." },
    { "path": "assets/logo.png",       "content": "..." }
  ],
  "timeoutMs": 60000
}
```

**Notes:**
- `revision` must be a non-negative integer, incremented by the client on each edit
- `timeoutMs` is capped server-side at `MAX_EXECUTION_TIMEOUT_MS` (default 120 s)
- `pubspec.yaml` is always server-controlled — any student-submitted `pubspec.yaml` is ignored
- File paths must be under `lib/`, `assets/`, `test/`, `web/`, or `fonts/`

**Response (202):**
```json
{
  "jobId":    "550e8400-e29b-41d4-a716-446655440000",
  "revision": 17,
  "status":   "queued"
}
```

**Error responses:**
- `400` — file validation failed (path traversal, too large, forbidden path, etc.)
- `401` — missing `X-Service-Key`
- `403` — invalid `X-Service-Key`
- `429` — rate limit exceeded

---

### `GET /jobs/:id` — Poll job status

**Headers:**
```
X-Service-Key: <COMPILER_SERVICE_API_KEY>
X-Student-Id: <studentId>        (or ?studentId=...)
```

**Response:**
```json
{
  "jobId":    "550e8400-...",
  "revision": 17,
  "state":    "queued | running | completed | failed | cancelled",
  "result":   null
}
```

When `state` is `completed`, `result` contains the structured analysis result (see below).

---

### `POST /jobs/:id/cancel` — Cancel a job

**Headers:** `X-Service-Key`, `X-Student-Id` (or body `studentId`)

Cancels a queued or active job. Only the owning student can cancel their own jobs.

---

### `GET /health` — Liveness probe

```json
{ "status": "ok", "ts": "...", "examEnvVersion": "v1", "activeJobs": 2 }
```

---

## Result Format

### Analyze success (no errors, warnings non-blocking)

```json
{
  "status":       "success",
  "phase":        "analyze",
  "errors":       [],
  "warnings":     [],
  "revision":     17,
  "examEnvVersion": "v1",
  "analyzeOnly":  true
}
```

### Analyze error

```json
{
  "status": "error",
  "phase":  "analyze",
  "errors": [
    {
      "severity": "error",
      "file":     "lib/main.dart",
      "line":     42,
      "column":   10,
      "code":     "undefined_identifier",
      "message":  "Undefined name 'foo'."
    }
  ],
  "warnings":   [],
  "revision":   17,
  "exitCode":   1
}
```

### Dependency error (pub get failed)

```json
{
  "status": "error",
  "phase":  "dependency",
  "errors": [
    {
      "severity": "error",
      "file":     "pubspec.yaml",
      "code":     "dependency_error",
      "message":  "Dependency resolution failed. The project may reference packages not in the exam allowlist."
    }
  ]
}
```

### Timeout

```json
{
  "status": "error",
  "phase":  "timeout",
  "errors": [{ "code": "timeout", "message": "Validation timed out after 60000ms." }]
}
```

### Cancelled

```json
{ "status": "cancelled", "phase": null, "errors": [], "warnings": [] }
```

---

## Allowed File Paths

Student files must be in one of:
```
lib/       — Dart source code
assets/    — images, fonts, JSON assets
test/      — test files
web/       — web-specific overrides
fonts/     — font files
```

Rejected: `pubspec.yaml`, `Dockerfile`, `.git/`, `android/`, `ios/`, `.sh`, `.exe`, absolute paths, path traversal (`../../`).

---

## Approved Packages

The exam environment is fixed. These packages are pre-installed in the sandbox:

| Package | Version |
|---|---|
| flutter | SDK |
| provider | ^6.1.2 |
| go_router | ^14.2.7 |
| flutter_bloc | ^8.1.6 |
| equatable | ^2.0.5 |
| http | ^1.2.1 |
| intl | ^0.19.0 |
| shared_preferences | ^2.3.1 |
| collection | ^1.18.0 |

To add packages: update `shared/pubspec.js` + `sandbox/packages/pubspec.yaml`, then rebuild the sandbox image and bump `EXAM_ENV_VERSION`.

---

## Sandbox Security

Each sandbox container runs with:

| Property | Value |
|---|---|
| User | `sandbox` (non-root) |
| Network | `none` — no internet access |
| Memory | 512 MB (configurable) |
| CPU | 1 core (configurable) |
| PIDs | 128 (configurable) |
| Root FS | Read-only |
| Capabilities | ALL dropped |
| Security | `no-new-privileges:true` |
| Privileged | `false` |
| Docker socket | Not mounted in sandbox |
| Writable paths | `/tmp` (tmpfs 64 MB), `/home/sandbox` (tmpfs 64 MB), `/workspace` (bind-mount, read-write for `.dart_tool/`) |

**Note:** tmpfs is RAM-backed. Combined tmpfs usage (128 MB) counts against the 512 MB memory limit.

---

## Resource Limits

All limits are configurable via environment variables. See `.env.example` for full documentation.

| Limit | Default | Env Var |
|---|---|---|
| Memory | 512 MB | `SANDBOX_MEMORY_MB` |
| CPU | 1 core | `SANDBOX_NANO_CPUS` |
| PIDs | 128 | `SANDBOX_PIDS` |
| tmpfs per mount | 64 MB | `SANDBOX_TMPFS_MB` |
| Timeout (default) | 60 s | `DEFAULT_EXECUTION_TIMEOUT_MS` |
| Timeout (max) | 120 s | `MAX_EXECUTION_TIMEOUT_MS` |
| stdout limit | 2 MB | `MAX_STDOUT_BYTES` |
| stderr limit | 2 MB | `MAX_STDERR_BYTES` |
| Files per project | 50 | `MAX_FILE_COUNT` |
| Source file size | 512 KB | `MAX_FILE_SIZE_BYTES` |
| Asset file size | 2 MB | `MAX_ASSET_SIZE_BYTES` |
| Total project | 10 MB | `MAX_PROJECT_SIZE_BYTES` |
| Rate limit | 10 req/min | `MAX_RUN_REQUESTS_PER_MINUTE` |
| Worker concurrency | 4 | `EXEC_CONCURRENCY` |

---

## Cancel-and-Replace (§17)

When a new RUN arrives for the same `(studentId, questionId)` with a newer revision:

1. If the old job is **queued**: removed from BullMQ before the worker picks it up
2. If the old job is **active** (container running): worker kills the container
3. The old job result (if any) is discarded: `result.revision != currentRevision`

At most one active sandbox exists per `(studentId, questionId)` at any time.

**Rate limiting**: cancel-and-replace counts as a new request against the rate limit.

---

## Running Tests

### Unit tests (no Redis, no Docker required)

```bash
npm run test:unit
# Runs: tests/unit/validate.test.js + tests/unit/parser.test.js
```

### Integration tests (requires running API + Redis)

```bash
npm run start:api    # in another terminal
npm run test:integration
```

### 20-student load test (requires full stack)

```bash
# Single burst — 20 students:
npm run load-test

# With label:
node tests/load-test.js --students=20 --label=concurrency-4

# 3 waves, 30 s apart (§33):
node tests/load-test.js --students=20 --waves=3 --wave-interval-ms=30000 --label=burst-3x

# Different concurrency values (run worker with each, then test):
EXEC_CONCURRENCY=2 npm run start:worker  →  node tests/load-test.js --label=c2
EXEC_CONCURRENCY=4 npm run start:worker  →  node tests/load-test.js --label=c4
EXEC_CONCURRENCY=8 npm run start:worker  →  node tests/load-test.js --label=c8
```

---

## Docker Build

```bash
# Sandbox image (contains Flutter SDK + approved packages)
npm run sandbox:build
# or: docker build --build-arg FLUTTER_VERSION=3.24.5 -t exam-platform/flutter-sandbox:v1 ./sandbox

# API image
docker build -f Dockerfile.api -t exam-platform/compiler-api:latest .

# Worker image
docker build -f Dockerfile.worker -t exam-platform/compiler-worker:latest .
```

---

## Known Limitations and Security Risks

### NOT production-secure yet

The following are **experimentally unverified** — Docker flags are present in configuration but their effectiveness has not been tested against actual attacks:

- `CapDrop: ALL` — drops Linux capabilities; not verified against capability-based escalation exploits
- `no-new-privileges` — prevents setuid escalation; not tested against SUID binary attacks
- `ReadonlyRootfs` — tested at the configuration level; tmpfs overrides were verified to work
- `NetworkMode: none` — network isolation; not tested against raw socket or netlink bypass attempts

### Architectural limitations

- **Cancel-and-replace tracker is in-memory**: If the worker restarts, orphaned containers are cleaned up by Docker forced-remove on each job's `finally` block. Multi-worker deployments require a Redis-backed tracker.
- **Rate limiter is in-memory**: Resets on process restart. Redis-backed implementation needed for production.
- **`flutter analyze` ≠ `flutter build web`**: Analyze-clean code can still fail to compile. Build validation is deliberately excluded from RUN (§2 decision).
- **Docker, not VM isolation**: Ordinary Docker hardening. Before production with real students, evaluate gVisor/Kata Containers/Firecracker for stronger kernel-level isolation.
- **Single approved package allowlist**: Expanding requires image rebuild.
- **No student auth in compiler service**: Relies on Exam Backend to verify student identity (§29 — Option B). A compromised Exam Backend could spoof `studentId`.

### Production blockers

1. Evaluate gVisor or Kata Containers (§9)
2. Benchmark actual resource usage of `flutter analyze` under 20-student load (§32)
3. Tune `SANDBOX_MEMORY_MB`, `SANDBOX_TMPFS_MB`, and `EXEC_CONCURRENCY` from benchmark data
4. Replace in-memory rate limiter and tracker with Redis-backed implementations for multi-worker
5. Change `COMPILER_SERVICE_API_KEY` from default value
6. Decide whether analyze-only RUN coverage is sufficient or whether build validation at submit-time is required
7. Set up image version pinning and rotation policy for `exam-platform/flutter-sandbox:v1`
