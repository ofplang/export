---
name: ofp-export
description: Turn ofplang YAML — a workflow, an ofp-schedule plan, an environment — into one self-contained HTML file a person can open and read (the workflow's dataflow graph and the plan's Gantt chart, linked). Use when someone needs to see or be sent a workflow or a schedule, rather than read the YAML.
---

# ofp-export view

Writes the interactive ofplang viewer as a single HTML file with the documents
inside it. The file opens from disk in any browser, with no server and nothing
beside it.

## Command

```sh
ofp-export view <file>... -o <out.html> [--layout split|workflow|plan] [--gantt device|flow|activity|object] [--json]
```

Also reachable as `ofp export view …` (and `lc export view …` under labcode).

- `<file>...` — a plan, a workflow and/or an environment, in any order. Which
  is which is read from the file, not its name.
- A plan names its workflow and environment in `meta`; they are found and
  included unless given explicitly (`--no-follow` turns this off).
- **Always pass `-o`.** Without it the HTML goes to standard output.
- With `-o`, the one line printed is the path written. Add `--json` for a
  summary instead (paths, activity count, outcome, warnings).
- `--layout` / `--gantt` choose what the page opens on. Leave them out unless
  asked: a workflow alone already opens on the workflow alone.
- `--gantt object` opens on one lane per physical Object (a plate, a sample),
  from where it appears to where it is used up. Use it when the question is
  what happens to one thing, not what a machine is doing. It needs the plan's
  workflow — that is what tells one plate from another — and the page opens on
  the device view where the Objects cannot be told apart.
- `--thin` writes a page of a few KB — the documents and one script tag that
  loads the viewer from a CDN — instead of the ~190 KB single file. Use it when
  you have to write the page out yourself, as an artifact: copy the file's text
  into the artifact unchanged. It needs the network to open; a file to send
  someone is better without `--thin`.

## Exit codes

| code | meaning | what to do |
|---|---|---|
| 0 | written | hand over the file; mention any warnings printed to stderr |
| 2 | bad input (missing file, not an ofplang document, nothing to draw, two plans) | fix the arguments; the message says which |
| 3 | refused — nothing written | tell the person why (stderr); nothing is refused at present (a plan of several `jobs` is drawn from 0.1.9) |

Warnings (exit 0) mean part of the workflow is shown only as its source
structure — `$import` not expanded, generics —, that a plan's jobs run
different workflows (the plan is then drawn without one), or that
`--gantt object` was asked for without a workflow, so the page opens on the
device view. The file is still worth sending; say what is missing.

## Examples

```sh
# a plan, with its workflow and environment found through meta
ofp-export view outputs/plate_batch.plan.yaml -o plate_batch.html

# a workflow on its own, before anything is scheduled
ofp-export view protocol.workflow.yaml -o protocol.html

# a summary to read back
ofp-export view plan.yaml -o plan.html --json
```

To produce a plan first: `ofp-schedule schedule <workflow> --env <env> -o plan.yaml`.
