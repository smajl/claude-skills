# First-run setup

Goal: the user confirms detected values instead of typing them. Detect first,
ask second, and ask in as few rounds as possible.

## 0. The Harvest token

Do this before anything else, because it decides how the rest of setup runs.
Step 2 reads 90 days of the user's entries: through the REST API that is a
script call returning about thirty lines, and through the MCP it is several
hundred entries arriving in the conversation. Same numbers, two orders of
magnitude apart.

Ask for it once, and take no for an answer — the MCP path works.

1. <https://id.getharvest.com/developers> → **Create new personal access token**.
   Name it `harvest`.
2. Copy the token *and* the account id shown beside it.
3. Into the environment, never into the config:

   ```powershell
   # PowerShell, persisted for this user
   [Environment]::SetEnvironmentVariable('HARVEST_TOKEN', 'pat...', 'User')
   [Environment]::SetEnvironmentVariable('HARVEST_ACCOUNT_ID', '123456', 'User')
   ```

   ```bash
   # bash / zsh
   export HARVEST_TOKEN=pat...
   export HARVEST_ACCOUNT_ID=123456
   ```

   A new terminal is needed for a persisted PowerShell variable to be visible.
   Set `harvest.tokenEnv` / `harvest.accountIdEnv` for other names.

**The same token serves `harvest-review`**, which needs one and cannot degrade
to the MCP at team scale. If the user has already set it up for that plugin,
there is nothing to do here.

The token only ever needs to see the user's own time, so a plain member account
is enough. `doctor.mjs` reports `harvestApi: true` once it works, and warns —
rather than fails — when it is absent.

## 1. Detect

Run in parallel:

- `git config --global user.email` and `user.name` → `identity.gitAuthors`
- `glab api user` → `identity.gitlabUsername`, and `glab config get host`
- ```
  node "${CLAUDE_PLUGIN_ROOT}/skills/harvest-log/scripts/harvest-meta.mjs" --tasks
  ```
  → `identity.harvestUserId` and `identity.timezone` from `/users/me`, the
  account's `wants_timestamp_timers` / `approval_required` / `time_rounding` /
  `week_start_day`, and every project the user can log against with its allowed
  tasks — the routing table's raw material, in one call.

  On `fallback: "mcp"`: Harvest `get_account_settings`, `list_users` filtered to
  the authenticated person (or the `user_id` off their own entries), and
  `list_projects` + `list_project_assignments(assignment_type: "tasks")` per
  candidate project.
- Calendar `list_calendars` → which calendars to read
- Atlassian `getAccessibleAtlassianResources` → `sources.jira.cloudId` and
  `sources.confluence.cloudId` (same site id serves both)

Then, with a guessed root (`C:\dev` on Windows, `~/dev` or `~/src` otherwise):

```
node "${CLAUDE_PLUGIN_ROOT}/skills/harvest-log/scripts/scan-repos.mjs" \
  --roots "C:/dev" --authors "email,Name" --days 90
```

`suggested` is the repos the user has actually committed to in 90 days — the
right default for `repos.include`.

## 2. Seed routing from history

The single most valuable setup step: 90 days of the user's own entries reveal
which task they use for meetings, which for bugfix work, how they phrase notes,
and their typical daily total.

```
node "${CLAUDE_PLUGIN_ROOT}/skills/harvest-log/scripts/harvest-entries.mjs" \
  --calibrate --days 90 --evening-days evenings.json
```

It paginates itself and returns a `suggested` block shaped like the config's
`harvest` section, plus `projects` (totals, ranked), `notePatterns` (the five
most repeated phrasings per task, with a real sample of each), `sampleSizes`
and `omitted`.

**Write `evenings.json` first.** It is the list of dates in the same 90 days
that carried timestamped evidence at or after `rules.eveningSessionHour` —
produced by running the git and GitLab collectors across the window and taking
each day's last session start. Harvest cannot supply it: an entry has a date and
a duration, never a clock. Without the file, the two evening-session fields are
omitted rather than guessed, and `omitted` says exactly that.

```json
["2026-06-04", "2026-06-11", "2026-07-02"]
```

Read `omitted` out loud. Each entry is a measurement the history could not
support — too few weekend days, too few evenings — not a value that came out
zero, and the difference decides whether the fill column pads or clips those
days later.

