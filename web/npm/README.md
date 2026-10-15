# @ofplang/export-viewer

`ofp-view.js`, the [OFP View](https://github.com/ofplang/export) viewer for
[ofplang](https://github.com/ofplang/spec) workflows and the plans
`ofp-schedule` makes from them, as one ES module. It is for a *thin page*: the
documents, and one script tag that loads the viewer — what
`ofp-export view --thin` writes.

```html
<script type="application/json" id="ofp-documents" data-contract="1">{"name": "…", "plan": "…", "workflow": "…"}</script>
<script type="module" src="https://cdn.jsdelivr.net/npm/@ofplang/export-viewer@<version>/ofp-view.js"></script>
```

The module brings its stylesheet and the page's markup with it and puts them
into the page before the viewer starts; the documents element is the same one
the single-file viewer carries. A thin page is a few KB where the single file
is some 210 KB, which is what makes it something Claude can write out as a
claude.ai artifact.

Every version is built and published by the release workflow of
[ofplang/export](https://github.com/ofplang/export), from the same commit as the
Python package [`ofplang-export`](https://pypi.org/project/ofplang-export/) of that
version, with provenance. A release candidate (`0.1.5-rc.2`, from the tag
`v0.1.5rc2`) is published under the dist-tag `rc`. `0.0.0` only reserved the
name and carries no viewer.

This directory is the package's source: the release workflow adds the built
`ofp-view.js` and the repository's `LICENSE`, and sets the version.
