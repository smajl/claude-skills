#!/usr/bin/env node
// Pull the team's time off and the company's holidays from BambooHR into a
// cache file, and print a small per-person summary.
//
//   node fetch-timeoff.mjs --from 2026-07-01 --to 2026-07-31
//   node fetch-timeoff.mjs --from 2026-07-01 --to 2026-07-31 --refresh
//   node fetch-timeoff.mjs --directory            (setup: map Harvest ↔ Bamboo)
//
// Needs a BambooHR API key in $BAMBOO_API_KEY (or wherever `bamboo.apiKeyEnv`
// points) and the company subdomain in `bamboo.subdomain`. Generate a key from
// the Bamboo web UI under your own profile → API Keys; it inherits *your*
// permissions, so a key made by someone who cannot see the team's time off
// produces an empty, well-formed, completely misleading answer.
//
// Two endpoints, because neither alone is enough:
//
//   /time_off/requests  — per-date hours, the leave *type*, and pending as well
//                         as approved requests. This is the one that matters:
//                         a review run mid-month needs to know about the leave
//                         somebody has booked, not only the leave they took.
//   /time_off/whos_out  — the only place company holidays appear, and they are
//                         not attached to any employee. A holiday nobody worked
//                         is otherwise a day nobody has a GitLab trace for.

import { existsSync, statSync } from 'node:fs'
import {
  bambooCredentials, bambooGet, cachePath, eachDate, fail, finish, isDate,
  parseArgs, readConfig, readJson, round, sum, writeCache,
} from './lib.mjs'

const args = parseArgs(process.argv.slice(2))
const cfg = readConfig()
if (!cfg) fail('No config found. Run the harvest-review setup first.')

const creds = bambooCredentials(cfg)
if (!creds.apiKey || !creds.subdomain) {
  fail(
    `BambooHR is not configured — need an API key in $${creds.apiKeyEnv} ` +
      `(\`node keys.mjs --set ${creds.apiKeyEnv}\`) and the company subdomain in \`bamboo.subdomain\`.`,
    { hasApiKey: Boolean(creds.apiKey), hasSubdomain: Boolean(creds.subdomain) },
  )
}

// A status Bamboo has approved is a day the person was off. A status it has
// only received is a day they *intend* to be off, which is worth knowing about
// and is not evidence of anything, so the two never collapse into one.
const OFF_STATUSES = new Set(['approved'])
const PLANNED_STATUSES = new Set(['requested'])

if (args.directory) {
  await directory()
} else {
  await timeOff()
}

// -------------------------------------------------------------------------

// Setup only: propose `bambooEmployeeId` for each roster member by matching on
// work email, which is the only field both systems agree on exactly. Names are
// offered as candidates, never applied — "Jan Peša" and "Jan Pesa" match on a
// good day and two different Jans match on a bad one, and a wrong id here means
// somebody else's holidays suppress this person's findings.
async function directory() {
  const r = await bambooGet('/employees/directory', creds)
  if (!r.ok) return finish({ ok: false, error: r.error, status: r.status }, 1)

  const employees = (r.data?.employees || []).map((e) => ({
    id: Number(e.id),
    name: e.displayName || [e.firstName, e.lastName].filter(Boolean).join(' '),
    email: (e.workEmail || '').toLowerCase() || null,
  }))
  const byEmail = new Map(employees.filter((e) => e.email).map((e) => [e.email, e]))

  const matched = []
  const unmatched = []
  for (const m of cfg.team || []) {
    const email = (m.email || '').toLowerCase()
    const hit = email ? byEmail.get(email) : null
    if (hit) {
      matched.push({ harvestUserId: m.harvestUserId, name: m.name, bambooEmployeeId: hit.id, matchedOn: 'email', bambooName: hit.name })
      continue
    }
    // Loose name candidates, diacritics folded, for a human to pick from.
    const key = fold(m.name)
    const candidates = employees
      .filter((e) => key && fold(e.name) === key)
      .map((e) => ({ bambooEmployeeId: e.id, bambooName: e.name, email: e.email }))
    unmatched.push({ harvestUserId: m.harvestUserId, name: m.name, email: m.email || null, candidates: candidates.slice(0, 3) })
  }

  return finish({
    ok: true,
    employeesVisible: employees.length,
    matched,
    unmatched: unmatched.length ? unmatched : null,
    // One employee back means the key belongs to a self-service account and
    // every review it feeds would show a team that never takes holidays.
    scopeWarning:
      employees.length <= 1
        ? 'the BambooHR key can see only one employee — it was created by an account without permission to view the directory, and time off for everyone else will come back empty rather than absent'
        : null,
    note: 'write the matched ids into team[].bambooEmployeeId; confirm anything under `unmatched` with the user before writing it',
  })
}

