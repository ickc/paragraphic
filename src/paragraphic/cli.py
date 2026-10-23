# paragraphic, https://github.com/ickc/paragraphic
# Copyright (C) 2026 Kolen Cheung
# SPDX-License-Identifier: AGPL-3.0-or-later
"""paragraphic build: write graph.json and the viewer into a rendered site."""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
import tomllib
from importlib.resources import files
from pathlib import Path

from .extract import PRESETS, Config, build_graph, selectors_from

VIEWER = ("paragraphic.js", "paragraphic-local.js", "paragraphic.css")


def quarto_project(directory: Path) -> dict:
    """output-dir and site-url from a Quarto project's _quarto.yml."""
    import yaml

    data = yaml.safe_load((directory / "_quarto.yml").read_text(encoding="utf-8")) or {}
    project = data.get("project") or {}
    out = {"output-dir": directory / project.get("output-dir", "_site")}
    site_url = (data.get("website") or {}).get("site-url")
    if site_url:
        out["site-url"] = site_url
    return out


def load_config(path: Path | None, args: argparse.Namespace) -> tuple[Config, Path]:
    raw: dict = {}
    root = Path.cwd()
    if path:
        raw = tomllib.loads(path.read_text(encoding="utf-8"))
        root = path.parent

    derived: dict = {}
    if raw.get("quarto-project"):
        derived = quarto_project(root / raw["quarto-project"])
        raw.setdefault("preset", "quarto")

    output_dir = args.output_dir or (
        root / raw["output-dir"] if "output-dir" in raw else derived.get("output-dir")
    )
    if output_dir is None:
        sys.exit("paragraphic: no output directory: pass one, or set output-dir or quarto-project")
    site_url = (args.site_url or os.environ.get("SITE_URL")
                or raw.get("site-url") or derived.get("site-url"))
    preset = args.preset or raw.get("preset", "pandoc")
    config = Config(
        output_dir=Path(output_dir),
        selectors=selectors_from(preset, raw.get("selectors", {})),
        site_url=site_url,
        index=raw.get("index"),
        uncoloured=list(raw.get("uncoloured", [])),
        colours=int(raw.get("colours", 7)),
    )
    out = Path(output_dir) / (args.out or raw.get("out", "graph.json"))
    return config, out


def summary(graph: dict) -> str:
    linked = {l["source"] for l in graph["links"]} | {l["target"] for l in graph["links"]}
    orphans = [n["id"] for n in graph["nodes"] if n["id"] not in linked]
    return (f"{len(graph['nodes'])} pages, {len(graph['links'])} links, "
            f"{len(orphans)} with no links in or out")


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(prog="paragraphic", description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    build = sub.add_parser("build", help="write graph.json and the viewer into the output directory")
    build.add_argument("output_dir", nargs="?", type=Path,
                       help="the rendered site (default: from the config)")
    build.add_argument("-c", "--config", type=Path, help="a paragraphic.toml")
    build.add_argument("--preset", choices=sorted(PRESETS))
    build.add_argument("--site-url", help="absolute links to it are internal (default: $SITE_URL)")
    build.add_argument("--out", help="the graph's path in the output directory (default: graph.json)")
    build.add_argument("--no-viewer", action="store_true",
                       help="do not copy paragraphic.js and paragraphic.css next to the graph")
    build.add_argument("-v", "--verbose", action="store_true",
                       help="also list the pages with no links in or out")
    args = parser.parse_args(argv)

    config, out = load_config(args.config, args)
    try:
        graph = build_graph(config)
    except FileNotFoundError as err:
        # A render of a single document into an empty output directory: there
        # is no site to draw yet, and that is not the render's failure.
        print(f"paragraphic: skipped: {err}", file=sys.stderr)
        return
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(graph, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    if not args.no_viewer:
        viewer = files("paragraphic") / "viewer"
        for name in VIEWER:
            with (viewer / name).open("rb") as src, open(out.parent / name, "wb") as dst:
                shutil.copyfileobj(src, dst)
    print(f"paragraphic: {out}: {summary(graph)}", file=sys.stderr)
    if args.verbose:
        linked = {l["source"] for l in graph["links"]} | {l["target"] for l in graph["links"]}
        for n in graph["nodes"]:
            if n["id"] not in linked:
                print(f"  {n['id']}", file=sys.stderr)


if __name__ == "__main__":
    main()
