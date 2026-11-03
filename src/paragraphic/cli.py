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

from .extract import GROUPS, PRESETS, Config, build_graph, selectors_from

VIEWER = ("paragraphic.js", "paragraphic-local.js", "paragraphic.css")


def quarto_project(directory: Path) -> dict:
    """output-dir and site-url from a Quarto project's configuration.

    That is _quarto.yml with, merged on top as Quarto does, the profiles it
    activates when none is given: `profile.default`, and the first profile of
    each `profile.group` (as a site sharing ickc/quarto-template keeps its own
    settings in _quarto-site.yml).
    """
    import yaml

    def load(name: str) -> dict:
        path = directory / name
        if not path.is_file():
            return {}
        return yaml.safe_load(path.read_text(encoding="utf-8")) or {}

    data = load("_quarto.yml")
    profile = data.get("profile") or {}
    default = profile.get("default") or []
    names = [default] if isinstance(default, str) else list(default)
    names += [group[0] for group in profile.get("group") or [] if group]

    project = dict(data.get("project") or {})
    website = dict(data.get("website") or {})
    for name in names:
        extra = load(f"_quarto-{name}.yml")
        project.update(extra.get("project") or {})
        website.update(extra.get("website") or {})

    out = {"output-dir": directory / project.get("output-dir", "_site")}
    site_url = website.get("site-url")
    if site_url:
        out["site-url"] = site_url
    return out


def load_config(path: Path | None, args: argparse.Namespace) -> tuple[Config, Path]:
    raw: dict = {}
    root = Path.cwd()
    if path:
        raw = tomllib.loads(path.read_text(encoding="utf-8"))
        root = path.parent

    # Run as a Quarto post-render script, the project and its output directory
    # come from the environment Quarto sets, so a site needs no settings file.
    # They are only fallbacks: the preset is still chosen explicitly.
    env_project = os.environ.get("QUARTO_PROJECT_DIR")
    env_output = os.environ.get("QUARTO_PROJECT_OUTPUT_DIR")

    derived: dict = {}
    if raw.get("quarto-project"):
        derived = quarto_project(root / raw["quarto-project"])
        raw.setdefault("preset", "quarto")
    elif env_project:
        try:
            derived = quarto_project(Path(env_project))
        except ImportError:
            print("paragraphic: install paragraphic[quarto] to read site-url from the Quarto project",
                  file=sys.stderr)

    if args.output_dir:
        output_dir = args.output_dir
    elif "output-dir" in raw:
        output_dir = root / raw["output-dir"]
    elif env_output:
        # Relative to the project, as Quarto gives it.
        output_dir = Path(env_project or ".") / env_output
    else:
        output_dir = derived.get("output-dir")
    if output_dir is None:
        sys.exit("paragraphic: no output directory: pass one, set output-dir or quarto-project,"
                 " or run as a Quarto post-render script")
    site_url = (args.site_url or os.environ.get("SITE_URL")
                or raw.get("site-url") or derived.get("site-url"))
    preset = args.preset or raw.get("preset", "pandoc")
    config = Config(
        output_dir=Path(output_dir),
        selectors=selectors_from(preset, raw.get("selectors", {})),
        site_url=site_url,
        index=args.index or raw.get("index"),
        uncoloured=list(args.uncoloured or raw.get("uncoloured", [])),
        colours=int(args.colours if args.colours is not None else raw.get("colours", 7)),
        groups=args.groups or raw.get("groups", "categories"),
        level=int(args.level if args.level is not None else raw.get("level", 1)),
        exclude=list(args.exclude or raw.get("exclude", [])),
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
                       help="the rendered site (default: from the config, or $QUARTO_PROJECT_OUTPUT_DIR)")
    build.add_argument("-c", "--config", type=Path, help="a paragraphic.toml")
    build.add_argument("--preset", choices=sorted(PRESETS))
    build.add_argument("--site-url", help="absolute links to it are internal (default: $SITE_URL)")
    build.add_argument("--out", help="the graph's path in the output directory (default: graph.json)")
    build.add_argument("--index", help="the page whose links are the nodes (default: every page)")
    build.add_argument("--exclude", action="append", metavar="GLOB",
                       help="pages that are never nodes, by path (e.g. 404.html); repeat for more")
    build.add_argument("--groups", choices=GROUPS,
                       help="what colours a page: its categories (the default), or its directory")
    build.add_argument("--level", type=int,
                       help="with --groups directories, how many directories deep a group is (default: 1)")
    build.add_argument("--colours", type=int, help="how many groups are coloured at first (default: 7)")
    build.add_argument("--uncoloured", action="append", metavar="GROUP",
                       help="a group never coloured; repeat for more")
    build.add_argument("--no-viewer", action="store_true",
                       help="do not copy paragraphic.js and paragraphic.css next to the graph")
    build.add_argument("-v", "--verbose", action="store_true",
                       help="also list the pages with no links in or out")
    args = parser.parse_args(argv)

    try:
        config, out = load_config(args.config, args)
    except ValueError as err:
        sys.exit(f"paragraphic: {err}")
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
