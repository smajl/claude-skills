# TODOs

Open items found while wiring BambooHR time off into `harvest-review` and moving
both plugins onto a shared key store (2026-08-03). Nothing here is blocking — the
review runs clean today — but each one is a real edge, written down while the
context was fresh.

Ordered roughly by how much damage each can do if left alone.

---

## 1. `fetch-meta.mjs` reports "no projects" when it means "not allowed"

**Severity:** high — this is the exact failure class the plugin is built against.

A Harvest token with the **Manager** access role (not admin) gets an empty array
from `/projects` rather than a 403. `fetch-meta.mjs` passes that straight
through:

```json
{ "counts": { "projects": 0 }, "projects": [], "projectsError": null }
```

An agent reading that concludes the account has no projects and moves on. The
real meaning is "this token cannot see the project list". Setup then cannot
build `projectByTicketPrefix`, which is the input to `project-mismatch` — the
one rule that moves money between clients.

**Possible fix.** Two parts, and the first matters more:

- When `/projects` returns zero rows but the account demonstrably has time
  logged, emit a warning saying the token likely lacks project-read permission,
  rather than reporting an empty list as a fact.
- Fall back to deriving the project list from time entries, which any token can
  read: `projectId` / `projectName` / `clientName` are on every entry. Ranking
  by hours gives a better list than `/projects` anyway, because it is scoped to
  what the team actually bills to. This is what was done by hand during setup
  and it took one pass over the entries cache.

---

## 2. GitLab handle discovery is documented as an admin-only call

**Severity:** high — it silently produces an unmapped roster.

`references/setup.md` step 3 says to resolve handles with:

```
glab api users?search=<email>
```

Email search only matches for GitLab **administrators**. For everyone else it
returns `[]` for every address, which reads as "these people have no GitLab
account". During this setup it matched 1 of 6 people, and the one it matched was
the caller.

**Possible fix.** Replace the documented method with a layered one, and say what
each layer cannot see:

1. **Group members** — `glab api groups/<id>/members/all`, which returns
   usernames *and* real names. **Page it**: `per_page` caps at 100 and a request
   for 200 silently returns 100, which looks like a complete small team. (The
   group here has 101 members, so a single unpaged call missed exactly one
   person.)
2. **The activity sweep itself** — `collect-gitlab-team.mjs` returns `byUser`
   keyed by username. Any handle in there that is not on the roster is a strong
   candidate, because it is by definition someone active in the team's own
   repos. This is how Yusuf was eventually found.
3. **Name search** — `glab api users?search=<name>` as a last resort. On
   gitlab.com this returns global results and is mostly noise; treat every hit
   as a candidate to confirm with the user, never as a match.

Worth considering a `resolve-handles.mjs` script that runs all three and emits
matched / candidates / unresolved, the way `fetch-timeoff.mjs --directory`
already does for Bamboo.

**Related gotcha to document:** group membership is not the whole team. Yusuf
has project-level access only and appears in no group member list, while being
one of the most active people in the sweep.

---

## 3. BambooHR holidays have no location, so regional ones apply to everyone

**Severity:** medium — it hides findings rather than inventing them.

`/time_off/whos_out` returns company holidays with no employee and no location
attached. July 2026 returned `Public Holiday, Northern Ireland`, which the
scanner merges into the global `holidays` set — so that day is excused for the
Prague, Istanbul and Rome engineers too.

The current behaviour is deliberate and documented: a holiday can only ever
suppress a finding, never manufacture one, so erring this way is safe. It is
mitigated by returning the applied holidays **named** in
`inputs.timeoff.holidaysApplied`, with SKILL.md requiring the report to print
them.

**Possible fix, if it ever becomes worth it.** Bamboo employees carry a
`location` field (`/employees/directory` can return it). If holiday records can
be tied to a location — via a report, or `/meta/fields` plus a per-employee
lookup — holidays could be scoped per person instead of globally. Unverified
whether the API exposes the holiday→location link at all; check before
committing to it. A cheaper middle option is a config flag
(`bamboo.applyHolidaysGlobally: false`) that turns off the merge for teams where
regional holidays are common.

---

## 4. Narrowing `ticketPattern` traded away detection of unknown-prefix keys

**Severity:** medium — a deliberate trade, but only one side is currently served.

The default pattern `[A-Z][A-Z0-9]{1,9}-\d+` matches things that are not tickets.
Real July notes contained `CVE-2026-…`, `NEO4J-5`, `TEST-2`, `TEST-3`. With Jira
verification on, each becomes a **HIGH** `ticket-unknown` finding — "hours billed
against a ticket that does not exist" — about a note that merely cited a CVE.

Setup fixed this by restricting the pattern to the 20 real Jira project keys.
The cost: a genuinely invented or typo'd key under any *other* prefix is now
invisible, because it never parses as a ticket at all.

**Possible fix.** Make the scanner two-tier instead of making the pattern
all-or-nothing:

- Keys matching a known project prefix → verified against Jira as today, and
  `ticket-unknown` stays HIGH when Jira cannot find them.
- Keys matching the generic shape but an unknown prefix → a separate, LOW
  finding (`ticket-unrecognised-prefix`) or simply a count in the coverage
  block, never an accusation.

That keeps CVEs out of the high-severity column without going blind to the case
the rule was written for. Would need `knownTicketPrefixes` in the config
alongside `ticketPattern`.

---

## 5. No `jiraAccountId` for anyone on the roster

**Severity:** medium — one verification query is unavailable.

All six roster entries have `jiraAccountId: ""`. SKILL.md Phase 5 uses it for
the per-person query that answers *when* somebody worked a ticket:

