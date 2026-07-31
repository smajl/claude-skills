---
description: Reconstruct a workday from git/GitLab/Jira/calendar and log it to Harvest after review
argument-hint: "[today | yesterday | 2026-07-29 | last week | 2026-07-27..2026-07-31]"
---

Use the `harvest-day` skill to build and log a Harvest timesheet.

Date range requested: `$ARGUMENTS`

If that is empty, run the catch-up path: find workdays in the last two weeks
that are empty or under target in Harvest, and ask which to fill.

Follow the skill's phases in order. Show the proposal table and wait for
explicit confirmation before calling `log_time`.
