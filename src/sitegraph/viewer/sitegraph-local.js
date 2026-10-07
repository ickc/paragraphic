// sitegraph local graph: the page's own neighbourhood, in a collapsible card.
//
//   <link rel="stylesheet" href="/sitegraph.css">
//   <script src="/sitegraph-local.js" data-src="/graph.json" defer></script>
//
// on every page. The script finds this page among graph.json's nodes by its
// URL and does nothing on a page that is not one. The card goes first in the
// margin (`data-margin`, default Quarto's #quarto-margin-sidebar) while the
// margin is shown, and otherwise at the end of the article (`data-after`,
// default `main`). It draws the page and the pages it links, is linked from,
// or shares a source with, around it; lists them; and enlarges into the full
// viewer, centred on the page, in a dialog. Plain DOM and SVG: d3 and
// sitegraph.js are loaded only when the graph is enlarged.
(function () {
  "use strict";

  const script = document.currentScript;
  const SVG = "http://www.w3.org/2000/svg";
  const OPEN = "sitegraph:local-open";
  const COLOURS = "sitegraph:colours"; // the full viewer's slider
  const MAX_SLICES = 3;
  const SLOTS = 18;
  const D3 = script.dataset.d3 || "https://cdnjs.cloudflare.com/ajax/libs/d3/7.9.0/d3.min.js";

  function el(tag, attrs, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === "on") for (const [ev, fn] of Object.entries(v)) node.addEventListener(ev, fn);
      else if (v !== false && v != null) node.setAttribute(k, v === true ? "" : v);
    }
    for (const c of children) if (c != null) node.append(c);
    return node;
  }

  function svg(tag, attrs, ...children) {
    const node = document.createElementNS(SVG, tag);
    for (const [k, v] of Object.entries(attrs || {})) node.setAttribute(k, v);
    for (const c of children) if (c != null) node.append(c);
    return node;
  }

  function stored(key, fallback) {
    try {
      const v = window.localStorage.getItem(key);
      return v === null ? fallback : v;
    } catch (e) {
      return fallback;
    }
  }

  function store(key, v) {
    try { window.localStorage.setItem(key, String(v)); } catch (e) { /* private mode */ }
  }

  function load(tag, attrs) {
    return new Promise((resolve, reject) => {
      const node = el(tag, attrs);
      node.addEventListener("load", resolve);
      node.addEventListener("error", () => reject(new Error("could not load " + (attrs.src || attrs.href))));
      document.head.append(node);
    });
  }

  async function start() {
    const src = new URL(script.dataset.src || "graph.json", script.src);
    // This page's node id: its path below graph.json's directory.
    const base = new URL(".", src).pathname;
    let path = decodeURIComponent(location.pathname);
    if (path.endsWith("/")) path += "index.html";
    if (!path.startsWith(base)) return;
    const id = path.slice(base.length);

    let data;
    try {
      const res = await fetch(src);
      if (!res.ok) return;
      data = await res.json();
    } catch (e) {
      return;
    }
    const posts = new Map(data.nodes.map((n) => [n.id, { ...n, url: new URL(n.id, src).href }]));
    const self = posts.get(id);
    if (!self) return;

    const outgoing = [], backlinks = [];
    for (const l of data.links) {
      if (l.source === id && !outgoing.includes(posts.get(l.target))) outgoing.push(posts.get(l.target));
      if (l.target === id && !backlinks.includes(posts.get(l.source))) backlinks.push(posts.get(l.source));
    }
    const linked = new Set([...outgoing, ...backlinks]);
    const sharing = [...posts.values()].filter((p) => p !== self && !linked.has(p)
      && p.sources.some((s) => self.sources.includes(s)));
    if (!linked.size && !sharing.length) return;
    const byTitle = (a, b) => a.title.localeCompare(b.title);
    [outgoing, backlinks, sharing].forEach((ps) => ps.sort(byTitle));

    // Colours as the full viewer gives them, with the reader's slider.
    const count = Math.max(0, Math.min(SLOTS, Number(stored(COLOURS, data.colours ?? 7)) || 0));
    const rank = new Map(data.groups.slice(0, count).map((g, i) => [g, i + 1]));
    const colours = (p) => {
      const own = p.categories.filter((c) => rank.has(c)).sort((a, b) => rank.get(a) - rank.get(b))
        .slice(0, MAX_SLICES).map((c) => rank.get(c));
      return own.length ? own : ["other"];
    };

    // --- the picture: this page in the middle, its neighbours around it ---
    const W = 240, H = 200, R = 72;
    const both = backlinks.filter((p) => outgoing.includes(p));
    // Round the circle in reading order: linked both ways, links to, linked
    // from, then shared sources, so each kind sits together.
    const ring = [
      ...both,
      ...outgoing.filter((p) => !both.includes(p)),
      ...backlinks.filter((p) => !both.includes(p)),
      ...sharing,
    ];
    const dot = (p, x, y, r, extra) => {
      const g = svg("a", { href: p.url, class: "sitegraph-local-dot" + (extra || "") },
        svg("title", {}, p.title));
      const cs = colours(p);
      if (cs.length === 1) {
        g.append(svg("circle", { cx: x, cy: y, r, class: "sitegraph-fill-" + cs[0] }));
      } else {
        cs.forEach((c, i) => {
          const a0 = -Math.PI / 2 + (2 * Math.PI * i) / cs.length;
          const a1 = -Math.PI / 2 + (2 * Math.PI * (i + 1)) / cs.length;
          const large = a1 - a0 > Math.PI ? 1 : 0;
          g.append(svg("path", {
            class: "sitegraph-fill-" + c,
            d: `M${x},${y}L${x + r * Math.cos(a0)},${y + r * Math.sin(a0)}`
              + `A${r},${r} 0 ${large} 1 ${x + r * Math.cos(a1)},${y + r * Math.sin(a1)}Z`,
          }));
        });
      }
      g.append(svg("circle", { cx: x, cy: y, r, class: "sitegraph-ring" }));
      return g;
    };
    const picture = svg("svg", {
      viewBox: `${-W / 2} ${-H / 2} ${W} ${H}`, class: "sitegraph-local-svg", role: "img",
      "aria-label": `${self.title}: linked with ${linked.size} post${linked.size === 1 ? "" : "s"}`
        + (sharing.length ? `, shares sources with ${sharing.length} more` : ""),
    });
    const edges = svg("g", {}), dots = svg("g", {});
    picture.append(edges, dots);
    ring.forEach((p, i) => {
      const a = -Math.PI / 2 + (2 * Math.PI * i) / ring.length;
      const x = R * Math.cos(a), y = R * Math.sin(a);
      edges.append(svg("line", {
        x1: 0, y1: 0, x2: x, y2: y,
        class: "sitegraph-edge " + (sharing.includes(p) ? "sitegraph-edge-source" : "sitegraph-edge-link"),
      }));
      dots.append(dot(p, x, y, 7.5));
    });
    dots.append(dot(self, 0, 0, 11, " sitegraph-local-self"));

    // --- the lists ---
    const linkTo = (p) => el("a", { href: p.url }, p.title);
    // Lists start open at the end of the article and closed in the margin,
    // where they would push the table of contents down; place() sets them.
    const section = (label, ps, open) => (ps.length
      ? el("details", { class: "sitegraph-local-list", "data-open": open ? "" : null },
        el("summary", {}, `${label} (${ps.length})`),
        el("ul", {}, ...ps.map((p) => el("li", {}, linkTo(p)))))
      : null);

    // --- the card ---
    const enlarge = el("button", {
      type: "button", class: "sitegraph-local-enlarge", title: "Enlarge the graph",
      "aria-label": "Enlarge the graph", on: { click: () => openDialog(true) },
    }, svg("svg", { viewBox: "0 0 16 16", "aria-hidden": "true" },
      // Two arrows pointing out to opposite corners.
      svg("path", {
        d: "M9.5 2H14v4.5M14 2 9 7M6.5 14H2V9.5M2 14l5-5",
        fill: "none", stroke: "currentColor", "stroke-width": "1.6", "stroke-linecap": "round",
        "stroke-linejoin": "round",
      })));
    const card = el("details", { class: "sitegraph-local" },
      el("summary", {}, "Graph view"),
      el("div", { class: "sitegraph-local-body" },
        el("div", { class: "sitegraph-local-picture" }, picture, enlarge),
        section("Backlinks", backlinks, true),
        section("Outgoing links", outgoing, true),
        section("Shares sources with", sharing, false)));
    // Only the reader's own clicks are remembered, not where place() puts it.
    let placing = false;
    card.addEventListener("toggle", () => { if (!placing) store(OPEN, card.open ? 1 : 0); });

    // In the margin while it is shown, otherwise at the end of the article.
    const margin = document.querySelector(script.dataset.margin || "#quarto-margin-sidebar");
    const after = document.querySelector(script.dataset.after || "main");
    const place = () => {
      const inMargin = margin && getComputedStyle(margin).display !== "none" && margin.offsetWidth > 0;
      const target = inMargin ? margin : after;
      if (!target) return;
      if (card.parentNode !== target) {
        if (inMargin) target.prepend(card); else target.append(card);
      }
      card.classList.toggle("sitegraph-local-in-margin", inMargin);
      for (const list of card.querySelectorAll(".sitegraph-local-list")) {
        list.open = !inMargin && list.hasAttribute("data-open");
      }
      const pref = stored(OPEN, null);
      const open = pref === null ? inMargin : pref === "1";
      if (card.open !== open) {
        placing = true;
        card.open = open;
        // The toggle event fires after this task.
        setTimeout(() => { placing = false; });
      }
    };
    place();
    let wide = window.innerWidth;
    window.addEventListener("resize", () => {
      if (Math.abs(window.innerWidth - wide) > 50) { wide = window.innerWidth; place(); }
    });

    // --- enlarged: the full viewer, centred on this page, in a dialog ---
    let dialog = null, pushed = false;
    async function openDialog(push) {
      if (!dialog) {
        const root = el("div", { class: "sitegraph sitegraph-in-dialog" });
        dialog = el("dialog", { class: "sitegraph-dialog", "aria-label": "Graph of " + self.title },
          el("div", { class: "sitegraph-dialog-head" },
            el("a", { href: new URL(script.dataset.page || "graph.html", src).href + "#post=" + encodeURIComponent(id) },
              "Open the full graph"),
            el("button", {
              type: "button", class: "sitegraph-dialog-close", "aria-label": "Close",
              on: { click: () => closeDialog() },
            }, "×")),
          root);
        dialog.addEventListener("close", () => {
          if (pushed) { pushed = false; history.back(); }
          else if (location.hash === "#graph") history.replaceState(null, "", location.pathname + location.search);
        });
        document.body.append(dialog);
        dialog.showModal();
        try {
          if (typeof d3 === "undefined") await load("script", { src: D3 });
          if (!window.sitegraph) await load("script", { src: new URL("sitegraph.js", script.src).href });
          await window.sitegraph.mount(root, { src: src.href, focus: id, depth: 1, sources: true, list: false });
        } catch (err) {
          root.append(el("p", { class: "sitegraph-error" }, "Could not load the graph: " + err.message));
        }
      } else {
        dialog.showModal();
      }
      // Back closes the dialog rather than leaving the page.
      if (push) { history.pushState({ sitegraph: true }, "", "#graph"); pushed = true; }
    }
    function closeDialog() {
      if (dialog && dialog.open) dialog.close();
    }
    window.addEventListener("popstate", () => {
      if (dialog && dialog.open) { pushed = false; dialog.close(); }
    });
    if (location.hash === "#graph") openDialog(false);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
