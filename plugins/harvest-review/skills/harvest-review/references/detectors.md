# Detectors

Every rule `scan-entries.mjs` implements, what it is looking for, what makes it
fire, and — the part that matters most in a report — the innocent explanation it
cannot distinguish from the guilty one.

The scanner is deterministic on purpose. When someone disagrees with a finding,
the answer has to be "here is the rule and here are the entries", not "the model
thought so". None of these rules use a model at all.

Thresholds named below are `thresholds.*` in the config; the defaults are in
`../templates/config.example.json`.

---

## Classification, before any rule runs

Two independent guesses at what an entry is about:

- **Task kind** — from the Harvest task *name*, via `taxonomy.taskKinds`.
  `Hume Meetings` → `meeting`, `Maintenance-Core` → `development`. First match
  wins, so the map's order is its precedence: `absence` is tested before
  `meeting`, `meeting` before `development`.
- **Note kind** — from the note *text*, via `taxonomy.noteKinds`, keyed on verbs
  and artefacts (`implemented`, `reviewed`, `standup`, `!5723`) rather than
  nouns that appear everywhere. A note can evidence several kinds; they come
  back ranked by how many terms hit.

Both are heuristics over a vocabulary that differs per account. **Tune the
taxonomy at setup against the account's real task list** — a taxonomy that reads
this team's task names wrongly produces false positives on every rule at once,
and that is the fastest way to make a review worthless.

---

## 1. `task-mismatch` — the note describes work the task doesn't bill for

Fires when the note evidences a kind that is not compatible with the task's kind
*and* evidences nothing that is. Coding logged against Meetings; a client call
logged against Maintenance.

Severity: high when the swap is meeting ↔ development and the entry is ≥ 2h;
medium otherwise.

**Innocent explanation:** one note covering a mixed morning — "standup, then the
Select V2 replacements" — which is why a note matching *both* kinds never fires.
Also a task named for a client rather than an activity, where the task kind is
meaningless; if that is how the account works, empty out `taxonomy.taskKinds`
for those tasks rather than living with the noise.

**Verify:** the ticket, if the note names one. Jira says what kind of work the
ticket was.

## 2. `project-mismatch` — a ticket billed to the wrong project

The note names `HUME-5720`, `projectByTicketPrefix` says `HUME` tickets belong
to project #123, and the entry is on project #456.

Always high. This is the only rule here that moves money between clients, and it
is the one to fix even when it was plainly an accident.

**Innocent explanation:** genuine cross-project work referencing another team's
ticket, and prefixes that legitimately span projects. Map only the prefixes that
really are one-to-one; a prefix left out of the map is simply never checked,
which is the right default.

**Verify:** ask. Nothing external knows which project should have been billed.

## 3. `repeated-note` — the same description, day after day

The filler pattern the user asked about. Groups a person's entries by normalized
note (lowercased, punctuation flattened, ticket keys kept) and fires at
`repeatedNoteDays` distinct days (default 3) and `repeatedNoteMinHours` total.

Severity rises with identical hours: the same words *and* the same duration
every day is the strongest single signal in this file, because real work is
lumpy and copied rows are not.

Short meeting entries (`meeting` kind, ≤ 1h) are excluded outright — a 15-minute
standup is identical every day and entirely honest — as are `absence` entries.

The finding carries `spanDays` and `consecutive`: five consecutive days reads
differently from five days spread over a month.

**Innocent explanation:** a genuinely repetitive week (a long migration, a
support rotation, exam-period QA), and people who write terse notes by habit.
The hours pattern is what separates these; the note alone does not.

**Verify:** GitLab for the days involved. Repetitive work that really happened
leaves differently-shaped traces each day; copied rows have nothing behind them.

## 4. `filler-note` — the note says nothing

Entries ≥ `fillerMinHours` (default 2) whose note is empty, one word, or in the
generic list (`work`, `development`, `misc`, `ongoing`, `wip`, …).

**Innocent explanation:** a team that never enforced note quality. If this fires
across everyone, it is a process finding, not a person finding — report it once
in the footer instead of six times in the per-person blocks.

## 5. `bulk-backdating` — a period written down in one sitting

Groups a person's entries by `created_at` into sessions (gap ≤
`bulkSessionMinutes`, default 30) and fires when one session holds ≥
`bulkMinEntries` entries covering ≥ `bulkMinDays` distinct days, or when any
entry was created ≥ `backdateDays` after the day it claims.

`created_at` is invisible in the Harvest UI and impossible to write around,
which makes this the most objective rule in the file. It says nothing about
whether the hours are right — only that they were reconstructed rather than
recorded, and reconstructions are where honest errors live too.

Severity: high at ≥ 14 days of lag or ≥ 10 days covered.

**Innocent explanation:** catching up after a holiday, after a laptop failure,
or at the end of a month because that is when the client's invoice runs. Some
teams work this way by policy. If yours does, this rule is noise — raise
`backdateDays` rather than reading it every month.

## 6. `implausible-day` / `implausible-week` — more hours than exist

Day totals over `maxHoursPerDay` (10, medium) or `hardMaxHoursPerDay` (14,
high); week totals over `maxHoursPerWeek` (50).

**Innocent explanation:** a release night, an incident, a conference day, or two
days logged onto one date by mistake — the last of which is worth catching for
the person's sake, not the company's.

## 7. `uniform-days` — every day exactly the same size

At least `uniformDaysMin` days (8) with ≥ `uniformDaysRatio` (90%) of them
totalling the identical figure.

Always low, and deliberately so: this is texture, not evidence. It never
justifies a conversation on its own. What it does is tell you which *other*
finding to take seriously — a `no-trace` week inside a month of perfectly
uniform 8.0h days is a different proposition from one inside a lumpy month.

