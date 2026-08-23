'use strict'

/**
 * compiler-service/worker/src/index.js
 *
 * BullMQ worker — processes Flutter project validation jobs.
 *
 * Pipeline per job (§23):
 *   1. tracker.register()  — cancel any previous job for this student/question
 *   2. Create tmpdir
 *   3. Validate files (defense-in-depth)
 *   4. Write student files to tmpdir
 *   5. Write server-controlled pubspec.yaml (overwrites any student-provided one)
 *   6. Create isolated Docker container (Flutter sandbox)
 *   7. Run sandbox-run script: flutter pub get --offline → flutter analyze
 *   8. Accumulate output with byte limits
 *   9. Enforce timeout
 *  10. Parse structured result
 *  11. Destroy container + clean tmpdir (always, in finally)
 *
 * RUN is analyze-only (§2) — flutter build web is deliberately NOT run here.
 *
 * Resource limits per sandbox container:
 *   Memory:   SANDBOX_MEMORY_MB     default 512 MB
 *   CPU:      SANDBOX_NANO_CPUS     default 1 core (1_000_000_000 NanoCpus)
 *   PIDs:     SANDBOX_PIDS          default 128
 *   Network:  none
 *   Root FS:  read-only (except /tmp, /home/sandbox tmpfs, /workspace bind-mount)
 *   CapDrop:  ALL
 *   Security: no-new-privileges
 */

require('dotenv').config()
const { Worker, Queue } = require('bullmq')
const Docker      = require('dockerode')
const fs          = require('fs')
const os          = require('os')
const path        = require('path')

const { validateFiles }  = require('../../shared/validate')
const { generatePubspec, generateAnalysisOptions } = require('../../shared/pubspec')
const { parseAnalyzeOutput, detectFailedPhase, truncateOutput } = require('./parser')
const tracker = require('./tracker')

// ── Config ───────────────────────────────────────────────────────────────────
const REDIS_URL          = process.env.REDIS_URL              || 'redis://localhost:6379'
const EXEC_CONCURRENCY   = parseInt(process.env.EXEC_CONCURRENCY       || '4',   10)
const SANDBOX_IMAGE      = process.env.DOCKER_SANDBOX_IMAGE             || 'exam-platform/flutter-sandbox:v1'

const DEFAULT_TIMEOUT_MS = parseInt(process.env.DEFAULT_EXECUTION_TIMEOUT_MS || '60000',  10)
const MAX_TIMEOUT_MS     = parseInt(process.env.MAX_EXECUTION_TIMEOUT_MS     || '120000', 10)

const SANDBOX_MEMORY_BYTES = parseInt(process.env.SANDBOX_MEMORY_MB || '512', 10) * 1024 * 1024
const SANDBOX_PIDS         = parseInt(process.env.SANDBOX_PIDS        || '128',  10)
const SANDBOX_TMPFS_MB     = parseInt(process.env.SANDBOX_TMPFS_MB    || '64',   10)

// CPU limit — supports a per-invocation experiment override so the production
// default is never silently changed. When SANDBOX_CPU_EXPERIMENT is set it
// overrides SANDBOX_NANO_CPUS for this worker process only. A value of 0
// means "unrestricted" (no NanoCpus limit applied to the container).
// NEVER leave SANDBOX_CPU_EXPERIMENT set in production.
const _baseCpuNano = parseInt(process.env.SANDBOX_NANO_CPUS || '500000000', 10)  // default: 0.5 CPU
const _cpuOverride = process.env.SANDBOX_CPU_EXPERIMENT     // e.g. '1000000000', '2000000000', '0'
const SANDBOX_NANO_CPUS = (_cpuOverride !== undefined)
  ? parseInt(_cpuOverride, 10)
  : _baseCpuNano
const CPU_LIMIT_UNRESTRICTED = SANDBOX_NANO_CPUS === 0  // 0 = omit NanoCpus field entirely


