'use strict'

/**
 * shared/validate.js
 *
 * Shared file-validation pipeline for the exam platform.
 *
 * Called by:
 *   - API POST /run  — before enqueueing the job (reject bad input early)
 *   - Worker         — defense-in-depth before writing files to tmpdir
 *   - Exam Backend SUBMIT — before persisting immutable snapshot (see §26)
 *
 * Validates:
 *   - Path traversal / absolute paths / Windows paths
 *   - Forbidden filenames (Dockerfile, .git/, android/, pubspec.yaml, etc.)
 *   - Allowed top-level directories only
 *   - Per-file size limits (source vs asset)
 *   - Total project size limit
 *   - File count limit
 *   - Path length limit
 *
 * Returns { valid: true } or { valid: false, reason: '...', field: '...' }
 */

const path = require('path')
const crypto = require('crypto')

// ── Configurable limits ──────────────────────────────────────────────────────
const MAX_FILE_COUNT       = parseInt(process.env.MAX_FILE_COUNT        || '50',       10)
const MAX_FILE_SIZE_BYTES  = parseInt(process.env.MAX_FILE_SIZE_BYTES   || '524288',   10) // 512 KB
const MAX_ASSET_SIZE_BYTES = parseInt(process.env.MAX_ASSET_SIZE_BYTES  || '2097152',  10) // 2 MB
const MAX_PROJECT_SIZE_BYTES = parseInt(process.env.MAX_PROJECT_SIZE_BYTES || '10485760', 10) // 10 MB
const MAX_PATH_LENGTH      = parseInt(process.env.MAX_PATH_LENGTH       || '260',      10)

// ── Forbidden path patterns ─────────────────────────────────────────────────
// These files/directories must never be written by a student submission.
// pubspec.yaml and pubspec.lock are server-controlled.
// Patterns are tested against the NORMALIZED path (e.g. lib/Dockerfile, lib/.git/config)
const FORBIDDEN_PATTERNS = [
  // Forbidden at any depth — these should never appear regardless of directory
  /(?:^|\/)Dockerfile(\..*)?\/$/i,          // Dockerfile directory
  /(?:^|\/)Dockerfile(\.[^/]*)?$/i,         // Dockerfile file
  /(?:^|\/)\.dockerignore$/i,
  /(?:^|\/)\.git(\/|$)/i,
  /(?:^|\/)\.env(\..*)?\/$/i,
  /(?:^|\/)\.env(\.[^/]*)?$/i,
  // Forbidden only at project root (top-level directories)
  /^android(\/|$)/i,
  /^ios(\/|$)/i,
  /^macos(\/|$)/i,
  /^windows(\/|$)/i,
  /^linux(\/|$)/i,
  /^pubspec\.yaml$/i,        // server-controlled — student version is ignored/replaced
  /^pubspec\.lock$/i,        // server-controlled
  /^build(\/|$)/i,           // generated output
  /^\.dart_tool(\/|$)/i,     // generated tooling artifacts
  // Executable/script files anywhere
  /\.sh$/i,
  /\.exe$/i,
  /\.bat$/i,
  /\.cmd$/i,
  /\.ps1$/i,
]

// ── Allowed top-level directories ───────────────────────────────────────────
// Student files must reside in one of these directories.
// This is intentionally restrictive for the exam environment.
const ALLOWED_PREFIXES = [
  'lib/',
  'assets/',
  'test/',
  'web/',
  'fonts/',
]

// ── Binary/asset file extensions ────────────────────────────────────────────
const ASSET_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.webp',
  '.ttf', '.otf', '.woff', '.woff2',
  '.json',  // e.g. asset JSON, not pubspec
  '.mp3', '.wav', '.ogg',
])

function isAsset(filePath) {
  return ASSET_EXTENSIONS.has(path.extname(filePath).toLowerCase())
}

// ── Main validation function ─────────────────────────────────────────────────
/**
 * Validates an array of { path, content } file objects.
 *
 * @param {Array<{ path: string, content: string }>} files
 * @returns {{ valid: boolean, reason?: string, field?: string }}
 */
