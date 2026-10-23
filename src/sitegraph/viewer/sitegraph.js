// sitegraph, https://github.com/ickc/sitegraph
// SPDX-License-Identifier: AGPL-3.0-or-later
// sitegraph viewer: every `.sitegraph[data-src]` on the page becomes a
// force-directed graph of the graph.json it names. Needs d3 v7 as `d3`.
// `window.sitegraph.mount(root, options)` does the same for a root made by
// script, as sitegraph-local.js does for its enlarged view; options are
// `src` (graph.json), `focus` (a node id to centre on), `depth` (how many
// links out from it to show, Infinity for all), `sources` (start with the
// shared-source edges on) and `list` (false: no list view). On the page
// itself, `#post=<id>` in the URL focuses that post.
// See sitegraph/README.md for the data and the options.
(function () {
  "use strict";

  const SLOTS = 18; // colours in sitegraph.css
  const MAX_SLICES = 3; // a dot shows at most this many of its categories
  const LABEL_SIZE = 13; // px on screen, whatever the zoom
  const LINE_CHARS = 28; // a label wraps onto a second line, then is cut
  const STORE = "sitegraph:colours";

  function el(tag, attrs, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === "on") for (const [ev, fn] of Object.entries(v)) node.addEventListener(ev, fn);
      else if (v !== false && v != null) node.setAttribute(k, v === true ? "" : v);
    }
    for (const c of children) if (c != null) node.append(c);
    return node;
  }

  function pairKey(a, b) {
    return a < b ? a + "\u0000" + b : b + "\u0000" + a;
  }

  // A title as at most two lines, broken between words.
  function wrap(title) {
    const lines = [""];
    for (const word of title.split(/\s+/)) {
      const last = lines.length - 1;
      if (!lines[last] || (lines[last] + " " + word).length <= LINE_CHARS) {
        lines[last] = lines[last] ? lines[last] + " " + word : word;
      } else if (lines.length < 2) {
        lines.push(word);
      } else {
        lines[last] += " " + word;
      }
    }
    if (lines.length === 2 && lines[1].length > LINE_CHARS) {
      lines[1] = lines[1].slice(0, LINE_CHARS - 1).trimEnd() + "…";
    }
    return lines;
  }

  function stored(fallback) {
    try {
      const v = window.localStorage.getItem(STORE);
      return v === null ? fallback : Number(v);
    } catch (e) {
      return fallback;
    }
  }

  function store(v) {
    try { window.localStorage.setItem(STORE, String(v)); } catch (e) { /* private mode */ }
  }

  async function init(root, opts = {}) {
    const src = new URL(opts.src || root.dataset.src, document.baseURI);
    let data;
    try {
      const res = await fetch(src);
      if (!res.ok) throw new Error(res.status + " " + res.statusText);
      data = await res.json();
    } catch (err) {
      root.append(el("p", { class: "sitegraph-error" }, "Could not load the graph: " + err.message));
      return;
    }

    // --- the data --------------------------------------------------------
    const posts = data.nodes.map((n) => ({ ...n, kind: "post", url: new URL(n.id, src).href }));
    const byId = new Map(posts.map((p) => [p.id, p]));
    const out = new Map(posts.map((p) => [p.id, []]));
    const into = new Map(posts.map((p) => [p.id, []]));
    for (const l of data.links) {
      out.get(l.source).push(byId.get(l.target));
      into.get(l.target).push(byId.get(l.source));
    }
    for (const p of posts) p.degree = new Set([...out.get(p.id), ...into.get(p.id)]).size;

    // Undirected, one edge per pair.
    const linkPairs = new Map();
    for (const l of data.links) {
      const k = pairKey(l.source, l.target);
      if (!linkPairs.has(k)) linkPairs.set(k, { a: l.source, b: l.target });
    }
    // Posts that cite or link the same source, but do not link each other.
    // A source is `cite:<key>` or `url:<URL>` (see sitegraph/README.md).
    const sourceName = (s) => s.startsWith("cite:") ? s.slice(5)
      : s.slice(4).replace(/^https?:\/\//, "");
    const sourcePairs = [];
    const sharing = new Map(posts.map((p) => [p.id, []]));
    for (let i = 0; i < posts.length; i++) {
      for (let j = i + 1; j < posts.length; j++) {
        const shared = posts[i].sources.filter((c) => posts[j].sources.includes(c));
        if (shared.length && !linkPairs.has(pairKey(posts[i].id, posts[j].id))) {
          sourcePairs.push({ a: posts[i].id, b: posts[j].id, shared });
          sharing.get(posts[i].id).push(posts[j]);
          sharing.get(posts[j].id).push(posts[i]);
        }
      }
    }
    const categories = [...new Set(posts.flatMap((p) => p.categories))].sort();
    // data.groups is every colourable category, most posts first. A
    // category's colour is its rank, so turning more on never repaints one.
    const maxColours = Math.min(SLOTS, data.groups.length);
    const clampColours = (v) => Math.max(0, Math.min(maxColours, Math.round(v) || 0));
    const rank = new Map(data.groups.slice(0, SLOTS).map((g, i) => [g, i + 1]));

    // --- the page --------------------------------------------------------
    const fromHash = new URLSearchParams(location.hash.slice(1)).get("post");
    const focusId = byId.has(opts.focus) ? opts.focus : byId.has(fromHash) ? fromHash : null;
    const state = {
      depth: focusId && opts.depth != null ? opts.depth : Infinity,
      sources: !!opts.sources, categories: false, orphans: true,
      focus: null, query: "", hovered: null,
      colours: clampColours(stored(data.colours ?? 7)),
    };
    const search = el("input", {
      type: "search", class: "sitegraph-search", placeholder: "Find a post",
      "aria-label": "Find a post by its title",
      on: {
        input: (e) => { state.query = e.target.value.trim().toLowerCase(); applyHighlight(); },
        keydown: (e) => {
          if (e.key === "Enter") { e.preventDefault(); zoomTo(matches()); }
          if (e.key === "Escape") { e.target.value = ""; state.query = ""; applyHighlight(); }
        },
      },
    });
    const count = el("output", { class: "sitegraph-colour-count" }, String(state.colours));
    const slider = el("input", {
      type: "range", min: 0, max: maxColours, step: 1, value: state.colours,
      "aria-label": "Number of categories with a colour",
      on: {
        input: (e) => {
          state.colours = clampColours(e.target.value);
          count.value = String(state.colours);
          store(state.colours);
          colourise();
        },
      },
    });
    const legend = el("div", { class: "sitegraph-legend", role: "group", "aria-label": "Categories" });
    // With a focus: how far out from it to show.
    const depths = el("div", { class: "sitegraph-depth", role: "group", "aria-label": "Links out from this post" },
      "Depth ", ...[[1, "1"], [2, "2"], [Infinity, "All"]].map(([d, label]) => el("button", {
        type: "button", "aria-pressed": String(state.depth === d),
        on: {
          click: (e) => {
            state.depth = d;
            for (const b of depths.querySelectorAll("button")) b.setAttribute("aria-pressed", String(b === e.target));
            refit = true;
            draw();
          },
        },
      }, label)));
    const toggle = (key, label) => el("label", { class: "sitegraph-toggle" },
      el("input", {
        type: "checkbox", checked: state[key],
        on: { change: (e) => { state[key] = e.target.checked; draw(); } },
      }), " " + label);
    const controls = el("div", { class: "sitegraph-controls" },
      el("div", { class: "sitegraph-row" }, search, focusId ? depths : null,
        el("label", { class: "sitegraph-slider" }, "Colours ", slider, " ", count),
        el("div", { class: "sitegraph-toggles" },
          toggle("sources", "Shared sources"),
          toggle("categories", "Categories as nodes"),
          toggle("orphans", "Unlinked posts"))),
      legend);
    const tooltip = el("div", { class: "sitegraph-tooltip", role: "status", hidden: true });
    const stage = el("div", { class: "sitegraph-stage" }, tooltip);
    const list = el("details", { class: "sitegraph-list" }, el("summary", {}, "The graph as a list"));
    root.append(controls, stage);
    if (opts.list !== false) root.append(list);

    // The list view: every post with its links out and in.
    const titled = [...posts].sort((a, b) => a.title.localeCompare(b.title));
    const ul = el("ul");
    const linkTo = (p) => el("a", { href: p.url }, p.title);
    const joined = (ps) => ps.flatMap((p, i) => (i ? [", ", linkTo(p)] : [linkTo(p)]));
    for (const p of titled) {
      const o = out.get(p.id), i = into.get(p.id), sh = sharing.get(p.id);
      ul.append(el("li", {}, linkTo(p),
        o.length ? el("div", {}, "Links to: ", ...joined(o)) : null,
        i.length ? el("div", {}, "Linked from: ", ...joined(i)) : null,
        !o.length && !i.length ? el("div", {}, "No links in or out.") : null,
        sh.length ? el("div", {}, "Shares sources with: ", ...joined(sh)) : null));
    }
    list.append(ul);

    // --- the graph -------------------------------------------------------
    const svg = d3.select(stage).append("svg").attr("class", "sitegraph-svg");
    const view = svg.append("g");
    const gEdges = view.append("g").attr("class", "sitegraph-edges");
    const gNodes = view.append("g").attr("class", "sitegraph-nodes");
    let width = 0, height = 0, fitted = false, refit = false;
    let transform = d3.zoomIdentity;
    const zoom = d3.zoom().scaleExtent([0.2, 6]).on("zoom", (e) => {
      transform = e.transform;
      view.attr("transform", transform);
      scaleLabels();
      schedule();
    });
    svg.call(zoom).on("dblclick.zoom", null);

    const radius = (n) => (n.kind === "post" ? 5 + 2.2 * Math.sqrt(n.degree) : 5);
    const arc = d3.arc().innerRadius(0);
    const pie = d3.pie().value(1).sort(null);
    let simulation = null, nodes = [], edges = [];

    // The posts within state.depth links of the focus, counting shared
    // sources as links when they are shown.
    function reach() {
      if (!focusId || state.depth === Infinity) return null;
      const next = new Map(posts.map((p) => [p.id, new Set()]));
      const join = (a, b) => { next.get(a).add(b); next.get(b).add(a); };
      for (const { a, b } of linkPairs.values()) join(a, b);
      if (state.sources) for (const c of sourcePairs) join(c.a, c.b);
      const seen = new Set([focusId]);
      let frontier = [focusId];
      for (let d = 0; d < state.depth; d++) {
        frontier = frontier.flatMap((id) => [...next.get(id)].filter((n) => !seen.has(n) && seen.add(n)));
      }
      return seen;
    }

    function graph() {
      const within = reach();
      const shown = posts.filter((p) => (within ? within.has(p.id)
        : state.orphans || p.degree > 0 || p.id === focusId));
      const ids = new Set(shown.map((p) => p.id));
      const ns = [...shown];
      const es = [];
      for (const { a, b } of linkPairs.values()) {
        if (ids.has(a) && ids.has(b)) es.push({ source: a, target: b, kind: "link" });
      }
      if (state.sources) {
        for (const c of sourcePairs) {
          if (ids.has(c.a) && ids.has(c.b)) {
            es.push({ source: c.a, target: c.b, kind: "source", shared: c.shared });
          }
        }
      }
      if (state.categories) {
        for (const name of categories) {
          const members = shown.filter((p) => p.categories.includes(name));
          if (!members.length) continue;
          const id = "category:" + name;
          ns.push({ id, title: name, kind: "category", name, degree: members.length });
          for (const p of members) es.push({ source: p.id, target: id, kind: "category" });
        }
      }
      return { ns, es };
    }

    function draw() {
      const previous = new Map(nodes.map((n) => [n.id, n]));
      const { ns, es } = graph();
      nodes = ns.map((n) => {
        const old = previous.get(n.id);
        return old ? Object.assign(n, { x: old.x, y: old.y, vx: 0, vy: 0 }) : n;
      });
      edges = es;

      if (simulation) simulation.stop();
      resize();
      // Pull harder along the frame's short side, so the layout takes its
      // shape: tall on a phone, wide on a desktop.
      const aspect = height / width;
      simulation = d3.forceSimulation(nodes)
        .force("link", d3.forceLink(edges).id((n) => n.id)
          .distance((e) => (e.kind === "link" ? 85 : 100))
          .strength((e) => (e.kind === "link" ? 0.35 : e.kind === "source" ? 0.06 : 0.12)))
        // Repulsion reaches only so far, and a post with no links is pulled
        // in harder, so the few unlinked posts do not drift to the edge and
        // shrink everything else when the graph is fitted to the frame.
        .force("charge", d3.forceManyBody().strength(-520).distanceMax(320))
        .force("collide", d3.forceCollide((n) => radius(n) + 10))
        .force("x", d3.forceX().strength((n) => (n.degree ? 0.04 : 0.12) * Math.max(1, aspect) ** 2))
        .force("y", d3.forceY().strength((n) => (n.degree ? 0.04 : 0.12) * Math.max(1, 1 / aspect) ** 2))
        .on("tick", () => { ticked(); schedule(); })
        .stop();
      // Lay out before the first paint, so the page does not open on a
      // writhing graph; dragging reheats it.
      simulation.tick(fitted ? 120 : 300);

      const edge = gEdges.selectAll("line").data(edges, (e) => e.kind + pairKey(
        e.source.id, e.target.id));
      edge.exit().remove();
      edge.enter().append("line").attr("class", (e) => "sitegraph-edge sitegraph-edge-" + e.kind)
        .filter((e) => e.kind === "source").append("title")
        .text((e) => "Both cite or link: " + e.shared.map(sourceName).join(", "));

      const node = gNodes.selectAll("g.sitegraph-node").data(nodes, (n) => n.id);
      node.exit().remove();
      const added = node.enter().append("g")
        .attr("class", (n) => "sitegraph-node sitegraph-node-" + n.kind)
        .attr("tabindex", 0)
        .attr("role", (n) => (n.kind === "post" ? "link" : "button"))
        .attr("aria-label", (n) => (n.kind === "post" ? n.title : "Category: " + n.title))
        .on("pointerenter focus", (e, n) => hover(n, e))
        .on("pointermove", (e) => placeTooltip(e))
        .on("pointerleave blur", () => hover(null))
        .on("click", (e, n) => activate(n))
        .on("keydown", (e, n) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); activate(n); } })
        .call(d3.drag()
          .on("start", (e, n) => { if (!e.active) simulation.alphaTarget(0.25).restart(); n.fx = n.x; n.fy = n.y; })
          .on("drag", (e, n) => { n.fx = e.x; n.fy = e.y; })
          .on("end", (e, n) => { if (!e.active) simulation.alphaTarget(0); n.fx = null; n.fy = null; }));
      added.classed("sitegraph-node-focus", (n) => n.id === focusId);
      added.append("g").attr("class", "sitegraph-mark");
      added.filter((n) => n.kind === "category").select(".sitegraph-mark").append("rect")
        .attr("x", -5).attr("y", -5).attr("width", 10).attr("height", 10).attr("rx", 2)
        .attr("class", "sitegraph-category-mark");
      const text = added.append("text").attr("class", "sitegraph-label").attr("text-anchor", "middle");
      text.each(function (n) {
        const t = d3.select(this);
        wrap(n.title).forEach((line, i) => {
          t.append("tspan").attr("x", 0).attr("dy", i ? "1.15em" : 0).text(line);
        });
      });
      text.append("title").text((n) => n.title);

      colourise();
      scaleLabels();
      ticked();
      if (!fitted || refit) {
        // A focus on the whole graph starts zoomed to its neighbourhood.
        const around = focusId && state.depth === Infinity
          ? nodes.filter((n) => n.id === focusId || out.get(focusId).includes(n) || into.get(focusId).includes(n))
          : nodes;
        svg.call(zoom.transform, fit(around, 1.5));
        fitted = true;
        refit = false;
      }
      applyHighlight();
      simulation.alpha(0.05).restart();
    }

    // The dots' colours and the legend, for the first state.colours groups.
    function colourise() {
      const slot = (c) => { const r = rank.get(c); return r && r <= state.colours ? r : 0; };
      for (const p of posts) {
        const own = p.categories.filter(slot).sort((a, b) => slot(a) - slot(b)).slice(0, MAX_SLICES);
        p.colours = own.length ? own.map(slot) : ["other"];
      }
      gNodes.selectAll("g.sitegraph-node-post").each(function (n) {
        const g = d3.select(this).select(".sitegraph-mark");
        g.selectAll("*").remove();
        const r = radius(n);
        if (n.colours.length === 1) {
          g.append("circle").attr("r", r).attr("class", "sitegraph-fill-" + n.colours[0]);
        } else {
          g.selectAll("path").data(pie(n.colours)).enter().append("path")
            .attr("d", (d) => arc.outerRadius(r)(d)).attr("class", (d) => "sitegraph-fill-" + d.data);
        }
        g.append("circle").attr("r", r).attr("class", "sitegraph-ring");
      });

      const swatch = (cls) => el("span", { class: "sitegraph-swatch " + cls, "aria-hidden": "true" });
      legend.replaceChildren(...data.groups.slice(0, state.colours).map((g) => el("button", {
        type: "button", class: "sitegraph-legend-item", "aria-pressed": String(state.focus === g),
        on: { click: () => { state.focus = state.focus === g ? null : g; colourise(); applyHighlight(); } },
      }, swatch("sitegraph-fill-" + rank.get(g)), g)));
      if (posts.some((p) => p.colours[0] === "other")) {
        legend.append(el("span", { class: "sitegraph-legend-item" }, swatch("sitegraph-fill-other"), "Other"));
      }
    }

    // Labels keep their size on screen as the graph is zoomed.
    function scaleLabels() {
      const k = transform.k;
      gNodes.selectAll("text.sitegraph-label")
        .attr("font-size", LABEL_SIZE / k)
        .attr("stroke-width", 3 / k)
        .attr("y", (n) => radius(n) + LABEL_SIZE / k);
    }

    function ticked() {
      gEdges.selectAll("line")
        .attr("x1", (e) => e.source.x).attr("y1", (e) => e.source.y)
        .attr("x2", (e) => e.target.x).attr("y2", (e) => e.target.y);
      gNodes.selectAll("g.sitegraph-node").attr("transform", (n) => `translate(${n.x},${n.y})`);
    }

    function resize() {
      width = stage.clientWidth;
      height = stage.clientHeight;
      svg.attr("viewBox", [-width / 2, -height / 2, width, height]);
    }

    // Zoom to show a set of nodes, no closer than maxK.
    function fit(set, maxK) {
      if (!set.length) return;
      const xs = set.map((n) => n.x), ys = set.map((n) => n.y);
      // Room for a label either side of the outermost dots, in screen pixels.
      const padX = Math.min(130, width / 10), padY = 50;
      const w = Math.max(...xs) - Math.min(...xs) || 1;
      const h = Math.max(...ys) - Math.min(...ys) || 1;
      const k = Math.min(maxK, (width - 2 * padX) / w, (height - 2 * padY) / h);
      const cx = (Math.max(...xs) + Math.min(...xs)) / 2;
      const cy = (Math.max(...ys) + Math.min(...ys)) / 2;
      return d3.zoomIdentity.scale(k).translate(-cx, -cy);
    }

    function zoomTo(set) {
      const t = fit(set, 2);
      if (t) svg.transition().duration(400).call(zoom.transform, t);
    }

    const matches = () => (state.query
      ? nodes.filter((n) => n.title.toLowerCase().includes(state.query)) : []);

    // What is picked out, most specific first: the hovered node and its
    // neighbours, the posts matching the search, or a category's posts.
    // Everything else is dimmed.
    // `first` are labelled before the rest; `forced` are labelled even over
    // another label: only ever one node, the hovered one or a lone match.
    let first = new Set(), forced = new Set(), near = null;
    function applyHighlight() {
      first = new Set();
      forced = new Set(focusId && byId.has(focusId) && nodes.some((n) => n.id === focusId) ? [focusId] : []);
      near = null;
      if (state.hovered) {
        const n = state.hovered;
        near = new Set([n.id]);
        forced = new Set([n.id]);
        for (const e of edges) {
          if (e.source.id === n.id) near.add(e.target.id);
          if (e.target.id === n.id) near.add(e.source.id);
        }
      } else if (state.query) {
        near = new Set(matches().map((n) => n.id));
        first = near;
        forced = near.size === 1 ? near : new Set();
      } else if (state.focus) {
        near = new Set(nodes.filter((n) =>
          (n.kind === "post" && n.categories.includes(state.focus)) || n.id === "category:" + state.focus)
          .map((n) => n.id));
      }
      svg.classed("sitegraph-focusing", !!near);
      search.classList.toggle("sitegraph-no-match", !!state.query && !near.size);
      gNodes.selectAll("g.sitegraph-node").classed("sitegraph-near", (n) => !!near && near.has(n.id));
      gEdges.selectAll("line").classed("sitegraph-near",
        (e) => !!near && near.has(e.source.id) && near.has(e.target.id));
      placeLabels();
    }

    // Label as many nodes as fit without overlapping: the picked-out ones
    // first, then the best connected. Zooming in makes room for more.
    const sizes = new Map();
    function placeLabels() {
      const k = transform.k;
      const screen = (n) => {
        const [x, y] = transform.apply([n.x, n.y]);
        return [x + width / 2, y + height / 2];
      };
      const size = (n, textEl) => {
        if (!sizes.has(n.id)) {
          const b = textEl.getBBox();
          sizes.set(n.id, [b.width * k, b.height * k]);
        }
        return sizes.get(n.id);
      };
      const order = nodes.filter((n) => !near || near.has(n.id)).sort((a, b) =>
        (forced.has(b.id) - forced.has(a.id)) || (first.has(b.id) - first.has(a.id))
        || ((b.kind === "category") - (a.kind === "category"))
        || (b.degree - a.degree) || a.title.localeCompare(b.title));
      // Labels avoid each other; where one crosses a dot, its halo keeps it
      // readable.
      const taken = [];
      const overlaps = (b) => taken.some((t) => b[0] < t[2] && b[2] > t[0] && b[1] < t[3] && b[3] > t[1]);
      const shown = new Set();
      const texts = new Map();
      gNodes.selectAll("g.sitegraph-node").each(function (n) { texts.set(n.id, this.querySelector("text")); });
      for (const n of order) {
        const [x, y] = screen(n);
        const [w, h] = size(n, texts.get(n.id));
        const top = y + radius(n) * k + 2;
        const box = [x - w / 2 - 2, top, x + w / 2 + 2, top + h];
        const inside = box[0] >= 0 && box[2] <= width && box[1] >= 0 && box[3] <= height;
        if (forced.has(n.id) || (inside && !overlaps(box))) {
          shown.add(n.id);
          taken.push(box);
        }
      }
      gNodes.selectAll("g.sitegraph-node").classed("sitegraph-labelled", (n) => shown.has(n.id));
    }

    // Once per frame, however many ticks or zoom events ask.
    let pending = false;
    function schedule() {
      if (pending) return;
      pending = true;
      requestAnimationFrame(() => { pending = false; placeLabels(); });
    }

    function hover(n, event) {
      state.hovered = n;
      applyHighlight();
      if (!n) {
        tooltip.hidden = true;
        return;
      }
      if (n.kind === "post") {
        const o = out.get(n.id).length, i = into.get(n.id).length;
        tooltip.replaceChildren(el("div", {}, el("strong", {}, n.title),
          n.date ? el("div", {}, n.date) : null,
          n.categories.length ? el("div", {}, n.categories.join(" · ")) : null,
          el("div", {}, `Links to ${o} · linked from ${i}`),
          sharing.get(n.id).length
            ? el("div", {}, `Shares sources with ${sharing.get(n.id).length} more`) : null));
      } else {
        tooltip.replaceChildren(el("div", {}, el("strong", {}, n.title),
          el("div", {}, `${n.degree} post${n.degree === 1 ? "" : "s"}`)));
      }
      tooltip.hidden = false;
      placeTooltip(event, n);
    }

    function placeTooltip(event, n) {
      const box = stage.getBoundingClientRect();
      let x, y;
      if (event && event.clientX != null && event.type !== "focus") {
        x = event.clientX - box.left; y = event.clientY - box.top;
      } else if (n) {
        [x, y] = transform.apply([n.x, n.y]);
        x += width / 2; y += height / 2;
      } else return;
      const tw = tooltip.offsetWidth, th = tooltip.offsetHeight;
      tooltip.style.left = Math.min(Math.max(4, x + 14), width - tw - 4) + "px";
      tooltip.style.top = (y + 14 + th > height ? y - th - 10 : y + 14) + "px";
    }

    function activate(n) {
      if (n.kind === "post") {
        window.location.href = n.url;
      } else {
        state.focus = state.focus === n.name ? null : n.name;
        colourise();
        applyHighlight();
      }
    }

    new ResizeObserver(() => { if (fitted) { resize(); schedule(); } }).observe(stage);
    draw();
  }

  function start() {
    if (typeof d3 === "undefined") {
      console.error("sitegraph: d3 is not loaded");
      return;
    }
    document.querySelectorAll(".sitegraph[data-src]").forEach((root) => init(root));
  }
  window.sitegraph = { mount: init };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