On `fallback: "mcp"`: pull the entries with `list_time_entries` and their
`user_ids`, **paginated** — 90 days of a daily logger is several hundred entries
and the page size caps at 500, so pass `limit: 500` and keep following
`next_cursor` while `truncated` is true, holding every other parameter
identical. Skipping this doesn't fail loudly; it silently derives everything
below from only the most recent slice of history. Take project totals from
`get_time_report` with `group_by: "project"`, which can't be truncated, and the
rest from the raw entries — `get_time_report` cannot group by day, so per-day
totals still have to come from them.

Either way, these are what end up in the config. On the script path the first
column of each is already computed for you in `suggested` — check it rather than
recompute it, and spend the attention on the two that need judgement (the note
style and the learned routes), which no script can write:

- `harvest.defaultProjectId` — the project with the most of their hours
- `harvest.learnedRoutes` — recurring note patterns → task id, e.g. any note
  matching a standup/sync/1on1/retro/demo phrase → the meetings task. Read them
  off `notePatterns`: a phrasing repeated a dozen times under one task is
  exactly a route worth learning.
- `harvest.noteStyle` — one sentence describing their phrasing, quoted back to
  them for confirmation. `notePatterns` carries a real sample of each recurring
  shape; describe those rather than inventing a style.
- `harvest.targetHoursPerDay` — median of their non-zero day totals, rounded.
  This is now only the fallback; `dayTotals` below is what the fill column reads.
- `harvest.calibration.medianHoursByTask` — `{ "<taskId>": <median hours per
  entry> }` across those 90 days, for every task with at least 3 entries. This
  is the only measured input the estimator has; without it the score→hours
  conversion has nothing to check itself against (see `mapping.md`). Set
  `computedFrom` to the date you computed it and leave `hoursPerScore` at its
  default — Phase 8 tunes that one from the user's corrections.
- `harvest.calibration.dayTotals` — median day total, split three ways, because
  one figure describes none of them well:
  - `weekday` — median over Mon–Fri days with any time logged.
  - `weekdayWithEveningSession` — median over the subset of those days that
    carry timestamped evidence starting at or after `rules.eveningSessionHour` —
    the `evenings.json` above. Expect it to come out one to two hours above
    `weekday`; below 5 such days the script omits it, and so should you.
  - `weekend` — median over Sat/Sun days with any time logged. Usually a short
    evening, nothing like a weekday. Omit if they never log weekends.
  - `weekendWithEveningSession` — the same split applied to weekend days. The
    sample is always small, so if fewer than 3 weekend days carry an evening
    session, omit it and let those days fall back to `weekend`.
- `harvest.calibration.medianWorkEntriesPerDay` — median count of non-meeting
  entries per logged day. This is frequently **1**: many people write one work
  entry a day plus a handful of small meeting entries. The collapse rule in
  `mapping.md` uses it to check whether a proposal has fragmented one piece of
  work into several rows.

These four are all measured from entries the user already wrote, so take them
from the same pass and don't ask about any of them. `targetHoursPerDay` is the
only one worth confirming out loud, and only because it appears in step 3.

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
   anything (`harvest-log`), pick their workspace.
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
   [Environment]::SetEnvironmentVariable('HARVEST_LOG_SLACK_TOKEN', 'xoxp-…', 'User')
   ```

   Set `sources.slack.huddles.tokenEnv` if they'd rather use a different
   variable name. Doctor warns if a token ends up written into `config.json`.

Then verify against their real workspace before trusting it:

```
node "${CLAUDE_PLUGIN_ROOT}/skills/harvest-log/scripts/collect-slack.mjs" --probe
```

This sweeps 90 days for any huddle and dumps the raw payloads. Confirm that
`room.date_start`, `room.date_end` and `room.participant_history` are present
and populated. If `date_end` comes back `0` on huddles that have clearly ended,
durations aren't available on that workspace and every huddle will report
`durationUnknown` — worth knowing at setup rather than discovering it in a
proposal.

## 4. Write

Write `~/.claude/harvest-log/config.json` using the shape in
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
but one `harvest-entries.mjs --calibrate` run — don't make the user answer the
step 3 questions again to get it.

A config written before v7 has no `harvest.tokenEnv` / `harvest.accountIdEnv`.
Those default correctly, so an upgrade only needs step 0 if the user does not
have a token yet — offer it, take no for an answer, and leave everything else
alone.
