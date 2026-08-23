'use strict'

require('dotenv').config()

/**
 * tests/load-test.js
 *
 * End-to-end HTTP load test for the Flutter compiler service.
 * Simulates N students submitting RUN requests simultaneously.
 * Measures queue latency, execution time, success rate, and timeout rate.
 *
 * Does NOT access Redis/BullMQ directly — tests the same path a student uses.
 *
 * Examples:
 *   npm run load-test
 *   node tests/load-test.js --students=20 --label=concurrency-4
 *   COMPILER_API_URL=http://localhost:5000 NUMBER_OF_STUDENTS=20 npm run load-test
 *
 * Full burst test (3 waves, §33):
 *   node tests/load-test.js --students=20 --waves=3 --wave-interval-ms=30000
 *
 * Environment:
 *   COMPILER_API_URL          default http://localhost:5000
 *   COMPILER_SERVICE_API_KEY  default changeme
 *   NUMBER_OF_STUDENTS        default 20
 */

const args = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const match = /^--([^=]+)=(.*)$/.exec(arg)
    if (!match) throw new Error(`Invalid option: ${arg}. Use --name=value.`)
    return [match[1], match[2]]
  }),
)

function positiveInteger(value, name, fallback) {
  const parsed = Number(value ?? fallback)
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer.`)
  return parsed
}

const apiUrl          = (args['api-url'] || process.env.COMPILER_API_URL || 'http://localhost:5000').replace(/\/$/, '')
const serviceKey      = process.env.COMPILER_SERVICE_API_KEY || 'change-me-before-production'
const students        = positiveInteger(args.students || args.student || process.env.NUMBER_OF_STUDENTS, 'students', 20)
const pollIntervalMs  = positiveInteger(args['poll-interval-ms'] || process.env.POLL_INTERVAL_MS, 'poll interval', 2000)
const globalTimeoutMs = positiveInteger(args['global-timeout-ms'] || process.env.GLOBAL_TIMEOUT_MS, 'global timeout', 600_000)
const waves           = positiveInteger(args.waves || '1', 'waves', 1)
const waveIntervalMs  = positiveInteger(args['wave-interval-ms'] || '30000', 'wave interval', 30000)
const label           = args.label || process.env.LOAD_TEST_LABEL || ''
// Namespace each invocation so queued jobs from an earlier load-test run cannot
// be mistaken for a newer revision from the same simulated student.
const runId           = (args['run-id'] || process.env.LOAD_TEST_RUN_ID || Date.now().toString(36))
  .replace(/[^a-zA-Z0-9_-]/g, '')
  .slice(0, 48) || Date.now().toString(36)

const sleep    = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const truncate = (value, max = 200) => !value || value.length <= max ? (value || '') : `${value.slice(0, max)}…`
const average  = (values) => values.length ? values.reduce((t, v) => t + v, 0) / values.length : null
function median(values) {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}
function formatMs(value) {
  if (value == null || !Number.isFinite(value)) return 'n/a'
  return value < 1000 ? `${Math.round(value)}ms` : `${(value / 1000).toFixed(2)}s`
}

// ── Flutter project fixtures ───────────────────────────────────────────────────
// Each student gets one of these Flutter project variants.
// Variants test different student scenarios.

const MAIN_DART_VALID = `import 'package:flutter/material.dart';

void main() {
  runApp(const MyApp());
}

class MyApp extends StatelessWidget {
  const MyApp({super.key});

  @override
  Widget build(BuildContext context) {
    return const MaterialApp(
      title: 'Exam App',
      home: Scaffold(
        body: Center(
          child: Text('Hello, Exam!'),
        ),
      ),
    );
  }
}
`

// Analyzer error: assigning a String to an int variable — definite type error.
const MAIN_DART_SYNTAX_ERROR = `import 'package:flutter/material.dart';

void main() {
  runApp(const MyApp());
}

class MyApp extends StatelessWidget {
  const MyApp({super.key});

  @override
  Widget build(BuildContext context) {
    int count = 'not a number'; // type error: String assigned to int
    return MaterialApp(home: Scaffold(body: Text(count.toString())));
  }
}
`

// Analyzer error: calling a method that doesn't exist on String.
const MAIN_DART_UNDEFINED = `import 'package:flutter/material.dart';

void main() {
  runApp(const MyApp());
}

class MyApp extends StatelessWidget {
  const MyApp({super.key});

  @override
  Widget build(BuildContext context) {
    const String label = 'hello';
    label.nonExistentMethod(); // undefined method on String — definite analyzer error
    return const MaterialApp(home: Scaffold());
  }
}
`

const MAIN_DART_STATEFUL = `import 'package:flutter/material.dart';

void main() => runApp(const MyApp());

class MyApp extends StatelessWidget {
  const MyApp({super.key});

  @override
  Widget build(BuildContext context) {
    return const MaterialApp(
      home: MyHomePage(title: 'Counter'),
    );
  }
}

class MyHomePage extends StatefulWidget {
  const MyHomePage({super.key, required this.title});
  final String title;

  @override
  State<MyHomePage> createState() => _MyHomePageState();
}

class _MyHomePageState extends State<MyHomePage> {
  int _counter = 0;

  void _increment() {
    setState(() { _counter++; });
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: Text(widget.title)),
      body: Center(child: Text('Count: \$_counter')),
      floatingActionButton: FloatingActionButton(
        onPressed: _increment,
        child: const Icon(Icons.add),
      ),
    );
  }
}
`

const MAIN_DART_VALID_LAYOUT = `import 'package:flutter/material.dart';

