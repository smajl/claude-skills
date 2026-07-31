---
name: harvest-day
description: Reconstruct what the user worked on from git, GitLab, Jira, Google Calendar, Granola and Slack, then propose and log Harvest time entries. Use when the user wants to fill in, catch up on, or check their Harvest timesheet ("log my day", "fill my harvest", "what did I do on Tuesday", "catch up my timesheet", "/harvest").
---

# Harvest day reconstruction

Turn a day's scattered evidence into Harvest time entries. **Never write to
Harvest without explicit confirmation** — the whole point is that the user
reviews a proposal first.

Scripts referenced below live in `${CLAUDE_PLUGIN_ROOT}/skills/harvest-day/scripts/`.
Run them with `node`. Config lives at `~/.claude/harvest-day/config.json`
(`$CLAUDE_CONFIG_DIR/harvest-day/config.json` if that variable is set).

## Phase 0 — preflight

```
node "${CLAUDE_PLUGIN_ROOT}/skills/harvest-day/scripts/doctor.mjs"
```

- `hasConfig: false` → go to Phase 1, then continue.
- Any failed check → report it in one line and continue with that source
  disabled. Only a dead Harvest MCP is fatal.
- Verify the MCP sources yourself with one cheap call each, in parallel:
  Harvest `get_account_settings`, Calendar `list_calendars`, Atlassian
  `getAccessibleAtlassianResources`. If Granola or Slack are configured but
  only expose `authenticate`, tell the user to run `/mcp` and carry on without
  them.

Preflight output to the user is at most three lines. Don't narrate healthy checks.

## Phase 1 — setup (first run only)

Full procedure in `references/setup.md`. Summary: detect everything detectable,
ask the user to confirm rather than type. Write the config, then continue to the
run the user actually asked for.

## Phase 2 — resolve the date range

- Explicit date, `today`, `yesterday`, `last friday`, `this week`, `last week`,
  or `2026-07-27..2026-07-31` — all accepted.
- **No date given**: call Harvest `list_time_entries` with the user's
  `user_ids` for the last 14 days, sum hours per day, and list workdays that are
  empty or under `harvest.targetHoursPerDay`. Ask which to fill. Skip weekends
  unless the user logged time on one before.
- Process one day at a time. A range is a loop over days, each with its own
  proposal and its own confirmation.

## Phase 3 — collect evidence

Run all of these in parallel for the day. Details and field meanings in
`references/collectors.md`.

| Source | How |
|---|---|
| git | `node .../collect-git.mjs --from D --to D` |
| GitLab | `node .../collect-gitlab.mjs --from D --to D` |
| Calendar | Calendar MCP `list_events` for the day across `sources.calendar.calendars` |
| Jira | Atlassian MCP: JQL for issues you touched, plus `getJiraIssue` for titles of keys found elsewhere |
| Confluence | Atlassian MCP CQL: comments you wrote and pages you edited. **UTC bounds — see the collectors reference.** Doc review shows up nowhere else |
| Granola | search meeting notes for the day — use them for note *substance*, not for durations |
| Slack | only when a day is thin on other evidence; look for your messages in work channels |

Never invent evidence. If a source is disabled or errors, say so in the
proposal's footer rather than silently producing a thinner day.

## Phase 4 — cluster

Group evidence into candidate entries. Rules in `references/mapping.md`.

1. **Meetings** — one cluster per calendar event that the user accepted and
   that isn't all-day, OOO, or declined.
2. **Ticket work** — one cluster per ticket key, mined from commit subjects,
   branch names, MR titles, review comments and Jira. Merge clusters sharing a key.
3. **Untracked work** — evidence with no ticket key, grouped by repo.
4. **Review clusters** — MRs the user commented on or approved but didn't author.
   These are separate from their own ticket work; they are the most commonly
   forgotten entries, so surface them even when small.
5. **Doc review clusters** — one per Confluence page the user commented on.
   Code has four sources backing it; document review has exactly one, so a page
   with a handful of substantive comments is a real entry, not noise.

Then route each cluster to a project and task per `references/mapping.md`.
Multi-project matters here: HUME is the default, but recruiting, interviews,
internal management and company-wide meetings belong to Engineering (ENG).
**When routing is genuinely ambiguous, mark the row `?` and ask** — the user
would rather correct a flagged row than find a wrong one later.

## Phase 5 — estimate hours, both ways

Produce two numbers per cluster and show both:

Meeting hours are the true calendar duration in both columns and are never
discounted automatically — the user trims them case by case at review.

- **Evidence** — meetings at their true calendar duration; work clusters sized
  from evidence volume (commits, diff size, review comments, Jira transitions)
  against the user's historical hours for similar work. Days won't total the target.
- **Fill** — meetings unchanged, then `targetHoursPerDay − meetings` distributed
  across work clusters in proportion to their evidence weight.

Round both to 0.25h. The account has no rounding and no timestamp timers, so log
plain durations — never `started_time`/`ended_time`.

## Phase 6 — present and confirm

Show one table per day:

```
Fri 2026-07-31  ·  evidence 5.75h  ·  fill 8h  ·  target 8h

#  Project  Task              Evid  Fill  Notes                                     Why
1  HUME     Hume Meetings     0.25  0.25  Hume standup                              cal 09:00–09:15
2  HUME     Hume Meetings     0.25  0.25  Leads Sync                                cal 09:15–09:30
3  HUME     Maintenance-Core  3.00  4.50  HUME-5720 Select V2 — replacements, tests 6 commits, +412/-180, hume-web
4  HUME     Feature - Core    1.00  1.50  review MR "HUME-8582 Replace BasicSelect" 4 diff notes + approval
5  ?        ?                 0.75  1.00  Interview — candidate screen              cal 14:00–14:45  ← route?

Already in Harvest for this date: none.
Sources: git ✓  gitlab ✓  calendar ✓  jira ✓  granola ✗ (not authenticated)
```

- Always run `list_time_entries` for that date and user first, and show what's
  already there. If a proposed row duplicates an existing entry, mark it and
  default to skipping it.
- Ask which column to use, then accept freeform edits: "row 3 → 2.5", "merge 1
  and 2", "drop 5", "row 5 is ENG/Recruiting", "notes on 3 should say …".
- Match the user's existing note style: ticket key first, lowercase imperative
  summary, e.g. `HUME-5720 Select V2 - remaining replacements, coding, reviews`.
  Bundled meeting entries use a `- item` list in one note, which is also fine.

## Phase 7 — write

Only after an explicit yes. One `log_time` call per row, `spent_at` = the day.
Report the created entry ids and the day's total. If the user asks, and it's the
end of a week, offer `submit_timesheet` — this account has `approval_required`.

## Phase 8 — learn

When the user corrects a route, append it to `harvest.learnedRoutes` in the
config so the next run gets it right. Keep entries as
`{ "match": "<lowercased substring or /regex/>", "projectId": N, "taskId": N, "source": "user" }`.
Never remove a user-authored route without being asked.