function validateFiles(files) {
  if (!Array.isArray(files)) {
    return { valid: false, reason: 'files must be an array', field: 'files' }
  }
  if (files.length === 0) {
    return { valid: false, reason: 'files array must not be empty', field: 'files' }
  }
  if (files.length > MAX_FILE_COUNT) {
    return {
      valid: false,
      reason: `too many files: ${files.length} (limit ${MAX_FILE_COUNT})`,
      field: 'files',
    }
  }

  let totalBytes = 0
  const seenPaths = new Set()

  for (let i = 0; i < files.length; i++) {
    const file = files[i]

    // ── Structure check ──────────────────────────────────────────────────────
    if (!file || typeof file !== 'object') {
      return { valid: false, reason: `files[${i}] must be an object`, field: `files[${i}]` }
    }
    if (typeof file.path !== 'string' || file.path.length === 0) {
      return { valid: false, reason: `files[${i}].path must be a non-empty string`, field: `files[${i}].path` }
    }
    if (typeof file.content !== 'string') {
      return { valid: false, reason: `files[${i}].content must be a string`, field: `files[${i}].content` }
    }

    const rawPath = file.path.trim()

    // ── Path length ──────────────────────────────────────────────────────────
    if (rawPath.length > MAX_PATH_LENGTH) {
      return {
        valid: false,
        reason: `path too long: "${rawPath.slice(0, 40)}…" (${rawPath.length} chars, limit ${MAX_PATH_LENGTH})`,
        field: `files[${i}].path`,
      }
    }

    // ── Absolute paths (Unix and Windows) ────────────────────────────────────
    if (path.isAbsolute(rawPath) || /^[A-Za-z]:/.test(rawPath) || rawPath.startsWith('\\')) {
      return {
        valid: false,
        reason: `absolute paths are not allowed: "${rawPath}"`,
        field: `files[${i}].path`,
      }
    }

    // ── Path traversal ───────────────────────────────────────────────────────
    // Normalize using POSIX rules (handles both / and \)
    const normalized = path.posix.normalize(rawPath.replace(/\\/g, '/'))
    if (
      normalized === '..' ||
      normalized.startsWith('../') ||
      normalized.startsWith('./..') ||
      normalized.includes('/../')
    ) {
      return {
        valid: false,
        reason: `path traversal detected: "${rawPath}"`,
        field: `files[${i}].path`,
      }
    }

    // ── Allowed prefix check ─────────────────────────────────────────────────
    const hasAllowedPrefix = ALLOWED_PREFIXES.some((prefix) => normalized.startsWith(prefix))
    if (!hasAllowedPrefix) {
      return {
        valid: false,
        reason: `path "${rawPath}" is not in an allowed directory (${ALLOWED_PREFIXES.join(', ')})`,
        field: `files[${i}].path`,
      }
    }

    // ── Forbidden patterns ───────────────────────────────────────────────────
    for (const pattern of FORBIDDEN_PATTERNS) {
      if (pattern.test(normalized)) {
        return {
          valid: false,
          reason: `forbidden file path: "${rawPath}"`,
          field: `files[${i}].path`,
        }
      }
    }

    // ── Duplicate paths ──────────────────────────────────────────────────────
    if (seenPaths.has(normalized)) {
      return {
        valid: false,
        reason: `duplicate path: "${rawPath}"`,
        field: `files[${i}].path`,
      }
    }
    seenPaths.add(normalized)

    // ── Size checks ──────────────────────────────────────────────────────────
    const fileBytes = Buffer.byteLength(file.content, 'utf8')
    const sizeLimit = isAsset(normalized) ? MAX_ASSET_SIZE_BYTES : MAX_FILE_SIZE_BYTES

    if (fileBytes > sizeLimit) {
      return {
        valid: false,
        reason: `file "${rawPath}" is too large: ${fileBytes} bytes (limit ${sizeLimit})`,
        field: `files[${i}].content`,
      }
    }

    totalBytes += fileBytes
    if (totalBytes > MAX_PROJECT_SIZE_BYTES) {
      return {
        valid: false,
        reason: `total project size exceeds limit: ${totalBytes} bytes (limit ${MAX_PROJECT_SIZE_BYTES})`,
        field: 'files',
      }
    }
  }

  return { valid: true }
}

// ── Project hash ────────────────────────────────────────────────────────────
/**
 * Computes a deterministic SHA-256 hash of the project contents.
 * Used to detect duplicate RUN requests and (optionally) reuse cached results.
 *
 * SHA-256(examEnvVersion + "\0" + sorted(path + "\0" + content) ...)
 *
 * @param {Array<{ path: string, content: string }>} files
 * @param {string} examEnvVersion
 * @returns {string} hex digest
 */
function computeProjectHash(files, examEnvVersion = 'v1') {
  const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path))
  const hash = crypto.createHash('sha256')
  hash.update(examEnvVersion + '\0')
  for (const f of sorted) {
    hash.update(f.path + '\0' + f.content + '\0')
  }
  return hash.digest('hex')
}

module.exports = { validateFiles, computeProjectHash, ALLOWED_PREFIXES, MAX_FILE_COUNT }
