# paragraphic

An Obsidian-style graph of how the pages of a static site link to each other. The name is PARA, the note-keeping
method, and parasite's `para`, made into a graph.

It reads the site **after** it is rendered, from its HTML, so it does not depend on the site generator: by then links
have been resolved, includes expanded and output names decided. A generator is described by a few CSS selectors, and
there are presets for pandoc's default template and for Quarto. It is a post-processing step, so switching generators
means changing the preset, not the tool.

```sh
pip install paragraphic             # or paragraphic[quarto], to read a Quarto project's _quarto.yml
paragraphic build path/to/rendered/site     # pandoc preset, every page is a node
paragraphic build -c paragraphic.toml       # settings from a file
```

In Quarto, it is a post-render script, which needs no settings file: the project and its output directory come from
the `QUARTO_PROJECT_DIR` and `QUARTO_PROJECT_OUTPUT_DIR` Quarto sets, and the site URL from the project's
`_quarto.yml` (with the `quarto` extra).

```yaml
project:
  post-render:
    - paragraphic build --preset quarto --groups directories
```

`build` writes `graph.json` into the site, with `paragraphic.js` and `paragraphic.css` beside it, and prints how many
pages have no links in or out (`-v` lists them).

## The graph

- **Nodes** are pages: those linked from the `index` page (`selectors.index_links`), or, without an index, every page
  that has a `selectors.content` element. A draft or an unlisted page is not on the index, so it is not a node.
- **Links** are the `<a href>`s inside a node's `content` element that resolve to another node, counted. Links in the
  navigation, footer and listings are outside it. Absolute links to `site-url` count as internal.
- **One document, several renderings.** A page lists its other renderings (the slides of a talk, its PDF) through
  `selectors.alternates`, and a link to any of them is a link to the page. The page itself stays the node.
- Each node carries its `title`, `date` and `categories`, and what it draws on:
  - `citations`: the keys of its bibliography entries (pandoc citeproc's `ref-<key>` ids);
  - `external`: its links off the site, without their `#fragment`, and otherwise exactly as written apart from the
    case of the scheme and host. Links inside the bibliography (`selectors.bibliography`) are left out, since the
    citations stand for them;
  - `sources`: the two together, as the hidden nodes two pages can share. A cited work is `cite:<key>`, and a link
    to one of the URLs in its bibliography entry, on any page, is the same work; any other external link is
    `url:<URL>`. So a page that links a paper inline and a page that cites it share a source.

  The viewer draws an edge between two pages that share a source but do not link each other.

```json
{"version": 1, "groups": ["Math", "LLM"], "colours": 7,
 "nodes": [{"id": "math/a.html", "title": "…", "date": "September 30th, 2026", "categories": ["Math"],
            "citations": ["naur1985"], "external": ["https://example.org/essay"],
            "sources": ["cite:naur1985", "url:https://example.org/essay"]}],
 "links": [{"source": "math/a.html", "target": "math/b.html", "count": 2}]}
```

The output is sorted and carries no timestamp, so the same site gives the same bytes.

## paragraphic.toml

All keys are optional. Paths are relative to the file.

```toml
preset = "quarto"            # or "pandoc" (the default)
quarto-project = "src"       # read output-dir and website.site-url from its _quarto.yml (and default profiles)
# output-dir = "_site"       # otherwise, the rendered site
# site-url = "https://example.org"   # $SITE_URL and --site-url override it
index = "index.html"         # the page whose links are the nodes
out = "graph.json"
groups = "categories"        # or "directories": what colours a page
level = 1                    # with "directories", how deep a group is
colours = 7                  # how many groups are coloured at first
uncoloured = ["Talk"]        # groups never coloured

[selectors]                  # override any of the preset's
content = "main"
```

Each key but `selectors`, `quarto-project` and `site-url` has a flag of the same name (`--uncoloured` once per group),
which takes precedence. Without a file, `output-dir` and `quarto-project` fall back to `$QUARTO_PROJECT_OUTPUT_DIR`
and `$QUARTO_PROJECT_DIR`; the preset never does, so it is always named.

**Groups.** A page is coloured by its categories, or, with `groups = "directories"`, for a site that has none, by the
directory it is in, cut to its first `level` parts: at level 1, `HPC/series/a.html` and `HPC/b.html` are both in
`HPC`; at level 2, the first is in `HPC/series`. A group is named by the title of its directory's `index.html`, or else
by its path, and a page at the top of the site is in none. The group takes the place of the page's categories in
`graph.json`, so the viewer is the same either way.

| Selector     | pandoc                                | quarto                               |
| ------------ | ------------------------------------- | ------------------------------------ |
| `content`    | `body`                                | `main#quarto-document-content`       |
| `title`      | `title`                               | `h1.title`                           |
| `date`       | `meta[name="dcterms.date"]`           | `#title-block-header .date`          |
| `categories` | `meta[name="keywords"]`               | `.quarto-category`                   |
| `alternates` | none                                  | `.quarto-alternate-formats a`        |
| `citations`  | `#refs .csl-entry[id^=ref-]`          | same                                 |
| `bibliography` | `#refs`                             | same                                 |
| `index_links`| `a`                                   | `.quarto-listing .listing-title a`   |

A selector that matches a `<meta>` reads its `content`, split on commas; anything else, its text.

## The viewer

```html
<link rel="stylesheet" href="paragraphic.css">
<div class="paragraphic" data-src="graph.json"></div>
<script src="https://cdnjs.cloudflare.com/ajax/libs/d3/7.9.0/d3.min.js"></script>
<script src="paragraphic.js"></script>
```

Every `.paragraphic[data-src]` on the page becomes a force-directed graph. A node's size is its number of links.

- **Colours.** `groups` in the graph is every category but the `uncoloured` ones, most pages first, and a category's
  colour is its place in that list, so it keeps its colour whatever else is turned on. A slider sets how many are
  coloured, from 0 to 18, starting at `colours` and remembered in the reader's browser. A page is drawn as a pie of
  up to three of its coloured categories, the most used first, and grey if it has none.
- **Labels.** Titles are wrapped onto two lines and placed most-linked first, skipping any that would overlap one
  already placed, so the graph shows as many as fit and more as it is zoomed in.
- **Finding a page.** Typing in the search box picks out the pages whose title matches; Enter zooms to them.
- Hovering a node shows it with its neighbours, clicking opens it, and nodes can be dragged and the graph zoomed. The
  legend picks out a category's pages. Three switches add edges between pages that share a source (hover one for what
  they share), categories as nodes of their own, and pages with no links.
