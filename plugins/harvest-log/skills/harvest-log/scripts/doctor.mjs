#!/usr/bin/env node
// Preflight for harvest-log: is there a config, and do the local CLIs work?
// MCP servers (Harvest, Calendar, Jira, Granola, Slack) can't be probed from a
// script — the skill checks those itself by calling a cheap tool on each.
//
//   node doctor.mjs

import { existsSync } from 'node:fs'
import { credentials, get, hasCredentials } from './harvest-api.mjs'
import { DEFAULT_DAY_START_HOUR, activeConfigPath, configDir, configPath, findRepos, legacyConfigDir, legacyConfigPath, localToday, readConfig, resolveDayStartHour, resolveTimezone, run, emit, usingLegacyConfig } from './lib.mjs'

// Bump whenever templates/config.example.json gains or drops a field. A config
// written against an older schema is missing whatever was added since, and the
// only symptom would otherwise be quietly worse output.
const SCHEMA_VERSION = 7

const cfg = readConfig()
const startHour = cfg ? resolveDayStartHour(cfg) : DEFAULT_DAY_START_HOUR
const checks = []
// Two tiers, deliberately. `problems` mean the config cannot produce a valid
// log_time call and block the write. `warnings` mean the run still works but
// produces worse answers — a missing calibration, an unset note style. Those
// used to degrade in silence, which is the worse failure: nobody investigates
// output that looks fine.
const warnings = []
const warn = (m) => warnings.push(m)

const legacy = usingLegacyConfig()

checks.push({
  name: 'config',
  ok: Boolean(cfg),
  detail: cfg ? activeConfigPath() : `missing at ${configPath()} — run setup`,
})

// The plugin used to be called harvest-day, and its config lived under that
// name. Reading the old path keeps a renamed install working, but leaving it
// there means the next machine — or the next reader of the docs — looks in the
// wrong place, so say it once and offer the one-line move.
if (legacy) {
  warn(
    `config is still at the pre-rename path ${legacyConfigPath()}. It is being read from there, but move the directory: \`mv "${legacyConfigDir()}" "${configDir()}"\` (the name is all that changed).`,
  )
}

