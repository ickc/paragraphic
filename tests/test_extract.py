# paragraphic, https://github.com/ickc/paragraphic
# Copyright (C) 2026 Kolen Cheung
# SPDX-License-Identifier: AGPL-3.0-or-later
import json
from dataclasses import replace
from pathlib import Path

import pytest

from paragraphic import PRESETS, Config, build_graph
from paragraphic.cli import main, quarto_project


def page(body, head="", title="T", main=True):
    content = f'<main id="quarto-document-content">{body}</main>' if main else body
    return (f"<html><head><title>{title}</title>{head}</head>"
            f'<body><nav><a href="/index.html">Home</a></nav>{content}</body></html>')


def titled(title):
    return page(f'<h1 class="title">{title}</h1>')


def write(root: Path, files: dict[str, str]) -> Path:
    for name, html in files.items():
        path = root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(html, encoding="utf-8")
    return root


def graph(root, **kw):
    return build_graph(Config(output_dir=root, selectors=PRESETS["quarto"], **kw))


def edges(g):
    return {(l["source"], l["target"]): l["count"] for l in g["links"]}


def test_links_resolve_relative_absolute_and_directory(tmp_path):
    write(tmp_path, {
        "a.html": page('<a href="b/c.html#x">1</a> <a href="./b/c.html">2</a>'
                       '<a href="https://example.org/d/">3</a> <a href="#top">self</a>'
                       '<a href="https://elsewhere.org/a.html">ext</a>'),
        "b/c.html": page('<a href="../a.html?q=1">back</a>'),
        "d/index.html": page(""),
    })
    g = graph(tmp_path, site_url="https://example.org/")
    assert edges(g) == {("a.html", "b/c.html"): 2, ("a.html", "d/index.html"): 1,
                        ("b/c.html", "a.html"): 1}


def test_only_links_inside_the_content_count(tmp_path):
    write(tmp_path, {
        "index.html": page(""),
        "a.html": page("no links"),
    })
    # The <nav> link to the index is outside <main>.
    assert graph(tmp_path)["links"] == []


def test_pages_without_content_are_not_nodes(tmp_path):
    write(tmp_path, {"a.html": page(""), "slides.html": page("", main=False)})
    assert [n["id"] for n in graph(tmp_path)["nodes"]] == ["a.html"]


def test_alternates_fold_into_their_page(tmp_path):
    other_formats = ('<div class="quarto-alternate-formats"><a href="talk.html">Slides</a>'
                     '<a href="talk.pdf">PDF</a></div>')
    write(tmp_path, {
        "talk-article.html": page('<a href="talk.html">embedded deck</a>' + other_formats),
        "talk.html": page("", main=False),
        "post.html": page('<a href="talk.html">the slides</a> <a href="talk.pdf">the pdf</a>'),
    })
    g = graph(tmp_path)
    assert [n["id"] for n in g["nodes"]] == ["post.html", "talk-article.html"]
    # Two links to two renderings of the talk; the article's own deck is not a self-link.
    assert edges(g) == {("post.html", "talk-article.html"): 2}


def test_index_decides_the_nodes(tmp_path):
    listing = ('<div class="quarto-listing"><h3 class="listing-title"><a href="./a.html">A</a></h3>'
               '<h3 class="listing-title"><a href="b.html">B</a></h3></div>')
    write(tmp_path, {
        "index.html": page(listing),
        "a.html": page('<a href="b.html">b</a> <a href="draft.html">draft</a>'),
        "b.html": page(""),
        "draft.html": page('<a href="a.html">a</a>'),
    })
    g = graph(tmp_path, index="index.html")
    assert [n["id"] for n in g["nodes"]] == ["a.html", "b.html"]
    assert edges(g) == {("a.html", "b.html"): 1}


def test_metadata_and_citations(tmp_path):
    body = ('<header id="title-block-header"><h1 class="title">The title</h1>'
            '<div class="quarto-category">Math</div><div class="quarto-category">LLM</div>'
            '<p class="date">September 30th, 2026</p></header>'
            '<div id="refs"><div class="csl-entry" id="ref-naur1985">Naur</div>'
            '<div class="csl-entry" id="ref-knuth1984">Knuth</div></div>')
    write(tmp_path, {"a.html": page(body, title="The title – Site")})
    [node] = graph(tmp_path)["nodes"]
    assert node == {"id": "a.html", "title": "The title", "date": "September 30th, 2026",
                    "categories": ["Math", "LLM"], "citations": ["knuth1984", "naur1985"],
                    "external": [], "sources": ["cite:knuth1984", "cite:naur1985"]}


