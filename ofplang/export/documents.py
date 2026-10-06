"""Find out what the given files are, and what else they point at.

The viewer page reads every document itself (design.md D5, D48); this module
reads only as much YAML as the command needs to do its job:

- which of plan / workflow / environment each file is, by its top-level keys;
- the workflow and environment a plan names in `meta` (§6.1), so that one
  plan is enough to ask for (D32);
- whether the page will refuse the plan outright, or draw only part of the
  workflow — so that the caller hears it here, not after opening the file.

The two checks mirror `gateDocument` and `gateWorkflow` in `web/src/read/gate.ts`
and look at the same keys. They are not validation: `ofp-validate` owns that.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml

KINDS = ("plan", "workflow", "environment")


class InputError(Exception):
    """A file that cannot be used as given. Exit code 2."""


@dataclass
class Document:
    kind: str
    path: Path
    text: str
    data: dict[str, Any]


@dataclass
class DocumentSet:
    plan: Document | None = None
    workflow: Document | None = None
    environment: Document | None = None
    #: Paths reached through a plan's `meta` rather than given.
    followed: list[Path] = field(default_factory=list)

    def get(self, kind: str) -> Document | None:
        return getattr(self, kind)


@dataclass
class Finding:
    what: str
    at: str
    why: str

    def line(self) -> str:
        # ASCII only: a Windows console decodes stderr in its own code page.
        return f"{self.what} at {self.at}: {self.why}"


def load(path: Path) -> Document:
    """Read one file and decide what it is."""
    try:
        text = path.read_text(encoding="utf-8-sig")
    except FileNotFoundError:
        raise InputError(f"{path}: no such file") from None
    except (OSError, UnicodeDecodeError) as e:
        raise InputError(f"{path}: cannot be read ({e})") from None
    try:
        data = yaml.safe_load(text)
    except yaml.YAMLError as e:
        raise InputError(f"{path}: not valid YAML ({e})") from None
    return Document(kind_of(data, path), path, text, data)


def kind_of(data: Any, path: Path) -> str:
    """Plan, workflow or environment, by the keys each one cannot do without.

    An environment has `processes` too, so `devices` is asked first; a plan
    or a status is the one document with `activities` (§6.1).
    """
    if isinstance(data, dict):
        if isinstance(data.get("activities"), list):
            return "plan"
        if "devices" in data:
            return "environment"
        if "processes" in data:
            return "workflow"
    raise InputError(f"{path}: not a plan, a workflow or an environment")


def collect(paths: list[Path], *, follow: bool = True) -> DocumentSet:
    """The document set for the given files, with a plan's `meta` followed."""
    docs = DocumentSet()
    for path in paths:
        doc = load(path)
        if docs.get(doc.kind) is not None:
            raise InputError(
                f"two {doc.kind} documents given ({docs.get(doc.kind).path}, {path}); "  # type: ignore[union-attr]
                "a viewer shows one set"
            )
        setattr(docs, doc.kind, doc)

    if docs.plan is None and docs.workflow is None:
        raise InputError("give a plan or a workflow; an environment alone has nothing to draw")

    if follow and docs.plan is not None:
        meta = docs.plan.data.get("meta")
        if isinstance(meta, dict):
            for kind in ("workflow", "environment"):
                ref = meta.get(kind)
                if docs.get(kind) is None and isinstance(ref, str) and ref:
                    found = resolve(ref, docs.plan.path)
                    if found is not None:
                        doc = load(found)
                        if doc.kind == kind:
                            setattr(docs, kind, doc)
                            docs.followed.append(found)
    return docs


def resolve(ref: str, plan: Path) -> Path | None:
    """Where a `meta` path points.

    `meta` paths are written relative to wherever the scheduler was run —
    usually a repository root above the plan (`examples/simple.workflow.yaml`
    from `examples/outputs/…`). So the plan's directory and each one above it
    are tried, then the current directory; the first file that exists wins.
    """
    candidate = Path(ref)
    if candidate.is_absolute():
        return candidate if candidate.is_file() else None
    for base in [plan.resolve().parent, *plan.resolve().parents, Path.cwd()]:
        hit = base / candidate
        if hit.is_file():
            return hit
    return None


JOINT_WHY = (
    "a joint plan schedules several workflows together (SPECIFICATIONS section 6.11); "
    "this viewer draws one workflow at a time"
)


def refusals(docs: DocumentSet) -> list[Finding]:
    """Why the page would refuse the plan outright — design.md D42."""
    if docs.plan is None:
        return []
    raw = docs.plan.data
    out: list[Finding] = []
    if raw.get("jobs") is not None:
        out.append(Finding("a joint plan (`jobs`)", "jobs", JOINT_WHY))
    for i, a in enumerate(raw.get("activities") or []):
        if isinstance(a, dict) and "job" in a:
            out.append(Finding("activities tagged with a `job`", f"activities[{i}].job", JOINT_WHY))
            break
    meta = raw.get("meta")
    if isinstance(meta, dict) and isinstance(meta.get("workflow"), list):
        out.append(Finding("more than one workflow in `meta.workflow`", "meta.workflow", JOINT_WHY))
    return out


_NODE_KINDS = {"map": "node_map", "fold": "node_fold", "do_while": "node_do_while", "branch": "node_branch"}


def warnings(docs: DocumentSet) -> list[Finding]:
    """What the page would draw only in part — design.md D10."""
    if docs.workflow is None:
        return []
    raw = docs.workflow.data
    out = [
        Finding(
            "$import",
            at,
            "the document has not been expanded; run it through ofplang-validate's expand() first",
        )
        for at in _imports(raw, "")
    ]
    processes = raw.get("processes")
    for name, d in processes.items() if isinstance(processes, dict) else []:
        if not isinstance(d, dict):
            continue
        base = f"processes.{name}"
        if "type_params" in d:
            out.append(
                Finding(
                    "a generic process (`type_params`)",
                    f"{base}.type_params",
                    "generics are not instantiated, so its ports are not known",
                )
            )
        if "script" in d:
            out.append(
                Finding(
                    "an inline script process (`script`)",
                    f"{base}.script",
                    "shown as an ordinary atomic step; its code is not read",
                )
            )
        body = d.get("body")
        nodes = body.get("nodes") if isinstance(body, dict) else None
        for i, n in enumerate(nodes if isinstance(nodes, list) else []):
            if isinstance(n, dict) and "kind" in n:
                kind = n["kind"]
                what = (
                    f"a structured node (`kind: {kind}`)"
                    if kind in _NODE_KINDS
                    else f"an unrecognised node kind (`kind: {kind}`)"
                )
                out.append(Finding(what, f"{base}.body.nodes[{i}]", "only the source structure is drawn"))
    return out


def _imports(node: Any, at: str) -> list[str]:
    """`$import` may sit anywhere a mapping may."""
    found: list[str] = []
    if isinstance(node, dict):
        for k, v in node.items():
            here = f"{at}.{k}" if at else str(k)
            if k == "$import":
                found.append(here)
            else:
                found.extend(_imports(v, here))
    elif isinstance(node, list):
        for i, v in enumerate(node):
            found.extend(_imports(v, f"{at}[{i}]"))
    return found
