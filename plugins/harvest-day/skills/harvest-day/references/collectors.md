# Collectors

All collectors take an inclusive `--from` / `--to` day range and emit JSON on
stdout. Run them in parallel. A collector that fails prints
`{"ok": false, "error": …}` and must not abort the run.

## The day window

A "day" means the user's local day, but no two sources agree on how to say so:
git parses a datetime in whatever timezone the machine is in, GitLab returns
UTC instants, Confluence CQL is interpreted in UTC. Mixing those conventions
files late-evening and early-morning work on the wrong day — an error nobody
spots in a timesheet.

So the window is computed once, from `identity.timezone`, and every collector
emits it as `window`:

```json
"window": {
  "tz": "Europe/Prague", "from": "2026-07-30", "to": "2026-07-30",
  "since": "2026-07-30T00:00:00+02:00", "until": "2026-07-30T23:59:59+02:00",
  "utcStart": "2026-07-29T22:00:00.000Z", "utcEnd": "2026-07-30T22:00:00.000Z",
  "cqlStart": "2026-07-29 22:00", "cqlEnd": "2026-07-30 22:00",
  "dstShift": null
}
```

Use these bounds for the MCP sources too, rather than deriving your own:
`cqlStart` / `cqlEnd` for Confluence CQL, `utcStart` / `utcEnd` for anything
that hands back ISO instants. `--tz` overrides the configured zone.

`dstShift` is non-null on the two days a year the offset changes, which are
also the days that are 23 or 25 hours long. Worth a mention in the footer if
the day's total looks odd.

## git — `collect-git.mjs`

```
node "${CLAUDE_PLUGIN_ROOT}/skills/harvest-day/scripts/collect-git.mjs" --from 2026-07-29 --to 2026-07-29
```

Per repo: `commits[]` (sha, author `date`, subject, insertions, deletions,
files, `tickets[]`, plus `rewritten` / `squashedFrom` where they apply),
`branches[]` (from refs *and* reflog checkouts, so branches worked on without a
commit still show up), `branchTickets[]`, `dirty` (only when the range includes
today), and `totals`. `--full` adds each commit's raw `%D` refs,
which are otherwise omitted — `branches[]` and `branchTickets[]` are the same
information, already deduplicated.

Empty fields are omitted rather than sent as `null` or `[]`, so a repo with no
branch activity simply has no `branches` key.

Reads `repos.include` from config, or every repo under `repos.roots` when the
include list is empty. Author matching uses every string in
`identity.gitAuthors` as an OR'd `--author` regex.

### Which day a commit belongs to

A commit carries two dates. The **author date** is stamped when the code is
first committed and survives rebase, amend and cherry-pick. The **committer
date** is reset to "now" by every one of those operations.

git's `--since` / `--until` select on the committer date. Filtering on it means
a commit written Tuesday and rebased Friday vanishes from Tuesday and reappears
on Friday — absent from the day it belongs to, double-counted on a day it
doesn't. So the collector filters on the **author date**, and `commits[].date`
is the author date: the day the code was actually written.

This also makes catch-up runs work. Reconstructing Monday on Friday, after
Monday's branch was rebased Tuesday, still finds Monday's commits under
Monday — the rewritten objects kept their authoring dates.

Two fields flag the cases where the dates disagree:

- `rewritten: true` with `committed: <iso>` — author and committer dates differ
  by more than an hour, so the commit was rebased, amended or cherry-picked
  after it was written. Attribution is still correct; this is context.
- `dateUnreliable: true` with `squashedFrom: "group/proj!412"` — a **squash
  merge**, the one rewrite that really does destroy the authoring date. The
  squashed commit is authored at squash time, and the original commits live on
  only in the (usually deleted) branch. Treat it as a duplicate of work already
  counted on earlier days, not as new work. See `mapping.md`.

`--date-basis committer` restores the old behaviour. There is little reason to
use it outside of debugging.

Interpreting the rest:

- Commit timestamps bracket the working window but are not the working window —
  people commit in bursts. Use them for ordering and for detecting a day's shape,
  not as a clock.
- `insertions + deletions` is the crudest possible effort proxy. A 2000-line
  lockfile churn is not eight hours. Discount generated files, lockfiles and
  vendored paths when you see them in the diffstat.
- Pushing today what was written yesterday is common, and handled: attribution
  follows the author date, not the push. If commit evidence still wildly
  outstrips the day's plausible hours, say so rather than inflating.

## GitLab — `collect-gitlab.mjs`

```
node "${CLAUDE_PLUGIN_ROOT}/skills/harvest-day/scripts/collect-gitlab.mjs" --from 2026-07-29 --to 2026-07-29
```

Wraps `glab api events`, rolled up into the four shapes that map onto billable
lines. Every raw event lands in exactly one of them:

| Field | What |
|---|---|
| `summary` | counts: pushes, mrsOpened, mrsMerged, approvals, comments |
| `reviews[]` | grouped by MR — title, comment count, whether approved, up to 3 comment excerpts |
| `pushes[]` | grouped by project + branch — push count, total commits, first/last timestamp |
| `mrs[]` | MR lifecycle (opened, merged, closed) — the titles that become note text |
| `other[]` | issues, milestones, anything else — one line each |

`--full` adds the raw `events[]` feed. Don't pass it during a normal run: the
rollups are lossless with respect to everything Phases 4–5 use, and the raw
feed is about four times the size of all of them together.

The API's `after` / `before` take UTC dates only, so the query is widened two
days each side and the results are then filtered on the `created_at` instant
against `window`. That widening is what keeps a 00:30-local commit — 22:30 UTC
the previous day — on the day the user actually worked.

