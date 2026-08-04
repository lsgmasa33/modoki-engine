#!/usr/bin/env node
// Merge the two coverage legs (`npm run coverage`) into one report.
//
// WHY THIS EXISTS: the repo's tests are split across two vitest projects — the engine
// package's own suite (466 files) and the root suite (276) — and BOTH exercise
// packages/modoki/src. Either leg alone understates it, so the honest number needs a
// real merge of per-line hit counts, not a max() over two summaries.
//
// Vitest cannot do this itself across two configs: it deletes <reportsDirectory>/.tmp
// once a leg has reported, so a shared-directory merge silently reports one leg's
// numbers as if they were both. See the comments in the two vitest configs.
//
// Each leg writes an istanbul-shaped coverage-final.json; istanbul-lib-coverage merges
// those correctly (summing hit counts per statement/branch/function), and istanbul-reports
// renders the merged map. Both libs ship as transitive deps of @vitest/coverage-v8.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import libCoverage from 'istanbul-lib-coverage'
import libReport from 'istanbul-lib-report'
import reports from 'istanbul-reports'

const engineDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const coverageDir = path.join(engineDir, 'coverage')
const legs = [
  { name: 'engine package suite', file: path.join(coverageDir, '.legs', 'pkg', 'coverage-final.json') },
  { name: 'root suite', file: path.join(coverageDir, '.legs', 'root', 'coverage-final.json') },
]

const map = libCoverage.createCoverageMap({})
let merged = 0
for (const leg of legs) {
  if (!fs.existsSync(leg.file)) {
    // Fail loudly. A missing leg is exactly the silent-half-measurement this script exists
    // to prevent — reporting the other leg alone would look like a complete answer.
    console.error(`[merge-coverage] MISSING leg: ${leg.name}\n  expected ${leg.file}\n  Run \`npm run coverage\`, which produces both legs before merging.`)
    process.exit(1)
  }
  const data = JSON.parse(fs.readFileSync(leg.file, 'utf8'))
  const files = Object.keys(data).length
  map.merge(data)
  merged += files
  console.log(`[merge-coverage] ${leg.name}: ${files} files`)
}

const context = libReport.createContext({ dir: coverageDir, coverageMap: map })
for (const r of ['text', 'json-summary', 'html']) reports.create(r, r === 'text' ? { maxCols: 120 } : {}).execute(context)

const total = map.getCoverageSummary()
console.log(`\n[merge-coverage] merged ${merged} file-entries → ${map.files().length} unique files`)
console.log(`[merge-coverage] lines ${total.lines.covered}/${total.lines.total} = ${total.lines.pct}%  ·  report: ${path.relative(process.cwd(), coverageDir)}`)
