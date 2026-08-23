'use strict'

/**
 * tests/warm-pool-test.js
 *
 * Warm-Container Pool & Batch Execution Benchmark.
 *
 * Simulates a production architecture with N pre-warmed sandbox containers:
 *   1. Spawns N isolated sandbox containers.
 *   2. Pre-warms all N containers concurrently (running pub get + flutter analyze once).
 *   3. Executes student batches in parallel (Student 1 -> Container 1, Student 2 -> Container 2, etc.).
 *   4. Measures parallel execution time, individual latencies, correctness, and throughput.
 *   5. Cleans up all pool containers on completion.
 *
 * Usage:
 *   node tests/warm-pool-test.js --students=4
 *   node tests/warm-pool-test.js --students=4 --batches=2
 *   node tests/warm-pool-test.js --students=8 --memory=1024 --cpu=1.0
 *   node tests/warm-pool-test.js --students=4 --no-warmup  (measures parallel cold start)
 */

require('dotenv').config()
const fs = require('fs')
const path = require('path')
const os = require('os')
const { spawnSync, execSync, spawn } = require('child_process')
const { performance } = require('perf_hooks')
const { generatePubspec, generateAnalysisOptions } = require('../shared/pubspec')
const { parseAnalyzeOutput } = require('../worker/src/parser')

// ── CLI Arguments ─────────────────────────────────────────────────────────────
const cliArgs = Object.fromEntries(
  process.argv.slice(2)
    .filter(a => a.startsWith('--'))
    .map(a => {
      const [k, v] = a.slice(2).split('=')
      return [k, v ?? 'true']
    })
)

const NUM_STUDENTS = parseInt(cliArgs.students || '4', 10)
const NUM_BATCHES  = parseInt(cliArgs.batches  || '1', 10)
const MEMORY_MB    = parseInt(cliArgs.memory   || '1024', 10)
const CPU          = parseFloat(cliArgs.cpu    || '1.0')
const PRE_WARM     = cliArgs['no-warmup'] !== 'true' && cliArgs.warmup !== 'false'

const SANDBOX_IMAGE = process.env.DOCKER_SANDBOX_IMAGE || 'exam-platform/flutter-sandbox:v1'
const SESSION_ID    = Date.now()
const POOL_PREFIX   = `flutter-pool-${SESSION_ID}`

// ── Workload Fixtures ─────────────────────────────────────────────────────────
const WORKLOADS = [
  {
    name: 'valid-simple',
    expectSuccess: true,
    files: {
      'lib/main.dart': `import 'package:flutter/material.dart';
void main() { runApp(const MyApp()); }
class MyApp extends StatelessWidget {
  const MyApp({super.key});
  @override
  Widget build(BuildContext context) {
    return const MaterialApp(title: 'Exam App', home: Scaffold(body: Center(child: Text('Hello!'))));
  }
}
`,
    },
  },
  {
    name: 'type-mismatch',
    expectSuccess: false,
    files: {
      'lib/main.dart': `import 'package:flutter/material.dart';
void main() { runApp(const MyApp()); }
class MyApp extends StatelessWidget {
  const MyApp({super.key});
  @override
  Widget build(BuildContext context) {
    int count = 'not a number';
    return MaterialApp(home: Scaffold(body: Text(count.toString())));
  }
}
`,
    },
  },
  {
    name: 'undefined-method',
    expectSuccess: false,
    files: {
      'lib/main.dart': `import 'package:flutter/material.dart';
void main() { runApp(const MyApp()); }
class MyApp extends StatelessWidget {
  const MyApp({super.key});
  @override
  Widget build(BuildContext context) {
    const String label = 'hello';
    label.nonExistentMethod();
    return const MaterialApp(home: Scaffold());
  }
}
`,
    },
  },
  {
    name: 'valid-stateful',
    expectSuccess: true,
    files: {
      'lib/main.dart': `import 'package:flutter/material.dart';
void main() => runApp(const MyApp());
class MyApp extends StatelessWidget {
  const MyApp({super.key});
  @override
  Widget build(BuildContext context) => const MaterialApp(home: MyHomePage(title: 'Counter'));
}
class MyHomePage extends StatefulWidget {
  const MyHomePage({super.key, required this.title});
  final String title;
  @override State<MyHomePage> createState() => _MyHomePageState();
}
class _MyHomePageState extends State<MyHomePage> {
  int _counter = 0;
  void _increment() { setState(() { _counter++; }); }
  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: Text(widget.title)),
      body: Center(child: Text('Count: $_counter')),
      floatingActionButton: FloatingActionButton(onPressed: _increment, child: const Icon(Icons.add)),
    );
  }
}
`,
    },
  },
  {
    name: 'missing-required-argument',
    expectSuccess: false,
    files: {
      'lib/main.dart': `import 'package:flutter/material.dart';
void main() { runApp(const MaterialApp(home: Scaffold(body: Text()))); }
`,
    },
  },
  {
    name: 'invalid-return-type',
    expectSuccess: false,
    files: {
      'lib/main.dart': `import 'package:flutter/material.dart';
String heading() => 42;
void main() { runApp(MaterialApp(home: Scaffold(body: Text(heading())))); }
`,
    },
  },
  {
    name: 'undefined-widget',
    expectSuccess: false,
    files: {
      'lib/main.dart': `import 'package:flutter/material.dart';
void main() { runApp(const MaterialApp(home: Scaffold(body: NotAWidget()))); }
`,
    },
  },
  {
    name: 'valid-layout',
    expectSuccess: true,
    files: {
      'lib/main.dart': `import 'package:flutter/material.dart';
void main() {
  runApp(const MaterialApp(
    home: Scaffold(body: SafeArea(child: Padding(
      padding: EdgeInsets.all(24),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start,
        children: [Text('Exam dashboard'), SizedBox(height: 8), Text('Ready')]),
    ))),
  ));
}
`,
    },
  },
]

