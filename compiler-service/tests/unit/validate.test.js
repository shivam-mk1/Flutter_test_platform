'use strict'

/**
 * tests/unit/validate.test.js
 *
 * Unit tests for shared/validate.js
 * Uses Node.js built-in test runner (node:test) — no external test framework needed.
 *
 * Run: npm run test:unit
 *      node --test tests/unit/validate.test.js
 */

const { test, describe } = require('node:test')
const assert = require('node:assert/strict')

const { validateFiles, computeProjectHash } = require('../../shared/validate')

// ── Helper ────────────────────────────────────────────────────────────────────
const makeFile = (p, content = 'void main() {}') => ({ path: p, content })

// ── validateFiles ─────────────────────────────────────────────────────────────

describe('validateFiles — basic structure', () => {
  test('rejects null', () => {
    const r = validateFiles(null)
    assert.equal(r.valid, false)
    assert.match(r.reason, /array/)
  })

  test('rejects empty array', () => {
    const r = validateFiles([])
    assert.equal(r.valid, false)
    assert.match(r.reason, /empty/)
  })

  test('accepts minimal valid project', () => {
    const r = validateFiles([makeFile('lib/main.dart')])
    assert.equal(r.valid, true)
  })

  test('accepts multiple valid files', () => {
    const r = validateFiles([
      makeFile('lib/main.dart'),
      makeFile('lib/screens/home.dart'),
      makeFile('assets/logo.png', 'PNG_DATA'),
      makeFile('test/widget_test.dart'),
    ])
    assert.equal(r.valid, true)
  })

  test('rejects non-object file entry', () => {
    const r = validateFiles(['lib/main.dart'])
    assert.equal(r.valid, false)
    assert.match(r.field, /files\[0\]/)
  })

  test('rejects file with missing path', () => {
    const r = validateFiles([{ content: 'x' }])
    assert.equal(r.valid, false)
    assert.match(r.field, /path/)
  })

  test('rejects file with non-string content', () => {
    const r = validateFiles([{ path: 'lib/main.dart', content: 123 }])
    assert.equal(r.valid, false)
    assert.match(r.field, /content/)
  })
})

describe('validateFiles — path traversal', () => {
  test('rejects ../escape', () => {
    const r = validateFiles([makeFile('../escape.dart')])
    assert.equal(r.valid, false)
    assert.match(r.reason, /traversal|allowed directory/i)
  })

  test('rejects ../../etc/passwd', () => {
    const r = validateFiles([makeFile('../../etc/passwd')])
    assert.equal(r.valid, false)
  })

  test('rejects lib/../../../etc/passwd', () => {
    const r = validateFiles([makeFile('lib/../../../etc/passwd')])
    assert.equal(r.valid, false)
    assert.match(r.reason, /traversal|allowed directory/i)
  })

  test('rejects absolute Unix path', () => {
    const r = validateFiles([makeFile('/etc/passwd')])
    assert.equal(r.valid, false)
    assert.match(r.reason, /absolute/i)
  })

  test('rejects absolute Windows path', () => {
    const r = validateFiles([makeFile('C:\\Windows\\System32\\cmd.exe')])
    assert.equal(r.valid, false)
    assert.match(r.reason, /absolute/i)
  })

  test('rejects backslash traversal \\..\\..', () => {
    const r = validateFiles([makeFile('..\\..\\etc\\passwd')])
    assert.equal(r.valid, false)
  })
})

describe('validateFiles — forbidden filenames', () => {
  test('rejects Dockerfile under lib/', () => {
    const r = validateFiles([makeFile('lib/Dockerfile')])
    assert.equal(r.valid, false)
    assert.match(r.reason, /forbidden/i)
  })

  test('rejects .git/ under lib/', () => {
    const r = validateFiles([makeFile('lib/.git/config')])
    assert.equal(r.valid, false)
    assert.match(r.reason, /forbidden/i)
  })

  test('rejects pubspec.yaml at root level (not under lib/)', () => {
    // pubspec.yaml is server-controlled; if somehow submitted at root it should fail
    // allowed-prefix check catches it first (not under lib/, assets/, etc.)
    const r = validateFiles([makeFile('pubspec.yaml')])
    assert.equal(r.valid, false)  // fails allowed-prefix OR forbidden check
  })

  test('rejects shell script under lib/', () => {
    const r = validateFiles([makeFile('lib/setup.sh')])
    assert.equal(r.valid, false)
    assert.match(r.reason, /forbidden/i)
  })

  test('rejects .env file under lib/', () => {
    const r = validateFiles([makeFile('lib/.env')])
    assert.equal(r.valid, false)
    assert.match(r.reason, /forbidden/i)
  })
})

