"""Read a rendered static site and return the graph of how its pages link.

Works on the HTML output, not the sources, so it does not care which generator
wrote the site: links have been resolved, includes expanded and output names
decided by the time it runs. What it needs to know about the generator's
markup is a handful of CSS selectors (``Selectors``), with presets for
pandoc's own template and for Quarto.
"""

from __future__ import annotations

import posixpath
from collections import Counter
from dataclasses import dataclass, field, fields, replace
from pathlib import Path
from urllib.parse import unquote, urljoin, urlsplit

from bs4 import BeautifulSoup, Tag

# A base for resolving hrefs as URLs. Any host would do; it is stripped again.
_BASE = "http://site.invalid/"


@dataclass(frozen=True)
class Selectors:
    """Where the generator puts each thing in a page.

    A selector matching a ``<meta>`` element reads its ``content``, anything
    else its text. Empty means "not on this site".
    """

    # A page is a candidate node only if this matches, and only links inside
    # it count, so navigation, footers and listings do not link everything to
    # everything.
    content: str = "body"
    title: str = "title"
    date: str = 'meta[name="dcterms.date"]'
    # A <meta> value is split on commas.
    categories: str = 'meta[name="keywords"]'
    # Links to other renderings of the same document (its slides, its PDF):
    # a link to one of them is a link to this node.
    alternates: str = ""
    # Citations, as pandoc's citeproc writes them: the entry's id is
    # `ref-<citekey>`.
    citations: str = "#refs .csl-entry[id^=ref-]"
    # On the index page: the links that are the site's posts.
    index_links: str = "a"


PRESETS: dict[str, Selectors] = {
    # pandoc's default HTML template.
    "pandoc": Selectors(),
    "quarto": Selectors(
        content="main#quarto-document-content",
        title="h1.title",
        # As the site formats it (date-format): Quarto writes no machine date.
        date="#title-block-header .date",
        categories=".quarto-category",
        alternates=".quarto-alternate-formats a",
        index_links=".quarto-listing .listing-title a",
    ),
}


@dataclass
class Config:
    output_dir: Path
    selectors: Selectors = field(default_factory=Selectors)
    # Absolute links to this address are links into the site.
    site_url: str | None = None
    # The page (relative to output_dir) whose `index_links` are the nodes.
    # Without one, every page with `content` is a node.
    index: str | None = None
    # Categories that get a colour in the viewer, in order of priority.
    groups: list[str] = field(default_factory=list)


@dataclass
class Page:
    path: str
    title: str = ""
    date: str = ""
    categories: list[str] = field(default_factory=list)
    citations: list[str] = field(default_factory=list)
    alternates: list[str] = field(default_factory=list)
    links: list[str] = field(default_factory=list)
    has_content: bool = False


def _value(el: Tag) -> str:
    if el.name == "meta":
        return (el.get("content") or "").strip()
    return el.get_text(" ", strip=True)


def _values(soup: BeautifulSoup, selector: str) -> list[str]:
    if not selector:
        return []
    out: list[str] = []
    for el in soup.select(selector):
        value = _value(el)
        parts = value.split(",") if el.name == "meta" else [value]
        out.extend(p.strip() for p in parts if p.strip())
    return list(dict.fromkeys(out))


def _first(soup: BeautifulSoup, selector: str) -> str:
    values = _values(soup, selector) if selector else []
    return values[0] if values else ""


class Resolver:
    """Turn an href on a page into the output path it points at, or None."""

    def __init__(self, site_url: str | None):
        self.site_url = site_url.rstrip("/") + "/" if site_url else None

    def __call__(self, page: str, href: str) -> str | None:
        href = href.strip()
        if not href or href.startswith("#"):
            return None
        if self.site_url and href.startswith(self.site_url):
            href = "/" + href[len(self.site_url):]
        elif self.site_url and href == self.site_url.rstrip("/"):
            href = "/"
        url = urlsplit(urljoin(_BASE + page, href))
        if f"{url.scheme}://{url.netloc}/" != _BASE:
            return None
        path = posixpath.normpath(unquote(url.path)).lstrip("/")
        if path in ("", "."):
            path = "index.html"
        elif url.path.endswith("/"):
            path += "/index.html"
        return path


def read_page(path: str, html: str, selectors: Selectors, resolve: Resolver) -> Page:
    soup = BeautifulSoup(html, "html.parser")
    page = Page(path=path)
    content = soup.select_one(selectors.content) if selectors.content else soup
    page.has_content = content is not None
    page.title = _first(soup, selectors.title)
    page.date = _first(soup, selectors.date)
    page.categories = _values(soup, selectors.categories)
    if selectors.alternates:
        page.alternates = [
            t for a in soup.select(selectors.alternates)
            if (t := resolve(path, a.get("href", ""))) and t != path
        ]
    if content is not None:
        page.links = [t for a in content.select("a[href]") if (t := resolve(path, a["href"]))]
        if selectors.citations:
            page.citations = sorted({
                el["id"].removeprefix("ref-") for el in content.select(selectors.citations)
            })
    return page


def read_site(config: Config) -> dict[str, Page]:
    resolve = Resolver(config.site_url)
    pages = {}
    for file in sorted(config.output_dir.rglob("*.html")):
        rel = file.relative_to(config.output_dir).as_posix()
        pages[rel] = read_page(rel, file.read_text(encoding="utf-8", errors="replace"),
                               config.selectors, resolve)
    return pages


def build_graph(config: Config, pages: dict[str, Page] | None = None) -> dict:
    """The graph as a JSON-ready dict: nodes, directed links with counts, groups."""
    if pages is None:
        pages = read_site(config)
    resolve = Resolver(config.site_url)

    if config.index:
        index = config.output_dir / config.index
        if not index.is_file():
            raise FileNotFoundError(f"the index page {index} has not been rendered")
        html = index.read_text(encoding="utf-8")
        soup = BeautifulSoup(html, "html.parser")
        listed = [resolve(config.index, a.get("href", ""))
                  for a in soup.select(config.selectors.index_links)]
        ids = [p for p in dict.fromkeys(listed) if p in pages and pages[p].has_content]
    else:
        ids = [p for p, page in pages.items() if page.has_content]
    nodes = set(ids)

    # Every rendering of a node stands for the node. A page that is a node in
    # its own right keeps its identity.
    alias = {p: p for p in nodes}
    for p in sorted(nodes):
        for alt in pages[p].alternates:
            alias.setdefault(alt, p)

    counts: Counter[tuple[str, str]] = Counter()
    for p in sorted(nodes):
        for target in pages[p].links:
            q = alias.get(target)
            if q and q != p:
                counts[(p, q)] += 1

    return {
        "version": 1,
        "groups": list(config.groups),
        "nodes": [
            {
                "id": p,
                "title": pages[p].title or p,
                "date": pages[p].date,
                "categories": pages[p].categories,
                "citations": pages[p].citations,
            }
            for p in sorted(nodes)
        ],
        "links": [
            {"source": s, "target": t, "count": n} for (s, t), n in sorted(counts.items())
        ],
    }


def selectors_from(preset: str, overrides: dict[str, str]) -> Selectors:
    base = PRESETS[preset]
    known = {f.name for f in fields(Selectors)}
    unknown = set(overrides) - known
    if unknown:
        raise ValueError(f"unknown selectors: {', '.join(sorted(unknown))}")
    return replace(base, **overrides)
