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

Derive and store:

- `harvest.defaultProjectId` — the project with the most of their entries
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
5. Timezone (default: system)

## 4. Write

Write `~/.claude/harvest-day/config.json` using the shape in
`../templates/config.example.json`. Confirm the path back to the user in one
line, then continue with whatever they originally asked for.

## Re-running setup

"reconfigure harvest", "change my harvest repos" and similar → re-run only the
relevant part and rewrite the file, preserving `harvest.learnedRoutes` entries
whose `source` is `user`.