describe('validateFiles — allowed prefixes', () => {
  test('rejects file at project root (no lib/ prefix)', () => {
    const r = validateFiles([makeFile('main.dart')])
    assert.equal(r.valid, false)
    assert.match(r.reason, /allowed directory/i)
  })

  test('rejects android/ directory', () => {
    const r = validateFiles([makeFile('android/app/build.gradle')])
    assert.equal(r.valid, false)
  })

  test('accepts lib/ files', () => {
    assert.equal(validateFiles([makeFile('lib/main.dart')]).valid, true)
  })

  test('accepts assets/ files', () => {
    assert.equal(validateFiles([makeFile('assets/logo.png', 'PNG')]).valid, true)
  })

  test('accepts test/ files', () => {
    assert.equal(validateFiles([makeFile('test/widget_test.dart')]).valid, true)
  })

  test('accepts web/ files', () => {
    assert.equal(validateFiles([makeFile('web/index.html', '<html></html>')]).valid, true)
  })
})

describe('validateFiles — size limits', () => {
  const env = process.env

  test('rejects oversized source file', () => {
    // 600 KB source (limit 512 KB by default)
    const bigContent = 'x'.repeat(600 * 1024)
    const r = validateFiles([makeFile('lib/big.dart', bigContent)])
    assert.equal(r.valid, false)
    assert.match(r.reason, /too large/i)
  })

  test('rejects oversized project (many files)', () => {
    // Each file 200 KB, 60 files = 12 MB > 10 MB limit
    const files = Array.from({ length: 60 }, (_, i) =>
      makeFile(`lib/file${i}.dart`, 'x'.repeat(200 * 1024)),
    )
    const r = validateFiles(files)
    assert.equal(r.valid, false)
    assert.match(r.reason, /too many files|total project size|too large/i)
  })

  test('rejects too many files', () => {
    const files = Array.from({ length: 55 }, (_, i) =>
      makeFile(`lib/file${i}.dart`, 'void main() {}'),
    )
    const r = validateFiles(files)
    assert.equal(r.valid, false)
    assert.match(r.reason, /too many files/i)
  })
})

describe('validateFiles — duplicate paths', () => {
  test('rejects duplicate paths', () => {
    const r = validateFiles([
      makeFile('lib/main.dart'),
      makeFile('lib/main.dart'),
    ])
    assert.equal(r.valid, false)
    assert.match(r.reason, /duplicate/i)
  })
})

// ── computeProjectHash ────────────────────────────────────────────────────────

describe('computeProjectHash', () => {
  test('returns a hex string', () => {
    const h = computeProjectHash([makeFile('lib/main.dart')])
    assert.match(h, /^[0-9a-f]{64}$/)
  })

  test('is deterministic', () => {
    const files = [makeFile('lib/main.dart', 'void main(){}')]
    assert.equal(computeProjectHash(files), computeProjectHash(files))
  })

  test('differs with different content', () => {
    const a = computeProjectHash([makeFile('lib/main.dart', 'A')])
    const b = computeProjectHash([makeFile('lib/main.dart', 'B')])
    assert.notEqual(a, b)
  })

  test('is order-independent (sorts by path)', () => {
    const h1 = computeProjectHash([
      makeFile('lib/a.dart', 'A'),
      makeFile('lib/b.dart', 'B'),
    ])
    const h2 = computeProjectHash([
      makeFile('lib/b.dart', 'B'),
      makeFile('lib/a.dart', 'A'),
    ])
    assert.equal(h1, h2)
  })

  test('differs with different examEnvVersion', () => {
    const files = [makeFile('lib/main.dart', 'x')]
    const h1 = computeProjectHash(files, 'v1')
    const h2 = computeProjectHash(files, 'v2')
    assert.notEqual(h1, h2)
  })
})