def test_pandoc_preset_reads_meta(tmp_path):
    head = ('<meta name="dcterms.date" content="2026-09-30">'
            '<meta name="keywords" content="Math, LLM">')
    write(tmp_path, {"a.html": page("", head=head, title="A", main=False)})
    [node] = build_graph(Config(output_dir=tmp_path))["nodes"]
    assert (node["title"], node["date"], node["categories"]) == ("A", "2026-09-30", ["Math", "LLM"])


def test_cli_with_quarto_project_writes_graph_and_viewer(tmp_path):
    project = tmp_path / "src"
    write(project, {"_quarto.yml": "project:\n  output-dir: docs\nwebsite:\n  site-url: https://example.org\n"})
    write(project / "docs", {
        "a.html": page('<a href="https://example.org/b.html">b</a>'),
        "b.html": page(""),
    })
    (tmp_path / "paragraphic.toml").write_text('quarto-project = "src"\ncolours = 3\n')
    main(["build", "-c", str(tmp_path / "paragraphic.toml")])
    out = project / "docs"
    g = json.loads((out / "graph.json").read_text())
    assert g["colours"] == 3
    assert edges(g) == {("a.html", "b.html"): 1}
    for name in ("paragraphic.js", "paragraphic-local.js", "paragraphic.css"):
        assert (out / name).is_file()



def test_cli_as_quarto_post_render_reads_the_environment(tmp_path, monkeypatch):
    # No settings file: the project and output directory are what Quarto sets
    # for a post-render script, and the site URL comes from the project.
    project = tmp_path / "src"
    write(project, {"_quarto.yml": "project:\n  output-dir: docs\nwebsite:\n  site-url: https://example.org\n"})
    write(project / "docs", {
        "a.html": page('<a href="https://example.org/b.html">b</a>'),
        "b.html": page(""),
    })
    monkeypatch.chdir(project)
    monkeypatch.setenv("QUARTO_PROJECT_DIR", str(project))
    monkeypatch.setenv("QUARTO_PROJECT_OUTPUT_DIR", "docs")
    monkeypatch.delenv("SITE_URL", raising=False)
    main(["build", "--preset", "quarto", "--colours", "2", "--uncoloured", "X", "--uncoloured", "Y"])
    g = json.loads((project / "docs" / "graph.json").read_text())
    assert edges(g) == {("a.html", "b.html"): 1}
    assert g["colours"] == 2


def test_cli_flags_override_the_file(tmp_path):
    write(tmp_path / "site", {
        "a/x.html": page("", title="X"),
        "b/y.html": page('<a href="../a/x.html">x</a>', title="Y"),
    })
    (tmp_path / "paragraphic.toml").write_text('output-dir = "site"\npreset = "quarto"\ncolours = 3\n')
    main(["build", "-c", str(tmp_path / "paragraphic.toml"), "--colours", "5", "--groups", "directories"])
    g = json.loads((tmp_path / "site" / "graph.json").read_text())
    assert g["colours"] == 5
    assert g["groups"] == ["a", "b"]


def test_cli_rejects_an_unknown_level(tmp_path):
    write(tmp_path, {"a.html": page("")})
    with pytest.raises(SystemExit, match="level"):
        main(["build", str(tmp_path), "--preset", "quarto", "--groups", "directories", "--level", "0"])


def test_directory_groups_by_level_named_by_their_index(tmp_path):
    write(tmp_path, {
        "index.html": titled("Home"),
        "HPC/index.html": titled("High-performance computing"),
        "HPC/b.html": titled("B"),
        "HPC/series/index.html": titled("The series"),
        "HPC/series/c.html": titled("C"),
        "math/d.html": titled("D"),
    })
    nodes = lambda g: {n["id"]: n["categories"] for n in g["nodes"]}
    one = graph(tmp_path, groups="directories")
    assert nodes(one) == {
        "index.html": [],
        "HPC/index.html": ["High-performance computing"],
        "HPC/b.html": ["High-performance computing"],
        "HPC/series/index.html": ["High-performance computing"],
        "HPC/series/c.html": ["High-performance computing"],
        "math/d.html": ["math"],
    }
    assert one["groups"] == ["High-performance computing", "math"]
    two = graph(tmp_path, groups="directories", level=2)
    assert nodes(two)["HPC/b.html"] == ["High-performance computing"]
    assert nodes(two)["HPC/series/c.html"] == ["The series"]
    assert nodes(two)["HPC/series/index.html"] == ["The series"]
    assert graph(tmp_path, groups="directories", uncoloured=["math"])["groups"] == ["High-performance computing"]


def test_directory_groups_with_the_same_title_keep_their_paths(tmp_path):
    write(tmp_path, {
        "a/index.html": titled("Notes"),
        "b/index.html": titled("Notes"),
        "c/index.html": titled("Other"),
    })
    g = graph(tmp_path, groups="directories")
    assert {n["id"]: n["categories"] for n in g["nodes"]} == {
        "a/index.html": ["a"], "b/index.html": ["b"], "c/index.html": ["Other"]}