function fold(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '') // Peša → Pesa; the two systems rarely agree on diacritics
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
}

async function timeOff() {
  if (!isDate(args.from)) fail('--from is required (YYYY-MM-DD)')
  const from = String(args.from)
  const to = isDate(args.to) ? String(args.to) : from
  if (to < from) fail(`--to (${to}) is before --from (${from})`)

  const name = `timeoff-${from}_${to}.json`
  const out = cachePath(name)
  if (!args.refresh && existsSync(out)) {
    const cached = readJson(out)
    return finish({
      ok: true, cache: out, cached: true, fetchedAt: statSync(out).mtime.toISOString(),
      from, to, people: cached.people, holidays: cached.holidays,
      note: 'served from cache — pass --refresh to refetch',
    })
  }

  const q = `start=${from}&end=${to}`
  const [requests, whosOut] = await Promise.all([
    bambooGet(`/time_off/requests/?${q}`, creds),
    bambooGet(`/time_off/whos_out/?${q}`, creds),
  ])
  if (!requests.ok) return finish({ ok: false, error: `BambooHR time off fetch failed: ${requests.error}`, status: requests.status }, 1)

  const teamByBambooId = new Map(
    (cfg.team || []).filter((m) => m.bambooEmployeeId).map((m) => [Number(m.bambooEmployeeId), m]),
  )

  // employeeId → { days: { date: {hours, type, status} } }
  const byEmployee = new Map()
  const seenEmployeeIds = new Set()
  const unmappedEmployees = new Map()

  for (const req of Array.isArray(requests.data) ? requests.data : []) {
    const status = String(req.status?.status || req.status || '').toLowerCase()
    const planned = PLANNED_STATUSES.has(status)
    if (!OFF_STATUSES.has(status) && !planned) continue // denied, cancelled, superseded

    const employeeId = Number(req.employeeId)
    seenEmployeeIds.add(employeeId)
    const member = teamByBambooId.get(employeeId)
    if (!member) {
      if (!unmappedEmployees.has(employeeId)) unmappedEmployees.set(employeeId, req.name || String(employeeId))
      continue
    }

    if (!byEmployee.has(employeeId)) {
      byEmployee.set(employeeId, {
        employeeId,
        bambooName: req.name || null,
        harvestUserId: member.harvestUserId,
        name: member.name,
        days: {},
      })
    }
    const person = byEmployee.get(employeeId)

    // `dates` carries the per-day hours, which is the only way a half day is
    // distinguishable from a full one — and a half day is a day with real work
    // in it, so it must not suppress anything on its own.
    const dates = req.dates && typeof req.dates === 'object' && Object.keys(req.dates).length
      ? Object.entries(req.dates).map(([date, hours]) => ({ date, hours: Number(hours) || 0 }))
      : eachDate(String(req.start).slice(0, 10), String(req.end).slice(0, 10)).map((date) => ({ date, hours: null }))

    for (const { date, hours } of dates) {
      if (date < from || date > to) continue
      const existing = person.days[date]
      // Two requests on one date (a morning of sick leave, an afternoon of
      // vacation) add up rather than overwrite.
      person.days[date] = {
        hours: hours === null ? existing?.hours ?? null : round((existing?.hours || 0) + hours, 0.01),
        type: existing?.type || req.type?.name || null,
        status: existing?.status === 'approved' ? 'approved' : (planned ? 'requested' : 'approved'),
      }
    }
  }

  // Company holidays live only in whos_out, and carry no location — a holiday
  // that applies to one office comes back looking exactly like one that applies
  // to everybody. They are kept anyway, because a holiday can only ever suppress
  // a finding and never invent one, and a missed finding costs less than an
  // accusation aimed at somebody who was legally off work. The names are carried
  // through so the report can say which days it excused and let the reader judge.
  const holidays = []
  if (whosOut.ok && Array.isArray(whosOut.data)) {
    for (const item of whosOut.data) {
      if (item.type !== 'holiday') continue
      for (const date of eachDate(String(item.start).slice(0, 10), String(item.end).slice(0, 10))) {
        if (date >= from && date <= to && !holidays.some((h) => h.date === date)) {
          holidays.push({ date, name: item.name || null })
        }
      }
    }
    holidays.sort((a, b) => a.date.localeCompare(b.date))
  }

  const people = [...byEmployee.values()]
    .map((p) => {
      const dates = Object.keys(p.days).sort()
      const approved = dates.filter((d) => p.days[d].status === 'approved')
      const requested = dates.filter((d) => p.days[d].status === 'requested')
      const known = dates.map((d) => p.days[d].hours).filter((h) => h !== null)
      return {
        harvestUserId: p.harvestUserId,
        name: p.name,
        bambooEmployeeId: p.employeeId,
        days: dates.length,
        approvedDays: approved.length,
        requestedDays: requested.length,
        hours: known.length ? round(sum(known), 0.01) : null,
        types: [...new Set(dates.map((d) => p.days[d].type).filter(Boolean))],
        ranges: compress(dates, p.days),
      }
    })
    .sort((a, b) => b.days - a.days)

  const cache = {
    from, to, fetchedAt: new Date().toISOString(),
    source: 'bamboohr',
    holidays: holidays.map((h) => h.date),
    holidayNames: holidays,
    // Who this file can speak about at all. A member missing from
    // `byHarvestUserId` took no leave *if* they are in here, and is simply
    // unmapped if they are not — the scanner must not confuse the two.
    mappedHarvestUserIds: (cfg.team || []).filter((m) => m.bambooEmployeeId).map((m) => m.harvestUserId),
    byHarvestUserId: Object.fromEntries([...byEmployee.values()].map((p) => [p.harvestUserId, { name: p.name, bambooEmployeeId: p.employeeId, days: p.days }])),
    people,
  }
  writeCache(name, cache)

  const withoutId = (cfg.team || []).filter((m) => !m.bambooEmployeeId).map((m) => m.name || m.harvestUserId)

  return finish({
    ok: true,
    cache: out,
    from,
    to,
    people,
    holidays: holidays.length ? holidays : null,
    // Every one of these is a person whose vacation the review cannot see, and
    // whose quiet week will therefore read as a finding. Say so here rather
    // than letting the report say it about them.
    membersWithoutBambooId: withoutId.length ? withoutId : null,
    timeOffVisibleForOthers: unmappedEmployees.size ? [...unmappedEmployees.values()].slice(0, 10) : null,
    employeesWithTimeOff: seenEmployeeIds.size,
    whosOutError: whosOut.ok ? null : `company holidays unavailable: ${whosOut.error}`,
    scopeWarning:
      seenEmployeeIds.size <= 1 && (cfg.team || []).length > 1
        ? 'BambooHR returned time off for at most one employee across the whole period — the API key probably cannot see other people, which is indistinguishable from a team that took no leave'
        : null,
  })
}

// "2026-07-06 … 2026-07-10" rather than five dates. Consecutive calendar days
// only; a Friday and the following Monday stay separate, because the weekend
// between them is not leave and printing it as one range implies it was.
function compress(dates, days) {
  const out = []
  for (const date of dates) {
    const last = out[out.length - 1]
    const prev = last && new Date(`${last.to}T00:00:00Z`)
    if (prev) prev.setUTCDate(prev.getUTCDate() + 1)
    if (last && prev.toISOString().slice(0, 10) === date && last.status === days[date].status && last.type === days[date].type) {
      last.to = date
      last.days++
    } else {
      out.push({ from: date, to: date, days: 1, type: days[date].type, status: days[date].status })
    }
  }
  return out
}
