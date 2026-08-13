---
name: harvest-log
description: Reconstruct what the user worked on from git, GitLab, Jira, Google Calendar and Slack, then propose and log Harvest time entries. Use when the user wants to fill in, catch up on, or check their Harvest timesheet ("log my day", "fill my harvest", "what did I do on Tuesday", "catch up my timesheet", "/harvest").
---

# Harvest day reconstruction

Turn a day's scattered evidence into Harvest time entries. **Never write to
Harvest without explicit confirmation** — the whole point is that the user
reviews a proposal first.

Scripts referenced below live in `${CLAUDE_PLUGIN_ROOT}/skills/harvest-log/scripts/`.
Run them with `node`. Config lives at `~/.claude/harvest-log/config.json`
(`$CLAUDE_CONFIG_DIR/harvest-log/config.json` if that variable is set). This
skill was called `harvest-day` until v0.7.0; a config still sitting at
`~/.claude/harvest-day/config.json` is read from there and doctor says so.

## Harvest: API first, MCP as fallback

Every Harvest read has two paths, and they differ by an order of magnitude in
context. Prefer the scripts:

| Need | Script (preferred) | MCP fallback |
|---|---|---|
| Identity, account settings, projects, tasks | `harvest-meta.mjs` | `get_account_settings`, `list_projects`, `list_project_assignments` |
| What's already logged for a day | `harvest-entries.mjs --from D --to D` | `list_time_entries` |
| Which recent days are thin | `harvest-entries.mjs --catch-up` | `list_time_entries` + arithmetic |
| Setup's medians and note patterns | `harvest-entries.mjs --calibrate` | 90 days of `list_time_entries` |
| Writing confirmed rows | `log-time.mjs --rows f.json --confirm` | `log_time`, one call per row |
| Submitting a timesheet | — | `submit_timesheet` (no REST equivalent) |

The MCP returns entries; the scripts return the numbers derived from them. A
90-day calibration is several hundred entries through the MCP and about thirty
lines through the script, and nobody reads the entries either way.

**When a script exits with `fallback: "mcp"` there is no token** — use the MCP
column and carry on. That path is fully supported; it is just expensive. Say so
once, in preflight, and don't repeat it every phase.

## Phase 0 — preflight

```
node "${CLAUDE_PLUGIN_ROOT}/skills/harvest-log/scripts/doctor.mjs"
```

- `hasConfig: false` → go to Phase 1, then continue.
- `canWrite: false` → the config can't produce a valid `log_time` call (usually
  an unfinished setup leaving `0` placeholders). Fix the listed
  `config-values` problems before Phase 7; don't discover it at the write.
- `warnings[]` → **print every one, verbatim, before doing anything else.**
  These are the settings that make the output quietly worse rather than
  failing: a missing calibration, an unset note style, a config written against
  an older schema. They are not "healthy checks" and are never suppressed by
  the line budget below. Each one names its own fix; offer to run it.
- Any failed check → report it in one line and continue with that source
  disabled. Only a total loss of Harvest — no working token *and* no working
  MCP — is fatal.
- `harvestApi: true` means doctor already authenticated against the REST API;
  don't re-verify Harvest through the MCP as well. When it is false, check the
  MCP with `get_account_settings` as before.
- Verify the other MCP sources yourself with one cheap call each, in parallel:
  Calendar `list_calendars`, Atlassian `getAccessibleAtlassianResources`. If
  Slack is configured but only exposes `authenticate`, tell the user to run
  `/mcp` and carry on without it.

Beyond the warnings, preflight output is at most three lines. Don't narrate
healthy checks — but never trade a warning for brevity. Silent degradation is
the failure mode this phase exists to prevent: output that looks fine is output
nobody thinks to question.

## Phase 1 — setup (first run only)

Full procedure in `references/setup.md`. Summary: detect everything detectable,
ask the user to confirm rather than type. Write the config, then continue to the
run the user actually asked for.

## Phase 2 — resolve the date range

- Explicit date, `today`, `yesterday`, `last friday`, `this week`, `last week`,
  or `2026-07-27..2026-07-31` — all accepted.
- **A day runs from `rules.dayStartHour` (default 03:00) to the same hour next
  morning**, not midnight to midnight, so work done just after midnight belongs
  to the evening before. This also moves what `today` means: run at 01:00 and
  `today` is still the previous calendar date, which is the session the user is
  actually in. `references/collectors.md` has the table and the reasoning.