// ── Container & Execution Helpers ─────────────────────────────────────────────

const activeContainers = []

function cleanupAllContainers() {
  if (activeContainers.length === 0) return
  process.stdout.write(`\nCleaning up ${activeContainers.length} container(s)... `)
  for (const name of activeContainers) {
    try {
      spawnSync('docker', ['rm', '-f', name], { stdio: 'pipe' })
    } catch (_) {}
  }
  activeContainers.length = 0
  console.log('done.')
}

process.on('SIGINT', () => { cleanupAllContainers(); process.exit(130) })
process.on('SIGTERM', () => { cleanupAllContainers(); process.exit(143) })

function startPoolContainer(name) {
  const result = spawnSync('docker', [
    'run', '-d',
    '--name', name,
    '--user', 'sandbox',
    '-e', 'PUB_CACHE=/exam-pub-cache',
    '-e', 'HOME=/tmp',
    '-e', 'XDG_CONFIG_HOME=/tmp/config',
    '-e', 'FLUTTER_CONFIG_DIR=/tmp/flutter-config',
    '-e', 'CI=true',
    '-e', 'FLUTTER_SUPPRESS_ANALYTICS=true',
    '--tmpfs', `/tmp:rw,nosuid,size=${MEMORY_MB <= 512 ? 64 : 128}m`,
    '--tmpfs', '/home/sandbox:rw,noexec,nosuid,size=8m',
    `--memory=${MEMORY_MB}m`,
    `--memory-swap=${MEMORY_MB}m`,
    `--cpus=${CPU}`,
    '--pids-limit=256',
    '--network=none',
    '--cap-drop=ALL',
    '--security-opt=no-new-privileges:true',
    '-w', '/workspace',
    SANDBOX_IMAGE,
    'sleep', 'infinity',
  ], { stdio: 'pipe', encoding: 'utf8' })

  if (result.status !== 0) {
    throw new Error(`Failed to start container ${name}: ${result.stderr}`)
  }
  activeContainers.push(name)
}