void main() {
  runApp(const MaterialApp(
    home: Scaffold(
      body: SafeArea(
        child: Padding(
          padding: EdgeInsets.all(24),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [Text('Exam dashboard'), SizedBox(height: 8), Text('Ready')],
          ),
        ),
      ),
    ),
  ));
}
`

const MAIN_DART_MISSING_ARGUMENT = `import 'package:flutter/material.dart';

void main() {
  runApp(const MaterialApp(home: Scaffold(body: Text())));
}
`

const MAIN_DART_BAD_RETURN = `import 'package:flutter/material.dart';

String heading() => 42;

void main() {
  runApp(MaterialApp(home: Scaffold(body: Text(heading()))));
}
`

const MAIN_DART_BAD_IMPORT = `import 'package:flutter/material.dart';
import 'missing_screen.dart';

void main() {
  runApp(const MaterialApp(home: Scaffold()));
}
`

const MAIN_DART_MULTI_FILE = `import 'package:flutter/material.dart';
import 'greeting.dart';

void main() {
  runApp(const MaterialApp(home: Scaffold(body: Center(child: Greeting()))));
}
`

const GREETING_DART = `import 'package:flutter/material.dart';

class Greeting extends StatelessWidget {
  const Greeting({super.key});

  @override
  Widget build(BuildContext context) => const Text('Hello from another file');
}
`

const MAIN_DART_BAD_WIDGET = `import 'package:flutter/material.dart';

void main() {
  runApp(const MaterialApp(home: Scaffold(body: NotAWidget())));
}
`

function workloadFor(studentNumber) {
  const workloads = [
    { name: 'valid-simple', files: [{ path: 'lib/main.dart', content: MAIN_DART_VALID }], expectSuccess: true },
    { name: 'type-mismatch', files: [{ path: 'lib/main.dart', content: MAIN_DART_SYNTAX_ERROR }], expectSuccess: false },
    { name: 'undefined-method', files: [{ path: 'lib/main.dart', content: MAIN_DART_UNDEFINED }], expectSuccess: false },
    { name: 'valid-stateful', files: [{ path: 'lib/main.dart', content: MAIN_DART_STATEFUL }], expectSuccess: true },
    { name: 'valid-layout', files: [{ path: 'lib/main.dart', content: MAIN_DART_VALID_LAYOUT }], expectSuccess: true },
    { name: 'missing-required-argument', files: [{ path: 'lib/main.dart', content: MAIN_DART_MISSING_ARGUMENT }], expectSuccess: false },
    { name: 'invalid-return-type', files: [{ path: 'lib/main.dart', content: MAIN_DART_BAD_RETURN }], expectSuccess: false },
    { name: 'missing-import', files: [{ path: 'lib/main.dart', content: MAIN_DART_BAD_IMPORT }], expectSuccess: false },
    {
      name: 'valid-multi-file',
      files: [
        { path: 'lib/main.dart', content: MAIN_DART_MULTI_FILE },
        { path: 'lib/greeting.dart', content: GREETING_DART },
      ],
      expectSuccess: true,
    },
    { name: 'undefined-widget', files: [{ path: 'lib/main.dart', content: MAIN_DART_BAD_WIDGET }], expectSuccess: false },
  ]

  return workloads[(studentNumber - 1) % workloads.length]
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────

const requestTimeoutMs = Math.min(30_000, globalTimeoutMs)

async function requestJson(url, options, deadline) {
  const remaining = deadline - Date.now()
  if (remaining <= 0) throw new Error('Global test timeout reached')
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), Math.min(requestTimeoutMs, remaining))
  try {
    const response = await fetch(url, { ...options, signal: controller.signal })
    const body = await response.text()
    let data
    try { data = body ? JSON.parse(body) : null } catch {
      throw new Error(`Malformed JSON (${response.status}): ${truncate(body)}`)
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${data?.error || truncate(body)}`)
    return data
  } catch (error) {
    if (error.name === 'AbortError') throw new Error(`Request timed out: ${url}`)
    throw error
  } finally { clearTimeout(timeout) }
}