- **No date given**: run the catch-up scan and ask which days to fill.

  ```
  node .../harvest-entries.mjs --catch-up --days 14
  ```

  It returns one row per day — date, weekday, hours, that day's target, whether
  it is under — plus a `candidates[]` already filtered the way this phase
  filters. On `fallback: "mcp"`, call `list_time_entries` with the user's
  `user_ids` and `limit: 500` over the same window and do the arithmetic
  yourself, including the pagination note below.
- **Weekends are not automatically absent.** `rules.skipWeekends` keeps them out
  of the *default* catch-up list, but when `rules.weekendsWithEvidence` is on and
  a weekend day has collector evidence, offer it anyway and say what was found.
  Weekend work is real, it is usually a short evening stretch rather than a day,
  and it is invisible to a rule that never looks. A weekend day offered this way
  targets `calibration.dayTotals.weekend`, never the weekday figure.
- Either path is paginated. **A day looks empty both when nothing was logged
  and when the page ran out** — on the MCP path, if the response has
  `truncated: true`, follow `next_cursor` (same parameters, opaque token) before
  deciding anything is empty; if `scope_limited` is true, permissions are hiding
  entries, so say so and don't report zeros as fact. The script paginates
  itself and reports `truncated` only when it hit its own page cap.
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
| Confluence | Atlassian MCP CQL: comments you wrote and pages you edited. **CQL bounds are UTC** — use the `window.cqlStart` / `window.cqlEnd` the collectors emit, never a bare local date. Doc review shows up nowhere else |
| Slack | `node .../collect-slack.mjs --from D --to D` — one sweep returns huddles (ad-hoc calls that reach no calendar) *and* messages, plus a ready-made `events[]` for the timeline. On `fallback: "mcp"` the huddles degrade and the messages must come from MCP search — both paths in `references/collectors.md` |
| Slack messages | always, by either path — the densest timestamped source there is, and the only one that catches otherwise-invisible work or a stated ad-hoc absence ("afk ~2h", "doctor") that should reduce the day's target |

Never invent evidence. If a source is disabled, errors, or reports
`truncated`, say so in the proposal's footer rather than silently producing a
thinner day.

Then build the day's timeline. It runs git and GitLab itself; hand it everything
that came from an MCP — Slack messages as points, calendar events as spans:

```
node .../build-timeline.mjs --from D --to D --events events.json
```

```json
[ {"t": "2026-07-30T11:35:48+02:00", "kind": "slack", "label": "#hume-e2e-testing"},
  {"start": "2026-07-30T09:00:00+02:00", "end": "2026-07-30T10:00:00+02:00",
   "kind": "meeting", "label": "Hume standup"} ]
```

It returns `sessions[]`, `eveningSession`, `meetingOverlaps[]` and
`afterMidnight[]`. **Use its answer rather than merging the collectors by
hand** — three timestamp conventions across five sources is exactly the
arithmetic that comes out differently on different runs. Supplying no `--events`
is allowed and it says so in `notes`, but Slack is the densest source there is,
so the timeline without it is much thinner than the day was.

## Phase 4 — cluster

Group evidence into candidate entries. Rules in `references/mapping.md`.

1. **Meetings** — one cluster per calendar event that the user accepted and
   that isn't all-day, OOO, or declined, plus one per Slack huddle. A huddle
   overlapping a calendar event is the same meeting — the call moved to Slack —
   so keep the calendar event and drop the huddle rather than billing both.
2. **Ticket work** — one cluster per ticket key, mined from commit subjects,
   branch names, MR titles, review comments and Jira. Merge clusters sharing a key.
3. **Untracked work** — evidence with no ticket key, grouped by repo. Local
   commits and the GitLab pushes that carried them are one cluster, not two —
   join on the repo slug per `references/mapping.md`.
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

Finally, **collapse the work clusters to the shape the user actually logs.**
The clustering above is deliberately fine-grained, because that is how you find
everything; it is not how anyone writes a timesheet. Merge every work cluster
sharing a project and task into one row, carrying the ticket keys into the note.
Meetings are exempt — they are genuinely logged one per event. Full rule and the
reasoning in `references/mapping.md`.

## Phase 5 — estimate hours, both ways

Produce two numbers per cluster and show both:

Meeting hours are the true calendar duration in both columns and are never
discounted automatically — the user trims them case by case at review. A
huddle's measured duration counts as exact in the same way; only a huddle
marked `durationUnknown` is an estimate, and it says so in its row.

