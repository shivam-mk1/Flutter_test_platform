'use strict'

/**
 * worker/src/tracker.js
 *
 * In-memory job/container tracker for cancel-and-replace (§15–§20).
 *
 * Invariant: at most ONE non-cancelled execution per (studentId, questionId).
 *
 * This is a singleton exported as a module-level object. It is intentionally
 * in-memory only, which means:
 *   - It works correctly for a single worker process
 *   - It resets if the worker restarts (orphaned containers are cleaned up on
 *     the next startup by the Docker forced-remove in every finally block)
 *   - Horizontal scaling (multiple worker processes) requires a Redis-backed
 *     implementation — documented as a known limitation (§9 of the plan)
 *
 * Entry shape:
 *   {
 *     jobId:       string,
 *     revision:    number,
 *     studentId:   string,
 *     questionId:  string,
 *     containerId: string | null,
 *     tmpDir:      string | null,
 *     cancelled:   boolean,
 *     cancel:      async (reason?: string) => void,
 *   }
 */

const { EventEmitter } = require('events')

class JobTracker extends EventEmitter {
  constructor() {
    super()
    // Map<`${studentId}:${questionId}`, Entry>
    this._map = new Map()
    // Map<jobId, key>  — reverse index so we can look up by jobId
    this._byJobId = new Map()
  }

  _key(studentId, questionId) {
    return `${studentId}:${questionId}`
  }

  // ── Registration ────────────────────────────────────────────────────────────

  /**
   * Register a new job for this student/question.
   *
   * If a previous job exists, immediately call its cancel() function.
   * The cancel() at registration time is a lightweight sentinel (no container
   * yet), replaced by the real cancel via setCancel() after container creation.
   *
   * @param {string} studentId
   * @param {string} questionId
   * @param {string} jobId
   * @param {number} revision
   * @returns {Promise<Entry | null>}  The cancelled old entry, or null
   */
  async register(studentId, questionId, jobId, revision) {
    const key = this._key(studentId, questionId)
    const existing = this._map.get(key)

    if (existing) {
      console.log(
        `[tracker] superseding job ${existing.jobId} (rev ${existing.revision}) ` +
        `with ${jobId} (rev ${revision}) for ${studentId}/${questionId}`,
      )
      try {
        await existing.cancel('superseded')
      } catch (err) {
        console.error(`[tracker] error cancelling old job ${existing.jobId}:`, err.message)
      }
      this._byJobId.delete(existing.jobId)
    }

    /** @type {Entry} */
    const entry = {
      jobId,
      revision,
      studentId,
      questionId,
      containerId: null,
      tmpDir:      null,
      cancelled:   false,
      // Placeholder cancel — replaced by setCancel() once the container exists
      cancel: async (reason = 'cancelled') => {
        entry.cancelled = true
        console.log(`[tracker] job ${jobId} marked cancelled (${reason}) before container started`)
      },
    }

    this._map.set(key, entry)
    this._byJobId.set(jobId, key)
    this.emit('registered', { studentId, questionId, jobId, revision })

    return existing || null
  }

  // ── Container binding ───────────────────────────────────────────────────────

  /**
   * Bind the real cancellation function after the container has been created.
   * Also records containerId and tmpDir for use in cancel().
   *
   * If the job was already superseded (another register() happened in the
   * tiny window between register() and setCancel()), this is a no-op and
   * returns false — the caller must then cancel the new container immediately.
   *
   * @param {string} jobId
   * @param {Function} cancelFn — async () => void, kills container + cleans up
   * @param {string} containerId
   * @param {string} tmpDir
   * @returns {boolean} true if successfully bound, false if already superseded
   */
  setCancel(jobId, cancelFn, containerId, tmpDir) {
    const key = this._byJobId.get(jobId)
    if (!key) return false               // already superseded and unregistered

    const entry = this._map.get(key)
    if (!entry || entry.jobId !== jobId) return false  // superseded

    entry.cancel      = cancelFn
    entry.containerId = containerId
    entry.tmpDir      = tmpDir
    return true
  }

  // ── Query helpers ───────────────────────────────────────────────────────────

  /**
   * Returns true if the job has been cancelled (superseded or externally cancelled).
   * A job is also considered cancelled if it is no longer the current job for
   * its student/question.
   */
  isCancelled(jobId) {
    const key = this._byJobId.get(jobId)
    if (!key) return true   // removed from map = superseded = cancelled

    const entry = this._map.get(key)
    if (!entry || entry.jobId !== jobId) return true

    return entry.cancelled
  }

  getCurrent(studentId, questionId) {
    return this._map.get(this._key(studentId, questionId)) || null
  }

  // ── Cleanup ─────────────────────────────────────────────────────────────────

  /**
   * Remove a job from the tracker after it completes (success, error, timeout, cancelled).
   * Only removes if the jobId matches the current entry for the student/question.
   */
  unregister(jobId, studentId, questionId) {
    const key = this._key(studentId, questionId)
    const entry = this._map.get(key)

    if (entry && entry.jobId === jobId) {
      this._map.delete(key)
      this._byJobId.delete(jobId)
      this.emit('unregistered', { studentId, questionId, jobId })
    } else {
      // The entry was already replaced by a newer job; just clean up the reverse index
      this._byJobId.delete(jobId)
    }
  }

  size() {
    return this._map.size
  }

  activeJobs() {
    return Array.from(this._map.values()).map((e) => ({
      jobId:      e.jobId,
      revision:   e.revision,
      studentId:  e.studentId,
      questionId: e.questionId,
      cancelled:  e.cancelled,
    }))
  }
}

// Export singleton — shared across the single worker process
module.exports = new JobTracker()
