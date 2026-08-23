'use strict'

/**
 * tests/unit/parser.test.js
 *
 * Unit tests for worker/src/parser.js
 * Uses Node.js built-in test runner (node:test).
 *
 * Run: npm run test:unit
 *      node --test tests/unit/parser.test.js
 */

const { test, describe } = require('node:test')
const assert = require('node:assert/strict')

const { parseAnalyzeOutput, detectFailedPhase, truncateOutput } = require('../../worker/src/parser')

// ── Fixtures — real flutter analyze output ────────────────────────────────────

const FIXTURE_CLEAN = `
Analyzing exam_project...
No issues found! (ran in 1.2s)
`

const FIXTURE_ONE_ERROR = `
Analyzing exam_project...
  error • The method 'doesNotExist' isn't defined for the type 'Widget' • lib/main.dart:15:5 • undefined_method
1 issue found.
`

const FIXTURE_MIXED = `
Analyzing exam_project...
  error • The method 'foo' isn't defined • lib/main.dart:10:3 • undefined_function
  error • Undefined name 'bar' • lib/main.dart:20:7 • undefined_identifier
  warning • Unused import: 'dart:io' • lib/main.dart:1:8 • unused_import
  info • Use 'const' with the constructor • lib/screens/home.dart:5:10 • prefer_const_constructors
3 issues found.
`

const FIXTURE_WITH_PHASES = `
=== PHASE:pubget ===
Resolving dependencies...
Got dependencies!

=== PHASE:analyze ===
Analyzing exam_project...
  error • The method 'foo' isn't defined • lib/main.dart:10:3 • undefined_function
1 issue found.

=== ANALYZE_EXIT:1 ===
`

const FIXTURE_PUBGET_FAILED = `
=== PHASE:pubget ===
Resolving dependencies...
Because exam_project depends on super_secret_package any which doesn't exist, version solving failed.

=== PUBGET_FAILED:1 ===
`

const FIXTURE_WITH_WORKSPACE = `
=== PHASE:analyze ===
Analyzing exam_project...
  error • Undefined name 'foo' • /tmp/exam-flutter-abc123/lib/main.dart:5:3 • undefined_identifier
1 issue found.
`

// ── detectFailedPhase ─────────────────────────────────────────────────────────

describe('detectFailedPhase', () => {
  test('returns null for clean output', () => {
    assert.equal(detectFailedPhase(FIXTURE_CLEAN), null)
  })

  test('returns null for analyze-error output', () => {
    assert.equal(detectFailedPhase(FIXTURE_ONE_ERROR), null)
  })

  test('returns "pubget" when PUBGET_FAILED marker present', () => {
    assert.equal(detectFailedPhase(FIXTURE_PUBGET_FAILED), 'pubget')
  })
})

// ── parseAnalyzeOutput ────────────────────────────────────────────────────────

describe('parseAnalyzeOutput — clean output', () => {
  test('returns empty errors and warnings for clean project', () => {
    const result = parseAnalyzeOutput(FIXTURE_CLEAN)
    assert.equal(result.errors.length, 0)
    assert.equal(result.warnings.length, 0)
    assert.equal(result.infos.length, 0)
  })
})

describe('parseAnalyzeOutput — single error', () => {
  test('parses one error correctly', () => {
    const result = parseAnalyzeOutput(FIXTURE_ONE_ERROR)
    assert.equal(result.errors.length, 1)
    assert.equal(result.warnings.length, 0)

    const err = result.errors[0]
    assert.equal(err.severity, 'error')
    assert.equal(err.file, 'lib/main.dart')
    assert.equal(err.line, 15)
    assert.equal(err.column, 5)
    assert.equal(err.code, 'undefined_method')
    assert.match(err.message, /doesNotExist/)
  })
})

describe('parseAnalyzeOutput — mixed diagnostics', () => {
  test('correctly separates errors, warnings, infos', () => {
    const result = parseAnalyzeOutput(FIXTURE_MIXED)
    assert.equal(result.errors.length, 2)
    assert.equal(result.warnings.length, 1)
    assert.equal(result.infos.length, 1)
  })

  test('first error has correct fields', () => {
    const result = parseAnalyzeOutput(FIXTURE_MIXED)
    const err = result.errors[0]
    assert.equal(err.severity, 'error')
    assert.equal(err.file, 'lib/main.dart')
    assert.equal(err.line, 10)
    assert.equal(err.column, 3)
    assert.equal(err.code, 'undefined_function')
  })

  test('warning has correct fields', () => {
    const result = parseAnalyzeOutput(FIXTURE_MIXED)
    const w = result.warnings[0]
    assert.equal(w.severity, 'warning')
    assert.equal(w.file, 'lib/main.dart')
    assert.equal(w.line, 1)
    assert.equal(w.column, 8)
    assert.equal(w.code, 'unused_import')
  })

  test('info has different file', () => {
    const result = parseAnalyzeOutput(FIXTURE_MIXED)
    const info = result.infos[0]
    assert.equal(info.file, 'lib/screens/home.dart')
    assert.equal(info.code, 'prefer_const_constructors')
  })
})

describe('parseAnalyzeOutput — phase markers', () => {
  test('only parses the analyze section, not pubget output', () => {
    const result = parseAnalyzeOutput(FIXTURE_WITH_PHASES)
    assert.equal(result.errors.length, 1)
    assert.equal(result.errors[0].code, 'undefined_function')
  })

  test('pubget failure output returns no diagnostics', () => {
    const result = parseAnalyzeOutput(FIXTURE_PUBGET_FAILED)
    assert.equal(result.errors.length, 0)
  })
})

describe('parseAnalyzeOutput — workspace path stripping', () => {
  test('strips absolute workspace prefix from file paths', () => {
    const result = parseAnalyzeOutput(FIXTURE_WITH_WORKSPACE, '/tmp/exam-flutter-abc123')
    assert.equal(result.errors.length, 1)
    assert.equal(result.errors[0].file, 'lib/main.dart')
  })

  test('works without workspace path (no stripping)', () => {
    const result = parseAnalyzeOutput(FIXTURE_WITH_WORKSPACE)
    assert.equal(result.errors.length, 1)
    // Without workspace arg, the full path is preserved
    assert.match(result.errors[0].file, /lib\/main\.dart/)
  })
})

// ── truncateOutput ────────────────────────────────────────────────────────────

describe('truncateOutput', () => {
  test('returns empty string for empty input', () => {
    assert.equal(truncateOutput('', 1000), '')
    assert.equal(truncateOutput(null, 1000), '')
  })

  test('returns unchanged output if under limit', () => {
    const output = 'hello world'
    assert.equal(truncateOutput(output, 100), output)
  })

  test('truncates and appends notice when over limit', () => {
    const output = 'A'.repeat(200)
    const result = truncateOutput(output, 100)
    assert.ok(result.length > 100)
    assert.ok(result.includes('[... output truncated'))
    assert.ok(result.startsWith('A'.repeat(100)))
  })

  test('truncates at byte boundary not char boundary', () => {
    // Each 'A' is 1 byte, so 100 bytes = 100 chars
    const result = truncateOutput('A'.repeat(200), 100)
    // Truncated portion is exactly 100 bytes of 'A'
    assert.ok(result.startsWith('A'.repeat(100)))
    assert.ok(result.includes('100 bytes'))
  })
})
