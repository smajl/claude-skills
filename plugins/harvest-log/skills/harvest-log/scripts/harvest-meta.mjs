#!/usr/bin/env node
// Who am I, what can I log against, and how does this account behave?
//
//   node harvest-meta.mjs           # identity, account settings, projects + tasks
//   node harvest-meta.mjs --tasks   # also every task assignment, for routing
//
// Setup's detect step, in one call instead of four MCP round trips. Runs before
// a config exists, so it accepts credentials straight from the environment.

import { credentials, get, hasCredentials, missingCredentialsMessage, paged } from './harvest-api.mjs'
import { finish, parseArgs, prune, readConfig } from './lib.mjs'

const args = parseArgs(process.argv.slice(2))
const cfg = readConfig() // may be null on a first run — that is the point

await main()

async function main() {
if (!hasCredentials(cfg)) {
  return finish({ ok: false, fallback: 'mcp', error: missingCredentialsMessage(cfg) }, 2)
}
const creds = credentials(cfg)

const [me, settings, assignments] = await Promise.all([
  get('/users/me', creds),
  get('/company', creds),
  // The project assignments of the authenticated user are exactly the projects
  // they can log against, with the tasks allowed on each. That is the routing
  // table's raw material, and it is one request.
  paged('/users/me/project_assignments?per_page=100', creds, 'project_assignments'),
])

if (!me.ok) return finish({ ok: false, error: `Harvest /users/me failed: ${me.error}` }, 1)

const projects = (assignments.items || []).map((a) =>
  prune({
    projectId: a.project?.id,
    projectName: a.project?.name,
    projectCode: a.project?.code || null,
    client: a.client?.name || null,
    isProjectManager: a.is_project_manager || null,
    tasks: (a.task_assignments || []).map((t) => ({ taskId: t.task?.id, taskName: t.task?.name, billable: t.billable })),
  }),
)

return finish({
  ok: true,
  source: 'harvest-api',
  identity: {
    harvestUserId: me.data.id,
    name: [me.data.first_name, me.data.last_name].filter(Boolean).join(' '),
    email: me.data.email,
    // Harvest's own display label ("Prague"), which is *not* an IANA zone and
    // must not be copied into identity.timezone — doctor validates that field
    // against Intl and would reject it. Use it to confirm the zone with the
    // user ("Prague" → Europe/Prague), never as the value.
    timezoneLabel: me.data.timezone || null,
    weeklyCapacityHours: me.data.weekly_capacity != null ? Math.round((me.data.weekly_capacity / 3600) * 100) / 100 : null,
  },
  // These four decide how entries must be shaped. wants_timestamp_timers in
  // particular: false means log plain durations and never send started_time.
  account: settings.ok
    ? prune({
        name: settings.data.name,
        wantsTimestampTimers: settings.data.wants_timestamp_timers,
        approvalRequired: settings.data.approval_required,
        timeRounding: settings.data.time_rounding,
        weekStartDay: settings.data.week_start_day,
        clockFormat: settings.data.clock,
      })
    : null,
  accountError: settings.ok ? null : settings.error,
  projects: args.tasks ? projects : projects.map((p) => ({ ...p, tasks: p.tasks.length })),
  taskNames: [...new Set(projects.flatMap((p) => p.tasks.map((t) => t.taskName)))].sort(),
  assignmentsError: assignments.ok ? null : assignments.error,
})
}