- **Evidence** — meetings at their true calendar duration; work clusters scored
  from evidence volume (commits, diff size, review comments, Jira transitions)
  and converted at `harvest.calibration.hoursPerScore`, then bounded by the
  user's median hours for that task. Scoring table and both constants are in
  `references/mapping.md` — use it rather than estimating freehand, so that the
  same evidence produces the same number twice. Days won't total the target.
- **Fill** — meetings unchanged, then `target − meetings` distributed across
  work clusters in proportion to their evidence weight.

Round both to `harvest.roundToHours` (0.25 by default). The account has no
rounding and no timestamp timers, so log plain durations — never
`started_time`/`ended_time`.

### The target is not one number

`harvest.targetHoursPerDay` is the fallback, not the answer. Pick the day's
target from `harvest.calibration.dayTotals`, which setup measures from the
user's own entries:

| Day | Target |
|---|---|
| Weekday | `dayTotals.weekday` |
| Weekday with an evening session | `dayTotals.weekdayWithEveningSession` |
| Saturday or Sunday | `dayTotals.weekend` |
| Saturday or Sunday with an evening session | `dayTotals.weekendWithEveningSession` |

The evening question applies to weekend days too. Weekend work is *usually* an
evening, so the session is not what makes it unusual — but a weekend day that
shows a real evening stretch still runs longer than one that shows a single
push, and the two should not land on the same number.

An **evening session** is timestamped evidence — commits, GitLab events, Slack
messages — at or after `rules.eveningSessionHour` (19:00 by default), or before
`rules.dayStartHour`. It is a real and frequent pattern: an evening picked up
after dinner, covering for an afternoon errand or simply working late.
`build-timeline.mjs` decides this; read `eveningSession` off its output rather
than working it out from the collectors.

The floor applies to **all** of the day's evening evidence taken together, not to
each session separately — an evening interrupted by dinner is still an evening.

**It must clear a floor: at least 3 events spanning at least 15 minutes**
(`rules.eveningFloorEvents`, `rules.eveningFloorSpanMinutes`).
Glancing at a pipeline before bed produces two messages a minute apart, and that
is not an evening of work. The event count is what separates a glance from a
session; the span is a weak secondary check, because a genuinely long evening can
leave only a few minutes of trace at the very end of it. Without the floor the
question fires on roughly half of all days and the user learns to dismiss it,
which costs more than never asking. A burst below the floor is still worth one
line in the Why column — it is evidence the day didn't end at 18:00 — it just
doesn't move the target on its own.

**Detect it, then ask — never silently raise the target.** Say what was found
and what days like it usually came to:

```
Evening session detected: 21:43–23:00 (4 Slack messages, 2 pushes).
Weekdays with an evening session usually total 9h rather than 8h.
Use 9h for this day?  [y / n / other]
```

The timeline is good at spotting *that* a day ran long and bad at measuring *how
long* — a stretch of evidence covers a fraction of the work it represents. So it
opens the question and the user settles it. If they decline, fall back to the
same day's no-session target — `dayTotals.weekend` on a Saturday or Sunday,
`dayTotals.weekday` otherwise. Declining the raise must never move a weekend day
onto a weekday figure.

**The target can also be wrong in the other direction, and the evidence says
so.** When the day's uncapped work evidence exceeds `target − meetings`, the
figure came from a median and this day is an outlier. Flag every capped row and
ask, exactly as above — `references/mapping.md` has the rule and the wording.
Weekend days are where this bites: a 2h target clips a long Saturday, and
without the flag the table's two columns agree, the rows sum to target, and
nothing shows that hours are missing.

An absence found by the Slack check (`references/collectors.md`) subtracts from
whichever target was chosen, and both adjustments can apply to the same day.

## Phase 6 — present and confirm

Show one table per day:

```
Fri 2026-07-31  ·  evidence 6h  ·  fill 9h  ·  target 9h (weekday + evening session)

#  Project  Task              Evid  Fill  Notes                                     Why
1  HUME     Hume Meetings     0.25  0.25  Hume standup                              cal 09:00–09:15
2  HUME     Hume Meetings     0.25  0.25  Leads Sync                                cal 09:15–09:30
3  HUME     Maintenance-Core  4.00  6.75  HUME-5720 Select V2 — replacements,       6 commits +412/-180 hume-web;
                                          tests; also review of !5723               4 diff notes + approval (merged)
4  HUME     Hume Meetings     0.75  0.75  huddle with Yusuf                         slack 13:00–13:50, 2 segments
5  ?        ?                 0.75  1.00  Interview — candidate screen              cal 14:00–14:45  ← route?

Evening session 21:10–22:40 (3 commits, 5 Slack messages) — target raised 8h → 9h.
Already in Harvest for this date: none.
Sources: git ✓  gitlab ✓  calendar ✓  jira ✓
         huddles ✓ (2, measured)
Estimates: uncalibrated — no historical bound (run setup to fix)
```

