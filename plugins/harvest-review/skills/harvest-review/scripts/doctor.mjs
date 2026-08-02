#!/usr/bin/env node
// Preflight for harvest-review: is there a config, does the Harvest token work
// and can it see other people's time, is glab logged in, is the roster mapped?
//
//   node doctor.mjs
//
// The permission question is the one that matters. A token that can only read
// its owner's entries returns a perfectly well-formed empty team, and every
// check downstream would then report a spotless month.

import { existsSync } from 'node:fs'
import {
  cacheDir, configPath, emit, harvestCredentials, harvestPaged, readConfig, run,
} from './lib.mjs'

const SCHEMA_VERSION = 1

const cfg = readConfig()
const checks = []
const warnings = []
const warn = (m) => warnings.push(m)

checks.push({
  name: 'config',
  ok: Boolean(cfg),
  detail: cfg ? configPath() : `missing at ${configPath()} — run setup`,
})

const creds = harvestCredentials(cfg)
checks.push({
  name: 'harvest-credentials',
  ok: Boolean(creds.token && creds.accountId),
  detail: creds.token && creds.accountId
    ? `token in $${creds.tokenEnv}, account in $${creds.accountEnv}`
    : `set $${creds.tokenEnv} and $${creds.accountEnv} — create a PAT at https://id.getharvest.com/developers`,
})

let visibleUsers = null
if (creds.token && creds.accountId) {
  const r = await harvestPaged('/users?is_active=true&per_page=100', creds, 'users', { maxPages: 3 })
  if (!r.ok) {
    checks.push({ name: 'harvest-api', ok: false, detail: r.error })
  } else {
    visibleUsers = r.items.length
    checks.push({ name: 'harvest-api', ok: true, detail: `${visibleUsers} active users visible` })
    // /users returns the whole account to an admin or manager and only the
    // caller to a member. One user back is the tell.
    if (visibleUsers <= 1) {
      warn(
        'the Harvest token can see only one user — it belongs to an account without permission to read other people\'s time. Every review would come back empty regardless of what the team logged. Use a token from a manager or administrator account.',
      )
    }
  }
}

if (cfg) {
  const problems = []
  const team = cfg.team || []
  if (!team.length) problems.push('team[] is empty — nobody to review')
  team.forEach((m, i) => {
    if (!Number.isInteger(m.harvestUserId) || m.harvestUserId < 1) {
      problems.push(`team[${i}] (${m.name || '?'}) has no harvestUserId`)
    }
  })

  const badRegex = (m) => {
    try {
      new RegExp(m, 'i')
      return false
    } catch {
      return true
    }
  }
  for (const [kind, re] of Object.entries(cfg.taxonomy?.taskKinds || {})) {
    if (badRegex(re)) problems.push(`taxonomy.taskKinds.${kind} is not a valid regex`)
  }
  for (const [kind, re] of Object.entries(cfg.taxonomy?.noteKinds || {})) {
    if (badRegex(re)) problems.push(`taxonomy.noteKinds.${kind} is not a valid regex`)
  }
  ;(cfg.suppressions || []).forEach((s, i) => {
    if (s.match && badRegex(s.match)) problems.push(`suppressions[${i}] has an invalid match regex`)
    if (!s.reason) warn(`suppressions[${i}] has no reason recorded — a suppression nobody can explain later is indistinguishable from a blind spot.`)
  })

  checks.push({
    name: 'config-values',
    ok: problems.length === 0,
    detail: problems.length ? problems.join('; ') : `${team.length} team members`,
    problems,
  })

  const version = Number(cfg.version || 0)
  if (version < SCHEMA_VERSION) {
    warn(`config is schema v${version || '?'}, current is v${SCHEMA_VERSION} — re-run setup to pick up fields added since.`)
  }

  const unmapped = team.filter((m) => !m.gitlabUsername).map((m) => m.name || m.harvestUserId)
  if (unmapped.length) {
    warn(`no gitlabUsername for ${unmapped.join(', ')} — their development hours cannot be checked against real activity, and the scan will say so rather than clearing them.`)
  }
  if (!(cfg.gitlab?.projects?.length || cfg.gitlab?.groups?.length)) {
    warn('gitlab.projects and gitlab.groups are both empty — the activity sweep falls back to per-user public feeds, which for a private group shows nothing at all.')
  }
  if (!Object.keys(cfg.projectByTicketPrefix || {}).length) {
    warn('projectByTicketPrefix is empty — work billed to the wrong client cannot be detected, which is the one error class that moves money.')
  }
  if (!cfg.jira?.cloudId) {
    warn('jira.cloudId is unset — ticket verification (does this key exist, was it already closed) is unavailable.')
  }
  if (visibleUsers && team.length && visibleUsers < team.length) {
    warn(`config lists ${team.length} team members but the token sees ${visibleUsers} users — some of the roster may be invisible to this token.`)
  }
}

const glab = run('glab', ['--version'])
if (!glab.ok) {
  checks.push({ name: 'glab', ok: false, detail: 'not installed — see https://gitlab.com/gitlab-org/cli' })
} else {
  const auth = run('glab', ['auth', 'status'])
  const text = `${auth.out || ''}\n${auth.err || ''}\n${auth.error || ''}`
  const ok = /Logged in/i.test(text)
  checks.push({ name: 'glab', ok, detail: ok ? text.split('\n').find((l) => /Logged in/i.test(l)).trim() : 'run `glab auth login`' })
}

emit({
  ok: checks.every((c) => c.ok),
  configPath: configPath(),
  hasConfig: Boolean(cfg),
  schemaVersion: SCHEMA_VERSION,
  configVersion: cfg ? Number(cfg.version || 0) : null,
  cacheDir: existsSync(cacheDir()) ? cacheDir() : null,
  degraded: warnings.length > 0,
  warnings,
  // False means a review would be reading an incomplete picture. Say so before
  // presenting findings, not after.
  canReview: Boolean(cfg) && checks.find((c) => c.name === 'harvest-api')?.ok === true,
  checks,
  mcpToVerify: ['atlassian(jira)'],
})
