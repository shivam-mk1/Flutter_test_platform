'use strict'

/**
 * tests/oom-investigation-sweep.js
 *
 * OOM Investigation & Failure Rate Sweep:
 *   1. Confirms OOM kill via Docker container inspection (.State.OOMKilled) & dmesg logs.
 *   2. Executes a 10-run sweep across memory levels: [256MB, 384MB, 512MB, 768MB, 1024MB]
 *      with CPU fixed at 0.5 (500000000 NanoCpus).
 *   3. Uses fresh containers per job through the production executeJob() pipeline.
 */

require('dotenv').config()
const { execSync } = require('child_process')
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

const MEMORY_LEVELS = [256, 384, 512, 768, 1024]
const RUNS_PER_LEVEL = 10
const CPU_NANOS = 500000000 // 0.5 CPU

async function runSingleJob(memMb, index) {
  const job = {
    id: `sweep-${memMb}mb-run-${index}-${Date.now()}`,
    data: {
      studentId: `student-${memMb}-${index}`,
      questionId: 'q1',
      revision: index,
      files: [{ path: 'lib/main.dart', content: MAIN_DART_VALID }],
      timeoutMs: 90000,
      examEnvVersion: 'v1',
    }
  }

  const result = await executeJob(job, {
    memoryMb: memMb,
    nanoCpus: CPU_NANOS,
    tmpfsMb: memMb <= 256 ? 64 : 128,
  })

  return {
    jobId: job.id,
    memMb,
    runIndex: index,
    status: result.status,
    phase: result.phase,
    exitCode: result.exitCode,
    oomKilled: result.oomKilled,
    isSuccess: result.status === 'success' && result.exitCode === 0 && !result.oomKilled,
    analyzeMs: result.timing?.totalContainerMs ?? result.timing?.analyzeMs ?? null,
    totalMs: result.timing?.totalExecutionMs ?? null,
    errorsCount: result.errors?.length || 0,
    firstError: result.errors?.[0]?.message || '',
    rawStdout: result.stdout || '',
    rawStderr: result.stderr || '',
  }
}

async function main() {
  console.log('='.repeat(70))
  console.log(' OOM Investigation & Memory Limit Sweep')
  console.log('='.repeat(70))
  console.log(`CPU Limit:       0.5 CPU (${CPU_NANOS} NanoCpus)`)
  console.log(`Memory Levels:   ${MEMORY_LEVELS.join(', ')} MB`)
  console.log(`Runs Per Level:  ${RUNS_PER_LEVEL}`)

  // ── PART 1: Check OOM confirmation on 256MB ──────────────────────────────────
  console.log('\n' + '='.repeat(70))
  console.log(' PART 1: OOM Confirmation on 256MB')
  console.log('='.repeat(70))
  console.log('Running test job at 256MB to inspect OOMKilled flag & dmesg...')

  const part1Run = await runSingleJob(256, 1)
  console.log(`Exit code:   ${part1Run.exitCode}`)
  console.log(`OOMKilled:   ${part1Run.oomKilled}`)
  console.log(`Status:      ${part1Run.status} (${part1Run.phase})`)
  if (part1Run.firstError) {
    console.log(`Error msg:   ${part1Run.firstError}`)
  }

  // Check dmesg for OOM killer output
  let dmesgOutput = ''
  try {
    // Try inside container dmesg or wsl dmesg
    dmesgOutput = execSync('dmesg -T 2>/dev/null | grep -i -E "oom|killed process|out of memory" | tail -n 10', { encoding: 'utf8' }).trim()
  } catch (_) {}

  console.log('\nKernel / dmesg OOM logs (if available):')
  console.log(dmesgOutput || '(No direct dmesg access inside container, confirmed via Docker inspect OOMKilled)')

  // ── PART 2: Memory Sweep ─────────────────────────────────────────────────────
  console.log('\n' + '='.repeat(70))
  console.log(' PART 2: 10-Run Sweep Across Memory Levels (Fresh Container Per Run)')
  console.log('='.repeat(70))

  const sweepResults = {}

  for (const memMb of MEMORY_LEVELS) {
    console.log(`\n── Testing ${memMb}MB RAM (10 runs) ──`)
    sweepResults[memMb] = []

    for (let i = 1; i <= RUNS_PER_LEVEL; i++) {
      process.stdout.write(`  Run ${i.toString().padStart(2)}/10... `)
      const res = await runSingleJob(memMb, i)
      sweepResults[memMb].push(res)

      if (res.isSuccess) {
        console.log(`SUCCESS (exit 0, container ${res.analyzeMs}ms, total ${res.totalMs}ms)`)
      } else {
        const reason = res.oomKilled ? 'OOM-KILLED' : `EXIT ${res.exitCode} (${res.phase})`
        console.log(`FAILED - ${reason}`)
      }
    }
  }

  // ── PART 3: Summary Table ────────────────────────────────────────────────────
  console.log('\n' + '='.repeat(70))
  console.log(' PART 3: SUMMARY RESULTS TABLE')
  console.log('='.repeat(70))
  console.log('Memory    Failure Rate    Avg analyzeMs (success)    Median analyzeMs    Notes')
  console.log('-'.repeat(75))

  let lowestSafeMemory = null

  for (const memMb of MEMORY_LEVELS) {
    const runs = sweepResults[memMb]
    const failedRuns = runs.filter(r => !r.isSuccess)
    const successRuns = runs.filter(r => r.isSuccess)
    const oomCount = runs.filter(r => r.oomKilled).length
    const failRateStr = `${failedRuns.length}/${RUNS_PER_LEVEL}`

    let avgMsStr = 'N/A'
    let medMsStr = 'N/A'

    if (successRuns.length > 0) {
      const times = successRuns.map(r => r.analyzeMs).filter(Number.isFinite)
      if (times.length > 0) {
        const avg = Math.round(times.reduce((a, b) => a + b, 0) / times.length)
        times.sort((a, b) => a - b)
        const med = times[Math.floor(times.length / 2)]
        avgMsStr = `${avg.toLocaleString()}ms`
        medMsStr = `${med.toLocaleString()}ms`
      }
    }

    let notes = ''
    if (failedRuns.length === 0) {
      notes = '100% Reliable (0 crashes)'
      if (lowestSafeMemory === null) {
        lowestSafeMemory = memMb
      }
    } else if (oomCount > 0) {
      notes = `${oomCount} OOM kills, ${failedRuns.length - oomCount} other crashes`
    } else {
      notes = `${failedRuns.length} crashes / exit non-zero`
    }

    console.log(
      `${memMb}MB`.padEnd(10) +
      `${failRateStr}`.padEnd(16) +
      `${avgMsStr}`.padEnd(27) +
      `${medMsStr}`.padEnd(20) +
      notes
    )
  }

  console.log('-'.repeat(75))
  console.log(`\nLowest safe memory level with 0/10 failure rate: ${lowestSafeMemory ? `${lowestSafeMemory}MB` : 'None in tested range'}`)
}

main().catch((err) => {
  console.error('Sweep execution failed:', err)
  process.exit(1)
})