Row 3 is two clusters — the ticket work and the MR review both route to
Maintenance-Core — merged per the collapse rule. The Why column keeps both
sources visible so the merge stays checkable.

The `Estimates:` line appears whenever doctor reported a calibration warning.
The hours in the table are the thing that warning is about, so it belongs here
as well as in preflight — omit it only when the calibration is present.

- The header shows the real sum of each column, and names which target was
  chosen and why — `target 9h (weekday + evening session)`, `target 2h
  (weekend)`. A target that changed between days should never be silent.
- When fill can't reach target — meetings-only days, thin evidence — print the
  gap rather than the target: `evidence 2.5h · fill 2.5h · target 8h · 5.5h
  unaccounted`. Never print a fill figure the rows don't add up to.
- When evidence *overshoots* the target, print that too, with the uncapped
  figure: `evidence 6.75h (capped to 2h) · fill 2h · target 2h  ← target
  may be low`. A day the rows agree on is not the same as a day that's right.
- Always check what's already logged for that date first
  (`harvest-entries.mjs --from D --to D`, or `list_time_entries` on the fallback
  path) and show it. If a proposed row duplicates an existing entry, mark it and
  default to skipping it.
- Ask which column to use, then accept freeform edits: "row 3 → 2.5", "merge 1
  and 2", "drop 5", "row 5 is ENG/Recruiting", "notes on 3 should say …".
- Match `harvest.noteStyle` — captured from their own entries at setup, and by
  default: ticket key first, lowercase imperative summary, e.g.
  `HUME-5720 Select V2 - remaining replacements, coding, reviews`. Bundled
  meeting entries use a `- item` list in one note, which is also fine.

## Phase 7 — write

Only after an explicit yes. Before the first call, check every confirmed row
has a resolved project id and task id, both ≥ 1, and that no row is still
marked `?` — Harvest rejects `0`, and a rejection halfway down the list leaves
the day half-logged. Resolve or drop those rows first.

Write the confirmed rows to a JSON file and run the writer twice — once to
validate, once to write:

```
node .../log-time.mjs --rows rows.json              # validates every row, writes nothing
node .../log-time.mjs --rows rows.json --confirm    # writes
```

```json
[ { "spentAt": "2026-07-31", "projectId": 41234567, "taskId": 8912345,
    "hours": 2.5, "notes": "HUME-5720 select v2 - remaining replacements" } ]
```

The dry run is not ceremony: it checks every row's ids, dates and hours before
any of them exists, so a bad row is found while the day is still unlogged rather
than half-logged. If the write does fail partway, the output names exactly which
rows landed — report that verbatim rather than re-running the whole file.

On `fallback: "mcp"`, one `log_time` call per row instead, `spent_at` = the day.

Report the created entry ids and the day's total. If the user asks, and it's the
end of a week, offer `submit_timesheet` — this account has `approval_required`,
and submission is MCP-only.

## Phase 8 — learn

When the user corrects a **route**, append it to `harvest.learnedRoutes` so the
next run gets it right. Keep entries as
`{ "match": "<case-insensitive regex>", "projectId": N, "taskId": N, "source": "user" }`
— same matching rule as `harvest.taskRules`, and both ids are required.
Never remove a user-authored route without being asked.

When the user corrects **hours**, tune the estimator. Over the work rows they
changed (ignore meetings — those are exact, and a trim there is a judgement
about attendance, not about sizing), compute
`ratio = Σ accepted hours ÷ Σ proposed hours`. If it is outside 0.9–1.1, the
scoring is systematically off, so nudge `harvest.calibration.hoursPerScore`
one third of the way toward `hoursPerScore × ratio` and increment `samples`.
Nudging rather than jumping keeps one unusual day from re-centring the model.
Leave `medianHoursByTask` alone; setup recomputes it from real logged entries.

When the user overrides the **day target** — declines the evening-session
raise, or sets a weekend day to something other than `dayTotals.weekend` —
don't touch the config on a single answer. Two of these in the same direction
for the same day type is a pattern worth acting on: move that `dayTotals` entry
one step (0.25h) toward what they chose, and say you did. These are measured
medians rather than a fitted constant, so they should move slowly and visibly;
a full recompute at the next setup run beats guessing from three corrections.