// ── Submit + poll ─────────────────────────────────────────────────────────────

async function submitJob(studentNumber, wave, deadline) {
  const workload = workloadFor(studentNumber)
  const studentId  = `load-test-${runId}-student-${studentNumber}`
  const questionId = `load-test-question-1`
  const revision   = wave * 1000 + studentNumber

  const record = {
    studentNumber,
    wave,
    workload: workload.name,
    expectSuccess: workload.expectSuccess,
    studentId,
    revision,
    submittedTime: Date.now(),
    jobId:         null,
    state:         'submission_failed',
    activeTime:    null,
    completedTime: null,
    result:        null,
    error:         null,
  }

  try {
    const response = await requestJson(
      `${apiUrl}/run`,
      {
        method:  'POST',
        headers: {
          'Content-Type':   'application/json',
          'X-Service-Key':  serviceKey,
          'X-Student-Id':   studentId,
          'X-Question-Id':  questionId,
        },
        body: JSON.stringify({
          studentId,
          questionId,
          revision,
          files:     workload.files,
          timeoutMs: 90_000,
        }),
      },
      deadline,
    )
    if (!response?.jobId) throw new Error('Missing jobId in response')
    record.jobId  = response.jobId
    record.state  = 'waiting'
  } catch (error) {
    record.completedTime = Date.now()
    record.error         = error.message
  }
  return record
}

async function pollJob(record, deadline) {
  if (!record.jobId) return record

  while (Date.now() < deadline) {
    try {
      const response = await requestJson(
        `${apiUrl}/jobs/${encodeURIComponent(record.jobId)}?studentId=${encodeURIComponent(record.studentId)}`,
        {
          headers: {
            'X-Service-Key': serviceKey,
            'X-Student-Id':  record.studentId,
          },
        },
        deadline,
      )
      if (!response?.state) throw new Error('Missing state in job response')

      record.state = response.state
      if (response.state === 'running' && record.activeTime == null) {
        record.activeTime = Date.now()
      }

      if (['completed', 'failed', 'cancelled'].includes(response.state)) {
        record.completedTime = Date.now()
        record.result        = response.result

        if (response.state === 'completed') {
          const { status } = response.result || {}
          // For load test: validate that success/error matches expectation
          if (record.expectSuccess && status !== 'success') {
            record.error = `Expected success but got status="${status}"`
          } else if (!record.expectSuccess && status !== 'error') {
            record.error = `Expected error but got status="${status}"`
          }

          // ── Timing presence check ───────────────────────────────────────────
          // Every completed job MUST return result.timing. If it's absent, the
          // instrumentation has a gap (missing field on a return path). Flag it
          // loudly rather than silently producing "(no timing data)" in the table.
          if (!response.result?.timing) {
            record.timingMissing = true
            const existingErr = record.error ? `${record.error}; ` : ''
            record.error = `${existingErr}TIMING BUG: result.timing absent on completed job (status="${status}", phase="${response.result?.phase}")`
          }
        } else if (response.state === 'cancelled') {
          record.error = 'Job was cancelled (may be expected in cancel-and-replace scenario)'
        } else {
          record.error = 'Worker reported a failed job'
        }
        return record
      }
    } catch (error) {
      record.state         = 'poll_failed'
      record.completedTime = Date.now()
      record.error         = error.message
      return record
    }

    await sleep(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())))
  }

  record.state         = 'global_timeout'
  record.completedTime = Date.now()
  record.error         = 'Global timeout reached before terminal state'
  return record
}

// ── Reporting ─────────────────────────────────────────────────────────────────

function timing(record, kind) {
  if (kind === 'queue')     return record.activeTime == null ? null : record.activeTime - record.submittedTime
  if (kind === 'execution') return (record.activeTime == null || record.completedTime == null) ? null : record.completedTime - record.activeTime
  return record.completedTime == null ? null : record.completedTime - record.submittedTime
}