const MAX_STDOUT_BYTES = parseInt(process.env.MAX_STDOUT_BYTES || String(2 * 1024 * 1024), 10) // 2 MB
const MAX_STDERR_BYTES = parseInt(process.env.MAX_STDERR_BYTES || String(2 * 1024 * 1024), 10) // 2 MB

// ── Workspace volume ─────────────────────────────────────────────────────────
// The worker and sandbox containers are SIBLINGS — both are children of the
// Docker daemon, not parent/child. Bind mount paths in Binds[] are resolved
// by the Docker daemon relative to the HOST, not the worker container.
//
// Solution: use a named Docker volume (exam-workspaces). The daemon manages it
// directly and can mount it into any container by name. The worker mounts it
// at /exam-workspaces to write job files; sandboxes mount the same volume
// to read those files.
//
// WORKSPACE_VOLUME_NAME must match the volume name in docker-compose.yml.
// WORKSPACE_BASE is where the volume is mounted inside the worker container.
const WORKSPACE_VOLUME_NAME = process.env.WORKSPACE_VOLUME_NAME || 'exam-workspaces'
const WORKSPACE_BASE        = '/exam-workspaces'

// ── Docker ───────────────────────────────────────────────────────────────────
const docker = new Docker()  // connects via /var/run/docker.sock

// ── Redis connection ──────────────────────────────────────────────────────────
const redisUrl = new URL(REDIS_URL)
const redisConnection = { host: redisUrl.hostname, port: Number(redisUrl.port) || 6379 }

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Force-remove a Docker container, ignoring errors (already removed, etc.) */
async function forceRemoveContainer(container) {
  if (!container) return
  try { await container.remove({ force: true }) } catch { /* already removed */ }
}

/** Recursively delete a directory, ignoring errors */
function cleanupTmpDir(dir) {
  if (!dir) return
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
}

