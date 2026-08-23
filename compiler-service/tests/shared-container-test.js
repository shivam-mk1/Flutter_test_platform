'use strict'

/**
 * tests/shared-container-test.js
 *
 * Runs student workloads inside a SINGLE shared container, reusing it across
 * all jobs. This is the WARM-CONTAINER model - the opposite of what production
 * does (fresh container per job).
 *
 * Each job runs the exact production entrypoint (/usr/local/bin/sandbox-run)
 * via docker exec, so the environment is identical to production. The only
 * difference is the container is reused, not discarded after each job.
 *
 * Use this to measure:
 *   - How much time is saved once the Dart analysis server has warmed up
 *   - The floor timing per job when cold-start overhead is amortized
 *
 * Compare against load-test.js (fresh container per job, ~58s each).
 *
 * Usage:
 *   node tests/shared-container-test.js
 *   node tests/shared-container-test.js --students=3    N jobs, cycling workloads (like load-test.js)
 *   node tests/shared-container-test.js --repeat=3      full workload set x R repetitions
 *   node tests/shared-container-test.js --memory=1024   container memory in MB (default: 1024)
 *   node tests/shared-container-test.js --cpu=1.0       cpu limit (default: 1.0)
 *
 * --students and --repeat are mutually exclusive; --students takes priority.
 */

require('dotenv').config()
const fs   = require('fs')
const path = require('path')
const os   = require('os')
const { spawnSync, execSync, spawn } = require('child_process')
const { performance } = require('perf_hooks')
const { generatePubspec, generateAnalysisOptions } = require('../shared/pubspec')
const { parseAnalyzeOutput } = require('../worker/src/parser')

// -- CLI args ------------------------------------------------------------------
const cliArgs = Object.fromEntries(
  process.argv.slice(2)
    .filter(a => a.startsWith('--'))
    .map(a => { const [k, v] = a.slice(2).split('='); return [k, v ?? 'true'] })
)
const MEMORY_MB    = parseInt(cliArgs.memory   || '1024', 10)
const CPU          = parseFloat(cliArgs.cpu    || '1.0')
const NUM_STUDENTS = cliArgs.students ? parseInt(cliArgs.students, 10) : null
const REPEAT       = cliArgs.repeat   ? parseInt(cliArgs.repeat,   10) : 1

const SANDBOX_IMAGE  = process.env.DOCKER_SANDBOX_IMAGE || 'exam-platform/flutter-sandbox:v1'
const CONTAINER_NAME = `flutter-shared-${Date.now()}`

// -- Workloads ----------------------------------------------------------------
const WORKLOADS = [
  {
    name: 'valid-simple',
    expectSuccess: true,
    files: { 'lib/main.dart': `import 'package:flutter/material.dart';
void main() { runApp(const MyApp()); }
class MyApp extends StatelessWidget {
  const MyApp({super.key});
  @override
  Widget build(BuildContext context) {
    return const MaterialApp(title: 'Exam App', home: Scaffold(body: Center(child: Text('Hello!'))));
  }
}
` },
  },
  {
    name: 'type-mismatch',
    expectSuccess: false,
    files: { 'lib/main.dart': `import 'package:flutter/material.dart';
void main() { runApp(const MyApp()); }
class MyApp extends StatelessWidget {
  const MyApp({super.key});
  @override
  Widget build(BuildContext context) {
    int count = 'not a number';
    return MaterialApp(home: Scaffold(body: Text(count.toString())));
  }
}
` },
  },
  {
    name: 'undefined-method',
    expectSuccess: false,
    files: { 'lib/main.dart': `import 'package:flutter/material.dart';
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
` },
  },
  {
    name: 'valid-stateful',
    expectSuccess: true,
    files: { 'lib/main.dart': `import 'package:flutter/material.dart';
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
` },
  },
  {
    name: 'missing-required-argument',
    expectSuccess: false,
    files: { 'lib/main.dart': `import 'package:flutter/material.dart';
void main() { runApp(const MaterialApp(home: Scaffold(body: Text()))); }
` },
  },
  {
    name: 'invalid-return-type',
    expectSuccess: false,
    files: { 'lib/main.dart': `import 'package:flutter/material.dart';
String heading() => 42;
void main() { runApp(MaterialApp(home: Scaffold(body: Text(heading())))); }
` },
  },
  {
    name: 'undefined-widget',
    expectSuccess: false,
    files: { 'lib/main.dart': `import 'package:flutter/material.dart';
void main() { runApp(const MaterialApp(home: Scaffold(body: NotAWidget()))); }
` },
  },
  {
    name: 'valid-layout',
    expectSuccess: true,
    files: { 'lib/main.dart': `import 'package:flutter/material.dart';
void main() {
  runApp(const MaterialApp(
    home: Scaffold(body: SafeArea(child: Padding(
      padding: EdgeInsets.all(24),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start,
        children: [Text('Exam dashboard'), SizedBox(height: 8), Text('Ready')]),
    ))),
  ));
}
` },
  },
]

