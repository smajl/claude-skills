#!/usr/bin/env node
// Pull a period's time entries for the whole team straight from the Harvest
// REST API into a cache file, and print only a summary.
//
//   node fetch-entries.mjs --from 2026-07-01 --to 2026-07-31
//   node fetch-entries.mjs --from 2026-07-01 --to 2026-07-31 --users 123,456
//   node fetch-entries.mjs --from 2026-07-01 --to 2026-07-31 --refresh
//
// Needs a Harvest personal access token in $HARVEST_TOKEN and the account id in
// $HARVEST_ACCOUNT_ID (both overridable via config.harvest.tokenEnv /
// accountIdEnv). Create them at https://id.getharvest.com/developers.
//
// The token must belong to someone who can see other people's time — a manager
// or administrator. With a plain member token the API silently returns only the
// caller's own entries, which looks exactly like a team that logged nothing, so
// the summary always names how many distinct users came back.

import { existsSync, statSync } from 'node:fs'
import {
  cachePath, fail, finish, harvestCredentials, harvestPaged, isDate, parseArgs,
  readConfig, readJson, round, sum, writeCache,
} from './lib.mjs'

const args = parseArgs(process.argv.slice(2))
const cfg = readConfig()
if (!cfg) fail('No config found. Run the harvest-review setup first.')
if (!isDate(args.from)) fail('--from is required (YYYY-MM-DD)')

const from = String(args.from)
const to = isDate(args.to) ? String(args.to) : from
if (to < from) fail(`--to (${to}) is before --from (${from})`)

const creds = harvestCredentials(cfg)
if (!creds.token || !creds.accountId) {
  fail(
    `Harvest credentials missing — set $${creds.tokenEnv} and $${creds.accountEnv}. ` +
      'Create a personal access token at https://id.getharvest.com/developers.',
  )
}

const userFilter = args.users
  ? String(args.users).split(',').map((s) => Number(s.trim())).filter(Boolean)
  : (cfg.team || []).map((m) => m.harvestUserId).filter(Boolean)

const name = `entries-${from}_${to}.json`
const out = cachePath(name)

// A period that has already been fetched is refetched only on request. Reviews
// get re-run — a second verification pass, a corrected roster, tomorrow's
// follow-up — and each re-run would otherwise spend a few hundred API calls
// re-reading a month that cannot have changed much.
if (!args.refresh && existsSync(out)) {
  const cached = readJson(out)
  finish({
    ok: true,
    cache: out,
    cached: true,
    fetchedAt: statSync(out).mtime.toISOString(),
    from,
    to,
    entries: cached.entries.length,
    users: cached.users.length,
    note: 'served from cache — pass --refresh to refetch',
    perUser: cached.users,
  })
  process.exit(0)
}

await main()

async function main() {
// `from`/`to` filter on the date the work is claimed for — the only date a
// review is about. (updated_since filters on edit time and would miss
// everything logged before the period was first touched.)
const query = new URLSearchParams({ from, to, per_page: '100' })
const r = await harvestPaged(`/time_entries?${query}`, creds, 'time_entries')
if (!r.ok) return finish({ ok: false, error: `Harvest fetch failed: ${r.error}`, fetched: r.items.length }, 1)

// Keep the fields a detector can actually use, drop the rest. created_at and
// updated_at matter as much as hours here: they are what separates time written
// down as it happened from a month reconstructed in one sitting.
//
// `spent_date` is the REST field. The MCP calls the same thing spent_at, and
// reading it by that name here returns undefined for every entry — which looks
// like a team that logged nothing rather than like a bug.
const entries = r.items
  .filter((e) => !userFilter.length || userFilter.includes(e.user?.id))
  .map((e) => ({
    id: e.id,
    userId: e.user?.id ?? null,
    userName: e.user?.name || null,
    spentAt: e.spent_date,
    hours: e.hours,
    notes: e.notes || '',
    projectId: e.project?.id ?? null,
    projectName: e.project?.name || null,
    clientName: e.client?.name || null,
    taskId: e.task?.id ?? null,
    taskName: e.task?.name || null,
    billable: e.billable,
    isLocked: e.is_locked || false,
    isRunning: e.is_running || false,
    createdAt: e.created_at,
    updatedAt: e.updated_at,
    startedTime: e.started_time || null,
    endedTime: e.ended_time || null,
  }))

const byUser = new Map()
for (const e of entries) {
  const k = e.userId
  if (!byUser.has(k)) byUser.set(k, { userId: k, name: e.userName, entries: 0, hours: 0, days: new Set() })
  const u = byUser.get(k)
  u.entries++
  u.hours += e.hours
  u.days.add(e.spentAt)
}
const users = [...byUser.values()]
  .map((u) => ({ userId: u.userId, name: u.name, entries: u.entries, hours: round(u.hours, 0.01), days: u.days.size }))
  .sort((a, b) => b.hours - a.hours)

const cache = { from, to, fetchedAt: new Date().toISOString(), users, entries }
writeCache(name, cache)

// Roster drift is worth catching here rather than in the report: a team member
// with no entries at all is either genuinely absent for the period or mapped to
// the wrong Harvest id, and those want very different conversations.
const seen = new Set(users.map((u) => u.userId))
const silent = (cfg.team || [])
  .filter((m) => m.harvestUserId && !seen.has(m.harvestUserId))
  .map((m) => m.name || m.harvestUserId)

return finish({
  ok: true,
  cache: out,
  from,
  to,
  entries: entries.length,
  fetchedRaw: r.items.length,
  pages: r.pages,
  truncated: r.truncated,
  hours: round(sum(entries.map((e) => e.hours)), 0.01),
  users: users.length,
  perUser: users,
  noEntriesForConfiguredMembers: silent.length ? silent : null,
  // One user back from a multi-person request usually means a member token.
  scopeWarning:
    users.length <= 1 && (!userFilter.length || userFilter.length > 1)
      ? 'only one user came back — the token may not have permission to see other people\'s time'
      : null,
})
}
