const fs = require('fs')
const path = require('path')
const os = require('os')
const { execSync, spawn } = require('child_process')
const { performance } = require('perf_hooks')
const { generatePubspec, generateAnalysisOptions } = require('../shared/pubspec')

const SANDBOX_IMAGE = process.env.DOCKER_SANDBOX_IMAGE || 'exam-platform/flutter-sandbox:v1'

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

function runCommand(cmd, args, options = {}) {
  return new Promise((resolve, reject) => {
    const start = performance.now()
    const proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...options })
    let stdout = ''
    let stderr = ''

    proc.stdout.on('data', (d) => { stdout += d.toString() })
    proc.stderr.on('data', (d) => { stderr += d.toString() })

    proc.on('close', (code) => {
      const durationMs = Math.round(performance.now() - start)
      resolve({ code, stdout, stderr, durationMs })
    })

    proc.on('error', reject)
  })
}

async function runContainerTest(memMb, cpu = '0.5', numRuns = 6) {
  const containerName = `flutter-warm-test-${memMb}mb-${Date.now()}`
  console.log('\n' + '='.repeat(70))
  console.log(` Running Benchmark in Container: Memory = ${memMb}MB, CPU = ${cpu}`)
  console.log('='.repeat(70))

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `warm-test-${memMb}m-`))
  const libDir = path.join(tmpDir, 'lib')
  fs.mkdirSync(libDir, { recursive: true })

  fs.writeFileSync(path.join(tmpDir, 'pubspec.yaml'), generatePubspec('exam_project'), 'utf8')
  fs.writeFileSync(path.join(tmpDir, 'analysis_options.yaml'), generateAnalysisOptions(), 'utf8')
  fs.writeFileSync(path.join(libDir, 'main.dart'), MAIN_DART_VALID, 'utf8')

  try {
    const tmpfsMb = memMb <= 256 ? 64 : 128
    const runArgs = [
      'run', '-d',
      '--name', containerName,
      '--user', 'sandbox',
      '-e', 'PUB_CACHE=/exam-pub-cache',
      '-e', 'HOME=/tmp',
      '-e', 'XDG_CONFIG_HOME=/tmp/config',
      '-e', 'FLUTTER_CONFIG_DIR=/tmp/flutter-config',
      '-e', 'CI=true',
      '-e', 'WORKSPACE=/workspace',
      '-e', 'FLUTTER_SUPPRESS_ANALYTICS=true',
      '--tmpfs', `/tmp:rw,nosuid,size=${tmpfsMb}m`,
      '--tmpfs', '/home/sandbox:rw,noexec,nosuid,size=8m',
      `--memory=${memMb}m`,
      `--memory-swap=${memMb}m`,
      `--cpus=${cpu}`,
      '--pids-limit=256',
      '--network=none',
      '--cap-drop=ALL',
      '--security-opt=no-new-privileges:true',
      '-w', '/workspace',
      SANDBOX_IMAGE,
      'sleep', 'infinity'
    ]

    console.log(`[1/4] Starting sandbox container (${containerName})...`)
    execSync(`docker ${runArgs.join(' ')}`, { stdio: 'pipe' })

    console.log('[2/4] Copying project files into container /workspace...')
    execSync(`docker cp "${tmpDir}/." ${containerName}:/workspace/`, { stdio: 'pipe' })

    console.log('[3/4] Running initial `flutter pub get --offline`...')
    const pubGetRes = await runCommand('docker', [
      'exec',
      '--user', 'sandbox',
      '-w', '/workspace',
      containerName,
      'flutter', 'pub', 'get', '--offline'
    ])
    console.log(`      pub get completed in ${pubGetRes.durationMs}ms (exit code ${pubGetRes.code})`)
    if (pubGetRes.code !== 0) {
      console.error('pub get stderr:', pubGetRes.stderr)
      throw new Error(`pub get failed with exit code ${pubGetRes.code}`)
    }

    console.log(`\n[4/4] Executing ${numRuns} consecutive \`flutter analyze\` runs...`)
    const runs = []

    for (let i = 1; i <= numRuns; i++) {
      process.stdout.write(`      Run ${i}... `)
      const res = await runCommand('docker', [
        'exec',
        '--user', 'sandbox',
        '-w', '/workspace',
        containerName,
        'flutter', 'analyze'
      ])
      process.stdout.write(`done in ${res.durationMs.toLocaleString()}ms (exit ${res.code})\n`)
      runs.push({
        runNumber: i,
        analyzeMs: res.durationMs,
        exitCode: res.code,
        stdout: res.stdout,
        stderr: res.stderr
      })
    }

    // Run verbose analyze once
    console.log('\n[+] Executing `flutter analyze -v` in warm container...')
    const verboseRes = await runCommand('docker', [
      'exec',
      '--user', 'sandbox',
      '-w', '/workspace',
      containerName,
      'flutter', 'analyze', '-v'
    ])
    console.log(`    Verbose analyze completed in ${verboseRes.durationMs.toLocaleString()}ms (exit ${verboseRes.code})`)

    return { memMb, cpu, runs, verboseRes }
  } finally {
    try {
      execSync(`docker rm -f ${containerName}`, { stdio: 'pipe' })
    } catch (_) {}
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    } catch (_) {}
  }
}

async function main() {
  console.log('='.repeat(70))
  console.log(' Diagnostic: Plateau Finding, Verbose Breakdown & Memory Comparison')
  console.log('='.repeat(70))
  console.log(`Sandbox image: ${SANDBOX_IMAGE}`)

  // Part 1 & 2: 1024MB
  const result1024 = await runContainerTest(1024, '0.5', 6)

  // Part 3: 256MB
  const result256 = await runContainerTest(256, '0.5', 6)

  // Output Comparison Table
  console.log('\n' + '='.repeat(70))
  console.log(' PART 1 & PART 3: 6-RUN TIMING COMPARISON (1024MB vs 256MB)')
  console.log('='.repeat(70))
  console.log('Run #    1024MB RAM (analyzeMs)    256MB RAM (analyzeMs)    Delta / Note')
  console.log('-'.repeat(70))
  for (let i = 0; i < 6; i++) {
    const r1 = result1024.runs[i]
    const r2 = result256.runs[i]
    const delta = r2 ? (r2.analyzeMs - r1.analyzeMs) : 'N/A'
    const note = r2.exitCode !== 0 ? ` [EXIT ${r2.exitCode} / CRASH]` : (delta > 0 ? `+${delta}ms` : `${delta}ms`)
    console.log(
      `${i + 1}`.padEnd(9) +
      `${r1.analyzeMs.toLocaleString()}ms`.padEnd(26) +
      `${r2.analyzeMs.toLocaleString()}ms`.padEnd(25) +
      note
    )
  }

  // Part 2: Verbose Output Dump & Analysis
  console.log('\n' + '='.repeat(70))
  console.log(' PART 2: VERBOSE OUTPUT BREAKDOWN (from 1024MB warm container)')
  console.log('='.repeat(70))
  console.log(result1024.verboseRes.stdout.trim() || '(empty stdout)')
  if (result1024.verboseRes.stderr.trim()) {
    console.log('\n--- Verbose Stderr ---')
    console.log(result1024.verboseRes.stderr.trim())
  }
}

main().catch((err) => {
  console.error('Benchmark error:', err)
  process.exit(1)
})
