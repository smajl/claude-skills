---
name: harvest-review
description: Review a team's logged Harvest time for irregularities — work billed to the wrong project or task, the same note repeated for days, hours with no corroborating activity, a month backdated in one sitting — and verify each flag against GitLab and Jira before reporting it. Use when a manager wants to check, audit, sanity-check or approve their reports' timesheets ("review my team's time", "check last month's harvest", "does anything look off in the timesheets", "/harvest-review").
---

# Harvest time review

Harvest is the source of truth here. Everything else — GitLab, Jira — exists to
corroborate or contradict what someone already logged. This skill finds the
handful of person-days in a month that are worth a manager's attention, and says
why, in a form the manager can check themselves.

**A finding is a question, not a verdict.** Every pattern this skill detects has
an innocent explanation, and most instances of most patterns are innocent. The
output is a shortlist to look at, phrased so that being wrong about one costs a
two-minute conversation rather than an accusation. Never present a finding as
established fact, never total up "suspicious hours" as though the total meant
something, and never write anything you would not be comfortable showing to the
person it is about.

Scripts live in `${CLAUDE_PLUGIN_ROOT}/skills/harvest-review/scripts/`. Run them
with `node`. Config lives at `~/.claude/harvest-review/config.json`
(`$CLAUDE_CONFIG_DIR/harvest-review/config.json` if that variable is set).

**Read-only.** This skill has no write path into Harvest. It never edits,
deletes or approves an entry — if the user wants a correction made, they make
it, or they use `harvest-log` for their own time.

## How the pipeline stays cheap

Two fetches, one scan, one narrow verification. The volume never enters the
conversation:

```
 fetch  │  Harvest REST → cache file        (thousands of entries, ~15 lines out)
 sweep  │  GitLab project events → cache    (whole team, whole period, one pass)
  scan  │  deterministic detectors → findings ranked by severity
verify  │  one JQL for every flagged key; the GitLab cache answers the rest
 report │  per person, most serious first, with the evidence attached
```

Do not read the cache files. They exist so that the entries stay out of context
— reading one back defeats the whole design. If you need something the scanner
does not report, add a detector rather than reading raw entries; the exception
is a single entry a user asks about by id, which is a line, not a table.

## Phase 0 — preflight

```
node "${CLAUDE_PLUGIN_ROOT}/skills/harvest-review/scripts/doctor.mjs"
```

- `hasConfig: false` → Phase 1, then continue.
- `canReview: false` → the Harvest API is unreachable or the token is rejected.
  Fix that before anything else; there is no degraded mode worth having.
- `warnings[]` → **print every one, verbatim.** The dangerous failure here is a
  review that comes back clean because it could not see anything: a token
  without permission for other people's time, a team member with no GitLab
  handle, an empty project list. Every one of those produces a spotless report.
  Silence is the symptom, so the warnings are the check.
- Verify the Atlassian MCP with one cheap call (`getAccessibleAtlassianResources`).
  Without it, ticket verification is unavailable and findings that depend on it
  stay unverified rather than becoming confirmed.

## Phase 1 — setup (first run only)

Full procedure in `references/setup.md`. Summary: the Harvest PAT and account id
go in environment variables; `fetch-meta.mjs` supplies the people, projects and
task names; the user confirms the roster mapping (Harvest user ↔ GitLab handle ↔
Jira account) and the ticket-prefix → project map rather than typing it.

## Phase 2 — scope

- Accept `last month`, `this month`, `last week`, `2026-07-01..2026-07-31`, a
  single date, or a person's name with any of those.
- **Default to the last complete month** for a bare `/harvest-review`. A period
  still open is a period people have not finished logging, and half a month of
  missing entries looks exactly like a problem.
- Default to everyone in `team[]`. A named person narrows it, and narrowing is
  a normal thing to want — but say what you narrowed to, because a review of one
  person is a different act from a review of a team and the user should see
  which one they asked for.
- Periods longer than a quarter: fetch anyway, but say the run will take a few
  minutes and that thresholds tuned for a month (weekly totals, repeated notes)
  read differently across a quarter.

## Phase 3 — fetch

Run both in parallel; each prints a summary and writes a cache file.

```
node .../fetch-entries.mjs --from 2026-07-01 --to 2026-07-31
node .../collect-gitlab-team.mjs --from 2026-07-01 --to 2026-07-31
```

- `scopeWarning` on the entries fetch means the token likely cannot see the
  team. Stop and say so — everything downstream would be an artefact.
- `noEntriesForConfiguredMembers` is not automatically a finding. It is either a
  genuine absence or a wrong `harvestUserId`; check the roster before treating
  it as the former.
- `errors[]` or `truncatedProjects[]` from the GitLab sweep mean the activity
  picture has holes. Carry that into the report — a `no-trace` finding against
  an incompletely swept project is not evidence of anything.
- Both scripts cache. Re-running a review the same day costs nothing; pass
  `--refresh` when entries have been edited since.