function printRecords(records) {
  console.log('\nJob Results')
  console.log(' # W  Workload              Job ID       State             Queue     Exec      Total   Status')
  for (const r of records) {
    const status = r.result?.status ?? '-'
    const phase  = r.result?.phase  ?? '-'
    const errors = r.result?.errors?.length ?? '-'
    console.log(
      `${String(r.studentNumber).padStart(2)} ${r.wave}  ` +
      `${r.workload.padEnd(20)}  ` +
      `${(r.jobId || '-').slice(0, 10).padEnd(10)}  ` +
      `${r.state.padEnd(15)}  ` +
      `${formatMs(timing(r, 'queue')).padStart(8)}  ` +
      `${formatMs(timing(r, 'execution')).padStart(8)}  ` +
      `${formatMs(timing(r, 'total')).padStart(8)}  ` +
      `${status}/${phase} errs=${errors}`,
    )
    if (r.error) console.log(`    ↳ ${r.error}`)
  }

  // ── Per-job timing breakdown ──────────────────────────────────────────────
  const hasTimingData = records.some((r) => r.result?.timing)
  if (hasTimingData) {
    console.log('\nPer-Job Timing Breakdown (from result.timing)')
    console.log(' # W  Workload               Container    PubGet       Analyze      Parse        Total(wkr)   Unaccounted')
    for (const r of records) {
      const tm = r.result?.timing
      if (!tm) {
        console.log(
          `${String(r.studentNumber).padStart(2)} ${r.wave}  ` +
          `${r.workload.padEnd(21)}  ` +
          `  (no timing data)`,
        )
        continue
      }
      const unaccStr = tm._unaccountedMs !== null
        ? (Math.abs(tm._unaccountedMs) > 500 ? `⚠ ${formatMs(tm._unaccountedMs)}` : formatMs(tm._unaccountedMs))
        : 'n/a'
      console.log(
        `${String(r.studentNumber).padStart(2)} ${r.wave}  ` +
        `${r.workload.padEnd(21)}  ` +
        `${formatMs(tm.containerStartMs).padStart(11)}  ` +
        `${(tm.dependencyResolutionMs !== null ? formatMs(tm.dependencyResolutionMs) : 'n/a').padStart(11)}  ` +
        `${(tm.analyzeMs !== null ? formatMs(tm.analyzeMs) : 'n/a').padStart(11)}  ` +
        `${formatMs(tm.resultParseMs).padStart(11)}  ` +
        `${(tm.totalExecutionMs !== null ? formatMs(tm.totalExecutionMs) : 'n/a').padStart(11)}  ` +
        `${unaccStr}`,
      )
    }
  }
}

