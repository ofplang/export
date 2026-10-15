"""`ofp-export view`, against the examples the pinned submodule ships.

The page itself is exercised in the browser tests (web/tests/e2e/single.spec.ts,
which also opens files this command wrote). What is checked here is the
command's own job: finding the documents, deciding what to refuse or warn
about, and putting the text into the template unchanged.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

from ofplang.export.cli import EXIT_INPUT, EXIT_OK, main
from ofplang.export.template import CONTRACT, TemplateError, embed, encode

ROOT = Path(__file__).resolve().parents[1]
EXAMPLES = ROOT / "external" / "ofplang-schedule" / "examples"
OUTPUTS = EXAMPLES / "outputs"

# A template is anything carrying the one element of the contract (design.md D48).
TEMPLATE = (
    '<!doctype html><html><head><meta name="ofp-viewer-build" content="abc1234" />'
    f'<script type="application/json" id="ofp-documents" data-contract="{CONTRACT}">null</script>'
    "</head><body></body></html>"
)

pytestmark = pytest.mark.skipif(not EXAMPLES.is_dir(), reason="the submodule is not checked out")


@pytest.fixture
def template(tmp_path: Path) -> Path:
    path = tmp_path / "viewer.html"
    path.write_text(TEMPLATE, encoding="utf-8")
    return path


def payload_of(html: str) -> dict | None:
    m = re.search(r'id="ofp-documents" data-contract="\d+">(.*?)</script>', html, re.DOTALL)
    assert m, "the element is gone"
    return json.loads(m.group(1))


def run(capsys, *args: str) -> tuple[int, str, str]:
    code = main(["view", *args])
    out, err = capsys.readouterr()
    return code, out, err


# ── what goes in ───────────────────────────────────────────────────────────


def test_a_plan_brings_its_workflow_and_environment_from_meta(tmp_path, template, capsys):
    # reroute_chain's replan runs on simple.workflow.yaml: matching by file
    # name would miss it; `meta` names it (design.md D32).
    out = tmp_path / "rc.html"
    code, stdout, _ = run(
        capsys, str(OUTPUTS / "reroute_chain.replan.yaml"), "-o", str(out), "--template", str(template)
    )
    assert code == EXIT_OK
    assert stdout.strip() == str(out)
    p = payload_of(out.read_text(encoding="utf-8"))
    assert p["name"] == "reroute_chain.replan.yaml"
    assert p["workflow"] == (EXAMPLES / "simple.workflow.yaml").read_text(encoding="utf-8")
    assert p["environment"] == (EXAMPLES / "reroute_chain.env.yaml").read_text(encoding="utf-8")


def test_files_in_any_order_and_what_was_given_wins_over_meta(tmp_path, template, capsys):
    out = tmp_path / "x.html"
    other = EXAMPLES / "two_arms.workflow.yaml"
    code, _, _ = run(
        capsys, str(other), str(OUTPUTS / "simple.plan.yaml"), "-o", str(out), "--template", str(template)
    )
    assert code == EXIT_OK
    assert payload_of(out.read_text(encoding="utf-8"))["workflow"] == other.read_text(encoding="utf-8")


def test_no_follow_takes_only_what_was_given(tmp_path, template, capsys):
    out = tmp_path / "x.html"
    run(capsys, str(OUTPUTS / "simple.plan.yaml"), "--no-follow", "-o", str(out), "--template", str(template))
    p = payload_of(out.read_text(encoding="utf-8"))
    assert "workflow" not in p and "environment" not in p


def test_a_workflow_alone(tmp_path, template, capsys):
    out = tmp_path / "wf.html"
    code, _, _ = run(
        capsys, str(EXAMPLES / "reformatter.workflow.yaml"), "-o", str(out), "--template", str(template)
    )
    assert code == EXIT_OK
    p = payload_of(out.read_text(encoding="utf-8"))
    assert set(p) == {"name", "workflow"}


def test_the_opening_view_is_carried_only_when_asked(tmp_path, template, capsys):
    out = tmp_path / "x.html"
    run(
        capsys,
        str(OUTPUTS / "plate_batch.plan.yaml"),
        "--layout",
        "plan",
        "--gantt",
        "flow",
        "-o",
        str(out),
        "--template",
        str(template),
    )
    assert payload_of(out.read_text(encoding="utf-8"))["ui"] == {"layout": "plan", "view": "flow"}
    run(capsys, str(OUTPUTS / "plate_batch.plan.yaml"), "-o", str(out), "--template", str(template))
    assert "ui" not in payload_of(out.read_text(encoding="utf-8"))


def test_the_object_view_is_carried_like_the_others(tmp_path, template, capsys):
    out = tmp_path / "o.html"
    code, _, err = run(
        capsys,
        str(OUTPUTS / "storage.plan.yaml"),
        "--gantt",
        "object",
        "-o",
        str(out),
        "--template",
        str(template),
    )
    assert code == EXIT_OK
    assert err == ""
    assert payload_of(out.read_text(encoding="utf-8"))["ui"] == {"view": "object"}


def test_the_object_view_without_a_workflow_is_written_with_a_warning(tmp_path, template, capsys):
    # The page tells Objects apart by the workflow's declarations (design.md D59)
    # and opens on the device view without it; say so before anyone looks.
    out = tmp_path / "o.html"
    code, stdout, err = run(
        capsys,
        str(OUTPUTS / "storage.plan.yaml"),
        "--no-follow",
        "--gantt",
        "object",
        "-o",
        str(out),
        "--json",
        "--template",
        str(template),
    )
    assert code == EXIT_OK
    assert "warning: the Object view (`--gantt object`) at --gantt" in err
    assert json.loads(stdout)["warnings"] == [
        {
            "what": "the Object view (`--gantt object`)",
            "at": "--gantt",
            "why": "it needs a plan and its workflow; the page opens on the device view instead",
        }
    ]
    assert payload_of(out.read_text(encoding="utf-8"))["ui"] == {"view": "object"}


@pytest.mark.parametrize("argv", [["--help"], ["view", "--help"]])
def test_help_is_ascii_so_any_console_can_print_it(argv, capsys):
    # A Windows console prints in its own code page; under cp932 an em dash in
    # the description made `ofp-export view --help` fail with UnicodeEncodeError.
    with pytest.raises(SystemExit):
        main(argv)
    text = capsys.readouterr().out
    assert "usage:" in text
    assert text.isascii(), sorted({c for c in text if not c.isascii()})


def test_the_details_pane_can_be_written_to_start_hidden(tmp_path, template, capsys):
    # For a narrow page such as an artifact (design.md D70); the page keeps its button.
    out = tmp_path / "d.html"
    code, _, err = run(
        capsys,
        str(OUTPUTS / "storage.plan.yaml"),
        "--details",
        "hide",
        "-o",
        str(out),
        "--template",
        str(template),
    )
    assert code == EXIT_OK, err
    assert payload_of(out.read_text(encoding="utf-8"))["ui"] == {"details": "hide"}


# ── a thin page (design.md D68) ────────────────────────────────────────────


def test_a_thin_page_is_the_documents_and_one_script_from_the_cdn(tmp_path, capsys, monkeypatch):
    # Pretend to be a released version: that is what has a viewer on the CDN.
    monkeypatch.setattr("ofplang.export.cli.__version__", "0.1.5")
    out = tmp_path / "thin.html"
    code, stdout, err = run(
        capsys, str(OUTPUTS / "storage.plan.yaml"), "--thin", "--gantt", "object", "-o", str(out), "--json"
    )
    assert code == EXIT_OK, err
    html = out.read_text(encoding="utf-8")
    url = "https://cdn.jsdelivr.net/npm/@ofplang/export-viewer@0.1.5/ofp-view.js"
    assert f'<script type="module" src="{url}"></script>' in html
    assert json.loads(stdout)["viewer"] == url
    assert "template_build" not in json.loads(stdout)
    # The same contract as the template's, so the page reads it the same way.
    p = payload_of(html)
    assert p["name"] == "storage.plan.yaml"
    assert set(p) == {"name", "plan", "workflow", "environment", "ui"}
    assert p["ui"] == {"view": "object"}
    # Small: the documents, and nothing of the viewer.
    assert len(html) < len(p["plan"]) + len(p["workflow"]) + len(p["environment"]) + 1000


def test_a_thin_page_can_load_the_viewer_from_elsewhere(tmp_path, capsys):
    out = tmp_path / "thin.html"
    url = "http://localhost:4173/ofp-view.js?x=<1>"
    code, _, err = run(
        capsys, str(OUTPUTS / "simple.plan.yaml"), "--thin", "--viewer-url", url, "-o", str(out)
    )
    assert code == EXIT_OK, err
    assert 'src="http://localhost:4173/ofp-view.js?x=&lt;1&gt;"' in out.read_text(encoding="utf-8")


def test_a_development_build_has_no_viewer_on_the_cdn(tmp_path, capsys, monkeypatch):
    monkeypatch.setattr("ofplang.export.cli.__version__", "0.1.5.dev3+g1234567")
    code, _, err = run(capsys, str(OUTPUTS / "simple.plan.yaml"), "--thin", "-o", str(tmp_path / "x.html"))
    assert code == EXIT_INPUT
    assert "not a released version" in err and "--viewer-url" in err
    assert not (tmp_path / "x.html").exists()


def test_the_viewer_url_is_for_a_thin_page_only(tmp_path, capsys):
    code, _, err = run(
        capsys,
        str(OUTPUTS / "simple.plan.yaml"),
        "--viewer-url",
        "http://x/v.js",
        "-o",
        str(tmp_path / "x.html"),
    )
    assert code == EXIT_INPUT
    assert "--viewer-url is for --thin" in err


def test_a_release_candidate_has_its_own_viewer_on_the_cdn():
    from ofplang.export.template import viewer_url

    # npm spells it the semver way, and the release workflow publishes it so.
    assert (
        viewer_url("0.1.5rc2") == "https://cdn.jsdelivr.net/npm/@ofplang/export-viewer@0.1.5-rc.2/ofp-view.js"
    )
    assert viewer_url("0.1.5.post1") is None


# ── the text arrives unchanged ─────────────────────────────────────────────


def test_text_that_would_end_the_element_is_escaped_losslessly():
    text = "a: 1  # </script><b>x</b> $1 \\g<0> 日本語\n"
    html = embed(TEMPLATE, {"name": "t", "workflow": text})
    assert "</script><b>" not in html
    assert html.count("</script>") == 1
    assert payload_of(html)["workflow"] == text


def test_encode_null_is_an_empty_viewer():
    assert encode(None) == "null"
    assert payload_of(embed(TEMPLATE, None)) is None


def test_a_template_without_the_element_or_of_another_contract_is_refused():
    with pytest.raises(TemplateError, match="no #ofp-documents"):
        embed("<html></html>", {"name": "x"})
    with pytest.raises(TemplateError, match="contract 9"):
        embed(TEMPLATE.replace(f'data-contract="{CONTRACT}"', 'data-contract="9"'), {"name": "x"})


# ── refused, warned, wrong ─────────────────────────────────────────────────


@pytest.mark.parametrize("plan", ["shared_bay.plan.yaml", "shared_refill.plan.yaml", "stopped_job.plan.yaml"])
def test_a_plan_of_several_jobs_is_written_with_the_workflow_they_all_run(tmp_path, template, capsys, plan):
    # Refused until 0.1.9 (design.md D42); drawn now, against the one workflow
    # every job's `meta` names (D75).
    out = tmp_path / "j.html"
    code, stdout, err = run(
        capsys, str(OUTPUTS / plan), "-o", str(out), "--template", str(template), "--json"
    )
    assert code == EXIT_OK and out.exists()
    summary = json.loads(stdout)
    assert summary["documents"]["workflow"] is not None
    assert summary["warnings"] == []


def test_jobs_of_different_workflows_are_written_with_a_warning(tmp_path, template, capsys):
    text = (OUTPUTS / "shared_refill.plan.yaml").read_text(encoding="utf-8")
    plan = tmp_path / "apart.plan.yaml"
    plan.write_text(
        text.replace("- examples/shared_refill.workflow.yaml\n", "- examples/simple.workflow.yaml\n", 1),
        encoding="utf-8",
    )
    out = tmp_path / "apart.html"
    code, stdout, err = run(capsys, str(plan), "-o", str(out), "--template", str(template), "--json")
    assert code == EXIT_OK and out.exists()
    assert "different workflows" in err
    assert json.loads(stdout)["documents"]["workflow"] is None


def test_a_workflow_drawn_only_in_part_is_written_with_a_warning(tmp_path, template, capsys):
    wf = tmp_path / "mapped.workflow.yaml"
    wf.write_text(
        (EXAMPLES / "reformatter.workflow.yaml").read_text(encoding="utf-8")
        + "\nx-extra:\n  $import: other.yaml\n",
        encoding="utf-8",
    )
    out = tmp_path / "m.html"
    code, stdout, err = run(capsys, str(wf), "-o", str(out), "--template", str(template), "--json")
    assert code == EXIT_OK and out.exists()
    assert "warning: $import" in err
    assert json.loads(stdout)["warnings"][0]["what"] == "$import"


@pytest.mark.parametrize(
    ("args", "message"),
    [
        (["nope.yaml"], "no such file"),
        ([str(EXAMPLES / "simple.env.yaml")], "nothing to draw"),
        ([str(OUTPUTS / "simple.plan.yaml"), str(OUTPUTS / "two_arms.plan.yaml")], "two plan documents"),
        ([str(EXAMPLES / "reformatter.workflow.yaml"), "--json"], "--json needs -o"),
    ],
)
def test_bad_input_is_exit_2_with_a_message(template, capsys, args, message):
    code, _, err = run(capsys, *args, "--template", str(template))
    assert code == EXIT_INPUT
    assert message in err


def test_a_file_that_is_no_document(tmp_path, template, capsys):
    junk = tmp_path / "junk.yaml"
    junk.write_text("just: a mapping\n", encoding="utf-8")
    code, _, err = run(capsys, str(junk), "--template", str(template))
    assert code == EXIT_INPUT and "not a plan, a workflow or an environment" in err


# ── where it goes ──────────────────────────────────────────────────────────


def test_without_o_the_html_goes_to_standard_output(template, capsysbinary):
    code = main(["view", str(EXAMPLES / "reformatter.workflow.yaml"), "--template", str(template)])
    out = capsysbinary.readouterr().out.decode("utf-8")
    assert code == EXIT_OK
    assert out.startswith("<!doctype html>")
    assert payload_of(out)["name"] == "reformatter.workflow.yaml"


def test_the_json_summary(tmp_path, template, capsys):
    out = tmp_path / "s.html"
    code, stdout, _ = run(
        capsys, str(OUTPUTS / "plate_batch.plan.yaml"), "-o", str(out), "--template", str(template), "--json"
    )
    s = json.loads(stdout)
    assert code == EXIT_OK
    assert s["written"] == str(out.resolve())
    assert s["activities"] == 44 and s["outcome"] == "optimal"
    assert s["template_build"] == "abc1234"
    assert all(s["documents"][k] for k in ("plan", "workflow", "environment"))
