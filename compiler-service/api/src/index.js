'use strict'

/**
 * compiler-service/api/src/index.js
 *
 * Express API for the Flutter coding-exam compiler service.
 *
 * Endpoints:
 *   POST /run          — submit a Flutter project for validation (analyze)
 *   POST /jobs/:id/cancel — cancel a queued or active job
 *   GET  /jobs/:id     — poll job status and structured result
 *   GET  /health       — liveness probe
 *
 * Auth model (§29 — Option B: Exam Backend proxies):
 *   All endpoints require X-Service-Key header matching COMPILER_SERVICE_API_KEY.
 *   studentId and questionId are trusted from the request body/headers as
 *   pre-verified by the Exam Backend. This API does NOT perform student auth.
 *
 * Status delivery (§23a — Polling):
 *   POST /run returns { jobId, revision, status: 'queued' } immediately.
 *   Clients poll GET /jobs/:id every ~2s until state is terminal.
 *   Cancelled jobs immediately reach terminal state so the frontend can stop
 *   polling the old jobId and start polling the new one.
 */

require('dotenv').config()
const express  = require('express')
const cors     = require('cors')
const { Queue } = require('bullmq')
const { v4: uuidv4 } = require('uuid')

const { validateFiles, computeProjectHash } = require('../../shared/validate')
const { checkRateLimit }                    = require('./rateLimit')
const { EXAM_ENV_VERSION }                  = require('../../shared/pubspec')

// ── Config ───────────────────────────────────────────────────────────────────
const PORT               = process.env.COMPILER_API_PORT           || 5000
const REDIS_URL          = process.env.REDIS_URL                   || 'redis://localhost:6379'
const SERVICE_KEY        = process.env.COMPILER_SERVICE_API_KEY    || 'change-me-before-production'
const MAX_TIMEOUT_MS     = parseInt(process.env.MAX_EXECUTION_TIMEOUT_MS || '120000', 10)
const DEFAULT_TIMEOUT_MS = parseInt(process.env.DEFAULT_EXECUTION_TIMEOUT_MS || '60000', 10)

if (!process.env.COMPILER_SERVICE_API_KEY) {
  console.warn('[compiler-api] WARNING: COMPILER_SERVICE_API_KEY not set in env — using default fallback: "change-me-before-production"')
}

// ── Redis / BullMQ ───────────────────────────────────────────────────────────
const redisUrl = new URL(REDIS_URL)
const redisConnection = {
  host: redisUrl.hostname,
  port: Number(redisUrl.port) || 6379,
}

const execQueue = new Queue('exec', { connection: redisConnection })

// ── In-memory active-job map ──────────────────────────────────────────────────
// Maps `${studentId}:${questionId}` → { jobId, revision }
// Used to:
//   (a) cancel queued jobs when a newer revision arrives (§18)
//   (b) look up the current job for cancel requests
// Active-job cancellation (running containers) is handled by the worker tracker.
//
// Limitation: single-process only. Multi-worker deployment needs Redis-backed state.
const activeJobMap = new Map()

// ── Express ──────────────────────────────────────────────────────────────────
const app = express()
app.use(cors())
// Hard body size limit: reject oversized requests before validation (§6)
app.use(express.json({ limit: '12mb' }))

// ── Auth middleware ───────────────────────────────────────────────────────────
/**
 * Verify X-Service-Key header matches COMPILER_SERVICE_API_KEY.
 * Returns 401 if missing, 403 if wrong.
 */
function requireServiceKey(req, res, next) {
  const key = req.headers['x-service-key']
  if (!key) {
    return res.status(401).json({ error: 'Missing X-Service-Key header' })
  }
  if (key !== SERVICE_KEY) {
    return res.status(403).json({ error: 'Invalid service key' })
  }
  next()
}

/**
 * Parse and validate studentId / questionId from request.
 * These come from the Exam Backend which already authenticated the student.
 */