function writeWorkloadToContainer(workload, containerName) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `pool-wl-${workload.name}-`))
  try {
    fs.writeFileSync(path.join(tmpDir, 'pubspec.yaml'), generatePubspec('exam_project'), 'utf8')
    fs.writeFileSync(path.join(tmpDir, 'analysis_options.yaml'), generateAnalysisOptions(), 'utf8')
    for (const [filePath, content] of Object.entries(workload.files)) {
      const dest = path.join(tmpDir, filePath.replace(/\//g, path.sep))
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      fs.writeFileSync(dest, content, 'utf8')
    }
    execSync(`docker cp "${tmpDir}/." ${containerName}:/workspace/`, { stdio: 'pipe' })
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
}

function runSandboxExec(containerName, timeoutMs = 180000) {
  return new Promise((resolve) => {
    const start = performance.now()
    const proc = spawn('docker', [
      'exec',
      '--user', 'sandbox',
      '-w', '/workspace',
      containerName,
      '/usr/local/bin/sandbox-run',
    ], {
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    proc.stdin.end()

    let stdout = ''
    let stderr = ''
    proc.stdout.on('data', d => { stdout += d })
    proc.stderr.on('data', d => { stderr += d })

    const timer = setTimeout(() => {
      proc.kill('SIGKILL')
      resolve({ code: -1, stdout, stderr, ms: Math.round(performance.now() - start), timedOut: true })
    }, timeoutMs)

    proc.on('close', code => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr, ms: Math.round(performance.now() - start), timedOut: false })
    })
  })
}

// ── Main Test Runner ──────────────────────────────────────────────────────────

async function main() {
  console.log('='.repeat(72))
  console.log(' Warm-Container Pool & Batch Execution Benchmark')
  console.log('='.repeat(72))
  console.log(`Pool Size (Concurrent Students): ${NUM_STUDENTS}`)
  console.log(`Total Batches:                   ${NUM_BATCHES}`)
  console.log(`Per-Container Memory:            ${MEMORY_MB}MB`)
  console.log(`Per-Container CPU:               ${CPU} core(s)`)
  console.log(`Pre-Warm Pool:                   ${PRE_WARM ? 'YES (5 different code samples per container)' : 'NO'}`)
  console.log(`Image:                           ${SANDBOX_IMAGE}`)
  console.log()

  const poolContainers = Array.from({ length: NUM_STUDENTS }, (_, i) => `${POOL_PREFIX}-${i + 1}`)

  try {
    // ── Phase 1: Launch Containers in Pool ────────────────────────────────────
    process.stdout.write(`[1/3] Launching ${NUM_STUDENTS} pool container(s)... `)
    const launchStart = performance.now()
    for (const name of poolContainers) {
      startPoolContainer(name)
    }
    const launchMs = Math.round(performance.now() - launchStart)
    console.log(`done in ${launchMs}ms`)

    // ── Phase 2: Concurrent Pre-Warming (5 Different Codes) ─────────────────
    const WARMUP_CODES_COUNT = parseInt(cliArgs['warmup-runs'] || '5', 10)

    if (PRE_WARM && WARMUP_CODES_COUNT > 0) {
      console.log(`[2/3] Pre-warming all ${NUM_STUDENTS} container(s) with ${WARMUP_CODES_COUNT} different code samples in parallel...`)
      const warmStart = performance.now()

      const warmupPromises = poolContainers.map(async (cName, idx) => {
        const warmupLogs = []
        for (let wIdx = 0; wIdx < WARMUP_CODES_COUNT; wIdx++) {
          const sample = WORKLOADS[wIdx % WORKLOADS.length]
          writeWorkloadToContainer(sample, cName)
          const res = await runSandboxExec(cName)
          warmupLogs.push({ sampleName: sample.name, ms: res.ms, code: res.code })
        }
        return { container: cName, index: idx + 1, logs: warmupLogs }
      })

      const warmupResults = await Promise.all(warmupPromises)
      const totalWarmMs = Math.round(performance.now() - warmStart)

      // Print warmup breakdown per container
      for (const w of warmupResults) {
        const progression = w.logs.map((l, i) => `Run ${i + 1} (${l.sampleName}): ${(l.ms / 1000).toFixed(1)}s`).join(' -> ')
        console.log(`      Container #${w.index}: ${progression}`)
      }
      console.log(`      -> All ${NUM_STUDENTS} container(s) fully primed across ${WARMUP_CODES_COUNT} warmup runs in ${(totalWarmMs / 1000).toFixed(2)}s wall-clock time.\n`)
    } else {
      console.log('[2/3] Pre-warming skipped (containers are cold).\n')
    }

    // ── Phase 3: Execute Batches ──────────────────────────────────────────────
    console.log(`[3/3] Executing ${NUM_BATCHES} batch(es) of ${NUM_STUDENTS} student submissions...`)
    
    const allBatchMetrics = []

    for (let batchNum = 1; batchNum <= NUM_BATCHES; batchNum++) {
      console.log(`\n── Batch ${batchNum} of ${NUM_BATCHES} (${NUM_STUDENTS} concurrent students) ──────────────────`)
      console.log(
        ' Student'.padEnd(10) +
        'Workload'.padEnd(28) +
        'Duration'.padEnd(14) +
        'Exit'.padEnd(8) +
        'Expected'.padEnd(12) +
        'Result'
      )
      console.log('-'.repeat(78))

      const batchStart = performance.now()

      // Assign student workloads
      const studentJobs = poolContainers.map((containerName, sIdx) => {
        const globalStudentIndex = (batchNum - 1) * NUM_STUDENTS + sIdx
        const workload = WORKLOADS[globalStudentIndex % WORKLOADS.length]
        return {
          studentNumber: sIdx + 1,
          globalIndex: globalStudentIndex + 1,
          containerName,
          workload,
        }
      })

      // Stage files in each container
      for (const job of studentJobs) {
        writeWorkloadToContainer(job.workload, job.containerName)
      }

      // Execute all students concurrently across the warm pool
      const jobPromises = studentJobs.map(async (job) => {
        const execRes = await runSandboxExec(job.containerName)
        const combined = execRes.stdout + '\n' + execRes.stderr
        const { errors } = parseAnalyzeOutput(combined, '/workspace')
        const isSuccess = errors.length === 0 && execRes.code === 0
        const matchExpect = execRes.timedOut
          ? '✗ TIMEOUT'
          : isSuccess === job.workload.expectSuccess ? '✓' : '✗ UNEXPECTED'

        return {
          ...job,
          ms: execRes.ms,
          code: execRes.code,
          isSuccess,
          matchExpect,
          timedOut: execRes.timedOut,
          errors,
        }
      })

      const completedJobs = await Promise.all(jobPromises)
      const batchWallClockMs = Math.round(performance.now() - batchStart)

      // Sort by student number for clean printing
      completedJobs.sort((a, b) => a.studentNumber - b.studentNumber)

      for (const res of completedJobs) {
        console.log(
          ` #${res.studentNumber}`.padEnd(10) +
          `${res.workload.name}`.padEnd(28) +
          `${res.timedOut ? 'TIMEOUT' : res.ms + 'ms'}`.padEnd(14) +
          `${res.code}`.padEnd(8) +
          `${res.workload.expectSuccess ? 'success' : 'error'}`.padEnd(12) +
          res.matchExpect
        )
      }

      const validTimes = completedJobs.filter(j => !j.timedOut).map(j => j.ms)
      const avgJobMs = Math.round(validTimes.reduce((a, b) => a + b, 0) / validTimes.length)
      const maxJobMs = Math.max(...validTimes)
      const minJobMs = Math.min(...validTimes)

      console.log('-'.repeat(78))
      console.log(`Batch ${batchNum} Wall-Clock Duration: ${(batchWallClockMs / 1000).toFixed(2)}s (Min: ${minJobMs}ms, Avg: ${avgJobMs}ms, Max: ${maxJobMs}ms)`)
      console.log(`Throughput: ${(NUM_STUDENTS / (batchWallClockMs / 1000)).toFixed(2)} student submissions/sec`)

      allBatchMetrics.push({
        batchNum,
        wallClockMs: batchWallClockMs,
        jobs: completedJobs,
        avgJobMs,
        minJobMs,
        maxJobMs,
      })
    }

    // ── Overall Summary ───────────────────────────────────────────────────────
    console.log('\n' + '='.repeat(72))
    console.log(' OVERALL BENCHMARK SUMMARY')
    console.log('='.repeat(72))

    const allJobs = allBatchMetrics.flatMap(b => b.jobs)
    const validJobs = allJobs.filter(j => !j.timedOut)
    const allTimes = validJobs.map(j => j.ms)
    const grandAvg = Math.round(allTimes.reduce((a, b) => a + b, 0) / allTimes.length)
    const grandMin = Math.min(...allTimes)
    const grandMax = Math.max(...allTimes)
    const sorted = [...allTimes].sort((a, b) => a - b)
    const grandMed = sorted[Math.floor(sorted.length / 2)]
    const failures = allJobs.filter(j => j.matchExpect.includes('✗'))

    const totalBatchWallClockMs = allBatchMetrics.reduce((sum, b) => sum + b.wallClockMs, 0)
    const totalStudentsProcessed = allJobs.length

    console.log(`Total Students Processed:      ${totalStudentsProcessed}`)
    console.log(`Failed / Unexpected Results:   ${failures.length}`)
    console.log()
    console.log(`Per-Student Latency (Warm State):`)
    console.log(`  Fastest Student:             ${grandMin}ms (~${(grandMin / 1000).toFixed(2)}s)`)
    console.log(`  Median Student:              ${grandMed}ms (~${(grandMed / 1000).toFixed(2)}s)`)
    console.log(`  Average Student:             ${grandAvg}ms (~${(grandAvg / 1000).toFixed(2)}s)`)
    console.log(`  Slowest Student:             ${grandMax}ms (~${(grandMax / 1000).toFixed(2)}s)`)
    console.log()
    console.log(`Batch Wall-Clock Performance:`)
    console.log(`  Average Batch Duration:      ${(totalBatchWallClockMs / NUM_BATCHES / 1000).toFixed(2)}s for ${NUM_STUDENTS} parallel students`)
    console.log(`  Effective Throughput:        ${(totalStudentsProcessed / (totalBatchWallClockMs / 1000)).toFixed(2)} submissions / sec`)
    console.log()
    console.log(`Comparison against Ephemeral Fresh Container Baseline (~58s cold start):`)
    console.log(`  Single submission speedup:   ~${(58000 / grandAvg).toFixed(1)}x faster response time`)
    console.log(`  Batch of ${NUM_STUDENTS} sequential cold:   ~${((58000 * NUM_STUDENTS) / 1000).toFixed(0)}s total time`)
    console.log(`  Batch of ${NUM_STUDENTS} warm pool:         ~${(allBatchMetrics[0].wallClockMs / 1000).toFixed(1)}s total time`)

  } finally {
    cleanupAllContainers()
  }
}

main().catch(err => {
  console.error('\nFatal Benchmark Error:', err.message || err)
  cleanupAllContainers()
  process.exit(1)
})
