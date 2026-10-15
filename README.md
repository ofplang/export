# ofplang export

[![CI](https://github.com/ofplang/export/actions/workflows/ci.yml/badge.svg)](https://github.com/ofplang/export/actions/workflows/ci.yml)
[![PyPI](https://img.shields.io/pypi/v/ofplang-export.svg)](https://pypi.org/project/ofplang-export/)

Readable views of [ofplang](https://github.com/ofplang/spec) documents: a
workflow as its dataflow graph, and the execution plans
[`ofp-schedule`](https://github.com/ofplang/schedule) produces from it, shown
side by side and linked — as a web site, and as one self-contained HTML file.
The viewer is **OFP View** (OFP: Object-Flow Programming).

It reads the documents the ofplang specifications define and nothing more, so
it does not depend on any dialect built on top of them.

```sh
pip install ofplang-export
ofp-export view plan.yaml -o plan.html        # a plan; its workflow and environment come from its meta
ofp-export view workflow.yaml -o wf.html      # a workflow on its own
```

`ofp-export view` writes the viewer as **one HTML file with the documents in
it**, to open from disk or send to someone. It is also `ofp export view`
(`pip install "ofplang[export]"`, from ofplang 0.7) and, under labcode,
`lc export view` (`labcode[export]`, from labcode 0.9).

**→ [ofplang.github.io/export](https://ofplang.github.io/export/)**
— twenty plans are bundled (two of them curated here: `data_flow`, Pure Data and an entry with inputs and outputs, and `plate_assay`, an assay whose five Objects each meet a different fate); `?doc=plate_assay` opens one directly. Drop your own
YAML on the window to read that instead: a plan, a workflow, an environment, or
all three at once. A workflow on its own is fine — the graph does not need a
plan to be read. Either pane can take the whole window: *Both / Workflow / Plan*
in the top bar, or `&layout=workflow` / `&layout=plan` in the address.

The point is to be able to hand someone a URL. They open it and see the
dataflow graph and the Gantt chart of a plan side by side, linked: pick a bar
and the workflow node it came from lights up, pick a node and every bar under
it lights up. No install, no server, no Python.

The Gantt chart slices the plan four ways: by machine, by top-level step, by
activity, and by **Object** — one lane per plate or sample, from where it
appears to where it is used up, with every step, move and wait on the way.
Which Object is which comes from the workflow's `objects` declarations, since
a plan names none; where they cannot be followed, that view is not offered.

Structured nodes — `map`, `fold`, `do_while`, `branch` — are drawn as the one node
they are, with how many times the plan runs each: a `map`, `fold` or loop opens
onto its body, and a `branch` onto both of its arms, the one the run took drawn
solid and one the plan only assumes dashed. A plan made before the run decides
something says so, and the chart shows it: the moment of each decision, the
spots kept so the plan holds whichever way it goes, the gate the outcome leaves
by, and the work that may not happen at all.

A plan of several jobs scheduled together — the same workflow run on different
material, competing for the same machines — is drawn as one plan against that
one workflow. A switch above the chart shows one job alone, and the flow view
gives each job its own lanes. Where the jobs cannot be shown to run the workflow
given, the plan is drawn on its own and says why.

> **Status: early but usable.** Both panes work and are linked: pick a bar and
> the workflow box it came from lights up, pick a box and everything under it
> lights up in the plan, pick an arc and it names the type it carries and the
> moves that carry it. No arc is drawn through a box it does not join. Plans
> can be exported as SVG or put in a link. `prototype/` holds the single-file
> look-and-feel study the visual decisions were made against, under the name
> the viewer had then.

## The command

```sh
ofp-export view <file>... [-o OUT] [--layout split|workflow|plan] [--gantt device|flow|activity|object]
                          [--name NAME] [--no-follow] [--thin [--viewer-url URL]] [--json]
```

- Files are a plan, a workflow and/or an environment, in any order; which is
  which is read from the file. A plan's `meta` supplies the workflow and the
  environment unless they are given (`--no-follow` turns that off).
- Without `-o` the HTML goes to standard output, as `ofp-schedule` does with a
  plan. With `-o` the path written is printed; `--json` prints a summary instead.
- Exit codes: **0** written (warnings, if any, on stderr — parts of a workflow
  the viewer shows only as source structure, or jobs of different workflows,
  whose plan is drawn on its own), **2** bad input, **3** refused and nothing
  written (nothing is refused at present; a plan of several jobs was, until 0.1.9).

[`skills/ofp-export/SKILL.md`](skills/ofp-export/SKILL.md) says the same for an
agent calling the command, as a skill to install where the agent looks for them.

## A single file

The same viewer also builds as **one self-contained HTML file** that carries
its documents inside it: open it from disk, no server, nothing beside it.
`npm run build:single` writes the empty template, `web/dist-single/viewer.html`
(also kept as the `viewer-template` artifact of every CI run), and
`web/scripts/embed.mjs` puts documents into it:

```sh
node scripts/embed.mjs dist-single/viewer.html out.html plan.yaml --workflow w.yaml --env e.yaml
```

The documents go in as the YAML text as written, in one element —
`<script type="application/json" id="ofp-documents" data-contract="1">` — and
the page reads them with the same reader it uses for a dropped file. An empty
template (`null` in that element) is an offline viewer to drop files on. The
web fonts stay a link, so offline the page falls back to system fonts; *Copy
link* is hidden, since a link made from a file on disk would point at the disk.

### A thin page

`ofp-export view --thin` writes the same element and, instead of the viewer,
one script tag that loads it from a CDN:

```html
<script type="application/json" id="ofp-documents" data-contract="1">…</script>
<script type="module" src="https://cdn.jsdelivr.net/npm/@ofplang/export-viewer@0.1.5/ofp-view.js"></script>
```

That is a few kilobytes of documents rather than some 190 KB, for a page
something else has to carry — a claude.ai artifact, which Claude writes out
token by token. It needs the network to open. The script is the version of
the command that wrote the page; each release builds it (`npm run build:single`
writes `web/dist-cdn/ofp-view.js` beside the template) and publishes it to npm as
[`@ofplang/export-viewer`](https://www.npmjs.com/package/@ofplang/export-viewer)
(package source in `web/npm/`), which [jsDelivr](https://www.jsdelivr.com/) serves
— from `/npm/`, the one path of it a claude.ai artifact may load scripts from.
A development build has none, so it takes `--viewer-url`.

## Layout

| Path | What it is |
|---|---|
| `web/` | the application — Vite + TypeScript, no runtime dependency beyond `yaml` |
| `web/src/model/` | types for the workflow, the environment and the execution document |
| `web/src/read/` | YAML → those types; the only part that tracks the specifications |
| `web/src/model/scene.ts` | the indices every view is built on — by node, by arc, by machine |
| `web/src/layout/` | lanes, bars and the time scale; pure functions, no DOM |
| `web/src/view/` | SVG rendering, the inspector, and the SVG export |
| `web/scripts/collect-datasets.mjs` | turns the submodule's examples into the bundled datasets |
| `web/scripts/build-single.mjs` | folds the build into the one-file viewer template |
| `web/scripts/embed.mjs` | puts documents into that template — the contract, in one place |
| `ofplang/export/` | the `ofp-export` Python package; `template.py` is the same contract in Python |
| `tests/` | its tests (pytest), against the pinned submodule's examples |
| `skills/ofp-export/SKILL.md` | how an agent calls `ofp-export`; not in the package |
| `datasets/curated/` | plans bundled here that the submodule does not ship (`data_flow`), with their provenance |
| `web/tests/golden/` | every example the pinned submodule ships must read |
| `web/tests/routing.test.ts` | no arc of any bundled workflow runs through a box it does not join |
| `external/ofplang-schedule` | submodule, pinned to a commit of ofplang/schedule — specifications and examples |
| `prototype/` | a single-file look-and-feel study; not the codebase |
| `web/public/favicon.png` | the ofplang mark, from [`ofplang/spec`](https://github.com/ofplang/spec) `logos/symbol-circle.png`; the SVG version is inline in `web/index.html` |

## Why a TypeScript reader instead of reusing the Python one

The sibling repositories own the specifications and the semantics, and this one
does not modify them. It also has to run with nothing installed on the viewer's
machine, which rules out a Python pre-processing step. So the document readers
here are a deliberate, bounded re-implementation of two stable schemas —
`SPECIFICATIONS.md` §5 (environment) and §6 (execution document) — kept honest
by the golden test against the pinned submodule's own examples.

Anything outside that subset — `$import`, generics, jobs of different workflows
in one plan — is left out and said so rather than guessed at.

## Working on it

```sh
git clone --recurse-submodules git@github.com:ofplang/export.git
cd web
npm install

npm run dev        # development server (collects the datasets first)
npm run datasets   # rebuild public/datasets/ from external/
npm run typecheck  # tsc --noEmit
npm test           # golden tests against external/ofplang-schedule
npm run build      # typecheck + production build into web/dist
npm run build:single  # …and the one-file template into web/dist-single
npm run test:e2e   # the browser tests (builds the template first)
```

The Python package, from the repository root (after `npm run build:single`,
which also puts the template into `ofplang/export/_template/`):

```sh
pip install -e ".[dev]"
pytest
```

A release is a `v*` tag: `publish.yml` builds the template and the wheel from
the same commit and publishes through PyPI trusted publishing (an `rc` tag goes
to TestPyPI). Installing straight from git gives no template — it is built, not
committed — and the command says so.

Already cloned without `--recurse-submodules`? `git submodule update --init`.

## License

MIT — see [LICENSE](LICENSE).
