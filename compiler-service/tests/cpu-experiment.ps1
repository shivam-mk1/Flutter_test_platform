<#
.SYNOPSIS
  CPU-limit experiment for flutter analyze timing.

.DESCRIPTION
  Runs the 3-student load test at four CPU limits with EXEC_CONCURRENCY=1
  (one job at a time so concurrency is not a variable). Captures analyzeMs
  for each run and prints a summary table.

  Reverts to production default when done.

.EXAMPLE
  .\tests\cpu-experiment.ps1

.NOTES
  Prerequisites:
    - Docker Compose stack running (redis + compiler-api + compiler-worker)
    - Worker rebuilt after the timing-fix changes (docker compose build compiler-worker)
#>

$ErrorActionPreference = 'Continue'  # docker compose writes warnings to stderr; don't let them abort
Set-Location (Split-Path -Parent $MyInvocation.MyCommand.Path | Split-Path -Parent)
$ROOT = Get-Location

# Run docker compose silently — suppress the harmless "version attribute obsolete" warning
function Invoke-DockerCompose {
  $output = docker compose @args 2>&1
  $output | Where-Object { $_ -notmatch 'attribute `version` is obsolete' } |
    ForEach-Object { Write-Verbose $_ }
}

# ── Config ──────────────────────────────────────────────────────────────────────
$STUDENTS    = 3
$CONCURRENCY = 1   # one job at a time — isolates per-job CPU, removes contention
$API_URL     = $env:COMPILER_API_URL
if (-not $API_URL) { $API_URL = 'http://localhost:5000' }
$SERVICE_KEY = $env:COMPILER_SERVICE_API_KEY
if (-not $SERVICE_KEY) { $SERVICE_KEY = 'my-local-test-key' }

# CPU levels: NanoCpus value (0 = unrestricted / no limit)
$CPU_LEVELS = @(
  [PSCustomObject]@{ Label = '0.5 CPU (prod baseline)'; NanoCpus = '500000000'  },
  [PSCustomObject]@{ Label = '1.0 CPU';                 NanoCpus = '1000000000' },
  [PSCustomObject]@{ Label = '2.0 CPU';                 NanoCpus = '2000000000' },
  [PSCustomObject]@{ Label = 'Unrestricted';            NanoCpus = '0'          }
)

# Workload names in submission order (matches load-test.js workloadFor logic)
$WORKLOADS = @('valid-simple', 'type-mismatch', 'undefined-method')

# Output dir for raw logs
$LOG_DIR = Join-Path $ROOT 'tests\cpu-experiment-logs'
New-Item -ItemType Directory -Force -Path $LOG_DIR | Out-Null

Write-Host ''
Write-Host ('=' * 70)
Write-Host ' CPU-Limit Experiment — flutter analyze timing'
Write-Host " EXEC_CONCURRENCY=$CONCURRENCY  Students=$STUDENTS"
Write-Host ('=' * 70)

$allResults = @()

