# First-run setup

Goal: the user confirms detected values instead of typing them. Detect first,
ask second, and ask in as few rounds as possible.

## 1. Detect

Run in parallel:

- `git config --global user.email` and `user.name` → `identity.gitAuthors`
- `glab api user` → `identity.gitlabUsername`, and `glab config get host`
- Harvest `get_account_settings` → `wants_timestamp_timers`, `approval_required`,
  `time_rounding`, `week_start_day`
- Harvest `list_users` filtered to the authenticated person, or read the
  `user_id` off their own entries in `list_time_entries` → `identity.harvestUserId`
- Harvest `list_projects` + `list_project_assignments(assignment_type: "tasks")`
  for each candidate project → the routing table's raw material
- Calendar `list_calendars` → which calendars to read
- Atlassian `getAccessibleAtlassianResources` → `sources.jira.cloudId` and
  `sources.confluence.cloudId` (same site id serves both)

Then, with a guessed root (`C:\dev` on Windows, `~/dev` or `~/src` otherwise):

```
node "${CLAUDE_PLUGIN_ROOT}/skills/harvest-day/scripts/scan-repos.mjs" \
  --roots "C:/dev" --authors "email,Name" --days 90
```

`suggested` is the repos the user has actually committed to in 90 days — the
right default for `repos.include`.

## 2. Seed routing from history

Pull the user's own Harvest entries for the last 90 days
(`list_time_entries` with their `user_ids`). This is the single most valuable
setup step: it reveals which task they use for meetings, which for bugfix work,
how they phrase notes, and their typical daily total.

**Paginate it.** 90 days of a daily logger is several hundred entries and the
page size caps at 500, so pass `limit: 500` and keep following `next_cursor`
while `truncated` is true, holding every other parameter identical. Skipping
this doesn't fail loudly — it silently derives the note style, the routing
table and the calibration below from only the most recent slice of history.

Take aggregates from the aggregate endpoint, which can't be truncated:
`get_time_report` with `group_by: "project"` over the same 90 days gives the
project totals directly. Use it for `defaultProjectId`, and use the raw entries
for the things only individual entries can show — phrasing, per-task medians,
recurring note patterns. Note that `get_time_report` cannot group by day, so
per-day totals still have to come from the entries.

Derive and store:

- `harvest.defaultProjectId` — the project with the most of their hours
- `harvest.learnedRoutes` — recurring note patterns → task id, e.g. any note
  matching a standup/sync/1on1/retro/demo phrase → the meetings task
- `harvest.noteStyle` — one sentence describing their phrasing, quoted back to
  them for confirmation
- `harvest.targetHoursPerDay` — median of their non-zero day totals, rounded
- `harvest.calibration.medianHoursByTask` — `{ "<taskId>": <median hours per
  entry> }` across those 90 days, for every task with at least 3 entries. This
  is the only measured input the estimator has; without it the score→hours
  conversion has nothing to check itself against (see `mapping.md`). Set
  `computedFrom` to the date you computed it and leave `hoursPerScore` at its
  default — Phase 8 tunes that one from the user's corrections.

## 3. Ask

One consolidated round of questions. Everything has a detected default:

1. Repo roots and which repos to track (present `suggested`, let them add/remove)
2. Default Harvest project, and any secondary projects to route to
3. Target hours per day
4. Which optional sources to enable: GitLab, GitHub, Jira, Calendar, Granola, Slack
5. Whether to track Slack huddles (see below — it needs one manual step)
6. Timezone (default: system)
7. `rules.dayStartHour` — only worth raising if they say something about their
   hours. Default 3 means work up to 03:00 counts toward the previous day; 0
   means literal midnight days. Don't interrogate anyone about this.

## 3b. The Slack huddle token

Only when the user enables huddles. Everything else in this skill authenticates
through an MCP or a CLI that is already logged in; this one needs a token,
because the huddle metadata — how long the call ran, who was in it — is not
exposed by the Slack MCP at all. Without it huddles degrade to bare start
times. Explain that trade-off and let the user decide; don't push.

Walk them through it rather than pasting a link and hoping:

1. <https://api.slack.com/apps> → **Create New App** → **From scratch**. Name it
   anything (`harvest-day`), pick their workspace.
2. **OAuth & Permissions** → *User* Token Scopes (the **User** column, not Bot —
   a bot token cannot see their DMs, which is where most huddles happen). Add:
   `users:read`, `channels:history`, `groups:history`, `im:history`,
   `mpim:history`, `channels:read`, `groups:read`, `im:read`, `mpim:read`.
   All read-only; the app can post nothing.
3. **Install to Workspace**, then copy the **User** OAuth Token — it starts
   `xoxp-`. If their workspace requires admin approval to install apps, this
   step is where it will stop, and the fallback path is the answer.
4. Put it in an environment variable, not in the config:

   ```powershell
   # PowerShell, persisted for this user
   [Environment]::SetEnvironmentVariable('HARVEST_DAY_SLACK_TOKEN', 'xoxp-…', 'User')
   ```

   Set `sources.slack.huddles.tokenEnv` if they'd rather use a different
   variable name. Doctor warns if a token ends up written into `config.json`.

Then verify against their real workspace before trusting it:

```
node "${CLAUDE_PLUGIN_ROOT}/skills/harvest-day/scripts/collect-slack.mjs" --probe
```

This sweeps 90 days for any huddle and dumps the raw payloads. Confirm that
`room.date_start`, `room.date_end` and `room.participant_history` are present
and populated. If `date_end` comes back `0` on huddles that have clearly ended,
durations aren't available on that workspace and every huddle will report
`durationUnknown` — worth knowing at setup rather than discovering it in a
proposal.

## 4. Write

Write `~/.claude/harvest-day/config.json` using the shape in
`../templates/config.example.json`. Confirm the path back to the user in one
line, then continue with whatever they originally asked for.

## Re-running setup

"reconfigure harvest", "change my harvest repos" and similar → re-run only the
relevant part and rewrite the file, preserving `harvest.learnedRoutes` entries
whose `source` is `user`.

## Upgrading an older config

Doctor reports `configVersion` against `schemaVersion` and warns when the file
predates the current shape. Re-running setup is the fix, but it must **fill in
the gaps, not start over**: derive only the fields that are missing, keep every
existing value, keep user-authored learned routes, and set `version` to the
current `schemaVersion` when done.

Setup is also the fix named by most other warnings, so expect it to be invoked
to repair one field at a time. Recomputing `harvest.calibration` needs nothing
but the 90-day entry pull from step 2 — don't make the user answer the step 3
questions again to get it.
