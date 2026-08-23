'use strict'

/**
 * worker/src/parser.js
 *
 * Parses raw flutter/dart tooling output into structured error/warning objects.
 *
 * flutter analyze output format (modern Flutter 3.x):
 *
 *   Analyzing exam_project...
 *     error • The function 'foo' isn't defined • lib/main.dart:10:3 • undefined_function
 *     warning • Unused import: 'dart:io' • lib/main.dart:1:8 • unused_import
 *     info • Use 'const' with the constructor • lib/main.dart:5:10 • prefer_const_constructors
 *   2 issues found. (ran in 1.2s)
 *
 * On success:
 *   Analyzing exam_project...
 *   No issues found! (ran in 0.9s)
 *
 * The sandbox run.sh inserts phase markers:
 *   === PHASE:pubget ===
 *   === PHASE:analyze ===
 *   === ANALYZE_EXIT:<n> ===
 *   === PUBGET_FAILED:<n> ===
 */

// Matches a single diagnostic line from flutter analyze
// Groups: severity, message, file, line, column, code
const ANALYZE_DIAG_RE =
  /^\s*(error|warning|info)\s+•\s+(.+?)\s+•\s+(.+?):(\d+):(\d+)\s+•\s+(\S+)\s*$/i

/**
 * Detect which phase failed based on the combined output from sandbox/run.sh.
 *
 * @param {string} combined  — full stdout+stderr output from the container
 * @returns {'pubget' | 'analyze' | null}
 */
function detectFailedPhase(combined) {
  if (/=== PUBGET_FAILED:\d+ ===/.test(combined)) return 'pubget'
  return null
}

/**
 * Extract the analyze section from combined output.
 * Strips everything before "=== PHASE:analyze ===" so we don't parse
 * pub-get output as diagnostics.
 *
 * @param {string} combined
 * @returns {string}
 */
function extractAnalyzeSection(combined) {
  const marker = '=== PHASE:analyze ==='
  const idx = combined.indexOf(marker)
  if (idx === -1) return combined   // fallback: parse everything
  return combined.slice(idx + marker.length)
}

/**
 * Parse flutter analyze output into structured diagnostic arrays.
 *
 * @param {string} combined     — full stdout + stderr from the container
 * @param {string} workspaceDir — absolute path to tmpdir, used to strip prefix from file paths
 * @returns {{ errors: Diagnostic[], warnings: Diagnostic[], infos: Diagnostic[] }}
 *
 * @typedef {{ severity: string, file: string, line: number, column: number, code: string, message: string }} Diagnostic
 */
function parseAnalyzeOutput(combined, workspaceDir = '') {
  const section = extractAnalyzeSection(combined)
  const lines = section.split(/\r?\n/)

  const errors   = []
  const warnings = []
  const infos    = []

  // Normalise workspace dir for stripping (ensure trailing slash)
  const wsPrefix = workspaceDir
    ? workspaceDir.replace(/\\/g, '/').replace(/\/?$/, '/')
    : ''

  for (const line of lines) {
    const match = ANALYZE_DIAG_RE.exec(line)
    if (!match) continue

    const [, rawSeverity, message, rawFile, lineStr, colStr, code] = match

    // Strip absolute workspace prefix so file paths are relative (e.g. lib/main.dart)
    let file = rawFile.trim().replace(/\\/g, '/')
    if (wsPrefix && file.startsWith(wsPrefix)) {
      file = file.slice(wsPrefix.length)
    }

    const entry = {
      severity: rawSeverity.toLowerCase(),
      file,
      line:    parseInt(lineStr, 10),
      column:  parseInt(colStr, 10),
      code:    code.trim(),
      message: message.trim(),
    }

    if (entry.severity === 'error')        errors.push(entry)
    else if (entry.severity === 'warning') warnings.push(entry)
    else                                   infos.push(entry)
  }

  return { errors, warnings, infos }
}

/**
 * Truncate a string to a byte limit, appending a notice if truncated.
 * Ensures Node.js memory is never exhausted by runaway compiler output.
 *
 * @param {string} output
 * @param {number} maxBytes
 * @returns {string}
 */
function truncateOutput(output, maxBytes) {
  if (!output) return ''
  const buf = Buffer.from(output, 'utf8')
  if (buf.length <= maxBytes) return output
  const truncated = buf.subarray(0, maxBytes).toString('utf8')
  return `${truncated}\n[... output truncated at ${maxBytes} bytes (${buf.length - maxBytes} bytes omitted) ...]`
}

module.exports = { parseAnalyzeOutput, detectFailedPhase, truncateOutput }