foreach ($level in $CPU_LEVELS) {
  $label    = $level.Label
  $nanoCpus = $level.NanoCpus
  $logFile  = Join-Path $LOG_DIR "cpu_$($nanoCpus)_nanocpu.txt"

  Write-Host ''
  Write-Host "-- Running: $label (SANDBOX_CPU_EXPERIMENT=$nanoCpus, EXEC_CONCURRENCY=$CONCURRENCY) --"

  # Set env vars before recreating the worker
  $env:SANDBOX_CPU_EXPERIMENT = $nanoCpus
  $env:EXEC_CONCURRENCY       = "$CONCURRENCY"

  Write-Host '  Restarting compiler-worker...'
  Invoke-DockerCompose up -d --force-recreate compiler-worker
  Start-Sleep -Seconds 4  # allow worker to start and print its startup lines

  # Show the cpu limit line from the worker log for confirmation
  $workerLog = docker compose logs compiler-worker --tail=10 2>&1 |
    Where-Object { $_ -notmatch 'attribute `version` is obsolete' }
  $cpuLine   = $workerLog | Where-Object { $_ -match 'cpu limit' } | Select-Object -First 1
  if ($cpuLine) { Write-Host "  $cpuLine" }

  # Run load test
  Write-Host '  Running load test (this takes ~30-90s per run)...'
  $testOutput = & node "$ROOT\tests\load-test.js" `
    "--students=$STUDENTS" `
    "--api=$API_URL" `
    "--key=$SERVICE_KEY" 2>&1
  $testOutput | Set-Content -Path $logFile -Encoding UTF8

  # Parse analyzeMs from the Per-Job Timing Breakdown table.
  # That table has lines like:
  #   " 1 1  valid-simple            412ms      2201ms     28400ms     2ms    31015ms    5ms"
  # Columns: # W  Workload  Container  PubGet  Analyze  Parse  Total  Unaccounted
  # analyzeMs is the 3rd ms-value (index 2, 0-based).
  foreach ($workload in $WORKLOADS) {
    # Match timing-breakdown rows (start with number, wave, workload)
    $line = $testOutput | Where-Object {
      $_ -match "^\s*\d+\s+\d+\s+$([regex]::Escape($workload))\s"
    } | Select-Object -Last 1   # last match = timing breakdown row (not job results row)

    $analyzeMs = $null
    if ($line) {
      $msValues = [regex]::Matches($line, '(\d[\d.]*)\s*ms')
      if ($msValues.Count -ge 3) {
        $analyzeMs = [double]($msValues[2].Groups[1].Value)
      }
    }

    $allResults += [PSCustomObject]@{
      Level     = $label
      Workload  = $workload
      AnalyzeMs = $analyzeMs
    }

    $dispVal = if ($null -ne $analyzeMs) { "${analyzeMs}ms" } else { 'n/a (parse failed)' }
    Write-Host "    $workload → analyzeMs: $dispVal"
  }

  Write-Host "  Raw log: $logFile"
}

# ── Revert to production defaults ────────────────────────────────────────────────
Write-Host ''
Write-Host '-- Reverting to production defaults --'
Remove-Item Env:\SANDBOX_CPU_EXPERIMENT -ErrorAction SilentlyContinue
$env:EXEC_CONCURRENCY = '4'
Invoke-DockerCompose up -d --force-recreate compiler-worker
Start-Sleep -Seconds 3
$revertLog = docker compose logs compiler-worker --tail=8 2>&1 |
  Where-Object { $_ -notmatch 'attribute `version` is obsolete' }
($revertLog | Where-Object { $_ -match 'cpu limit|concurrency' }) |
  ForEach-Object { Write-Host "  $_" }
Write-Host '  Production config restored.'

# ── Print summary table ───────────────────────────────────────────────────────────
Write-Host ''
Write-Host ('=' * 70)
Write-Host ' RESULTS: analyzeMs by CPU level'
Write-Host ('=' * 70)
Write-Host ''

$col0 = 28; $colW = 22
$hdr  = '{0,-28} {1,-22} {2,-22} {3,-22}' -f 'CPU Level', 'valid-simple', 'type-mismatch', 'undefined-method'
$sep  = '{0,-28} {1,-22} {2,-22} {3,-22}' -f ('-' * 27), ('-' * 21), ('-' * 21), ('-' * 21)
Write-Host $hdr
Write-Host $sep

foreach ($level in $CPU_LEVELS) {
  $label = $level.Label
  $vals  = $WORKLOADS | ForEach-Object {
    $w = $_
    $r = $allResults | Where-Object { $_.Level -eq $label -and $_.Workload -eq $w } | Select-Object -First 1
    if ($r -and $null -ne $r.AnalyzeMs) { "$($r.AnalyzeMs)ms" } else { 'n/a' }
  }
  Write-Host ('{0,-28} {1,-22} {2,-22} {3,-22}' -f $label, $vals[0], $vals[1], $vals[2])
}

Write-Host ''
Write-Host 'Interpretation:'
Write-Host '  analyzeMs drops significantly as CPU increases → CPU-bound; raising the'
Write-Host '  production limit will help. Trade-off: fewer concurrent jobs per host.'
Write-Host ''
Write-Host '  analyzeMs roughly flat across all CPU levels → NOT CPU-bound.'
Write-Host '  Likely cause: analyzer cold-start + SDK indexing on every fresh container.'
Write-Host '  Next investigation: container pooling / persistent analyzer server.'
Write-Host ''
Write-Host "Raw logs: $LOG_DIR"
