'use strict'

/**
 * api/src/rateLimit.js
 *
 * Per-(studentId, questionId) sliding-window rate limiter.
 *
 * Behaviour per §13:
 *   - Maximum N RUN requests per student per question per minute
 *   - Cancel-and-replace (§17) COUNTS as a new request against this limit
 *   - In-memory implementation — acceptable for single-process API
 *   - Resets on process restart (acceptable for MVP; use Redis for production)
 *
 * Config:
 *   MAX_RUN_REQUESTS_PER_MINUTE  default 10
 */

const MAX_REQUESTS = parseInt(process.env.MAX_RUN_REQUESTS_PER_MINUTE || '10', 10)
const WINDOW_MS    = 60_000

// Map<key, number[]>  key = `${studentId}:${questionId}`, value = array of timestamps
const _windows = new Map()

/**
 * Check whether a new RUN is allowed for this student/question.
 * Side-effect: records the current timestamp if allowed.
 *
 * @param {string} studentId
 * @param {string} questionId
 * @returns {{ allowed: boolean, retryAfterMs?: number, current: number, limit: number }}
 */
function checkRateLimit(studentId, questionId) {
  const key  = `${studentId}:${questionId}`
  const now  = Date.now()
  const cutoff = now - WINDOW_MS

  let timestamps = (_windows.get(key) || []).filter((t) => t > cutoff)

  if (timestamps.length >= MAX_REQUESTS) {
    const oldest = timestamps[0]
    const retryAfterMs = Math.max(0, oldest + WINDOW_MS - now)
    // Do NOT record — the request is rejected
    _windows.set(key, timestamps)
    return { allowed: false, retryAfterMs, current: timestamps.length, limit: MAX_REQUESTS }
  }

  timestamps.push(now)
  _windows.set(key, timestamps)

  // Periodic cleanup: remove expired entries (~1% of requests)
  if (Math.random() < 0.01) {
    for (const [k, ts] of _windows.entries()) {
      if (ts.every((t) => t <= cutoff)) _windows.delete(k)
    }
  }

  return { allowed: true, current: timestamps.length, limit: MAX_REQUESTS }
}

/** Expose for testing only — clear all windows */
function _reset() {
  _windows.clear()
}

module.exports = { checkRateLimit, _reset }
