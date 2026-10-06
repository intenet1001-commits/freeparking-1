<!-- AgentsToZ tester:start -->
# AgentsToZ project tester

For testing requests and verification of changes, read `.agentstoz/MAINTAINER.md`
and `.agentstoz/maintainer.json`. Use the existing project tests first:
`python3 scripts/agentstoz-maintainer.py run --root . --profile quick`.
Select the project's configured profile matching the requested scope.
In a linked worktree, execute against that worktree; memory recall alone uses the primary root.
If connected AgentsToZ MCP tester tools are available, start and read the same run ID there.
Do not run the CLI again while that request is pending. If a parent runtime holds the
workspace lease, execute the CLI inside that task, not another independent lease.
Never clear another process's lock. Missing tests/tools, skipped checks and failures differ.
Report the actual current run and verified scope; an earlier pass is not current verification.
Testing alone does not authorize unrelated changes. When asked to fix a failure,
reproduce it, add a regression, fix it, and re-run the relevant checks.
Do not remove tests or weaken assertions simply to pass.
Read relevant canonical project memory. Save verified reusable lessons through the existing
remember-session workflow, not raw logs or credentials. Reports remain local under
`.agentstoz/maintainer/`. Commit the runner, manifest, tests and instructions to this project's
Git when authorized. Never push or create a repository without authorization.

Inspect without running: `python3 scripts/agentstoz-maintainer.py plan`.
Read results: `python3 scripts/agentstoz-maintainer.py status`.
Use the generated handoff.md for failures, verify fixes and remember durable lessons.

Scenarios live in `.agentstoz/scenarios/common/` (managed, shared by every project) and
`.agentstoz/scenarios/project/` (this project's, committed). Run the most valuable safe ones within a
time budget with `run --auto --budget 300` (preview: `plan --auto`), or one with `run --scenario <id>`.
Grow them with `scenarios discover` (writes proposals only, runs nothing), review
`.agentstoz/maintainer/proposals/` and the gaps file, then `scenarios accept <id>` or `scenarios reject <id>`.
`scenarios lint` rejects destructive, networked or state-changing steps. Budget-skipped and
not-applicable scenarios are reported as skipped, never as passed. `stats` shows per-check history.
<!-- AgentsToZ tester:end -->
