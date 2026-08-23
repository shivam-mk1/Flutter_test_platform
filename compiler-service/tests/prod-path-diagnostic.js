'use strict'

/**
 * tests/prod-path-diagnostic.js
 *
 * Diagnostic runner that imports and invokes the REAL production worker function:
 *   executeJob(job, options) from worker/src/index.js
 *
 * Executes under exact production configuration:
 *   - Dockerode createContainer with named volume, CapDrop ALL, tmpfs mounts,
 *     memory limits, CPU limits, no-new-privileges, etc.
 *   - Docker modem stream demuxing
 *   - Production output parsing & timing calculation
 */

require('dotenv').config()
const { executeJob } = require('../worker/src/index')

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

async function main() {
  console.log('='.repeat(70))
  console.log(' Diagnostic: Running Real Production Worker Code Path')
  console.log('='.repeat(70))
  console.log(`Node environment memory: ${process.env.SANDBOX_MEMORY_MB || '1024'}MB`)
  console.log(`Node environment CPU:    ${process.env.SANDBOX_NANO_CPUS ? (parseInt(process.env.SANDBOX_NANO_CPUS) / 1e9) + ' CPU' : 'default'}`)

  // ── 1. Standard Production Run (executing sandbox-run: pub get -> flutter analyze) ──
  console.log('\n[1/2] Executing standard job via production `executeJob`...')
  const standardJob = {
    id: `prod-diag-${Date.now()}`,
    data: {
      studentId: 'diag-student-1',
      questionId: 'diag-q-1',
      revision: 1,
      files: [{ path: 'lib/main.dart', content: MAIN_DART_VALID }],
      timeoutMs: 90000,
      examEnvVersion: 'v1',
    }
  }

  const standardResult = await executeJob(standardJob)

  console.log('\n--- Standard Job Result ---')
  console.log(`Status:    ${standardResult.status}`)
  console.log(`Phase:     ${standardResult.phase}`)
  console.log(`Exit code: ${standardResult.exitCode}`)
  console.log('Timing block:', JSON.stringify(standardResult.timing, null, 2))
  console.log('Stdout (first 500 chars):', (standardResult.stdout || '').slice(0, 500))
  if (standardResult.stderr) {
    console.log('Stderr:', standardResult.stderr)
  }

  // ── 2. Verbose Production Run (executing flutter analyze -v) ─────────────────
  console.log('\n[2/2] Executing verbose job via production `executeJob` (cmdOverride: flutter analyze -v)...')
  const verboseJob = {
    id: `prod-diag-v-${Date.now()}`,
    data: {
      studentId: 'diag-student-2',
      questionId: 'diag-q-1',
      revision: 2,
      files: [{ path: 'lib/main.dart', content: MAIN_DART_VALID }],
      timeoutMs: 90000,
      examEnvVersion: 'v1',
    }
  }

  const verboseResult = await executeJob(verboseJob, {
    cmdOverride: ['sh', '-c', 'cd "$WORKSPACE" && flutter pub get --offline >/dev/null 2>&1 && flutter analyze -v']
  })

  console.log('\n--- Verbose Job Result ---')
  console.log(`Status:    ${verboseResult.status}`)
  console.log(`Phase:     ${verboseResult.phase}`)
  console.log(`Exit code: ${verboseResult.exitCode}`)
  console.log('Timing block:', JSON.stringify(verboseResult.timing, null, 2))

  console.log('\n' + '='.repeat(70))
  console.log(' SUMMARY & VERBOSE LOG BREAKDOWN')
  console.log('='.repeat(70))
  console.log('Standard run timing summary:')
  if (standardResult.timing) {
    console.log(`  containerStartMs:       ${standardResult.timing.containerStartMs}ms`)
    console.log(`  totalContainerMs:       ${standardResult.timing.totalContainerMs}ms`)
    console.log(`  dependencyResolutionMs: ${standardResult.timing.dependencyResolutionMs}ms`)
    console.log(`  analyzeMs:              ${standardResult.timing.analyzeMs}ms`)
    console.log(`  totalExecutionMs:       ${standardResult.timing.totalExecutionMs}ms`)
  }

  console.log('\nVerbose stdout:')
  console.log(verboseResult.stdout || '(empty stdout)')
  if (verboseResult.stderr) {
    console.log('\nVerbose stderr:')
    console.log(verboseResult.stderr)
  }
}

main().catch((err) => {
  console.error('Diagnostic error:', err)
  process.exit(1)
})
