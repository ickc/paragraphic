# sitegraph

An Obsidian-style graph of how the pages of a static site link to each other.

It reads the site **after** it is rendered, from its HTML, so it does not depend on the site generator: by then links
have been resolved, includes expanded and output names decided. A generator is described by a few CSS selectors, and
there are presets for pandoc's default template and for Quarto. It is a post-processing step, so switching generators
means changing the preset, not the tool.

```sh
sitegraph build path/to/rendered/site            # pandoc preset, every page is a node
sitegraph build -c sitegraph.toml                # settings from a file
```

`build` writes `graph.json` into the site, with `sitegraph.js` and `sitegraph.css` beside it, and prints how many pages
have no links in or out (`-v` lists them).

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

## sitegraph.toml

All keys are optional. Paths are relative to the file.

```toml
preset = "quarto"            # or "pandoc" (the default)
quarto-project = "src"       # read output-dir and website.site-url from its _quarto.yml
# output-dir = "_site"       # otherwise, the rendered site
# site-url = "https://example.org"   # $SITE_URL and --site-url override it
index = "index.html"         # the page whose links are the nodes
out = "graph.json"
colours = 7                  # how many categories are coloured at first
uncoloured = ["Talk"]        # categories never coloured

[selectors]                  # override any of the preset's
content = "main"
```

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
<link rel="stylesheet" href="sitegraph.css">
<div class="sitegraph" data-src="graph.json"></div>
<script src="https://cdnjs.cloudflare.com/ajax/libs/d3/7.9.0/d3.min.js"></script>
<script src="sitegraph.js"></script>
```

Every `.sitegraph[data-src]` on the page becomes a force-directed graph. A node's size is its number of links.

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

The colours are CSS custom properties, `--sitegraph-1` to `--sitegraph-18` and `--sitegraph-other`, the same in both
themes. They are Tableau 20 without its greys, ordered by `sitegraph/palette.py` so that wherever the slider stops,
the colours in use are as far apart as that many can be: each next colour is the one farthest, in OKLab, from all the
colours before it. `python -m sitegraph.palette` prints them, and a test checks the CSS matches. Dark mode follows Quarto's `body.quarto-dark`, `[data-theme="dark"]` on the root, or the system setting.

## Tests

```sh
pytest sitegraph/tests
```
