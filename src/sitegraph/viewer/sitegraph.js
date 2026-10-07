// sitegraph viewer: every `.sitegraph[data-src]` on the page becomes a
// force-directed graph of the graph.json it names. Needs d3 v7 as `d3`.
// See sitegraph/README.md for the data and the options.
(function () {
  "use strict";

  const SLOTS = 8;
  const LABEL_ZOOM = 2; // zoomed in this far, every post is labelled
  const LABELLED = 6; // the best-connected posts are labelled at any zoom
  const LABEL_SIZE = 13; // px on screen, whatever the zoom
  const LABEL_CHARS = 36;

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

  async function init(root) {
    const src = new URL(root.dataset.src, document.baseURI);
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
    const slot = new Map(data.groups.slice(0, SLOTS).map((g, i) => [g, i + 1]));
    const posts = data.nodes.map((n) => {
      const colours = n.categories.filter((c) => slot.has(c))
        .sort((a, b) => slot.get(a) - slot.get(b)).map((c) => slot.get(c));
      return {
        ...n, kind: "post", url: new URL(n.id, src).href,
        colours: colours.length ? colours : ["other"],
      };
    });
    const byId = new Map(posts.map((p) => [p.id, p]));
    const out = new Map(posts.map((p) => [p.id, []]));
    const into = new Map(posts.map((p) => [p.id, []]));
    for (const l of data.links) {
      out.get(l.source).push(byId.get(l.target));
      into.get(l.target).push(byId.get(l.source));
    }
    const neighbours = (p) => new Set([...out.get(p.id), ...into.get(p.id)]);
    for (const p of posts) p.degree = neighbours(p).size;

    // Undirected, one edge per pair.
    const linkPairs = new Map();
    for (const l of data.links) {
      const k = pairKey(l.source, l.target);
      if (!linkPairs.has(k)) linkPairs.set(k, { a: l.source, b: l.target });
    }
    const citePairs = [];
    for (let i = 0; i < posts.length; i++) {
      for (let j = i + 1; j < posts.length; j++) {
        const shared = posts[i].citations.filter((c) => posts[j].citations.includes(c));
        if (shared.length && !linkPairs.has(pairKey(posts[i].id, posts[j].id))) {
          citePairs.push({ a: posts[i].id, b: posts[j].id, shared: shared.length });
        }
      }
    }
    const categories = [...new Set(posts.flatMap((p) => p.categories))].sort();

    const labelled = new Set([...posts].sort((a, b) => b.degree - a.degree)
      .slice(0, LABELLED).map((p) => p.id));
    const short = (t) => (t.length > LABEL_CHARS ? t.slice(0, LABEL_CHARS - 1).trimEnd() + "…" : t);

    // --- the page --------------------------------------------------------
    const state = { citations: false, categories: false, orphans: true, focus: null };
    const legend = el("div", { class: "sitegraph-legend", role: "group", "aria-label": "Categories" });
    const toggle = (key, label) => el("label", { class: "sitegraph-toggle" },
      el("input", {
        type: "checkbox", checked: state[key],
        on: { change: (e) => { state[key] = e.target.checked; draw(); } },
      }), " " + label);
    const controls = el("div", { class: "sitegraph-controls" }, legend,
      el("div", { class: "sitegraph-toggles" },
        toggle("citations", "Shared citations"),
        toggle("categories", "Categories as nodes"),
        toggle("orphans", "Unlinked posts")));
    const tooltip = el("div", { class: "sitegraph-tooltip", role: "status", hidden: true });
    const stage = el("div", { class: "sitegraph-stage" }, tooltip);
    const list = el("details", { class: "sitegraph-list" }, el("summary", {}, "The graph as a list"));
    root.append(controls, stage, list);

    const swatch = (cls) => el("span", { class: "sitegraph-swatch " + cls, "aria-hidden": "true" });
    const legendItems = [...slot.keys()].map((g) => [g, "sitegraph-fill-" + slot.get(g)]);
    if (posts.some((p) => p.colours[0] === "other")) legendItems.push([null, "sitegraph-fill-other"]);
    for (const [g, cls] of legendItems) {
      legend.append(g === null
        ? el("span", { class: "sitegraph-legend-item" }, swatch(cls), "Other")
        : el("button", {
          type: "button", class: "sitegraph-legend-item", "aria-pressed": "false",
          on: { click: () => setFocus(state.focus === g ? null : g) },
        }, swatch(cls), g));
    }

    // The list view: every post with its links out and in.
    const titled = [...posts].sort((a, b) => a.title.localeCompare(b.title));
    const ul = el("ul");
    const linkTo = (p) => el("a", { href: p.url }, p.title);
    const joined = (ps) => ps.flatMap((p, i) => (i ? [", ", linkTo(p)] : [linkTo(p)]));
    for (const p of titled) {
      const o = out.get(p.id), i = into.get(p.id);
      ul.append(el("li", {}, linkTo(p),
        o.length ? el("div", {}, "Links to: ", ...joined(o)) : null,
        i.length ? el("div", {}, "Linked from: ", ...joined(i)) : null,
        !o.length && !i.length ? el("div", {}, "No links in or out.") : null));
    }
    list.append(ul);

    // --- the graph -------------------------------------------------------
    const svg = d3.select(stage).append("svg").attr("class", "sitegraph-svg");
    const view = svg.append("g");
    const gEdges = view.append("g").attr("class", "sitegraph-edges");
    const gNodes = view.append("g").attr("class", "sitegraph-nodes");
    let width = 0, height = 0, fitted = false;
    let transform = d3.zoomIdentity;
    const zoom = d3.zoom().scaleExtent([0.2, 6]).on("zoom", (e) => {
      transform = e.transform;
      view.attr("transform", transform);
      svg.classed("sitegraph-zoomed", transform.k >= LABEL_ZOOM);
      scaleLabels();
    });
    svg.call(zoom).on("dblclick.zoom", null);

    const radius = (n) => (n.kind === "post" ? 5 + 2.2 * Math.sqrt(n.degree) : 5);
    const arc = d3.arc().innerRadius(0);
    const pie = d3.pie().value(1).sort(null);
    let simulation = null, nodes = [], edges = [];

    function graph() {
      const shown = posts.filter((p) => state.orphans || p.degree > 0);
      const ids = new Set(shown.map((p) => p.id));
      const ns = [...shown];
      const es = [];
      for (const { a, b } of linkPairs.values()) es.push({ source: a, target: b, kind: "link" });
      if (state.citations) {
        for (const c of citePairs) {
          if (ids.has(c.a) && ids.has(c.b)) es.push({ source: c.a, target: c.b, kind: "cite" });
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
          .distance((e) => (e.kind === "link" ? 70 : 90))
          .strength((e) => (e.kind === "link" ? 0.4 : e.kind === "cite" ? 0.08 : 0.15)))
        .force("charge", d3.forceManyBody().strength(-340))
        .force("collide", d3.forceCollide((n) => radius(n) + 6))
        .force("x", d3.forceX().strength(0.06 * Math.max(1, aspect)))
        .force("y", d3.forceY().strength(0.06 * Math.max(1, 1 / aspect)))
        .on("tick", ticked)
        .stop();
      // Lay out before the first paint, so the page does not open on a
      // writhing graph; dragging reheats it.
      simulation.tick(fitted ? 120 : 300);

      const edge = gEdges.selectAll("line").data(edges, (e) => e.kind + pairKey(
        e.source.id, e.target.id));
      edge.exit().remove();
      edge.enter().append("line").attr("class", (e) => "sitegraph-edge sitegraph-edge-" + e.kind);

      const node = gNodes.selectAll("g.sitegraph-node").data(nodes, (n) => n.id);
      node.exit().remove();
      const added = node.enter().append("g")
        .attr("class", (n) => "sitegraph-node sitegraph-node-" + n.kind)
        .attr("tabindex", 0)
        .attr("role", (n) => (n.kind === "post" ? "link" : "button"))
        .attr("aria-label", (n) => (n.kind === "post" ? n.title : "Category: " + n.title))
        .on("pointerenter focus", (e, n) => hover(n, e))
        .on("pointermove", (e, n) => placeTooltip(e))
        .on("pointerleave blur", () => hover(null))
        .on("click", (e, n) => activate(n))
        .on("keydown", (e, n) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); activate(n); } })
        .call(d3.drag()
          .on("start", (e, n) => { if (!e.active) simulation.alphaTarget(0.25).restart(); n.fx = n.x; n.fy = n.y; })
          .on("drag", (e, n) => { n.fx = e.x; n.fy = e.y; })
          .on("end", (e, n) => { if (!e.active) simulation.alphaTarget(0); n.fx = null; n.fy = null; }));
      added.filter((n) => n.kind === "post").each(function (n) {
        const g = d3.select(this);
        const r = radius(n);
        if (n.colours.length === 1) {
          g.append("circle").attr("r", r).attr("class", "sitegraph-fill-" + n.colours[0]);
        } else {
          g.selectAll("path").data(pie(n.colours)).enter().append("path")
            .attr("d", (d) => arc.outerRadius(r)(d)).attr("class", (d) => "sitegraph-fill-" + d.data);
        }
        g.append("circle").attr("r", r).attr("class", "sitegraph-ring");
      });
      added.filter((n) => n.kind === "category").append("rect")
        .attr("x", -5).attr("y", -5).attr("width", 10).attr("height", 10).attr("rx", 2)
        .attr("class", "sitegraph-category-mark");
      added.append("text").attr("class", "sitegraph-label")
        .attr("text-anchor", "middle").text((n) => short(n.title))
        .append("title").text((n) => n.title);
      gNodes.selectAll("g.sitegraph-node")
        .classed("sitegraph-labelled", (n) => n.kind === "category" || labelled.has(n.id));
      scaleLabels();

      ticked();
      if (!fitted) { fit(); fitted = true; }
      setFocus(state.focus);
      simulation.alpha(0.05).restart();
    }

    // Labels keep their size on screen as the graph is zoomed.
    function scaleLabels() {
      const k = transform.k;
      gNodes.selectAll("text.sitegraph-label")
        .attr("font-size", LABEL_SIZE / k)
        .attr("stroke-width", 3 / k)
        .attr("dy", (n) => radius(n) + (LABEL_SIZE + 2) / k);
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

    function fit() {
      const xs = nodes.map((n) => n.x), ys = nodes.map((n) => n.y);
      // Room for a label either side of the outermost dots, in screen pixels.
      const padX = Math.min(130, width / 10), padY = 40;
      const w = Math.max(...xs) - Math.min(...xs);
      const h = Math.max(...ys) - Math.min(...ys);
      const k = Math.min(1.5, (width - 2 * padX) / w, (height - 2 * padY) / h);
      const cx = (Math.max(...xs) + Math.min(...xs)) / 2;
      const cy = (Math.max(...ys) + Math.min(...ys)) / 2;
      svg.call(zoom.transform, d3.zoomIdentity.scale(k).translate(-cx, -cy));
    }

    // Pick out a set of nodes: a hovered node and its neighbours, or a
    // category's posts. Everything else is dimmed.
    function highlight(set) {
      svg.classed("sitegraph-focusing", !!set);
      gNodes.selectAll("g.sitegraph-node").classed("sitegraph-near", (n) => !!set && set.has(n.id));
      gEdges.selectAll("line").classed("sitegraph-near",
        (e) => !!set && set.has(e.source.id) && set.has(e.target.id));
    }

    function setFocus(name) {
      state.focus = name;
      for (const b of legend.querySelectorAll("button")) {
        b.setAttribute("aria-pressed", String(b.textContent === name));
      }
      highlight(name ? new Set(nodes.filter((n) =>
        (n.kind === "post" && n.categories.includes(name)) || n.id === "category:" + name)
        .map((n) => n.id)) : null);
    }

    function hover(n, event) {
      if (!n) {
        tooltip.hidden = true;
        setFocus(state.focus);
        return;
      }
      const set = new Set([n.id]);
      for (const e of edges) {
        if (e.source.id === n.id) set.add(e.target.id);
        if (e.target.id === n.id) set.add(e.source.id);
      }
      highlight(set);
      if (n.kind === "post") {
        const o = out.get(n.id).length, i = into.get(n.id).length;
        tooltip.replaceChildren(el("div", {}, el("strong", {}, n.title),
          n.date ? el("div", {}, n.date) : null,
          n.categories.length ? el("div", {}, n.categories.join(" · ")) : null,
          el("div", {}, `Links to ${o} · linked from ${i}`)));
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
      if (n.kind === "post") window.location.href = n.url;
      else setFocus(state.focus === n.name ? null : n.name);
    }

    new ResizeObserver(() => { if (fitted) { resize(); } }).observe(stage);
    draw();
  }

  function start() {
    if (typeof d3 === "undefined") {
      console.error("sitegraph: d3 is not loaded");
      return;
    }
    document.querySelectorAll(".sitegraph[data-src]").forEach(init);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