// The template ships id placeholders of 0, and Harvest's log_time requires
// project_id and task_id >= 1. Without this check a half-finished setup sails
// through preflight, collection and the user's review, and only blows up on
// the write — after the run is unrepeatable and the user has already said yes.
if (cfg) {
  const problems = []
  const id = (v) => Number.isInteger(v) && v >= 1

  if (!(cfg.identity?.gitAuthors?.length > 0)) problems.push('identity.gitAuthors is empty')
  if (!id(cfg.identity?.harvestUserId)) problems.push('identity.harvestUserId is unset')

  const tz = resolveTimezone(cfg)
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
  } catch {
    problems.push(`identity.timezone "${tz}" is not a valid IANA zone`)
  }

  if (!id(cfg.harvest?.defaultProjectId)) problems.push('harvest.defaultProjectId is unset')

  // `match` is a case-insensitive regex in both rule lists. An unparseable one
  // silently routes nothing, which looks exactly like a rule that never fires.
  const badRegex = (m) => {
    if (typeof m !== 'string' || !m) return true
    try {
      new RegExp(m, 'i')
      return false
    } catch {
      return true
    }
  }

  const rules = cfg.harvest?.taskRules || []
  if (!rules.length) problems.push('harvest.taskRules is empty')
  rules.forEach((r, i) => {
    const label = r.taskName || r.match
    if (!id(r.taskId)) problems.push(`harvest.taskRules[${i}] (${label}) has no task id`)
    if ('projectId' in r && !id(r.projectId)) problems.push(`harvest.taskRules[${i}] (${label}) has an invalid project id`)
    if (badRegex(r.match)) problems.push(`harvest.taskRules[${i}] (${label}) has an invalid match regex`)
  })
  if (rules.length && !rules.some((r) => r.match === '.*')) {
    problems.push('harvest.taskRules has no catch-all ".*" rule — some clusters will not route')
  }

  ;(cfg.harvest?.learnedRoutes || []).forEach((r, i) => {
    if (!id(r.projectId) || !id(r.taskId)) problems.push(`harvest.learnedRoutes[${i}] (${r.match}) has an invalid id`)
    if (badRegex(r.match)) problems.push(`harvest.learnedRoutes[${i}] has an invalid match regex`)
  })

  for (const src of ['jira', 'confluence']) {
    if (cfg.sources?.[src]?.enabled && !cfg.sources[src].cloudId) {
      problems.push(`sources.${src}.enabled but cloudId is empty`)
    }
  }

  checks.push({
    name: 'config-values',
    ok: problems.length === 0,
    detail: problems.length ? problems.join('; ') : `${tz}, ids resolved`,
    problems,
  })

  // --- Quality warnings: the run works, the answers are just worse ---------

  const version = Number(cfg.version || 0)
  if (version < SCHEMA_VERSION) {
    warn(`config is schema v${version || '?'}, current is v${SCHEMA_VERSION} — it predates fields added since, so anything new falls back to defaults. Re-run setup to fill them in.`)
  }

  const cal = cfg.harvest?.calibration
  if (!cal) {
    warn('harvest.calibration is missing — hour estimates use the shipped defaults with no history to check them against. Re-run setup to compute it.')
  } else {
    if (!(cal.hoursPerScore > 0)) {
      warn('harvest.calibration.hoursPerScore is unset — scoring falls back to the shipped 0.28 h/point.')
    }
    if (!Object.keys(cal.medianHoursByTask || {}).length) {
      warn('harvest.calibration.medianHoursByTask is empty — estimates have no historical bound, so nothing catches an over-scored cluster. Re-run setup to compute it from 90 days of entries.')
    }
    // A single target for every day is wrong on any timesheet that has both
    // long days and weekend work: the fill column pads a 2h Sunday to a full
    // day, and clips a 10h Thursday back to eight. These are measured from the
    // user's own entries, so their absence means the fill column is guessing.
    if (!(cal.dayTotals?.weekday > 0)) {
      warn('harvest.calibration.dayTotals is unset — every day fills to the same target, so long days get clipped and weekend days get padded. Re-run setup to measure it from 90 days of entries.')
    }
    if (!(cal.medianWorkEntriesPerDay > 0)) {
      warn('harvest.calibration.medianWorkEntriesPerDay is unset — proposals are not collapsed to the shape the user actually logs, so expect more work rows than they would write themselves.')
    }
    if (cal.computedFrom) {
      const age = Math.round((Date.parse(localToday(tz, startHour)) - Date.parse(cal.computedFrom)) / 86400000)
      if (age > 180) warn(`harvest.calibration was computed ${age} days ago — recompute it if the work has changed shape since.`)
    }
  }

  // An unusable value here doesn't break the write, it just quietly files
  // late-night work on the wrong day — exactly the class of fault this tier
  // exists to announce.
  const configuredStart = cfg.rules?.dayStartHour
  if (configuredStart !== undefined && configuredStart !== null && Number(configuredStart) !== startHour) {
    warn(`rules.dayStartHour is ${JSON.stringify(configuredStart)}, which is not an integer 0–11 — falling back to ${startHour}:00, so work after midnight files under the previous day.`)
  }

  if (!(cfg.harvest?.targetHoursPerDay > 0)) {
    warn('harvest.targetHoursPerDay is unset — the fill column has no target to fill to.')
  }
  if (!cfg.harvest?.noteStyle) {
    warn("harvest.noteStyle is unset — notes won't match the phrasing of existing entries.")
  }
  if (cfg.sources?.gitlab?.enabled !== false && !cfg.identity?.gitlabUsername) {
    warn('identity.gitlabUsername is unset — GitLab events can still be read, but nothing verifies they belong to the right account.')
  }
  if (cfg.sources?.github?.enabled && !cfg.identity?.githubUsername) {
    warn('sources.github is enabled but identity.githubUsername is unset — the GitHub collector cannot run.')
  }
  if (cfg.sources?.jira?.enabled && !Object.keys(cfg.sources.jira.projectRouting || {}).length) {
    warn('sources.jira.projectRouting is empty — every ticket routes to the default project regardless of its key.')
  }

  // Huddles are ad-hoc meetings that reach no calendar, so a day full of them
  // looks like a day of nothing. Without a token the collector degrades to
  // reading start events through the MCP, which knows when a huddle began and
  // not how long it ran — every duration becomes a guess. That is exactly the
  // kind of quietly-worse output this tier exists to announce.
  const huddles = cfg.sources?.slack?.huddles
  if (cfg.sources?.slack?.enabled && huddles?.enabled !== false) {
    const tokenEnv = huddles?.tokenEnv || cfg.sources.slack.tokenEnv
    const inlineToken = huddles?.token || cfg.sources.slack.token
    const hasToken = Boolean(
      process.env.HARVEST_LOG_SLACK_TOKEN || process.env.HARVEST_DAY_SLACK_TOKEN || (tokenEnv && process.env[tokenEnv]) || inlineToken,
    )
    if (!hasToken) {
      warn(
        `no Slack user token found${tokenEnv ? ` in $${tokenEnv} or $HARVEST_LOG_SLACK_TOKEN` : ' in $HARVEST_LOG_SLACK_TOKEN'} — huddle durations and participants are unavailable, so huddles fall back to start-events read through the MCP and each one is proposed at the ${huddles?.fallbackHuddleHours ?? 0.5}h default. See references/setup.md to create one.`,
      )
    }
    if (inlineToken) {
      warn('a Slack token is stored in plain text inside config.json — move it to an environment variable and set sources.slack.huddles.tokenEnv to its name.')
    }
  }
}

