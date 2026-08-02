# Verification

The scan is cheap because it never leaves the disk. Verification is where the
external calls happen, so it happens **once, in batch, for flagged rows only**.
A verification pass that costs one JQL and no new GitLab calls is one that gets
run every time; a per-finding lookup loop is one that gets skipped.

## The batching rule

| Question | How many calls |
|---|---|
| Do these 40 tickets exist, and what state are they in? | **one** JQL |
| Did this person move anything in Jira this month? | **one** JQL per person, only for contested findings |
| Was this person active in GitLab on these days? | **zero** — already in the sweep cache |
| Was the work paired? | **zero** — look for the ticket in other people's days in the same cache |

Never loop `getJiraIssue` over a list of keys. `key in (...)` takes all of them.

## Jira: existence and state

```
key in (HUME-5720, HUME-5731, ENG-88) ORDER BY created
```

Fields: `summary,status,resolutiondate,created,assignee`. Nothing else — a
description field on forty issues is a context window spent on prose no one
reads.

Hand the result to the scanner as JSON:

```json
{
  "issues": [
    { "key": "HUME-5720", "summary": "Select V2 replacements", "status": "Done",
      "resolutionDate": "2026-06-02", "created": "2026-05-11", "assignee": "Sam Okafor" }
  ],
  "missing": ["HUME-9999"]
}
```

`missing[]` must list every key that was asked for and did not come back.
Leaving it out makes "this key does not exist" indistinguishable from "nobody
asked about this key", and the scanner will correctly decline to say either.

**A key missing from the response can mean the reviewer cannot see the
project**, not that the ticket is invented. Check that the JQL was run against
the right site and that the prefix belongs to a project the user has access to
before reporting `ticket-unknown` about a person.

## Jira: what someone actually moved

For a finding that turns on *when* work happened rather than whether the ticket
exists:

```
status CHANGED BY <accountId> DURING ("2026-07-01", "2026-07-31")
```

One query, whole month, whole person. It answers "was this ticket anywhere near
this person that month" for every finding about them at once. Transitions are a
weak positive — moving a ticket takes a second — but a strong negative is
informative: a month of hours on tickets the person never touched in Jira is
worth the conversation.

## GitLab: reading the sweep

Everything the activity cache can answer, it already contains. For a `no-trace`
finding, three questions in order:

1. **Adjacent days.** Active on the days either side? A quiet week inside an
   active month is a change of activity; a quiet month is a mapping problem or
   a different job.
2. **The tickets named.** Do the keys from those entries appear in *anyone's*
   activity that week? If they appear on a colleague's account, the work was
   almost certainly paired and the finding is answered.
3. **Coverage.** Was the project they usually work in actually swept? Check
   `projectsScanned` and `errors` before drawing any conclusion. A repo missing
   from the sweep produces a perfect `no-trace` finding about an innocent
   person.

## Grading a finding after verification

Three outcomes, and only three:

- **Answered** — the evidence explains it. Drop it from the report; say in the
  footer how many were answered this way, because that number is what tells the
  user the pipeline is working rather than merely quiet.
- **Open** — nothing available settles it. Report it with the question the
  manager should ask. This is the normal outcome and it is not a failure.
- **Corroborated** — the external evidence points the same way as the flag (the
  ticket was closed in May, the person moved nothing all month, no activity in
  any repo). Report it first, and still as an observation. Corroboration raises
  how much attention it deserves; it does not turn a pattern into an intent.

Never invent a fourth grade, and never write "confirmed" about a person's
motives. The evidence available here can establish what a system recorded. It
cannot establish what someone meant, and a report that blurs the two is worse
than no report at all.