```
status CHANGED BY <accountId> DURING ("2026-07-01", "2026-07-31")
```

Without it, findings that turn on timing stay unverified rather than becoming
confirmed.

**Fix.** Resolve them with `lookupJiraAccountId` on the Atlassian MCP, one call
per email, and write them into the roster. Straightforward — it was simply not
reached during this setup.

---

## 6. This Harvest account has no absence task, so Bamboo is the only leave signal

**Severity:** medium — worth a doctor warning, not a code change.

None of the account's 28 task names is Vacation, Sick, Holiday or PTO, so
`taxonomy.taskKinds.absence` matches nothing. Every place the scanner treats "an
absence entry exists" as an escape hatch — `no-trace`, `logged-during-absence`,
the `uniform-days` day filter — is therefore dead code in this account, and
BambooHR is the sole source of leave information. That makes
`team[].bambooEmployeeId` load-bearing rather than a nicety.

**Possible fix.** `doctor.mjs` could warn when *no* task name in the account
classifies as `absence`:

- if Bamboo is configured → informational, "leave is only visible via BambooHR;
  anyone unmapped has no leave signal at all";
- if Bamboo is not configured → a strong warning, because in that combination
  the review cannot see leave by any route whatsoever, and every holiday in the
  period is a candidate finding.

Needs `fetch-meta.mjs` task names, which doctor does not currently fetch.

---

## 7. Duplicated `lib.mjs` / `keys.mjs` between the two plugins can drift

**Severity:** low — deliberate, but unenforced.

The secrets block and `keys.mjs` are byte-identical copies in `harvest-log` and
`harvest-review`, because the plugins install and version independently and
either may be the only one present. Both must agree on `~/.claude/.env-keys`,
since `HARVEST_TOKEN` is one token serving both. Nothing checks that they still
match.

**Possible fix.** A tiny CI or pre-commit check comparing the two `keys.mjs`
files and the `--- Secrets ---` region of both `lib.mjs` files, failing on
divergence. Cheaper than a build step that generates one from the other, and it
preserves the property that each plugin is self-contained.

---

## 8. The credential-in-config check misses non-hex keys

**Severity:** low.

`doctor.mjs` warns when a value in `config.json` looks like a credential:

```js
/^(pat\.[\w.-]{20,}|xoxp-[\w-]{10,}|[a-f0-9]{40,})$/i
```

A BambooHR key is ~40 characters of mixed alphanumerics, which the hex branch
does not match. Someone who pastes one into `bamboo.apiKey` instead of using
`bamboo.apiKeyEnv` gets no warning.

**Possible fix.** Add a generic high-entropy branch — e.g. a value of 32+ chars
that is all `[A-Za-z0-9_\-.]` and appears under a key whose name contains
`key`, `token`, `secret` or `password`. Keying partly on the *field name* keeps
the false-positive rate down.

---

## 9. `logged-during-absence` thresholds are untested against real data

**Severity:** low — but it is the only new detector, and it has never fired in
anger.

The rule was verified end-to-end against a synthetic fixture (four days of work
billed across an approved vacation, plus a half day that correctly did not
fire). It has not yet been run over the real July entries together with the real
Bamboo data, so `absenceMinWorkHours: 4` and the 6h half-day floor are reasoned
defaults rather than measured ones.

**Next step.** Run the full July review with `--timeoff` and see what it says
about the three people who took leave. Razvan is the interesting case: he was on
approved leave 27–31 July and has no GitLab activity that week, which should
produce *no* finding at all — neither `no-trace` (suppressed by leave) nor
`logged-during-absence` (unless he also billed hours).

---

## 10. `harvest-log` config on this machine is stale

**Severity:** low — pre-existing, unrelated to this work, surfaced by doctor.

- Still at the pre-rename path `~/.claude/harvest-day/config.json`. It is read
  from there, and doctor prints the one-line move.
- Schema v4 against a current v7, so fields added since fall back to defaults —
  notably `harvest.calibration.dayTotals` and
  `harvest.calibration.medianWorkEntriesPerDay`, both unset.

**Fix.** Move the directory, then re-run setup so it *fills the gaps rather than
starting over*, per `references/setup.md`. Recomputing the calibration needs one
`harvest-entries.mjs --calibrate` run and none of the interactive questions.

---

## 11. Config leftovers worth a second look

**Severity:** low — judgement calls made during setup, recorded so they can be
revisited rather than forgotten.

- **`ORC` is unmapped in `projectByTicketPrefix`.** Orchestra tasks exist
  (`Feature - Orchestra`, `Maintenance - Orchestra`) and `ORC` is a real Jira
  project, but no July entry referenced an ORC ticket, so there was no evidence
  for which Harvest project it belongs to. Left out on the "when in doubt, leave
  it out" rule. Add it once a month's data shows the mapping.
- **21 of 28 task names are unclassified** in the taxonomy — all marketing and
  sales tasks (`PPC`, `SEO`, `Farming`, `Hunting`, `MarTech`, `Content - *`, …)
  that this team never uses. Unclassified means never checked by
  `task-mismatch`, which is the right default. Only worth revisiting if the
  roster ever widens beyond engineering.
- **`Prep / Followup / Admin / Review`** would classify as `review` under the
  default rule order, because `review` is tested before `admin`. As `review` its
  compatible set excludes meetings, so a note about a call logged there would
  fire `task-mismatch` on a task explicitly meant for admin. Setup reordered the
  local taxonomy so `admin` is tested first and added `prep|followup` to it.
  **The shipped default in `templates/config.example.json` still has the old
  order** — worth fixing at source if other accounts use similar task names.
