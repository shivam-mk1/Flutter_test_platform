'use strict'

/**
 * tests/integration/run-api.test.js
 *
 * Integration tests for the compiler API.
 * Requires a running API server and Redis (NOT a running Flutter sandbox).
 *
 * These tests verify API-layer behaviour:
 *   - Request validation, auth, rate limiting, error shapes
 *   - They do NOT verify that Flutter compilation actually works
 *     (that requires the full stack with the sandbox image)
 *
 * Prerequisites:
 *   npm run start:api           (in a separate terminal)
 *   # OR: docker compose up compiler-api redis -d
 *
 * Run:
 *   node --test tests/integration/run-api.test.js
 *   COMPILER_API_URL=http://localhost:5000 node --test tests/integration/run-api.test.js
 *
 * Environment:
 *   COMPILER_API_URL          default http://localhost:5000
 *   COMPILER_SERVICE_API_KEY  default changeme (must match API server config)
 */

require('dotenv').config()
const { test, describe, before } = require('node:test')
const assert = require('node:assert/strict')

const BASE_URL   = (process.env.COMPILER_API_URL || 'http://localhost:5000').replace(/\/$/, '')
const SERVICE_KEY = process.env.COMPILER_SERVICE_API_KEY || 'change-me-before-production'

// ── Helpers ───────────────────────────────────────────────────────────────────

async function apiPost(path, body, headers = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method:  'POST',
    headers: {
      'Content-Type':  'application/json',
      'X-Service-Key': SERVICE_KEY,
      ...headers,
    },
    body: JSON.stringify(body),
  })
  const data = await res.json().catch(() => null)
  return { status: res.status, data }
}

async function apiGet(path, headers = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: {
      'X-Service-Key': SERVICE_KEY,
      ...headers,
    },
  })
  const data = await res.json().catch(() => null)
  return { status: res.status, data }
}

const VALID_RUN_BODY = {
  studentId:  'student-test-1',
  questionId: 'q-test-1',
  revision:   1,
  files: [
    {
      path:    'lib/main.dart',
      content: `import 'package:flutter/material.dart';
void main() => runApp(const MaterialApp(home: Scaffold(body: Text('Hello'))));`,
    },
  ],
  timeoutMs: 60000,
}

// ── Verify server is reachable ─────────────────────────────────────────────────
before(async () => {
  try {
    const res = await fetch(`${BASE_URL}/health`)
    assert.ok(res.ok, `API health check failed: HTTP ${res.status}`)
  } catch (err) {
    throw new Error(`API server not reachable at ${BASE_URL}: ${err.message}\nRun: npm run start:api`)
  }
})

// ── Auth ───────────────────────────────────────────────────────────────────────

describe('Auth (§29)', () => {
  test('POST /run without X-Service-Key returns 401', async () => {
    const res = await fetch(`${BASE_URL}/run`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(VALID_RUN_BODY),
    })
    assert.equal(res.status, 401)
  })

  test('POST /run with wrong X-Service-Key returns 403', async () => {
    const { status } = await apiPost('/run', VALID_RUN_BODY, { 'X-Service-Key': 'wrong-key' })
    assert.equal(status, 403)
  })

  test('GET /jobs/:id without X-Service-Key returns 401', async () => {
    const res = await fetch(`${BASE_URL}/jobs/does-not-exist`)
    assert.equal(res.status, 401)
  })
})

// ── /health ────────────────────────────────────────────────────────────────────

describe('GET /health', () => {
  test('returns 200 with status ok', async () => {
    const res  = await fetch(`${BASE_URL}/health`)
    const data = await res.json()
    assert.equal(res.status, 200)
    assert.equal(data.status, 'ok')
    assert.ok(data.ts)
  })
})

// ── POST /run — validation ─────────────────────────────────────────────────────

describe('POST /run — request validation (§6)', () => {
  test('valid request returns 202 with jobId and revision', async () => {
    const { status, data } = await apiPost('/run', VALID_RUN_BODY)
    assert.equal(status, 202)
    assert.ok(typeof data.jobId === 'string' && data.jobId.length > 0, 'missing jobId')
    assert.equal(data.revision, VALID_RUN_BODY.revision)
    assert.equal(data.status, 'queued')
  })

  test('missing studentId returns 400', async () => {
    const { studentId: _, ...body } = VALID_RUN_BODY
    const { status, data } = await apiPost('/run', body)
    assert.equal(status, 400)
    assert.match(data.error, /studentId/)
  })

  test('missing questionId returns 400', async () => {
    const { questionId: _, ...body } = VALID_RUN_BODY
    const { status, data } = await apiPost('/run', body)
    assert.equal(status, 400)
    assert.match(data.error, /questionId/)
  })

  test('non-integer revision returns 400', async () => {
    const { status } = await apiPost('/run', { ...VALID_RUN_BODY, revision: 'not-a-number' })
    assert.equal(status, 400)
  })

  test('missing files returns 400', async () => {
    const { files: _, ...body } = VALID_RUN_BODY
    const { status, data } = await apiPost('/run', body)
    assert.equal(status, 400)
    assert.ok(data.error || data.reason)
  })

  test('empty files array returns 400', async () => {
    const { status, data } = await apiPost('/run', { ...VALID_RUN_BODY, files: [] })
    assert.equal(status, 400)
    assert.match(data.reason || data.error, /empty/)
  })
})