## Phase 4 — scan

```
node .../scan-entries.mjs --entries <entries cache> --activity <gitlab cache>
```

The detectors, their thresholds and their known false positives are in
`references/detectors.md`. Read it before explaining a finding to the user —
each rule has a specific innocent explanation, and naming that explanation in
the report is what keeps the review honest.

The scanner returns `findings[]` ranked by severity then hours, `perUser`
totals, and a `needs` block naming what verification would sharpen. Trust its
ranking; do not re-sort by hours or by person. **Read `omittedNote` and say so
if the cap fired** — a truncated list of findings reads as a short one.

## Phase 5 — verify

Only the flagged rows, batched. Two calls, not two hundred.

**Jira** — one JQL for every key in `needs.jiraKeys`:

```
key in (HUME-5720, HUME-5731, ENG-88) ORDER BY created
```

Request `summary,status,resolutiondate,created,assignee` and nothing else. Write
the result to a small JSON file and re-scan:

```json
{ "issues": [ { "key": "HUME-5720", "summary": "Select V2", "status": "Done",
                "resolutionDate": "2026-06-02", "assignee": "Sam" } ],
  "missing": ["HUME-9999"] }
```

```
node .../scan-entries.mjs --entries <entries> --activity <gitlab> --jira <jira.json>
```

`missing[]` matters as much as `issues[]`: a key that resolves to nothing is
either a typo or a reference to work that does not exist, and the scanner can
only tell the difference between "absent" and "not asked" if you say which.

When a finding turns on *when* someone worked a ticket rather than whether it
exists, one more JQL answers it for a whole person at once:

```
status CHANGED BY <accountId> DURING ("2026-07-01", "2026-07-31")
```

**GitLab** — already in the cache. For a `no-trace` finding, check whether the
person was active on adjacent days (a quiet week inside an active month reads
differently from a quiet month) and whether the tickets they logged appear in
anyone else's activity — pairing leaves a trace on the other person's account.

**Everything else is a conversation, not a query.** `check: "ask"` means no
system can settle it: the manager asks the person. Say that plainly instead of
padding the report with speculation.

## Phase 6 — report

One block per person, people with the most serious findings first, then a
whole-team footer. Nobody clean gets a paragraph — one line.

```
Harvest review · 2026-07-01 → 2026-07-31 · 6 people · 812.5h

Sam Okafor · 168h over 21 days · 3 findings (1 high)
  HIGH  no-trace        22.0h  Jul 6–9   4 days of development logged, no GitLab
                                         activity from sam.okafor; active before
                                         and after                    → ask
  MED   task-mismatch    3.5h  Jul 14    "call with the client about scoping"
                                         logged to Hume / Maintenance-Core
                                                                      → ask
  LOW   uniform-days       —   —         19 of 21 days total exactly 8.0h

Petra Novák · 152h over 20 days · 1 finding
  MED   bulk-backdating  60h   Jul 1–19  23 entries covering 19 days, all created
                                         within 12 min on Jul 20      → ask

Clean: Adam Bílý, Tom Reid, Yusuf Aydın, Klára Horáková

Coverage: Harvest ✓ · GitLab ✓ (14 projects) · Jira ✓ (12 keys, 1 missing)
Not checked: Marek Sedláček — no GitLab handle in the roster
```

- Every row names the evidence and what would settle it. A finding with no
  suggested next step should not be in the report.
- Say what was **not** checked, every time — unmapped people, projects that
  errored, keys Jira could not resolve. A clean line for someone nothing could
  see is the failure this whole skill is trying not to produce.
- Keep the innocent explanation attached to patterns that have an obvious one:
  bulk backdating on the 20th is what a person catching up on holiday does.
- Offer, don't produce: a per-person summary the manager could paste into a 1:1,
  a CSV of flagged entry ids, a re-run at a lower threshold. Write those only if
  asked.
- If the user asks for a written message *to* the person, keep it to observation
  and question — "I noticed the week of the 6th has 22h of development with no
  MRs or commits; what were you on?" — never an allegation.

## Phase 7 — resolve

The manager's answers are the point of the run; keep them.

- A finding the manager dismisses for good — a rotation genuinely logged with
  the same note daily, a contractor who legitimately invoices in one batch —
  becomes a `suppressions` entry: `{ "rule": "...", "userId": N, "match":
  "<regex>", "reason": "<why>", "addedAt": "<date>" }`. **A suppression without a
  reason is a blind spot with better manners** — doctor warns about those.
- A threshold the manager overrules twice in the same direction is a threshold
  that is wrong for this team. Move it one step in `thresholds` and say you did.
- A recurring route the scanner keeps mistaking — a task name it reads as
  meetings that the team uses for delivery — belongs in `taxonomy`, not in a
  suppression. Fix the vocabulary and the false positives stop for everyone.
- Never suppress a `project-mismatch` rule wholesale. Individual entries, yes;
  the rule itself is the one that moves money between clients.