**Innocent explanation:** a contract that bills fixed days, salaried people who
log their contracted hours as a matter of policy, and part-timers on fixed
schedules. In many companies this is what everybody's timesheet looks like.

## 8. `duplicate-entry` — the same row twice on one day

Same person, day, project, task and note.

**Innocent explanation:** a genuine second session on the same thing, and a
double-submit in the UI. Usually the latter, usually harmless, occasionally
double-billed.

## 9. `ticket-unknown` — the key does not exist

Needs `--jira`. The note references a key that the Jira lookup returned in
`missing[]`. High: an entry billed to nothing.

**Innocent explanation:** a typo, a ticket since deleted, a key from another
Jira site the lookup did not cover, or a project the reviewer cannot see.
**Check the last one before reporting it** — permissions produce this finding
just as reliably as invention does.

## 10. `ticket-closed-before` — work logged after the ticket was done

Needs `--jira`. Entry's `spent_at` is more than `ticketResolvedGraceDays` (3)
after the ticket's `resolutionDate`. High at ≥ 30 days.

**Innocent explanation:** follow-up work, a reopened-then-reclosed ticket
(`resolutionDate` only shows the latest), review comments arriving after merge,
and the entirely normal habit of logging against the ticket a piece of work
*related* to rather than *inside* it.

## 11. `no-trace` — development hours with nothing behind them

Needs `--activity`. A workday with ≥ `noTraceMinDevHours` (4) on
development-or-review tasks, no GitLab activity from that person, not a weekend,
not a holiday, not a day of approved leave, and no absence entry. Consecutive
quiet days collapse into a single finding; severity is high at 3+ days or 20+
hours.

**Pass `--timeoff` or this rule is half-blind.** A week of holiday looks
identical to a week of nothing, and the rule resolves that ambiguity against the
person. Approved BambooHR leave suppresses the day outright, and Bamboo's
company holidays merge into `holidays[]`. Leave that is only *requested* does
not suppress anything — it is a plan, and the day may well have been worked.
Anyone with no `bambooEmployeeId` comes back in `needs.noLeaveDataFor` rather
than being quietly treated as never absent.

Bamboo's holidays carry no location, so a regional one ("Public Holiday,
Northern Ireland") excuses that day for the whole team, including the people it
does not apply to. That direction is the safe one — it can only hide a finding,
never manufacture one — but the excused days come back named in
`inputs.timeoff.holidaysApplied`, and the report prints them so the reader can
see what was waved through and why.

The strongest check available and the easiest to misuse. It requires the person
to be mapped (`gitlabUsername`) and present in the sweep; anyone unmapped or
invisible is reported in `needs.unmappedUsers` / `needs.invisibleUsers` and
never as a finding. **"We could not see" and "there was nothing" must never
print the same way.**

**Innocent explanation:** design, specification, debugging without a commit,
pairing (the trace is on the other person's account), reviewing in a tool other
than GitLab, a week of meetings billed to a delivery task, working in a repo
nobody listed in `gitlab.projects`, and pushing on Monday what was written on
Friday. This rule is a prompt to ask, and the question — "what were you on that
week?" — usually has an immediate, boring answer.

**Verify:** adjacent days first. Then whether the tickets named in those entries
appear in anyone else's activity that week.

## 12. `logged-during-absence` — work billed on an approved day off

Needs `--timeoff`. Non-absence hours on a day BambooHR records as **approved**
leave: ≥ `absenceMinWorkHours` (4) against a full day off, and ≥ 6h against a
half day, because working the other half of a half day is what a half day is.
Consecutive days collapse into one finding. High at 3+ days or 16+ hours.

Absence entries are excluded — logging Vacation against a vacation day is the
correct behaviour, not a finding. Requested-but-not-approved leave never fires
this at all.

**Innocent explanation:** leave cancelled at the last minute and never updated
in Bamboo, which is by far the most common cause; an entry typed onto the wrong
date; genuinely working through a holiday to hit a deadline; and an unpaid or
informal arrangement recorded in Bamboo as leave. What makes this worth
reporting anyway is that the same set of causes are all worth knowing about —
one of them means the person is owed their day back.

**Verify:** GitLab for those dates. Someone who worked through their holiday
usually left the same trace they leave any other day.

## 13. `ticket-missing` — no ticket named, against that person's own habit

Development entries ≥ 2h with no key, for someone whose other development
entries carry keys ≥ 60% of the time. Low.

**Innocent explanation:** untracked work genuinely happens — support, spikes,
build fixes. This rule only says the person departed from their own convention.

## 14. `clone-across-people` — two people, one note, one day

Identical notes of ≥ 4 words from different people on the same date. Low.
Meeting and absence entries are excluded: everyone in the room writes the same
title, so including them fires the rule on every shared meeting in the period
and finds nothing.

**Innocent explanation:** pairing, which is most of what remains — and the note
usually says so. What it is looking for is the rarer case of one timesheet
copied into another, which is invisible from inside either one.

---

## What is deliberately not detected

- **Anything requiring intent.** No rule says fraud, and no output should.
- **Rounding.** Everyone rounds. A 0.25h grid is a convention, not a signal.
- **Low hours.** Under-logging is a real problem and a different one; this skill
  is not an attendance monitor, and treating a light week as an irregularity
  makes people log defensively rather than accurately.
- **Leave that was taken but never logged as absence in Harvest.** Bamboo knows
  it, so the rule would be easy — and it is bookkeeping tidiness dressed up as a
  finding, one that fires hardest on people who took their holiday properly. The
  time-off data is here to *stop* those days being flagged, not to flag them a
  different way.
- **Slack and calendar presence.** Available, deliberately unused: they measure
  being visible rather than doing work, they are the most invasive sources
  within reach, and they punish the quiet. Keep them out.