Paging stops after 5 pages (500 events). If it stops there the output carries
`truncated: true` and a `truncatedNote` — put that in the proposal's footer,
because the evidence really is incomplete. `--max-pages N` fetches further.

`reviews[]` is the payload that justifies review time — comment excerpts tell
you whether a review was a rubber stamp or a real design argument. Size review
entries from comment count and substance, not from the MR's diff size.

## GitHub — optional

Off unless `sources.github.enabled`. Uses
`gh api "/users/<identity.githubUsername>/events"` with the same normalization.
`gh` is not installed by default; doctor reports it.

## Calendar — Google Calendar MCP

`list_events` for the day across `sources.calendar.calendars`, with
`orderBy: startTime` and the config timezone. Exclude: declined events, all-day
events, and events whose title matches `rules.ignoreEventPatterns`.

The user's own RSVP is the attendee entry with `self: true` — read its
`responseStatus`, not the event's. `needsAction` is not the same as declined;
recurring team meetings often sit at `needsAction` and were still attended, so
treat only `declined` as a skip and flag `needsAction` events as uncertain.

`start`/`end` carry per-event `timeZone` fields that can differ from the
calendar's (an organizer in another country). Compute durations from the
offset-bearing `dateTime` values, never from the wall-clock string.

Also check `sources.calendar.holidayCalendars` for the day — a company holiday
or PTO means propose nothing and say why.

Calendar durations are the only *exact* numbers in the whole pipeline — use them
as-is. Overlapping accepted meetings mean the user was in one of them: flag the
overlap and ask rather than double-counting.

Attendee lists are useful for note text ("Yusuf / Jan 1on1") and for routing —
an external-domain attendee list often means recruiting or sales, not HUME.

## Jira — Atlassian MCP

Two uses:

1. **Titles** — for each ticket key found anywhere, `getJiraIssue` gives a
   summary that makes a far better Harvest note than a commit subject.
2. **Activity** — `searchJiraIssuesUsingJql` with
   `assignee = currentUser() AND updated >= "<day>" AND updated < "<day+1>"`
   finds tickets that moved without producing a commit (triage, grooming,
   writing acceptance criteria).

Jira is read-only here. Never transition anything.

## Confluence — Atlassian MCP

Document review is real, billable, and leaves **no trace in git, GitLab, Jira or
the calendar**. It is the single biggest blind spot in every other source, so
always run this collector.

Use `searchConfluenceUsingCql` with `sources.jira.cloudId`.

### Timestamps are UTC — this is the important part

CQL `created` / `lastmodified` bounds are interpreted in **UTC**, not the user's
timezone. Verified: comments made 15:44 and 15:52 CEST match a
`created >= "2026-07-30 13:00"` bound.

So never query a bare local date — `created >= "2026-07-30"` files late-evening
work on the wrong day. Pass `window.cqlStart` / `window.cqlEnd` from any
collector's output, which are already the local day's midnights expressed in
UTC with a time component:

```
# window.cqlStart/cqlEnd for Europe/Prague, local day 2026-07-30
type = comment AND creator = currentUser()
  AND created >= "2026-07-29 22:00" AND created < "2026-07-30 22:00"
```

### Recipes

| Want | CQL |
|---|---|
| Comments you wrote | `type = comment AND creator = currentUser() AND created >= "<cqlStart>" AND created < "<cqlEnd>"` |
| Pages you touched | `type = page AND contributor = currentUser() AND lastmodified >= "<cqlStart>" AND lastmodified < "<cqlEnd>"` |
| Blog posts | same as pages with `type = blogpost` |

Run the comment query always. Run the page and blogpost queries only when
`sources.confluence.includePageEdits` — they're the noisier of the two, for the
reason in the second limitation below.

Add `order by created desc` and `limit: 50`.

### Reading the results

- `title` is `Re: <Page Name>` for comments — strip the `Re: ` to name the
  document in the Harvest note.
- `summary` is the comment text. Use it: substantive design argument is worth
  more time than "👍". This is the best signal available for sizing doc review.
- Comments cluster hard by page. Group every comment on one page into a single
  "review <Page Name>" entry.
- Personal spaces (`~<accountid>`, `name` shows a person) are normal — drafts
  live there. Don't filter them out.

### Two limitations to respect

- **No usable timestamp.** The API returns `lastModified` as a rendered string
  ("yesterday at 3:52 PM", or "Jul 28, 2026" for older items) and ignores
  `expand`. For today/yesterday you can read the clock time off it; for older
  days you only get the count. If you need a span, issue two or three extra
  queries with narrower UTC hour bounds and bisect — don't parse the string.
- **`contributor = currentUser()` means "ever contributed"**, not "edited that
  day". It returns pages modified in the window that the user touched at some
  point, and the result's `author` is the *last* modifier — often someone else.
  Treat a page hit as evidence only when `author` is the user, and otherwise
  mention it as weak context rather than proposing an entry.

## Granola — meeting notes

Search notes for the day. Granola supplies *substance*, never duration: use it
to turn "Front-End Architecture" into "Front-End Architecture — agreed on Select
v2 rollout plan". If a Granola note exists for a meeting that isn't on the
calendar, propose it as an entry and say where it came from.

## Slack

Use only when a day is otherwise thin, or when the user asks. Search their own
messages for the day across `sources.slack.channels`, or all work channels when
that list is empty; a burst of substantive messages in a support or
architecture channel is real work that leaves no other trace. Never quote
private DM content into a Harvest note.
