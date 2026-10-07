// sitegraph local graph: the page's own neighbourhood, in a collapsible card.
//
//   <link rel="stylesheet" href="/sitegraph.css">
//   <script src="/sitegraph-local.js" data-src="/graph.json" defer></script>
//
// on every page. The script finds this page among graph.json's nodes by its
// URL and does nothing on a page that is not one. The card goes first in the
// margin (`data-margin`, default Quarto's #quarto-margin-sidebar) while the
// margin is shown, and otherwise at the end of the article (`data-after`,
// default `main`). It lists the pages this one links, is linked from, or
// shares a source with, and draws them around it; pointing at a dot names it.
// The card is a fold, open at first, with each list a fold inside it, closed. The graph enlarges into the full
// viewer, centred on the page, in a dialog. Plain DOM and SVG: d3 and
// sitegraph.js are loaded only when the graph is enlarged.
(function () {
  "use strict";

  const script = document.currentScript;
  const SVG = "http://www.w3.org/2000/svg";
  const OPEN = "sitegraph:local-open:"; // + the fold's name
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
    const W = 240, H = 200, R = 72, DOT = 7.5, SELF = 11;
    const both = backlinks.filter((p) => outgoing.includes(p));
    const shared = (p) => p.sources.filter((s) => self.sources.includes(s));
    const relation = (p) => (both.includes(p) ? "↔ links both ways"
      : outgoing.includes(p) ? "→ linked from this page"
        : backlinks.includes(p) ? "← links to this page"
          : `shares ${shared(p).length} source${shared(p).length === 1 ? "" : "s"}`);
    // Round the circle in reading order: linked both ways, links to, linked
    // from, then shared sources, so each kind sits together.
    const ring = [
      ...both,
      ...outgoing.filter((p) => !both.includes(p)),
      ...backlinks.filter((p) => !both.includes(p)),
      ...sharing,
    ];
    // A pie of the page's colours, at (x, y), as SVG shapes.
    const pie = (p, x, y, r) => {
      const cs = colours(p);
      if (cs.length === 1) return [svg("circle", { cx: x, cy: y, r, class: "sitegraph-fill-" + cs[0] })];
      return cs.map((c, i) => {
        const a0 = -Math.PI / 2 + (2 * Math.PI * i) / cs.length;
        const a1 = -Math.PI / 2 + (2 * Math.PI * (i + 1)) / cs.length;
        const large = a1 - a0 > Math.PI ? 1 : 0;
        return svg("path", {
          class: "sitegraph-fill-" + c,
          d: `M${x},${y}L${x + r * Math.cos(a0)},${y + r * Math.sin(a0)}`
            + `A${r},${r} 0 ${large} 1 ${x + r * Math.cos(a1)},${y + r * Math.sin(a1)}Z`,
        });
      });
    };
    const swatch = (p) => svg("svg", { viewBox: "-6 -6 12 12", class: "sitegraph-local-swatch", "aria-hidden": "true" },
      ...pie(p, 0, 0, 5), svg("circle", { cx: 0, cy: 0, r: 5, class: "sitegraph-ring" }));
    const picture = svg("svg", {
      viewBox: `${-W / 2} ${-H / 2} ${W} ${H}`, class: "sitegraph-local-svg", role: "img",
      "aria-label": `${self.title}: linked with ${linked.size} post${linked.size === 1 ? "" : "s"}`
        + (sharing.length ? `, shares sources with ${sharing.length} more` : ""),
    });
    // An arrowhead, for which way a link goes.
    picture.append(svg("defs", {}, svg("marker", {
      id: "sitegraph-local-arrow", viewBox: "0 0 10 10", refX: 10, refY: 5,
      markerWidth: 5, markerHeight: 5, orient: "auto-start-reverse",
    }, svg("path", { d: "M0,0L10,5L0,10Z", class: "sitegraph-local-arrowhead" }))));
    const chords = svg("g", {}), edges = svg("g", {}), dots = svg("g", {});
    picture.append(chords, edges, dots);
    const at = new Map();
    ring.forEach((p, i) => {
      const a = -Math.PI / 2 + (2 * Math.PI * i) / ring.length;
      at.set(p, [R * Math.cos(a), R * Math.sin(a)]);
    });
    // Links between the neighbours themselves, faintly, so a cluster shows.
    const seen = new Set();
    for (const l of data.links) {
      const s = posts.get(l.source), t = posts.get(l.target);
      if (!at.has(s) || !at.has(t)) continue;
      const key = [l.source, l.target].sort().join("\n");
      if (seen.has(key)) continue;
      seen.add(key);
      const [x1, y1] = at.get(s), [x2, y2] = at.get(t);
      chords.append(svg("line", { x1, y1, x2, y2, class: "sitegraph-local-chord" }));
    }
    const items = new Map(); // post -> its <li>s in the lists
    const dotOf = new Map();
    const caption = el("p", { class: "sitegraph-local-caption", "aria-live": "polite" });
    const rest = `${linked.size} linked post${linked.size === 1 ? "" : "s"}`
      + (sharing.length ? `, ${sharing.length} sharing sources` : "") + ". Point at a dot to name it.";
    caption.textContent = rest;
    const show = (p, on) => {
      dotOf.get(p)?.classList.toggle("sitegraph-local-hot", on);
      for (const li of items.get(p) || []) li.classList.toggle("sitegraph-local-hot", on);
      caption.replaceChildren(...(on ? [el("strong", {}, p.title), " ", el("span", {}, relation(p))] : [rest]));
    };
    ring.forEach((p) => {
      const [x, y] = at.get(p);
      // From the edge of one dot to the edge of the other, so the arrows show.
      const d = Math.hypot(x, y), ux = x / d, uy = y / d;
      const line = svg("line", {
        x1: ux * (SELF + 2), y1: uy * (SELF + 2), x2: x - ux * (DOT + 2), y2: y - uy * (DOT + 2),
        class: "sitegraph-edge " + (sharing.includes(p) ? "sitegraph-edge-source" : "sitegraph-edge-link"),
      });
      if (outgoing.includes(p)) line.setAttribute("marker-end", "url(#sitegraph-local-arrow)");
      if (backlinks.includes(p)) line.setAttribute("marker-start", "url(#sitegraph-local-arrow)");
      edges.append(line);
      const g = svg("a", { href: p.url, class: "sitegraph-local-dot", "aria-label": p.title },
        ...pie(p, x, y, DOT), svg("circle", { cx: x, cy: y, r: DOT, class: "sitegraph-ring" }),
        // A larger target than the dot.
        svg("circle", { cx: x, cy: y, r: DOT + 4, class: "sitegraph-local-hit" }));
      for (const ev of ["mouseenter", "focus"]) g.addEventListener(ev, () => show(p, true));
      for (const ev of ["mouseleave", "blur"]) g.addEventListener(ev, () => show(p, false));
      dotOf.set(p, g);
      dots.append(g);
    });
    dots.append(svg("g", { class: "sitegraph-local-dot sitegraph-local-self" },
      svg("title", {}, self.title), ...pie(self, 0, 0, SELF),
      svg("circle", { cx: 0, cy: 0, r: SELF, class: "sitegraph-ring" })));

    // --- the card: the graph, open, with each list folded inside it ---
    const enlarge = el("button", {
      type: "button", class: "sitegraph-local-enlarge", title: "Enlarge the graph",
      "aria-label": "Enlarge the graph",
      on: { click: (e) => { e.preventDefault(); openDialog(true); } },
    }, svg("svg", { viewBox: "0 0 16 16", "aria-hidden": "true" },
      // Two arrows pointing out to opposite corners.
      svg("path", {
        d: "M9.5 2H14v4.5M14 2 9 7M6.5 14H2V9.5M2 14l5-5",
        fill: "none", stroke: "currentColor", "stroke-width": "1.6", "stroke-linecap": "round",
        "stroke-linejoin": "round",
      })));
    // Each fold is remembered in the reader's browser, by name.
    const fold = (name, open, summary, ...body) => {
      const pref = stored(OPEN + name, null);
      const node = el("details", { class: "sitegraph-local-fold sitegraph-local-" + name,
        open: pref === null ? open : pref === "1" },
      el("summary", {}, ...summary), ...body);
      node.addEventListener("toggle", () => store(OPEN + name, node.open ? 1 : 0));
      return node;
    };
    const list = (name, label, ps) => {
      if (!ps.length) return null;
      return fold(name, false, [`${label} (${ps.length})`],
        el("ul", {}, ...ps.map((p) => {
          const li = el("li", {
            on: { mouseenter: () => show(p, true), mouseleave: () => show(p, false) },
          }, swatch(p), el("a", { href: p.url }, p.title));
          items.set(p, [...(items.get(p) || []), li]);
          return li;
        })));
    };
    const card = el("div", { class: "sitegraph-local" },
      fold("graph", true, ["Graph view", enlarge],
        el("div", { class: "sitegraph-local-picture" }, picture), caption,
        list("backlinks", "Backlinks", backlinks),
        list("outgoing", "Outgoing links", outgoing),
        list("sharing", "Shares sources with", sharing)));

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