// -- Helpers ------------------------------------------------------------------

function writeWorkload(workload, containerName) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `shared-wl-${workload.name}-`))
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

/**
 * Run the production sandbox-run entrypoint via docker exec.
 *
 * We run sandbox-run (not flutter analyze directly) because flutter analyze
 * internally forks the Dart analysis server and communicates with it via
 * a stdin/stdout pipe. When docker exec runs with stdio:'ignore', the server
 * reads EOF on that internal pipe immediately and the whole thing deadlocks.
 * Running sandbox-run as a shell entrypoint gives it a proper pipe context.
 * sandbox-run also handles git safe.directory config automatically.
 *
 * Trade-off: each job pays ~3-5s extra for pub get (sandbox-run runs it).
 */
function runSandboxExec(containerName, timeoutMs = 180000) {
  return new Promise((resolve) => {
    const start = performance.now()
    const proc  = spawn('docker', [
      'exec',
      '--user', 'sandbox',
      '-w', '/workspace',
      containerName,
      '/usr/local/bin/sandbox-run',
    ], {
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    // Close our stdin — we don't send input, but the pipe must exist
    // (not /dev/null) for the internal analysis server pipe to work.
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

// -- Main ---------------------------------------------------------------------

async function main() {
  console.log('='.repeat(68))
  console.log(' Shared-Container Test -- All Workloads in One Container')
  console.log('='.repeat(68))
  console.log(`Image:   ${SANDBOX_IMAGE}`)
  console.log(`Memory:  ${MEMORY_MB}MB    CPU: ${CPU}`)

  let jobQueue
  if (NUM_STUDENTS !== null) {
    jobQueue = Array.from({ length: NUM_STUDENTS }, (_, i) => WORKLOADS[i % WORKLOADS.length])
    console.log(`Mode:    --students=${NUM_STUDENTS} (${NUM_STUDENTS} jobs, cycling through ${WORKLOADS.length} workloads)`)
  } else {
    jobQueue = Array.from({ length: REPEAT }, () => WORKLOADS).flat()
    console.log(`Mode:    --repeat=${REPEAT} (${WORKLOADS.length} workloads x ${REPEAT} = ${jobQueue.length} total jobs)`)
  }
  console.log()

  // 1. Start long-lived container
  process.stdout.write('[1/2] Starting container... ')
  const startResult = spawnSync('docker', [
    'run', '-d',
    '--name', CONTAINER_NAME,
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

  if (startResult.status !== 0) {
    throw new Error(`Failed to start container:\n${startResult.stderr}`)
  }
  console.log(`OK (${CONTAINER_NAME})`)

  try {
    // 2. Run each job
    // Each job runs sandbox-run = pub get + analyze. First job is cold (~55s+);
    // subsequent jobs should be faster as Dart caches warm up.
    console.log(`[2/2] Running ${jobQueue.length} job(s)...\n`)
    console.log(
      ' #  Workload'.padEnd(32) +
      'totalMs'.padEnd(14) +
      'Exit'.padEnd(8) +
      'Expected'.padEnd(12) +
      'Result'
    )
    console.log('-'.repeat(78))

    const results = []
    for (let i = 0; i < jobQueue.length; i++) {
      const wl = jobQueue[i]
      process.stdout.write(`  ${String(i + 1).padStart(2)}  ${wl.name.padEnd(26)}`)

      writeWorkload(wl, CONTAINER_NAME)

      const { code, stdout, stderr, ms, timedOut } = await runSandboxExec(CONTAINER_NAME)

      const { errors } = parseAnalyzeOutput(stdout + '\n' + stderr, '/workspace')
      const isSuccess   = errors.length === 0 && code === 0
      const matchExpect = timedOut
        ? '✗ TIMEOUT'
        : isSuccess === wl.expectSuccess ? '✓' : '✗ UNEXPECTED'

      results.push({ name: wl.name, ms, code, isSuccess, expectSuccess: wl.expectSuccess, errors, timedOut })

      console.log(
        (timedOut ? '  TIMEOUT  ' : `${String(ms).padStart(8)}ms`).padEnd(14) +
        `${code}`.padEnd(8) +
        `${wl.expectSuccess ? 'success' : 'error  '}`.padEnd(12) +
        matchExpect
      )
    }

    // Summary
    console.log('\n' + '='.repeat(68))
    console.log(' SUMMARY')
    console.log('='.repeat(68))

    const valid  = results.filter(r => !r.timedOut)
    const times  = valid.map(r => r.ms)
    const avg    = times.length ? Math.round(times.reduce((a, b) => a + b, 0) / times.length) : 0
    const min    = times.length ? Math.min(...times) : 0
    const max    = times.length ? Math.max(...times) : 0
    const sorted = [...times].sort((a, b) => a - b)
    const med    = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0

    const unexpected   = results.filter(r => !r.timedOut && r.isSuccess !== r.expectSuccess)
    const timedOutJobs = results.filter(r => r.timedOut)

    console.log(`Total jobs:         ${results.length}`)
    console.log(`Timed out:          ${timedOutJobs.length}`)
    console.log(`Unexpected results: ${unexpected.length}${unexpected.length > 0 ? '  <- ' + unexpected.map(r => r.name).join(', ') : ''}`)
    console.log()
    console.log(`totalMs per job (sandbox-run = pub get + flutter analyze):`)
    console.log(`  Min:    ${min}ms`)
    console.log(`  Avg:    ${avg}ms`)
    console.log(`  Median: ${med}ms`)
    console.log(`  Max:    ${max}ms`)
    console.log()
    console.log(`Fresh-container baseline (load-test.js): ~58,000ms per job`)
    if (avg > 0) {
      console.log(`Warm speedup: ~${Math.round(58000 / avg)}x faster per job in shared container`)
    }

    if (unexpected.length > 0) {
      console.log('\nUnexpected result details:')
      for (const r of unexpected) {
        console.log(`  ${r.name}: expected ${r.expectSuccess ? 'success' : 'error'}, got ${r.isSuccess ? 'success' : 'error'} (exit ${r.code})`)
        if (r.errors.length) console.log(`    Errors: ${r.errors.map(e => e.message).slice(0, 3).join('; ')}`)
      }
    }

  } finally {
    spawnSync('docker', ['rm', '-f', CONTAINER_NAME], { stdio: 'pipe' })
    console.log(`\nContainer ${CONTAINER_NAME} removed.`)
  }
}

main().catch(err => {
  console.error('\nFatal error:', err.message || err)
  spawnSync('docker', ['rm', '-f', CONTAINER_NAME], { stdio: 'pipe' })
  process.exit(1)
})