// ── POST /run — path traversal ────────────────────────────────────────────────

describe('POST /run — path traversal rejection (§6)', () => {
  test('../../etc/passwd path returns 400', async () => {
    const { status, data } = await apiPost('/run', {
      ...VALID_RUN_BODY,
      files: [{ path: '../../etc/passwd', content: 'evil' }],
    })
    assert.equal(status, 400)
    assert.match(data.reason || data.error, /traversal|absolute|allowed directory/i)
  })

  test('/etc/passwd absolute path returns 400', async () => {
    const { status } = await apiPost('/run', {
      ...VALID_RUN_BODY,
      files: [{ path: '/etc/passwd', content: 'evil' }],
    })
    assert.equal(status, 400)
  })

  test('android/ path returns 400', async () => {
    const { status } = await apiPost('/run', {
      ...VALID_RUN_BODY,
      files: [{ path: 'android/build.gradle', content: 'evil' }],
    })
    assert.equal(status, 400)
  })
})

// ── POST /run — oversized requests ───────────────────────────────────────────

describe('POST /run — size limits (§6)', () => {
  test('single oversized file (>512KB) returns 400', async () => {
    const { status, data } = await apiPost('/run', {
      ...VALID_RUN_BODY,
      files: [{ path: 'lib/big.dart', content: 'x'.repeat(600 * 1024) }],
    })
    assert.equal(status, 400)
    assert.match(data.reason || data.error, /too large|size/i)
  })

  test('too many files (>50) returns 400', async () => {
    const files = Array.from({ length: 55 }, (_, i) => ({
      path:    `lib/file${i}.dart`,
      content: 'void main() {}',
    }))
    const { status } = await apiPost('/run', { ...VALID_RUN_BODY, files })
    assert.equal(status, 400)
  })
})

// ── POST /run — timeout capping ───────────────────────────────────────────────

describe('POST /run — timeout capping (§12)', () => {
  test('client-requested 10-minute timeout is accepted (capped server-side)', async () => {
    // The API should accept the request but cap the timeout internally.
    // The response is 202 regardless of what the capped timeout is.
    const { status, data } = await apiPost('/run', {
      ...VALID_RUN_BODY,
      revision:  99,
      timeoutMs: 10 * 60 * 1000, // 10 minutes
    })
    assert.equal(status, 202)
    assert.ok(data.jobId)
  })
})

// ── GET /jobs/:id — ownership check ──────────────────────────────────────────

describe('GET /jobs/:id — ownership (§30)', () => {
  test('correct studentId can access their job', async () => {
    // First create a job
    const { data: created } = await apiPost('/run', {
      ...VALID_RUN_BODY,
      studentId: 'ownership-test-student',
      revision:  100,
    })
    assert.ok(created.jobId)

    // Poll with correct studentId
    const { status } = await apiGet(
      `/jobs/${created.jobId}?studentId=ownership-test-student`,
    )
    assert.notEqual(status, 403)
  })

  test('wrong studentId cannot access another student job', async () => {
    const { data: created } = await apiPost('/run', {
      ...VALID_RUN_BODY,
      studentId: 'real-student',
      revision:  200,
    })
    assert.ok(created.jobId)

    const { status } = await apiGet(
      `/jobs/${created.jobId}?studentId=malicious-student`,
    )
    assert.equal(status, 403)
  })

  test('non-existent job returns 404', async () => {
    const { status } = await apiGet('/jobs/non-existent-job-id?studentId=anyone')
    assert.equal(status, 404)
  })
})

// ── Revision in response ──────────────────────────────────────────────────────

describe('Revision (§16)', () => {
  test('queued job response includes correct revision', async () => {
    const { data: created } = await apiPost('/run', {
      ...VALID_RUN_BODY,
      studentId:  'revision-test',
      questionId: 'rev-q',
      revision:   42,
    })
    assert.equal(created.revision, 42)

    const { data: polled } = await apiGet(
      `/jobs/${created.jobId}?studentId=revision-test`,
    )
    assert.equal(polled.revision, 42)
  })
})
