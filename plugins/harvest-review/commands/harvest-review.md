---
description: Review the team's logged Harvest time for irregularities, verified against GitLab and Jira
argument-hint: "[last month | this week | 2026-07-01..2026-07-31 | <person> last month]"
---

Use the `harvest-review` skill to review logged Harvest time.

Scope requested: `$ARGUMENTS`

If that is empty, review the last complete month for everyone in the configured
team.

Follow the skill's phases in order. Findings are questions for the manager to
ask, never verdicts — report what was not checked as prominently as what was.
This skill never writes to Harvest.