- Below the graph, the same graph as a list of each page's links out and in, and the pages it shares sources with.

The colours are CSS custom properties, `--paragraphic-1` to `--paragraphic-18` and `--paragraphic-other`, the same in
both themes. They are Tableau 20 without its greys, ordered by `paragraphic/palette.py` so that wherever the slider stops,
the colours in use are as far apart as that many can be: each next colour is the one farthest, in OKLab, from all the
colours before it. `python -m paragraphic.palette` prints them, and a test checks the CSS matches. Dark mode follows Quarto's `body.quarto-dark`, `[data-theme="dark"]` on the root, or the system setting.

## The local graph

```html
<link rel="stylesheet" href="/paragraphic.css">
<script src="/paragraphic-local.js" data-src="/graph.json" defer></script>
```

on every page (in Quarto, a project-level `include-after-body`). The script finds the page among the graph's nodes by
its URL, and does nothing on a page that is not one. It adds a "Graph view" fold, open at first, with the lists folded
inside it, closed at first. Each fold is remembered in the reader's browser.

`data-src` (the graph) and `data-page` (the full graph page) are relative to the page, like an `href`. Without them,
`graph.json` is beside the script and `graph.html` beside the graph, and `paragraphic.js` is always beside the script.
So the paths above are the only ones that assume the site is at the root of its host. A site that is also served under
a path loads the two files relative to the page instead: in Quarto, whose pages carry their offset to the site root in `<meta name="quarto:offset">`, on `DOMContentLoaded`, so
after `quarto-nav.js` has rewritten the page's links (it throws on an SVG link, such as the card's dots, if it finds
one already there),

```html
<script>
  document.addEventListener("DOMContentLoaded", function () {
    const root = document.querySelector('meta[name="quarto:offset"]')?.content ?? "/";
    const css = document.createElement("link");
    css.rel = "stylesheet";
    css.href = root + "paragraphic.css";
    const js = document.createElement("script");
    js.src = root + "paragraphic-local.js";
    document.head.append(css, js);
  });
</script>
```

- The picture: the page with the pages it links, is linked from, or shares a source with (dashed) around it, in the
  same colours as the full graph. Arrows show which way a link goes, and faint lines the links between the neighbours
  themselves. Pointing at a dot names it under the picture, with how it is linked, and marks it in the lists; pointing
  at a list entry marks its dot. An enlarge button, in the fold's heading so it works while the fold is closed, opens
  the full viewer in a dialog, centred on the page, with a depth control (1, 2 or all links out) and a link to the
  full graph page at `#post=<id>`, which focuses the page there too.
- **Backlinks**, **Outgoing links** and **Shares sources with**, each entry with its dot's colours.

It goes first in the margin (`data-margin`, default Quarto's `#quarto-margin-sidebar`) while the margin is shown, and
otherwise at the end of the article (`data-after`, default `main`). It is plain DOM and SVG: d3 (`data-d3`, default
cdnjs) and `paragraphic.js` load only when the graph is enlarged, so a page pays for one `graph.json` fetch, which the
browser caches across pages.

## Tests

```sh
pytest paragraphic/tests
```

## License

Copyright (C) 2026 Kolen Cheung, under the [GNU Affero General Public License v3.0 or later](LICENSE.md). The
viewer's files are copied into every site that uses it, so a site serving them keeps their notice and points to this
repository for their source.
