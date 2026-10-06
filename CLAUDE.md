<!-- AgentsToZ shared-output-style:start -->
<!-- AgentsToZ memory-agent-version:23 -->
# Shared output style

- For every user request, first provide a single faithful and concise English translation of the user's request under the label `English translation:`.
- Then proceed with the requested work.
- Write the actual response in the user's language unless the user asks for another language.
- Do not translate code, file paths, URLs, proper nouns, or quoted text unless needed for clarity.

## Task-aware model and reasoning advice

At the start of substantial planning or work, give one brief model/effort recommendation
using context already available. For a multi-phase plan, identify the demanding phase and
the condition for lowering effort. Reassess at planning, implementation, verification and
handoff transitions, or when task difficulty materially changes; do not announce an
unchanged recommendation at every transition or on every reply.
- Identify the active agent, model/provider and execution surface where known. Claude,
  Codex, Antigravity (agy) and Hermes do not necessarily expose the same controls; a
  provider's effort labels are not portable to another agent or model. If effort is not
  configurable, say so briefly and recommend a supported alternative only when known.
- Treat model and reasoning effort as separate settings. Use runtime-provided metadata or
  the user's latest explicit statement, and distinguish these sources. If unknown, do not
  guess, claim to have inspected settings, or interrupt routine work just to ask.
- Recommend a higher reasoning level for unresolved concurrency, privilege isolation,
  destructive data migration design, or repeated failures whose cause remains unclear.
  An authentication prompt, missing dependency, network failure, or large token counter
  alone is not a reason to upgrade the model.
- Consider a lower level for routine edits or repetitive work after representative checks
  establish a reliable approach. Do not infer a fixed model ranking from its name, or
  promise cost savings without measured evidence.
- Recommend a specific setting only when the active surface is known to support it.
  Otherwise describe the direction without inventing a model or level. When a change is
  useful, give one short recommendation with its reason, applicable phase, and the condition
  for reassessment. After the initial assessment, staying at the current setting normally
  needs no announcement. Simple questions and trivial edits do not need an effort preamble.
- Advice does not change settings. Never switch automatically, and honor the user's choice
  to keep the current setting. Do not repeat the same recommendation in the same phase
  unless new evidence materially changes it. Continue independent work while waiting.
- Use no extra AI calls, polling loop, transcript copy, or growing advice history. At normal
  session saving, retain only verified, reusable task/check/result lessons in the existing
  project memory. Keep model source and uncertainty explicit; do not attribute success to
  a model without evidence or store current settings as a permanent project preference.

## Project tester setup on demand

When the user asks to test, verify, or check work in a registered project folder, reconcile the
project tester once before testing — do not send the user to the app. Do this even when tester
files already exist, because a different device may have a newer bundled common layer:
`curl --fail-with-body -sS -X POST --get --data-urlencode "folderPath=$(git rev-parse --show-toplevel 2>/dev/null || pwd)" http://127.0.0.1:3001/api/project-tester/ensure`
(Windows PowerShell: `curl.exe` with the same flags and the folder path.)
- The AgentsToZ app owns and versions the common runner, shared scenarios and instruction blocks.
  The project's `.agentstoz/maintainer.json`, project scenarios and tests are a separate app-specific
  layer kept in that project's Git. Reconciliation preserves that layer and locally edited files.
- It only installs or updates a project registered in AgentsToZ. It runs no tests and makes no commits.
- `installed`/`updated`/`ready`: follow `.agentstoz/MAINTAINER.md` and run its quick profile.
  `skipped` or not registered: say why in one line and test with the project's existing tools.
- If the local API is unreachable, continue without it. Call it at most once per session, and
  never for requests that are not about testing this project.
<!-- AgentsToZ shared-output-style:end -->

<!-- AgentsToZ project-memory:start -->
## Project memory integration

<!-- AgentsToZ memory-agent-version:23 -->
- Resolve the current Git top-level, take the first porcelain worktree as the repository authority,
  then append this registered project's fixed relative subpath (repository root).
  If that canonical `$MEMORY_ROOT/.agent-memory/config.json` is unavailable, stop memory reads and
  writes instead of creating or promoting a linked-worktree fallback.
- Read `$MEMORY_ROOT/.agent-memory/config.json` and its project-relative `sourcePath` before substantial work when historical decisions may matter.
- At substantial work or a material phase change, apply the generated `project-memory`
  skill's model/effort advice using already-known settings and task evidence. Recommend only;
  never auto-switch or repeat a declined recommendation without new evidence.
- Once the memory outgrows a single file, `sourcePath` holds an **index** of entry titles and
  `.agent-memory/notes/` holds the bodies. Read the index, then only the notes whose titles
  match the task. The index is generated — edit the notes, never the index.
- Every durable `###` entry carries an immediately following `<!-- memory-entry-id:<24 lowercase hex> -->` marker.
  Never remove or regenerate that ID when renaming, moving, or editing the entry; only a genuinely new entry gets a new ID.
- “세션 기억하기” is the project-local memory workflow. When the user asks to remember the
  session, update the configured local memory first, mark current activity as remembered,
  and then back it up:
  `WORKING_ROOT="$(pwd -P)"; PROJECT_TOP="$(git -C "$WORKING_ROOT" rev-parse --show-toplevel 2>/dev/null || true)"; MEMORY_SUBPATH=''; MEMORY_ROOT="$WORKING_ROOT"; if [ -n "$PROJECT_TOP" ]; then MAIN_TOP="$(git -C "$PROJECT_TOP" worktree list --porcelain 2>/dev/null | sed -n 's/^worktree //p' | head -n 1)"; [ -n "$MAIN_TOP" ] || { echo "Canonical project worktree is unavailable" >&2; exit 1; }; MEMORY_ROOT="$MAIN_TOP"; [ -z "$MEMORY_SUBPATH" ] || MEMORY_ROOT="$MAIN_TOP/$MEMORY_SUBPATH"; fi; [ -f "$MEMORY_ROOT/.agent-memory/config.json" ] || { echo "Canonical project memory is unavailable: $MEMORY_ROOT/.agent-memory/config.json" >&2; exit 1; }; curl --fail-with-body -sS -X POST --get --data-urlencode "folderPath=$MEMORY_ROOT" http://127.0.0.1:3001/api/project-memory/mark-remembered && curl --fail-with-body -sS -X POST --get --data-urlencode "folderPath=$MEMORY_ROOT" http://127.0.0.1:3001/api/project-memory/push`
- Generated Claude/Codex `UserPromptSubmit` hooks are token-free: they discard prompt
  content and record only the last activity time and agent so AgentsToZ can highlight
  “세션 기억하기 필요”.
- If a compatible external closing workflow such as `/cs-end` runs, apply the same
  “세션 기억하기” procedure before it finishes.
- Keep each note at or under 12000 bytes; a save is asked to compact one
  over-budget note at a time. Merge or compress older entries within that note instead of
  growing it; never drop a durable decision outright.
- A failed remote backup must never roll back the local memory update. Report the failure so Push can be retried in AgentsToZ_byCS.
<!-- AgentsToZ project-memory:end -->


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
<!-- AgentsToZ tester:end -->