/** Write all student files into the tmpdir, creating subdirectories as needed. */
function writeProjectFiles(files, tmpDir) {
  for (const file of files) {
    // Use posix-normalized path (validated by shared/validate.js)
    const normalized = path.posix.normalize(file.path.replace(/\\/g, '/'))
    const dest = path.join(tmpDir, normalized.replace(/\//g, path.sep))
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.writeFileSync(dest, file.content, 'utf8')
  }
}

// ── Job Execution Pipeline ───────────────────────────────────────────────────
/**
 * Execute a single validation job against an isolated Docker sandbox.
 * Can be called by BullMQ worker or directly by diagnostics.
 *
 * @param {object} job - BullMQ job-like object with { id, data: { studentId, questionId, revision, files, timeoutMs, examEnvVersion } }
 * @param {object} [options] - Execution options (e.g. { cmdOverride })
 * @returns {Promise<object>} Structured result object with status, errors, warnings, timing, etc.
 */
async function executeJob(job, options = {}) {
  const {
    studentId,
    questionId,
    revision,
    files,
    timeoutMs: requestedTimeout,
    examEnvVersion = 'v1',
  } = job.data

  // Clamp timeout
  const effectiveTimeout = Math.min(
    Number.isFinite(requestedTimeout) && requestedTimeout > 0
      ? requestedTimeout
      : DEFAULT_TIMEOUT_MS,
    MAX_TIMEOUT_MS,
  )

  console.log(`[worker] job ${job.id} | ${studentId}/${questionId} rev=${revision} timeout=${effectiveTimeout}ms`)

    // ── Step 1: Register with tracker (§15, §17) ────────────────────────────
    // This cancels any previous active job for this student/question.
    await tracker.register(studentId, questionId, job.id, revision)

    let tmpDir    = null
    let container = null
    let timedOut  = false
    let outputLimitExceeded = false

    // ── Per-job timing instrumentation ────────────────────────────────────────
    // Timestamps bracket each pipeline phase. null means the phase never ran
    // (distinguishable from a phase that completed in 0 ms).
    const t = {
      containerCreateStart:  null,  // just before docker.createContainer()
      containerReady:        null,  // just after container.start() returns
      analyzeStart:          null,  // when '=== PHASE:analyze ===' first appears in stdout
      streamEnd:             null,  // when the output stream closes
      resultParseStart:      null,  // just before parseAnalyzeOutput()
      resultParseEnd:        null,  // just after parseAnalyzeOutput()
    }

    try {
      // ── Early cancellation check ────────────────────────────────────────────
      // The API may have set cancelRequested=true on this job before the worker
      // picked it up (explicit cancel endpoint or replace-race).
      if (job.data.cancelRequested || tracker.isCancelled(job.id)) {
        return buildCancelledResult(revision, examEnvVersion)
      }

      // ── Step 2: Create per-job workspace directory ─────────────────────────────
      // Use a subdirectory of the named volume rather than os.tmpdir().
      // The named volume (exam-workspaces) is accessible to the Docker daemon
      // by name, so sandbox containers can mount it regardless of host paths.
      // Per-job isolation: each job gets its own job-{id}/ subdirectory.
      const jobDirName = `job-${job.id}`
      tmpDir = path.join(WORKSPACE_BASE, jobDirName)
      const jobContainerPath = `/exam-workspaces/${jobDirName}`
      fs.mkdirSync(tmpDir, { recursive: true })
      fs.chmodSync(tmpDir, 0o777)  // world-writable so sandbox user can create .dart_tool/

      // ── Step 3: Validate files (defense-in-depth) ─────────────────────────
      // The API already validated, but we re-validate inside the worker
      // as defense-in-depth before writing anything to disk.
      const validation = validateFiles(files)
      if (!validation.valid) {
        return {
          status:  'error',
          phase:   'validation',
          errors:  [{ severity: 'error', message: validation.reason, file: validation.field || 'input', line: 0, column: 0, code: 'invalid_input' }],
          warnings: [],
          stdout:  '',
          stderr:  validation.reason,
          exitCode: 1,
          revision,
          examEnvVersion,
        }
      }

      // ── Step 4: Write student files ────────────────────────────────────────
      writeProjectFiles(files, tmpDir)

      // ── Step 5: Write server-controlled project config files ─────────────────
      // Always overwrite any student-provided versions of these files.
      // pubspec.yaml: locks dependency versions and the approved package list.
      // analysis_options.yaml: activates flutter_lints and ensures consistent
      //   analysis rules across all exam submissions. Without this file,
      //   flutter_lints has no effect and flutter analyze may exit non-zero
      //   due to missing lint configuration, causing false-positive failures.
      const pubspecContent = generatePubspec('exam_project')
      fs.writeFileSync(path.join(tmpDir, 'pubspec.yaml'), pubspecContent, 'utf8')
      const analysisOptionsContent = generateAnalysisOptions()
      fs.writeFileSync(path.join(tmpDir, 'analysis_options.yaml'), analysisOptionsContent, 'utf8')


      // ── Step 6: Create Docker sandbox container ────────────────────────────
      const effectiveMemoryBytes = options.memoryMb ? options.memoryMb * 1024 * 1024 : SANDBOX_MEMORY_BYTES
      const effectiveNanoCpus    = options.nanoCpus !== undefined ? options.nanoCpus : SANDBOX_NANO_CPUS
      const isCpuUnrestricted    = effectiveNanoCpus === 0

      t.containerCreateStart = Date.now()
      container = await docker.createContainer({
        Image: SANDBOX_IMAGE,

        // The sandbox-run script: pub get --offline → flutter analyze
        Cmd: options.cmdOverride || ['/usr/local/bin/sandbox-run'],

        WorkingDir: jobContainerPath,
        User: 'sandbox',

        // Environment: point pub cache to pre-seeded read-only location.
        // HOME=/tmp: Docker mounts /home/sandbox tmpfs owned by root (mode 755),
        //   so the non-root sandbox user cannot write to it. /tmp is 1777.
        // CI=true: suppresses Flutter's "Welcome to Flutter!" first-run banner
        //   and analytics prompts. Flutter detects CI environments and skips them.
        Env: [
          'PUB_CACHE=/exam-pub-cache',
          'HOME=/tmp',
          'XDG_CONFIG_HOME=/tmp/config',
          'FLUTTER_CONFIG_DIR=/tmp/flutter-config',
          'CI=true',                   // suppresses welcome banner + analytics prompt
          `WORKSPACE=${jobContainerPath}`,
          'FLUTTER_SUPPRESS_ANALYTICS=true',
        ],

        AttachStdout: true,
        AttachStderr: true,
        OpenStdin:    false,

        HostConfig: {
          // ── Volume mounts ────────────────────────────────────────────────────
          // Mount the named Docker volume so the sandbox sees the job files
          // the worker wrote. A named volume is resolved by the Docker daemon
          // directly — no host path required, works for sibling containers.
          Binds: [`${WORKSPACE_VOLUME_NAME}:/exam-workspaces:rw`],

          // ── Writable tmpfs locations ───────────────────────────────────────
          // /tmp is mode 1777 (world-writable). HOME=/tmp so Flutter writes its
          // config here. noexec prevents running compiled binaries from tmpfs.
          // /home/sandbox is kept as a mount but HOME no longer points there.
          Tmpfs: {
            '/tmp':          `rw,nosuid,size=${options.tmpfsMb || SANDBOX_TMPFS_MB}m`,
            '/home/sandbox': `rw,noexec,nosuid,size=8m`,
          },

          // ── Resource limits ───────────────────────────────────────────────
          Memory:     effectiveMemoryBytes,
          MemorySwap: effectiveMemoryBytes,  // disable swap (swap = memory limit)
          ...(isCpuUnrestricted ? {} : { NanoCpus: effectiveNanoCpus }),
          PidsLimit: SANDBOX_PIDS,

          // ── Network isolation ─────────────────────────────────────────────
          NetworkMode: 'none',

          // ── Filesystem security ────────────────────────────────────────────────────
          // ReadonlyRootfs is intentionally NOT set.
          // Flutter writes to /usr/local/flutter/bin/cache/lockfile on every startup.
          // That path is inside the image layer. ReadonlyRootfs blocks this write,
          // crashing Flutter before pub get runs, regardless of user permissions.
          // The critical isolation comes from: NetworkMode:none, CapDrop:ALL,
          // non-root user (sandbox), memory/CPU/PID limits, and no-new-privileges.
          // ReadonlyRootfs can be re-enabled once we confirm a Flutter version that
          // supports $FLUTTER_CACHE_DIR to redirect its writable cache outside the SDK.

          // ── Linux capability drops ────────────────────────────────────────
          // Drop ALL capabilities; the sandbox only needs to run flutter.
          CapDrop: ['ALL'],

          // ── Security options ──────────────────────────────────────────────
          // no-new-privileges: prevent privilege escalation via setuid/setgid
          // seccomp=default:   Docker's default seccomp profile (syscall filter)
          SecurityOpt: [
            'no-new-privileges:true',
            // The default seccomp profile is applied automatically by Docker
            // unless explicitly overridden. We do NOT override it.
          ],

          // ── Prevent privileged mode ───────────────────────────────────────
          Privileged: false,

          // Auto-remove: always false — we manage cleanup explicitly in finally
          AutoRemove: false,
        },
      })

      // ── Step 7: Register cancel function with tracker ─────────────────────
      // The cancel function kills the container. setCancel() returns false if
      // this job was already superseded by another register() call.
      let cancelResolve = null
      const cancelPromise = new Promise((resolve) => { cancelResolve = resolve })

      const cancelFn = async (reason = 'cancelled') => {
        console.log(`[worker] cancelling job ${job.id} (${reason})`)
        try { await container.kill() } catch { /* already stopped */ }
        if (cancelResolve) cancelResolve()
      }

      const stillCurrent = tracker.setCancel(job.id, cancelFn, container.id, tmpDir)
      if (!stillCurrent) {
        // Superseded between register() and setCancel() — kill this container
        await forceRemoveContainer(container)
        container = null
        return buildCancelledResult(revision, examEnvVersion)
      }

      // ── Step 8: Start and stream output ───────────────────────────────────
      const stream = await container.attach({ stream: true, stdout: true, stderr: true })

      let stdoutBuf = ''
      let stderrBuf = ''

      const outputPromise = new Promise((resolve) => {
        docker.modem.demuxStream(
          stream,
          {
            write: (chunk) => {
              if (outputLimitExceeded) return
              stdoutBuf += chunk.toString()
              // Detect the pub-get → analyze boundary to timestamp when the
              // Dart analysis server actually starts (not just when the
              // container starts). This is the single most useful split point.
              if (t.analyzeStart === null && stdoutBuf.includes('=== PHASE:analyze ===')) {
                t.analyzeStart = Date.now()
              }
              if (Buffer.byteLength(stdoutBuf, 'utf8') > MAX_STDOUT_BYTES) {
                outputLimitExceeded = true
                console.warn(`[worker] job ${job.id}: stdout limit exceeded (${MAX_STDOUT_BYTES} bytes)`)
                container.kill().catch(() => {})
              }
            },
          },
          {
            write: (chunk) => {
              if (outputLimitExceeded) return
              stderrBuf += chunk.toString()
              if (Buffer.byteLength(stderrBuf, 'utf8') > MAX_STDERR_BYTES) {
                outputLimitExceeded = true
                console.warn(`[worker] job ${job.id}: stderr limit exceeded (${MAX_STDERR_BYTES} bytes)`)
                container.kill().catch(() => {})
              }
            },
          },
        )
        stream.on('end',   () => { t.streamEnd = Date.now(); resolve() })
        stream.on('error', () => { t.streamEnd = Date.now(); resolve() })
      })

      await container.start()
      t.containerReady = Date.now()


      // ── Step 9: Enforce timeout ────────────────────────────────────────────
      const timeoutHandle = setTimeout(async () => {
        timedOut = true
        console.warn(`[worker] job ${job.id} timed out after ${effectiveTimeout}ms`)
        try { await container.kill() } catch { /* already stopped */ }
      }, effectiveTimeout)

      // Also watch for external cancellation (cancelRequested flag)
      const cancelCheckInterval = setInterval(async () => {
        try {
          const fresh = await execQueue.getJob(job.id)
          if (fresh?.data?.cancelRequested || tracker.isCancelled(job.id)) {
            clearInterval(cancelCheckInterval)
            await cancelFn('external_cancel')
          }
        } catch { /* ignore */ }
      }, 2000)

      // Race: output done vs cancel signal
      await Promise.race([outputPromise, cancelPromise])
      clearTimeout(timeoutHandle)
      clearInterval(cancelCheckInterval)

      // Inspect container for exit code & OOM status
      let exitCode = 1
      let oomKilled = false
      try {
        const inspect = await container.inspect()
        exitCode = inspect.State.ExitCode
        oomKilled = Boolean(inspect.State.OOMKilled)
      } catch { /* container may have been removed */ }

      // ── Step 10: Handle cancellation ──────────────────────────────────────
      if (tracker.isCancelled(job.id)) {
        return buildCancelledResult(revision, examEnvVersion)
      }

      // ── Step 11: Handle output limit ──────────────────────────────────────
      if (outputLimitExceeded) {
        return {
          status:   'error',
          phase:    'output_limit',
          errors:   [{ severity: 'error', message: `Compiler output exceeded limit (${MAX_STDOUT_BYTES} bytes). This may indicate an infinite loop or runaway process.`, file: '', line: 0, column: 0, code: 'output_limit_exceeded' }],
          warnings: [],
          stdout:   truncateOutput(stdoutBuf, MAX_STDOUT_BYTES),
          stderr:   truncateOutput(stderrBuf, MAX_STDERR_BYTES),
          exitCode,
          revision,
          examEnvVersion,
          timing:   buildTiming(t),  // resultParseStart/End null → resultParseMs: 0
        }
      }

      // ── Step 12: Handle timeout ────────────────────────────────────────────
      if (timedOut) {
        return {
          status:   'error',
          phase:    'timeout',
          errors:   [{ severity: 'error', message: `Validation timed out after ${effectiveTimeout}ms.`, file: '', line: 0, column: 0, code: 'timeout' }],
          warnings: [],
          stdout:   truncateOutput(stdoutBuf, MAX_STDOUT_BYTES),
          stderr:   truncateOutput(stderrBuf, MAX_STDERR_BYTES),
          exitCode,
          revision,
          examEnvVersion,
          timing:   buildTiming(t),
        }
      }

      // ── Step 13: Parse and return structured result ────────────────────────
      const combined = stdoutBuf + '\n' + stderrBuf

      // Detect pubget failure (exit code 2 from run.sh)
      const failedPhase = detectFailedPhase(combined)
      if (failedPhase === 'pubget' || exitCode === 2) {
        // Extract pub get output for debugging
        const pubgetOutput = combined.split('=== PHASE:analyze ===')[0] || combined
        return {
          status:   'error',
          phase:    'dependency',
          errors:   [{
            severity: 'error',
            message:  'Dependency resolution failed. The project may reference packages not in the exam allowlist, or the sandbox image needs to be rebuilt.',
            file:     'pubspec.yaml',
            line:     0,
            column:   0,
            code:     'dependency_error',
          }],
          warnings: [],
          stdout:   truncateOutput(pubgetOutput, MAX_STDOUT_BYTES),
          stderr:   '',
          exitCode,
          revision,
          examEnvVersion,
          timing:   buildTiming(t),
        }
      }

      // Parse analyzer output — bracketed with timestamps
      t.resultParseStart = Date.now()
      const { errors, warnings, infos } = parseAnalyzeOutput(combined, tmpDir)
      t.resultParseEnd = Date.now()
      const timingInfo = buildTiming(t)

      // Log timing breakdown to worker console for every job
      console.log(
        `[worker] job ${job.id} timing: ` +
        `container=${timingInfo.containerStartMs}ms ` +
        `pubget=${timingInfo.dependencyResolutionMs !== null ? timingInfo.dependencyResolutionMs + 'ms' : 'n/a'} ` +
        `analyze=${timingInfo.analyzeMs !== null ? timingInfo.analyzeMs + 'ms' : 'n/a'} ` +
        `parse=${timingInfo.resultParseMs}ms ` +
        `total=${timingInfo.totalExecutionMs}ms`
      )
      if (timingInfo._unaccountedMs !== null && Math.abs(timingInfo._unaccountedMs) > 500) {
        console.warn(`[worker] job ${job.id}: ${timingInfo._unaccountedMs}ms unaccounted in timing breakdown`)
      }

      if (errors.length > 0) {
        return {
          status:   'error',
          phase:    'analyze',
          errors,
          warnings,
          infos,
          stdout:   truncateOutput(stdoutBuf, MAX_STDOUT_BYTES),
          stderr:   truncateOutput(stderrBuf, MAX_STDERR_BYTES),
          exitCode,
          oomKilled,
          revision,
          examEnvVersion,
          timing:   timingInfo,
        }
      }

      // ── Safety net: flutter analyze exited non-zero but parser found no errors ──
      // This means either:
      //   (a) The output format changed and the regex doesn't match, OR
      //   (b) The analysis server crashed mid-run (SIGKILL from OOM/PID limit)
      // In both cases, returning "success" would be wrong — broken code would
      // silently pass. Log the raw stdout so we can fix the parser.
      if (exitCode !== 0) {
        const analyzeSection = stdoutBuf.includes('=== PHASE:analyze ===')
          ? stdoutBuf.split('=== PHASE:analyze ===')[1] || stdoutBuf
          : stdoutBuf
        console.warn(
          `[worker] job ${job.id}: flutter analyze exited ${exitCode} but parser found 0 errors.`,
          `\n--- raw analyze stdout (first 2000 chars) ---\n`,
          analyzeSection.slice(0, 2000),
          `\n--- end ---`,
        )
        return {
          status:   'error',
          phase:    'analyze',
          errors:   [{
            severity: 'error',
            message:  'flutter analyze reported errors but they could not be parsed. Check compiler-worker logs for raw output.',
            file:     '',
            line:     0,
            column:   0,
            code:     'parse_error',
          }],
          warnings: [],
          stdout:   truncateOutput(stdoutBuf, MAX_STDOUT_BYTES),
          stderr:   truncateOutput(stderrBuf, MAX_STDERR_BYTES),
          exitCode,
          oomKilled,
          revision,
          examEnvVersion,
          timing:   timingInfo,
        }
      }

      // Analyze succeeded (warnings are non-blocking)
      return {
        status:   'success',
        phase:    'analyze',
        errors:   [],
        warnings,
        infos,
        stdout:   truncateOutput(stdoutBuf, MAX_STDOUT_BYTES),
        stderr:   truncateOutput(stderrBuf, MAX_STDERR_BYTES),
        exitCode: 0,
        oomKilled: false,
        revision,
        examEnvVersion,
        // NOTE: RUN does not run flutter build web (§2).
        // A project can be analyze-clean but fail to build.
        // Build validation belongs at submit-time evaluation.
        analyzeOnly: true,
        timing:   timingInfo,  // ← was missing: caused "(no timing data)" for success jobs
      }

    } finally {
      // ── Always clean up (§34) ─────────────────────────────────────────────
      // This runs on success, error, timeout, cancellation, or unexpected exception.
      // No leaked containers. No leaked temporary directories.
      await forceRemoveContainer(container)
      cleanupTmpDir(tmpDir)
      tracker.unregister(job.id, studentId, questionId)

      console.log(`[worker] job ${job.id} cleaned up (container=${container?.id?.slice(0, 12) || 'none'})`)
    }
}

// ── Worker Instance ───────────────────────────────────────────────────────────
const worker = new Worker(
  'exec',
  async (job) => executeJob(job),
  {
    connection: redisConnection,
    concurrency: EXEC_CONCURRENCY,
  },
)

// ── Helper: cancelled result ──────────────────────────────────────────────────
function buildCancelledResult(revision, examEnvVersion) {
  return {
    status:   'cancelled',
    phase:    null,
    errors:   [],
    warnings: [],
    stdout:   '',
    stderr:   '',
    exitCode: null,
    revision,
    examEnvVersion,
  }
}

// ── Helper: build timing block from raw timestamps ────────────────────────────
//
// IMPORTANT — stdout-marker limitation:
//   Docker buffers container stdout and delivers it all at once when the
//   container process exits (no TTY, non-interactive). This means the
//   "=== PHASE:analyze ===" marker that sandbox-run emits arrives in the
//   same final chunk as all of flutter analyze's output, at the same moment
//   as t.streamEnd. As a result:
//     - analyzeMs ≈ 0  (marker and stream-end are nearly simultaneous)
//     - dependencyResolutionMs ≈ totalContainerMs  (captures ALL in-container time)
//   These values are NOT reliable splits of pub-get vs analyze time.
//
//   The ONLY reliable metric for in-container wall-clock time is:
//     totalContainerMs = streamEnd - containerReady
//   Use this for the CPU-limit experiment.
//
// Fields:
//   containerStartMs       = containerReady - containerCreateStart
//                            (docker create + start latency)
//   totalContainerMs       = streamEnd - containerReady
//                            (entire container execution time: pub-get + analyze)
//                            Reliable regardless of output buffering.
//   dependencyResolutionMs = analyzeStart - containerReady
//                            (UNRELIABLE when Docker buffers stdout —
//                             likely equals totalContainerMs ≈ 0ms before end)
//   analyzeMs              = streamEnd - analyzeStart
//                            (UNRELIABLE — ≈ 0ms when Docker buffers stdout)
//   resultParseMs          = resultParseEnd - resultParseStart
//   totalExecutionMs       = resultParseEnd - containerCreateStart
//                            (containerStartMs + totalContainerMs + resultParseMs)
function buildTiming(t) {
  const containerStartMs = (t.containerCreateStart !== null && t.containerReady !== null)
    ? t.containerReady - t.containerCreateStart
    : null

  // totalContainerMs: the one reliable in-container time metric.
  // Measures from when container.start() returned to when the output stream closed.
  const totalContainerMs = (t.containerReady !== null && t.streamEnd !== null)
    ? t.streamEnd - t.containerReady
    : null

  // dependencyResolutionMs + analyzeMs: UNRELIABLE when Docker buffers stdout.
  // Kept for completeness; log a warning if analyzeMs ≈ 0 and total > 1s.
  const dependencyResolutionMs = (t.containerReady !== null && t.analyzeStart !== null)
    ? t.analyzeStart - t.containerReady
    : null

  const analyzeMs = (t.analyzeStart !== null && t.streamEnd !== null)
    ? t.streamEnd - t.analyzeStart
    : null

  const resultParseMs = (t.resultParseStart !== null && t.resultParseEnd !== null)
    ? t.resultParseEnd - t.resultParseStart
    : 0

  const totalExecutionMs = (t.containerCreateStart !== null && t.resultParseEnd !== null)
    ? t.resultParseEnd - t.containerCreateStart
    : null

  // Warn if analyzeMs looks like a Docker-buffering artifact
  const _analyzesMayBeBuffered = (
    analyzeMs !== null && analyzeMs < 500 &&
    totalContainerMs !== null && totalContainerMs > 2000
  )

  let _unaccountedMs = null
  if (totalExecutionMs !== null && containerStartMs !== null && totalContainerMs !== null) {
    _unaccountedMs = totalExecutionMs - containerStartMs - totalContainerMs - resultParseMs
  }

  return {
    containerStartMs,
    totalContainerMs,         // ← use this for CPU-limit experiment
    dependencyResolutionMs,   // unreliable when Docker buffers stdout
    analyzeMs,                // unreliable when Docker buffers stdout
    resultParseMs,
    totalExecutionMs,
    _unaccountedMs,
    _analyzesMayBeBuffered,   // diagnostic flag
  }
}

// ── Worker events ─────────────────────────────────────────────────────────────
worker.on('completed', (job, result) => {
  const status = result?.status ?? 'unknown'
  const phase  = result?.phase  ?? '-'
  console.log(`[worker] job ${job.id} completed — status=${status} phase=${phase}`)
})

worker.on('failed', (job, err) => {
  console.error(`[worker] job ${job?.id} failed:`, err.message)
})

worker.on('error', (err) => {
  console.error('[worker] queue error:', err.message)
})

// ── Startup ───────────────────────────────────────────────────────────────────
const execQueue = new Queue('exec', { connection: redisConnection })

// Ensure the workspace base dir exists inside this container.
// The named volume is mounted here by docker-compose; this is a safety net
// in case the volume mount isn't configured (e.g. running outside compose).
fs.mkdirSync(WORKSPACE_BASE, { recursive: true })

console.log(`[compiler-worker] started`)
console.log(`[compiler-worker] concurrency: ${EXEC_CONCURRENCY}`)
console.log(`[compiler-worker] sandbox image: ${SANDBOX_IMAGE}`)
console.log(`[compiler-worker] memory limit: ${SANDBOX_MEMORY_BYTES / 1024 / 1024} MB`)
console.log(`[compiler-worker] cpu limit: ${CPU_LIMIT_UNRESTRICTED ? 'unrestricted' : `${SANDBOX_NANO_CPUS / 1e9} CPU`}${_cpuOverride !== undefined ? ' [EXPERIMENT OVERRIDE]' : ''}`)
console.log(`[compiler-worker] max timeout: ${MAX_TIMEOUT_MS}ms`)

module.exports = {
  executeJob,
  buildTiming,
  forceRemoveContainer,
  cleanupTmpDir,
  writeProjectFiles,
  docker,
}
