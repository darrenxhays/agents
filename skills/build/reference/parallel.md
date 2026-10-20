# Splitting into parallel subtasks

Split only where the work divides into parts that can each be built and checked on their own, such as separate components, or a service and the UI that calls it. One subtask is the default and fits most changes.

## In the plan
Give each subtask under `## Subtasks` a wave and the files it owns:

```
### S1: <title>
- Builds: <what it implements and which acceptance criteria it covers>
- Wave: 1
- Owns: `<path>`, `<path>`
- Model: <model>; effort: <effort>; <one-line rationale>
```

- Subtasks in the same wave run at the same time in the same working tree, so each must own files no other subtask in its wave touches.
- A subtask that needs another's output goes in a later wave.
- Every implementer gets the whole plan plus `Your subtask: <id>`, so the plan must say what each subtask builds and owns clearly enough to need no follow-up.

## Running them
Run wave by wave. Start every subtask in a wave at once, then wait for all of them before starting the next wave. If a subtask fails or reports a blocker, don't start later waves; go to the review and include the blocker.

- **Codex mode:** one background Bash call per subtask, each `run-codex.sh build ... --subtask <id>`.
- **Claude mode:** one `general-purpose` Agent per subtask, all in a single message, each with its `model` alias and effort. Its prompt is `templates/implement-prompt.md`, then `--- PLAN START ---`, the plan, `--- PLAN END ---`, a blank line, and `Your subtask: <id>`. Save each final report to `<output_dir>/runs/<run_id>-<id>-build.md`.

The implement prompt limits each implementer to its owned files and to sandbox checks scoped to them; Claude runs every check once all waves finish.