def test_directory_groups_replace_categories(tmp_path):
    write(tmp_path, {"a/x.html": page('<span class="quarto-category">Math</span>')})
    assert graph(tmp_path)["nodes"][0]["categories"] == ["Math"]
    assert graph(tmp_path, groups="directories")["nodes"][0]["categories"] == ["a"]


def test_excluded_pages_and_the_graph_page_are_not_nodes(tmp_path):
    write(tmp_path, {
        "a.html": page('<a href="graph.html">graph</a> <a href="b.html">b</a>'),
        "b.html": page(""),
        "404.html": page('<a href="a.html">home</a>'),
        "graph.html": page('<div class="paragraphic" data-src="graph.json"></div>'),
    })
    g = graph(tmp_path, exclude=["404.html"])
    assert [n["id"] for n in g["nodes"]] == ["a.html", "b.html"]
    assert edges(g) == {("a.html", "b.html"): 1}


def test_cli_exclude(tmp_path):
    write(tmp_path, {"a.html": page(""), "x/404.html": page("")})
    main(["build", str(tmp_path), "--preset", "quarto", "--exclude", "*404.html"])
    assert [n["id"] for n in json.loads((tmp_path / "graph.json").read_text())["nodes"]] == ["a.html"]


def test_unknown_groups_are_rejected(tmp_path):
    with pytest.raises(ValueError, match="groups"):
        Config(output_dir=tmp_path, groups="folders")


def test_quarto_project_merges_default_profiles(tmp_path):
    # As a site sharing ickc/quarto-template: its own settings in the `site`
    # profile, the first of a group, which Quarto activates by default.
    project = tmp_path / "src"
    write(project, {
        "_quarto.yml": "profile:\n  group:\n    - [site]\nproject:\n  type: website\n",
        "_quarto-site.yml": "project:\n  output-dir: docs\nwebsite:\n  site-url: https://example.org\n",
    })
    assert quarto_project(project) == {"output-dir": project / "docs", "site-url": "https://example.org"}

def test_output_is_deterministic(tmp_path):
    write(tmp_path, {"b.html": page('<a href="a.html">a</a>'), "a.html": page('<a href="b.html">b</a>')})
    assert graph(tmp_path) == graph(tmp_path)
    assert [n["id"] for n in graph(tmp_path)["nodes"]] == ["a.html", "b.html"]


def test_missing_index_is_reported(tmp_path):
    write(tmp_path, {"a.html": page("")})
    with pytest.raises(FileNotFoundError):
        graph(tmp_path, index="index.html")


def test_external_links_drop_the_fragment_and_skip_the_site_and_bibliography(tmp_path):
    body = ('<a href="https://Example.COM/x?q=1#sec">1</a> <a href="https://example.com/x?q=1">2</a>'
            '<a href="https://example.com/X">case of the path matters</a>'
            '<a href="https://blog.example.org/a.html">own site</a> <a href="mailto:a@b.c">mail</a>'
            '<div id="refs"><div class="csl-entry" id="ref-k">'
            '<a href="https://doi.org/10.1/k">doi</a></div></div>')
    write(tmp_path, {"a.html": page(body)})
    [node] = graph(tmp_path, site_url="https://blog.example.org")["nodes"]
    assert node["external"] == ["https://example.com/X", "https://example.com/x?q=1"]


def test_sources_join_a_citation_and_a_link_to_the_same_work(tmp_path):
    refs = ('<div id="refs"><div class="csl-entry" id="ref-naur1985">Naur. '
            '<a href="https://doi.org/10.1/naur">doi</a></div></div>')
    write(tmp_path, {
        "cites.html": page(refs),
        # Links the work its neighbour cites, and a page its other neighbour links.
        "links.html": page('<a href="https://doi.org/10.1/naur#p3">Naur</a>'
                           '<a href="https://example.com/essay#top">essay</a>'),
        "other.html": page('<a href="https://example.com/essay">essay</a>'),
    })
    nodes = {n["id"]: n for n in graph(tmp_path)["nodes"]}
    assert nodes["cites.html"]["sources"] == ["cite:naur1985"]
    assert nodes["links.html"]["sources"] == ["cite:naur1985", "url:https://example.com/essay"]
    assert nodes["other.html"]["sources"] == ["url:https://example.com/essay"]


def test_groups_are_categories_by_page_count_without_the_uncoloured(tmp_path):
    def cats(*names):
        return "".join(f'<div class="quarto-category">{n}</div>' for n in names)
    write(tmp_path, {
        "a.html": page(cats("Math", "Talk")),
        "b.html": page(cats("Math", "LLM", "Talk")),
        "c.html": page(cats("Ethics", "LLM", "Talk")),
        "d.html": page(cats("Agents")),
    })
    g = graph(tmp_path, uncoloured=["Talk"])
    # Most pages first, ties by name.
    assert g["groups"] == ["LLM", "Math", "Agents", "Ethics"]
    assert g["colours"] == 7