// --- Harvest REST -------------------------------------------------------
//
// The API is the preferred path and the MCP is the fallback, because the
// difference is measured in context: setup reads 90 days of entries and the
// catch-up scan two weeks, and through the MCP every one of those entries
// arrives in the conversation. Both paths work; only one of them is cheap.
let harvestApi = false
if (hasCredentials(cfg)) {
  const creds = credentials(cfg)
  const me = await get('/users/me', creds)
  harvestApi = me.ok
  checks.push({
    name: 'harvest-api',
    ok: me.ok,
    detail: me.ok
      ? `authenticated as ${me.data.email} (user ${me.data.id}) via $${creds.tokenEnv}`
      : `${me.error} — fix the token or unset $${creds.tokenEnv} to fall back to the MCP`,
  })
  // A token belonging to one person and a config naming another produces
  // entries logged against the wrong user, silently and irreversibly.
  if (me.ok && cfg?.identity?.harvestUserId && me.data.id !== cfg.identity.harvestUserId) {
    warn(
      `identity.harvestUserId is ${cfg.identity.harvestUserId} but the API token belongs to user ${me.data.id} (${me.data.email}). Entries would be written against whichever the write path uses — re-run setup so they agree.`,
    )
  }
} else if (cfg) {
  const creds = credentials(cfg)
  warn(
    `no Harvest personal access token found in $${creds.tokenEnv} / $${creds.accountEnv} — falling back to the Harvest MCP. That works, but setup and the catch-up scan then read every entry into the conversation instead of a summary. See references/setup.md step 0 to create one.`,
  )
}

const git = run('git', ['--version'])
checks.push({ name: 'git', ok: git.ok, detail: git.ok ? git.out.trim() : git.error })

const glabWanted = cfg?.sources?.gitlab?.enabled !== false
if (glabWanted) {
  const v = run('glab', ['--version'])
  if (!v.ok) {
    checks.push({ name: 'glab', ok: false, detail: 'not installed — see https://gitlab.com/gitlab-org/cli' })
  } else {
    const auth = run('glab', ['auth', 'status'])
    // glab writes its status banner to stderr even on success.
    const text = `${auth.out || ''}\n${auth.err || ''}\n${auth.error || ''}`
    checks.push({
      name: 'glab',
      ok: /Logged in/i.test(text),
      detail: /Logged in/i.test(text) ? text.split('\n').find((l) => /Logged in/i.test(l)).trim() : 'run `glab auth login`',
    })
  }
}

if (cfg?.sources?.github?.enabled) {
  const v = run('gh', ['auth', 'status'])
  checks.push({ name: 'gh', ok: v.ok, detail: v.ok ? 'authenticated' : 'not installed or not authenticated' })
}

if (cfg) {
  const roots = cfg.repos?.roots || []
  const missing = roots.filter((r) => !existsSync(r))
  const found = findRepos(roots, cfg.repos?.depth ?? 2)
  checks.push({
    name: 'repos',
    ok: missing.length === 0 && found.length > 0,
    detail: missing.length
      ? `missing roots: ${missing.join(', ')}`
      : `${found.length} git repos under ${roots.join(', ')}`,
  })
}

emit({
  ok: checks.every((c) => c.ok),
  configPath: activeConfigPath(),
  legacyConfigPath: legacy ? legacyConfigPath() : null,
  hasConfig: Boolean(cfg),
  schemaVersion: SCHEMA_VERSION,
  configVersion: cfg ? Number(cfg.version || 0) : null,
  // The working-day boundary in effect. 3 means a day runs 03:00 to 03:00, so
  // work just after midnight belongs to the evening before.
  dayStartHour: startHour,
  // True when the run will work but produce worse answers than it should.
  // Report every warning to the user — that is the whole point of the field.
  degraded: warnings.length > 0,
  warnings,
  // False means the config cannot produce a valid log_time call. Collect and
  // propose anyway if you like, but do not offer to write until it's fixed.
  canWrite: Boolean(cfg) && checks.find((c) => c.name === 'config-values')?.ok === true,
  // True when the REST path is live. False is not a failure — it means every
  // Harvest read goes through the MCP and costs context.
  harvestApi,
  checks,
  // The Harvest MCP is only needed when harvestApi is false, plus for
  // submit_timesheet, which has no REST equivalent.
  mcpToVerify: [harvestApi ? null : 'harvest', 'google-calendar', 'atlassian(jira)', 'granola', 'slack'].filter(Boolean),
})
