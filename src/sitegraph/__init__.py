"""The graph of how a static site's pages link to each other, Obsidian-style."""

from .extract import PRESETS, Config, Selectors, build_graph, read_page, read_site

__all__ = ["PRESETS", "Config", "Selectors", "build_graph", "read_page", "read_site"]
