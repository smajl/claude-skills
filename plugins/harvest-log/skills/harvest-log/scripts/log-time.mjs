#!/usr/bin/env node
// Write confirmed rows to Harvest.
//
//   node log-time.mjs --rows rows.json              # dry run: validates, writes nothing
//   node log-time.mjs --rows rows.json --confirm    # actually writes
//
// rows.json:
//   [ { "spentAt": "2026-07-31", "projectId": 123, "taskId": 456,
//       "hours": 2.5, "notes": "HUME-5720 select v2 - replacements" } ]
//
// **--confirm means the user said yes to a table, not that the agent is
// confident.** The default is a dry run precisely so that the validation and
// the write are separate acts: everything that can be checked without writing
// is checked first, and a row that would be rejected is found before any row
// has been created.
//
// Validation is all-or-nothing on purpose. A rejection halfway down the list
// leaves the day half-logged, and a half-logged day is worse than an unlogged
// one — nobody can tell by looking which half is missing.

import { readFileSync } from 'node:fs'
import { credentials, hasCredentials, missingCredentialsMessage, postTimeEntry } from './harvest-api.mjs'
import { fail, finish, parseArgs, readConfig } from './lib.mjs'

const args = parseArgs(process.argv.slice(2))
const cfg = readConfig()
if (!cfg) fail('No config found. Run the harvest-log setup first.')
if (!args.rows) fail('--rows <path> is required')

const userId = cfg.identity?.harvestUserId || null

const rows = JSON.parse(readFileSync(String(args.rows), 'utf8'))
if (!Array.isArray(rows) || !rows.length) fail('--rows must be a non-empty JSON array')

const isId = (v) => Number.isInteger(v) && v >= 1
const problems = []
rows.forEach((r, i) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(r.spentAt || ''))) problems.push(`rows[${i}]: spentAt must be YYYY-MM-DD`)
  if (!isId(r.projectId)) problems.push(`rows[${i}]: projectId must be an integer >= 1 (got ${JSON.stringify(r.projectId)})`)
  if (!isId(r.taskId)) problems.push(`rows[${i}]: taskId must be an integer >= 1 (got ${JSON.stringify(r.taskId)})`)
  if (!(Number(r.hours) > 0)) problems.push(`rows[${i}]: hours must be > 0`)
  if (Number(r.hours) > 24) problems.push(`rows[${i}]: hours is ${r.hours} — more than a day`)
})

const total = rows.reduce((a, r) => a + Number(r.hours || 0), 0)
const dates = [...new Set(rows.map((r) => r.spentAt))].sort()

// Nothing below this point runs unless every row is valid, so a failed write
// is a Harvest-side rejection rather than something that could have been caught
// here. Both of these are pre-network and may exit outright.
if (problems.length) {
  finish({ ok: false, wrote: 0, problems, note: 'nothing was written — fix these rows and re-run' }, 1)
  process.exit(1)
}

// Validation runs without credentials on purpose: the row checks are worth
// having on the MCP path too, where this script validates and the MCP writes.
if (!args.confirm) {
  finish({
    ok: true,
    dryRun: true,
    rows: rows.length,
    dates,
    totalHours: Math.round(total * 100) / 100,
    credentials: hasCredentials(cfg) ? 'present' : 'missing — --confirm would fall back to the MCP',
    note: 'validated only — re-run with --confirm to write',
  })
  process.exit(0)
}

if (!hasCredentials(cfg)) {
  finish({ ok: false, fallback: 'mcp', wrote: 0, error: missingCredentialsMessage(cfg) }, 2)
  process.exit(2)
}

await write()

async function write() {
const creds = credentials(cfg)

const created = []
for (const [i, r] of rows.entries()) {
  const res = await postTimeEntry(creds, {
    projectId: r.projectId,
    taskId: r.taskId,
    spentDate: r.spentAt,
    hours: Number(r.hours),
    notes: r.notes,
    userId: r.userId || userId,
  })
  if (!res.ok) {
    // Stop at the first failure and say exactly how far it got. Continuing
    // would scatter the successes and leave nobody able to reconstruct which
    // rows landed.
    return finish(
      {
        ok: false,
        wrote: created.length,
        created,
        failedRow: i,
        failedRowDetail: { spentAt: r.spentAt, projectId: r.projectId, taskId: r.taskId, hours: r.hours },
        error: res.error,
        note: `stopped at row ${i}; rows 0–${i - 1} were written and rows ${i}–${rows.length - 1} were not`,
      },
      1,
    )
  }
  created.push({ id: res.data.id, spentAt: res.data.spent_date, hours: res.data.hours, project: res.data.project?.name, task: res.data.task?.name })
}

return finish({
  ok: true,
  wrote: created.length,
  dates,
  totalHours: Math.round(total * 100) / 100,
  created,
  // Approval is not in the REST API. When this account requires it, submitting
  // the timesheet is still an MCP call.
  submitTimesheet: 'not available via REST — use the Harvest MCP submit_timesheet if the week is being closed',
})
}