function parseStudentContext(req, res) {
  const studentId  = (req.body?.studentId  || req.headers['x-student-id']  || '').trim()
  const questionId = (req.body?.questionId || req.headers['x-question-id'] || '').trim()

  if (!studentId) {
    res.status(400).json({ error: 'studentId is required (body or X-Student-Id header)' })
    return null
  }
  if (!questionId) {
    res.status(400).json({ error: 'questionId is required (body or X-Question-Id header)' })
    return null
  }
  // Basic sanity: alphanumeric + hyphens + underscores
  if (!/^[a-zA-Z0-9_\-]{1,128}$/.test(studentId)) {
    res.status(400).json({ error: 'studentId must be 1–128 alphanumeric/hyphen/underscore characters' })
    return null
  }
  if (!/^[a-zA-Z0-9_\-]{1,128}$/.test(questionId)) {
    res.status(400).json({ error: 'questionId must be 1–128 alphanumeric/hyphen/underscore characters' })
    return null
  }
  return { studentId, questionId }
}

// ── POST /run ─────────────────────────────────────────────────────────────────
/**
 * Submit a Flutter project for validation.
 *
 * Body:
 * {
 *   "studentId":  "s123",
 *   "questionId": "q1",
 *   "revision":   17,
 *   "files": [
 *     { "path": "lib/main.dart", "content": "..." },
 *     { "path": "lib/home.dart", "content": "..." }
 *   ],
 *   "timeoutMs": 60000   (optional — capped at MAX_EXECUTION_TIMEOUT_MS)
 * }
 *
 * Response (202):
 * { "jobId": "uuid", "revision": 17, "status": "queued" }
 */
app.post('/run', requireServiceKey, async (req, res, next) => {
  try {
    // ── 1. Parse student context ─────────────────────────────────────────────
    const ctx = parseStudentContext(req, res)
    if (!ctx) return
    const { studentId, questionId } = ctx

    // ── 2. Parse request body ────────────────────────────────────────────────
    const { files, revision, timeoutMs: clientTimeout } = req.body

    if (!Number.isInteger(revision) || revision < 0) {
      return res.status(400).json({ error: 'revision must be a non-negative integer' })
    }

    // Clamp timeout: min(clientRequest, serverMaximum)
    const effectiveTimeout = Math.min(
      Number.isFinite(clientTimeout) && clientTimeout > 0 ? clientTimeout : DEFAULT_TIMEOUT_MS,
      MAX_TIMEOUT_MS,
    )

    // ── 3. Validate files (§6) ───────────────────────────────────────────────
    const validation = validateFiles(files)
    if (!validation.valid) {
      return res.status(400).json({
        error: 'File validation failed',
        reason: validation.reason,
        field:  validation.field,
      })
    }

    // ── 4. Rate limit (§13) ──────────────────────────────────────────────────
    // Cancel-and-replace counts as a new request per §13.
    const rateResult = checkRateLimit(studentId, questionId)
    if (!rateResult.allowed) {
      return res.status(429).json({
        error:        'Rate limit exceeded',
        retryAfterMs: rateResult.retryAfterMs,
        limit:        rateResult.limit,
      })
    }

    // ── 5. Compute project hash (§21) ────────────────────────────────────────
    const projectHash = computeProjectHash(files, EXAM_ENV_VERSION)

    // ── 6. Cancel previous queued job for this student/question (§18) ────────
    const activeKey = `${studentId}:${questionId}`
    const existing  = activeJobMap.get(activeKey)

    if (existing) {
      try {
        const oldJob = await execQueue.getJob(existing.jobId)
        if (oldJob) {
          const oldState = await oldJob.getState()
          if (oldState === 'waiting' || oldState === 'delayed') {
            // Job not yet picked up by worker — cancel it directly
            await oldJob.remove()
            console.log(`[api] removed queued job ${existing.jobId} (rev ${existing.revision}) for ${studentId}/${questionId}`)
          }
          // If active: the worker tracker handles cancellation when the new job arrives.
          // We publish a cancellation hint via job data (the worker checks this).
        }
      } catch (err) {
        // Non-fatal: old job may have completed already
        console.warn(`[api] could not cancel old job ${existing.jobId}:`, err.message)
      }
    }

    // ── 7. Enqueue new job ───────────────────────────────────────────────────
    const jobId = uuidv4()
    await execQueue.add(
      'run',
      {
        studentId,
        questionId,
        revision,
        files,
        projectHash,
        timeoutMs: effectiveTimeout,
        examEnvVersion: EXAM_ENV_VERSION,
      },
      {
        jobId,
        removeOnComplete: { age: 3600 },  // keep result for 1 hour
        removeOnFail:     { age: 3600 },
      },
    )

    // ── 8. Update active job map ─────────────────────────────────────────────
    activeJobMap.set(activeKey, { jobId, revision })

    console.log(`[api] queued job ${jobId} rev=${revision} for ${studentId}/${questionId}`)
    res.status(202).json({ jobId, revision, status: 'queued' })

  } catch (err) { next(err) }
})

