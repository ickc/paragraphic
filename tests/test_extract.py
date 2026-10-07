import json
from pathlib import Path

import pytest

from sitegraph import PRESETS, Config, build_graph
from sitegraph.cli import main


def page(body, head="", title="T", main=True):
    content = f'<main id="quarto-document-content">{body}</main>' if main else body
    return (f"<html><head><title>{title}</title>{head}</head>"
            f'<body><nav><a href="/index.html">Home</a></nav>{content}</body></html>')


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
    (tmp_path / "sitegraph.toml").write_text('quarto-project = "src"\ncolours = 3\n')
    main(["build", "-c", str(tmp_path / "sitegraph.toml")])
    out = project / "docs"
    g = json.loads((out / "graph.json").read_text())
    assert g["colours"] == 3
    assert edges(g) == {("a.html", "b.html"): 1}
    assert (out / "sitegraph.js").is_file() and (out / "sitegraph.css").is_file()


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