function printSummary(records, startedAt, finishedAt) {
  const successful = records.filter((r) => r.state === 'completed' && !r.error)
  const failed     = records.filter((r) => !successful.includes(r))
  const timedOut   = records.filter((r) => r.state === 'global_timeout')
  const totals     = records.map((r) => timing(r, 'total')).filter(Number.isFinite)
  const queues     = records.map((r) => timing(r, 'queue')).filter(Number.isFinite)
  const execs      = records.map((r) => timing(r, 'execution')).filter(Number.isFinite)
  const duration   = finishedAt - startedAt
  const LINE = '═'.repeat(70)

  console.log(`\n${LINE}`)
  console.log(` Flutter Compiler Load Test${label ? ` [${label}]` : ''}`)
  console.log(LINE)
  console.log(`Students/wave:         ${students}    Waves: ${waves}    Total jobs: ${records.length}`)
  console.log(`Successful:            ${successful.length}`)
  console.log(`Failed/unexpected:     ${failed.length}`)
  console.log(`Global timeout:        ${timedOut.length}`)
  console.log(``)
  console.log(`Total batch time:      ${formatMs(duration)}`)
  console.log(`Average job time:      ${formatMs(average(totals))}`)
  console.log(`Median job time:       ${formatMs(median(totals))}`)
  console.log(`Min job time:          ${formatMs(totals.length ? Math.min(...totals) : null)}`)
  console.log(`Max job time:          ${formatMs(totals.length ? Math.max(...totals) : null)}`)
  console.log(``)
  console.log(`Average queue wait:    ${formatMs(average(queues))}`)
  console.log(`Median queue wait:     ${formatMs(median(queues))}`)
  console.log(`Max queue wait:        ${formatMs(queues.length ? Math.max(...queues) : null)}`)
  console.log(``)
  console.log(`Average execution:     ${formatMs(average(execs))}`)
  console.log(`Median execution:      ${formatMs(median(execs))}`)
  console.log(`Max execution:         ${formatMs(execs.length ? Math.max(...execs) : null)}`)

  // ── Aggregate timing breakdown (from result.timing) ───────────────────────
  const timingRecords = records.filter((r) => r.result?.timing?.totalExecutionMs != null)
  if (timingRecords.length > 0) {
    const pick = (field) => timingRecords.map((r) => r.result.timing[field]).filter((v) => v !== null && Number.isFinite(v))
    const containerTimes = pick('containerStartMs')
    const pubgetTimes    = pick('dependencyResolutionMs')
    const analyzeTimes   = pick('analyzeMs')
    const parseTimes     = pick('resultParseMs')
    const totalTimes     = pick('totalExecutionMs')

    console.log(``)
    console.log(`Worker-side timing breakdown (${timingRecords.length}/${records.length} jobs with timing data):`)
    console.log(`                       Avg          Median       Max`)
    const row = (label, vals) =>
      console.log(`  ${label.padEnd(20)} ${formatMs(average(vals)).padStart(12)} ${formatMs(median(vals)).padStart(12)} ${formatMs(vals.length ? Math.max(...vals) : null).padStart(12)}`)
    row('Container start',   containerTimes)
    row('Pub get / cache',   pubgetTimes)
    row('flutter analyze',   analyzeTimes)
    row('Result parse',      parseTimes)
    row('Total (worker)',    totalTimes)

    // Dominant phase identification
    const avgContainer = average(containerTimes) ?? 0
    const avgPubget    = average(pubgetTimes)    ?? 0
    const avgAnalyze   = average(analyzeTimes)   ?? 0
    const avgTotal     = average(totalTimes)     ?? 1
    const dominant = [
      { name: 'Container start', pct: avgContainer / avgTotal },
      { name: 'Pub get / cache', pct: avgPubget    / avgTotal },
      { name: 'flutter analyze', pct: avgAnalyze   / avgTotal },
    ].sort((a, b) => b.pct - a.pct)[0]
    if (dominant) {
      console.log(``)
      console.log(`  Dominant phase: ${dominant.name} (${(dominant.pct * 100).toFixed(0)}% of avg worker-side total)`)
    }
  }

  console.log(``)
  console.log(`Throughput:            ${(records.length / (duration / 1000)).toFixed(2)} jobs/sec`)
  console.log(``)
  console.log(`NOTE: RUN is analyze-only (§2). flutter build web is NOT part of this test.`)
  console.log(`      Benchmark only validates that flutter analyze meets exam time budgets.`)
  console.log(`Result: ${failed.length === 0 ? 'PASS ✓' : `FAIL ✗ (${failed.length} unexpected failures)`}`)
  console.log(LINE)
  return failed.length === 0
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function runWave(waveNumber, deadline) {
  console.log(`\n── Wave ${waveNumber}/${waves}: submitting ${students} students to ${apiUrl} ──`)
  const records = await Promise.all(
    Array.from({ length: students }, (_, i) => submitJob(i + 1, waveNumber, deadline)),
  )
  const accepted = records.filter((r) => r.jobId).length
  console.log(`Accepted ${accepted}/${students}. Polling every ${pollIntervalMs}ms...`)
  await Promise.all(records.map((r) => pollJob(r, deadline)))
  return records
}

async function main() {
  const startedAt = Date.now()
  const deadline  = startedAt + globalTimeoutMs

  console.log(`Flutter Compiler Load Test`)
  console.log(`API: ${apiUrl}  Run: ${runId}  Students/wave: ${students}  Waves: ${waves}  Poll: ${pollIntervalMs}ms`)

  const allRecords = []

  for (let w = 1; w <= waves; w++) {
    const waveRecords = await runWave(w, deadline)
    allRecords.push(...waveRecords)

    if (w < waves) {
      console.log(`Waiting ${waveIntervalMs}ms before next wave...`)
      await sleep(Math.min(waveIntervalMs, Math.max(0, deadline - Date.now())))
    }
  }

  const finishedAt = Date.now()
  printRecords(allRecords)
  const passed = printSummary(allRecords, startedAt, finishedAt)

  const unfinished = allRecords.filter((r) => r.state === 'global_timeout').map((r) => r.jobId).filter(Boolean)
  if (unfinished.length) console.error(`Unfinished jobs: ${unfinished.join(', ')}`)

  process.exitCode = passed ? 0 : 1
}

main().catch((err) => {
  console.error(`Load test failed to start: ${err.message}`)
  process.exitCode = 1
})
