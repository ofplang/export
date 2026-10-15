"""`ofp-export` — write ofplang documents out in a form people read.

    ofp-export view plan.yaml -o plan.html
    ofp-export view workflow.yaml -o workflow.html

`view` is the one target so far: the interactive viewer as a single HTML file,
opened from disk with nothing beside it. Further targets would sit beside it
as their own subcommands (design.md D49).

Exit codes (design.md D50):
  0  written (possibly with warnings: parts of the workflow the viewer cannot draw,
     jobs of different workflows, or an Object view that cannot be offered)
  2  bad input: a missing or unreadable file, nothing to draw, a bad option
  3  refused: a document the viewer does not draw at all; nothing written (none at present)

Without `-o` the HTML goes to standard output, as `ofp-schedule` does with a
plan. With `-o` the path written is the one line on standard output, and
`--json` may be added for a summary instead.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from collections.abc import Sequence
from pathlib import Path
from typing import Any

from . import __version__
from .documents import Finding, InputError, collect, refusals, warnings
from .template import TemplateError, embed, load_template, template_build, thin, viewer_url

EXIT_OK = 0
EXIT_INPUT = 2
EXIT_REFUSED = 3

LAYOUTS = ("split", "workflow", "plan")
GANTT_VIEWS = ("device", "flow", "activity", "object")
DETAILS = ("show", "hide")


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="ofp-export",
        description="Write ofplang documents out in a form people read.",
    )
    parser.add_argument("-V", "--version", action="version", version=f"ofp-export {__version__}")
    sub = parser.add_subparsers(dest="target", required=True, metavar="<target>")

    v = sub.add_parser(
        "view",
        help="the interactive viewer as one self-contained HTML file",
        description=(
            # ASCII only, like the warnings: a Windows console prints help in its own code page,
            # and cp932 cannot encode an em dash (`--help` failed there with UnicodeEncodeError).
            "Write the interactive viewer (the workflow's dataflow graph and the plan's Gantt chart, "
            "linked) as one HTML file that opens from disk with nothing beside it. Give a plan, a "
            "workflow, an environment, in any order; a plan's own `meta` supplies the other two unless "
            "they are given."
        ),
    )
    v.add_argument(
        "files", nargs="+", type=Path, metavar="FILE", help="a plan, a workflow and/or an environment (YAML)"
    )
    v.add_argument(
        "-o", "--out", type=Path, metavar="FILE", help="write the HTML here (default: standard output)"
    )
    v.add_argument("--layout", choices=LAYOUTS, help="panes to open on (default: decided by what was given)")
    v.add_argument(
        "--gantt",
        choices=GANTT_VIEWS,
        help=(
            "Gantt view to open on (default: device). `object` follows each Object through the plan; "
            "it needs the workflow, and the page opens on device where the Objects cannot be told apart"
        ),
    )
    v.add_argument(
        "--details",
        choices=DETAILS,
        help=(
            "whether the pane with the details of what is selected starts shown or hidden (default: "
            "shown where the window is wide enough); the page has a button for it either way"
        ),
    )
    v.add_argument(
        "--name", help="what the page calls the documents (default: the plan's or workflow's file name)"
    )
    v.add_argument(
        "--no-follow",
        action="store_true",
        help="do not read the workflow and environment a plan's `meta` names",
    )
    v.add_argument(
        "--thin",
        action="store_true",
        help=(
            "write a thin page instead: the documents and one script tag that loads this version's "
            "viewer from jsDelivr (npm). A few KB rather than some 210 KB, for a page something "
            "else has to carry, such as a claude.ai artifact; it needs the network to open"
        ),
    )
    v.add_argument(
        "--viewer-url",
        metavar="URL",
        help="with --thin: load the viewer from here (default: this version's, on the CDN)",
    )
    v.add_argument("--json", action="store_true", help="with -o: print a JSON summary instead of the path")
    v.add_argument("--template", type=Path, metavar="FILE", help=argparse.SUPPRESS)  # development only
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    if args.target == "view":
        return _view(args)
    return EXIT_INPUT  # pragma: no cover — argparse requires a target


def _view(args: argparse.Namespace) -> int:
    if args.json and args.out is None:
        return _fail("--json needs -o: the HTML and the summary would share standard output")
    if args.viewer_url and not args.thin:
        return _fail("--viewer-url is for --thin: the single file carries its viewer inside it")

    # A thin page loads the viewer rather than carrying it (design.md D68), and
    # only a released version has one on the CDN.
    viewer: str | None = None
    if args.thin:
        viewer = args.viewer_url or viewer_url(__version__)
        if viewer is None:
            return _fail(
                f"--thin: {__version__} is not a released version, so it has no viewer on the CDN; "
                "give one with --viewer-url"
            )

    try:
        docs = collect(args.files, follow=not args.no_follow)
        template = None if args.thin else load_template(args.template)
    except (InputError, TemplateError) as e:
        return _fail(str(e))

    refused = refusals(docs)
    if refused:
        for f in refused:
            print(f"ofp-export: refused: {f.line()}", file=sys.stderr)
        if args.json:
            print(json.dumps({"written": None, "refused": [vars(f) for f in refused]}, indent=2))
        return EXIT_REFUSED

    warned = warnings(docs)
    if args.gantt == "object" and (docs.plan is None or docs.workflow is None):
        # The page decides whether the Objects can be told apart (design.md D59);
        # this much is visible from here, and worth saying before anyone looks.
        warned.append(
            Finding(
                "the Object view (`--gantt object`)",
                "--gantt",
                "it needs a plan and its workflow; the page opens on the device view instead",
            )
        )
    for f in warned:
        print(f"ofp-export: warning: {f.line()}", file=sys.stderr)

    first = docs.plan or docs.workflow
    assert first is not None  # collect() guarantees one of them
    payload: dict[str, Any] = {"name": args.name or first.path.name}
    for kind in ("plan", "workflow", "environment"):
        doc = docs.get(kind)
        if doc is not None:
            payload[kind] = doc.text
    ui = {k: v for k, v in (("layout", args.layout), ("view", args.gantt), ("details", args.details)) if v}
    if ui:
        payload["ui"] = ui

    try:
        html = thin(payload, viewer) if viewer is not None else embed(template or "", payload)
    except TemplateError as e:
        return _fail(str(e))

    if args.out is None:
        try:
            sys.stdout.buffer.write(html.encode("utf-8"))
            sys.stdout.buffer.flush()
        except BrokenPipeError:
            # The reader stopped early (`| head`); that is its choice, not a failure here.
            # Point stdout at devnull so the interpreter's final flush stays quiet.
            devnull = os.open(os.devnull, os.O_WRONLY)
            os.dup2(devnull, sys.stdout.fileno())
        return EXIT_OK

    try:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_bytes(html.encode("utf-8"))
    except OSError as e:
        return _fail(f"{args.out}: cannot be written ({e})")

    if args.json:
        plan = docs.plan.data if docs.plan else {}
        summary = {
            "written": str(args.out.resolve()),
            "name": payload["name"],
            "documents": {
                k: (str(d.path.resolve()) if (d := docs.get(k)) else None)
                for k in ("plan", "workflow", "environment")
            },
            "followed": [str(p.resolve()) for p in docs.followed],
            "warnings": [vars(f) for f in warned],
            "activities": len(plan.get("activities") or []) if docs.plan else None,
            "outcome": plan.get("outcome"),
            **(
                {"viewer": viewer}
                if viewer is not None
                else {"template_build": template_build(template or "")}
            ),
        }
        # ASCII-escaped: valid JSON, and safe in any console code page.
        print(json.dumps(summary, indent=2))
    else:
        print(args.out)
    return EXIT_OK


def _fail(message: str) -> int:
    print(f"ofp-export: {message}", file=sys.stderr)
    return EXIT_INPUT


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