def test_palette_prefixes_stay_apart_and_match_the_css():
    from importlib.resources import files

    from paragraphic.palette import PALETTE, TABLEAU_20, css, greedy_order, prefix_min

    assert sorted(PALETTE) == sorted(TABLEAU_20) and PALETTE[0] == "#1f77b4"
    # Every prefix the slider is likely to stop at is at least as spread out
    # as Tableau 20's own order.
    for k in range(3, 13):
        assert prefix_min(PALETTE, k) >= prefix_min(list(TABLEAU_20), k)
    assert prefix_min(PALETTE, 12) > 12
    assert greedy_order(TABLEAU_20) == PALETTE
    assert css() in (files("paragraphic") / "viewer" / "paragraphic.css").read_text()


def test_quarto_breadcrumbs_are_not_links_but_the_title_block_is_read(tmp_path):
    crumbs = ('<header id="title-block-header"><nav class="quarto-page-breadcrumbs">'
              '<ol class="breadcrumb"><li class="breadcrumb-item"><a href="./index.html">Part</a></li>'
              '</ol></nav><h1 class="title">A</h1>'
              '<div class="abstract"><a href="b.html">companion</a></div></header>')
    write(tmp_path, {
        "part/index.html": page(""),
        "part/a.html": page(crumbs),
        "part/b.html": page(""),
    })
    g = graph(tmp_path)
    assert edges(g) == {("part/a.html", "part/b.html"): 1}
    assert {n["id"]: n["title"] for n in g["nodes"]}["part/a.html"] == "A"


def test_ignore_is_a_selector(tmp_path):
    write(tmp_path, {
        "a.html": page('<aside class="see"><a href="b.html">b</a></aside><a href="c.html">c</a>'),
        "b.html": page(""),
        "c.html": page(""),
    })
    selectors = replace(PRESETS["quarto"], ignore=".see")
    g = build_graph(Config(output_dir=tmp_path, selectors=selectors))
    assert edges(g) == {("a.html", "c.html"): 1}


def test_links_to_a_shared_bibliography_are_citations(tmp_path):
    bibliography = ('<div id="refs"><div class="csl-entry" id="ref-naur1985">Naur. '
                    '<a href="https://doi.org/10.1/naur">doi</a></div>'
                    '<div class="csl-entry" id="ref-knuth1984">Knuth</div></div>')
    write(tmp_path, {
        "references.html": page(bibliography),
        "a.html": page('<a href="references.html#ref-naur1985">Naur</a>'
                       '<a href="./references.html#ref-knuth1984">Knuth</a>'),
        "b/c.html": page('<a href="../references.html#ref-naur1985">Naur</a>'
                         # Not a citation: another site's anchor.
                         '<a href="https://example.org/x.html#ref-other">x</a>'),
        # Links the work references.html lists for naur1985.
        "d.html": page('<a href="https://doi.org/10.1/naur">Naur</a>'),
    })
    nodes = {n["id"]: n for n in graph(tmp_path, exclude=["references.html"])["nodes"]}
    assert nodes["a.html"]["citations"] == ["knuth1984", "naur1985"]
    assert nodes["b/c.html"]["citations"] == ["naur1985"]
    assert nodes["b/c.html"]["sources"] == ["cite:naur1985", "url:https://example.org/x.html"]
    assert nodes["d.html"]["sources"] == ["cite:naur1985"]
    # The bibliography, a node unless excluded, is still linked.
    assert edges(graph(tmp_path)) == {("a.html", "references.html"): 2,
                                      ("b/c.html", "references.html"): 1}
    assert edges(graph(tmp_path, exclude=["references.html"])) == {}


def test_citation_links_on_the_page_add_nothing_to_its_bibliography(tmp_path):
    write(tmp_path, {"a.html": page(
        '<a href="#ref-naur1985">Naur</a>'
        '<div id="refs"><div class="csl-entry" id="ref-naur1985">Naur</div></div>')})
    [node] = graph(tmp_path)["nodes"]
    assert node["citations"] == ["naur1985"]


def test_only_a_bibliography_a_node_cites_from_names_its_works(tmp_path):
    entry = ('<div id="refs"><div class="csl-entry" id="ref-draft">Draft. '
             '<a href="https://doi.org/10.1/draft">doi</a></div></div>')
    write(tmp_path, {
        "draft.html": page(entry),
        "a.html": page('<a href="https://doi.org/10.1/draft">x</a>'),
    })
    nodes = {n["id"]: n for n in graph(tmp_path, exclude=["draft.html"])["nodes"]}
    assert nodes["a.html"]["sources"] == ["url:https://doi.org/10.1/draft"]