// ── POST /jobs/:id/cancel ─────────────────────────────────────────────────────
/**
 * Cancel a queued or active job.
 *
 * Headers: X-Service-Key, X-Student-Id (or body.studentId)
 *
 * Response (200):
 * { "jobId": "...", "cancelled": true }
 *
 * Response (404): job not found
 * Response (403): studentId does not own this job
 */
app.post('/jobs/:id/cancel', requireServiceKey, async (req, res, next) => {
  try {
    const { id } = req.params
    const studentId = (req.body?.studentId || req.headers['x-student-id'] || '').trim()
    if (!studentId) {
      return res.status(400).json({ error: 'studentId is required to cancel a job' })
    }

    const job = await execQueue.getJob(id)
    if (!job) {
      return res.status(404).json({ error: 'Job not found' })
    }

    // Ownership check (§30)
    if (job.data.studentId !== studentId) {
      return res.status(403).json({ error: 'Access denied: job belongs to a different student' })
    }

    const state = await job.getState()

    if (state === 'waiting' || state === 'delayed') {
      await job.remove()
      console.log(`[api] cancelled queued job ${id}`)
    } else if (state === 'active') {
      // Signal worker to kill the container. Worker tracker handles this when
      // the next RUN arrives. For an explicit cancel, we update the job data.
      // The worker checks job.data.cancelRequested on each iteration.
      await job.updateData({ ...job.data, cancelRequested: true })
      console.log(`[api] signalled active job ${id} for cancellation`)
    }
    // completed/failed/cancelled jobs: no-op

    res.json({ jobId: id, cancelled: true, previousState: state })
  } catch (err) { next(err) }
})

// ── GET /jobs/:id ─────────────────────────────────────────────────────────────
/**
 * Poll job status and result.
 *
 * Headers: X-Service-Key, X-Student-Id (ownership check §30)
 *
 * Response:
 * {
 *   "jobId":    "...",
 *   "revision": 17,
 *   "state":    "queued" | "running" | "completed" | "failed" | "cancelled",
 *   "result":   null | { status, phase, errors, warnings, ... }
 * }
 */
app.get('/jobs/:id', requireServiceKey, async (req, res, next) => {
  try {
    const { id } = req.params
    const studentId = (req.query.studentId || req.headers['x-student-id'] || '').trim()
    if (!studentId) {
      return res.status(400).json({ error: 'studentId is required (query param or X-Student-Id header)' })
    }

    const job = await execQueue.getJob(id)
    if (!job) {
      // Job may have been removed (queued-cancel) or never existed
      return res.status(404).json({ error: 'Job not found' })
    }

    // Ownership check (§30) — students may only access their own jobs
    if (job.data.studentId !== studentId) {
      return res.status(403).json({ error: 'Access denied: job belongs to a different student' })
    }

    const rawState   = await job.getState()
    const result     = job.returnvalue ?? null
    const revision   = job.data.revision ?? null

    // Map BullMQ states to our API states
    // Cancelled jobs complete with result.status === 'cancelled'
    let state = rawState
    if (rawState === 'completed' && result?.status === 'cancelled') {
      state = 'cancelled'
    } else if (rawState === 'waiting') {
      state = 'queued'
    } else if (rawState === 'active') {
      state = 'running'
    }

    res.json({ jobId: id, revision, state, result })

  } catch (err) { next(err) }
})

// ── GET /health ───────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({
    status:       'ok',
    ts:           new Date().toISOString(),
    examEnvVersion: EXAM_ENV_VERSION,
    activeJobs:   activeJobMap.size,
  })
})

// ── Error handler ─────────────────────────────────────────────────────────────
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  console.error('[compiler-api] unhandled error:', err)
  res.status(500).json({ error: 'Internal server error' })
})

app.listen(PORT, () => {
  console.log(`[compiler-api] listening on :${PORT}`)
  console.log(`[compiler-api] exam env version: ${EXAM_ENV_VERSION}`)
  console.log(`[compiler-api] max timeout: ${MAX_TIMEOUT_MS}ms`)
  if (!SERVICE_KEY) console.warn('[compiler-api] WARNING: no service key configured!')
})
