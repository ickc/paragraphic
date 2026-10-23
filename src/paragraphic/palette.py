# paragraphic, https://github.com/ickc/paragraphic
# Copyright (C) 2026 Kolen Cheung
# SPDX-License-Identifier: AGPL-3.0-or-later
"""The viewer's category colours: Tableau 20 without its greys, reordered so
that every prefix is as spread out as it can be.

The slider in the viewer turns on the first n colours, so what matters is
not how far apart the whole palette is but how far apart each prefix is. The
order is greedy farthest-point: start from Tableau's blue, and each next
colour is the one whose nearest already-chosen colour is farthest away, with
distance measured in OKLab. Measured as the smallest distance within the
first k colours (OKLab ΔE × 100), it beats Tableau 20's own order and every
coprime stride through it at every k, and stays above 12 up to k = 12.

    python -m paragraphic.palette    # print the CSS custom properties
"""

from __future__ import annotations

import math
from itertools import combinations

# Tableau 20 (Tableau 10 and its light partners), without the two greys:
# grey is "other" in the viewer.
TABLEAU_20 = (
    "#1f77b4", "#aec7e8", "#ff7f0e", "#ffbb78", "#2ca02c", "#98df8a",
    "#d62728", "#ff9896", "#9467bd", "#c5b0d5", "#8c564b", "#c49c94",
    "#e377c2", "#f7b6d2", "#bcbd22", "#dbdb8d", "#17becf", "#9edae5",
)


def oklab(hex_colour: str) -> tuple[float, float, float]:
    def linear(c: int) -> float:
        c /= 255
        return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4

    r, g, b = (linear(int(hex_colour[i:i + 2], 16)) for i in (1, 3, 5))
    l = (0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b) ** (1 / 3)
    m = (0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b) ** (1 / 3)
    s = (0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b) ** (1 / 3)
    return (0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
            1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
            0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s)


def distance(a: str, b: str) -> float:
    """OKLab ΔE × 100: about 10 is the least that tells two small dots apart."""
    return 100 * math.dist(oklab(a), oklab(b))


def greedy_order(colours: tuple[str, ...] | list[str]) -> list[str]:
    """Farthest-point order, from the first colour."""
    order, rest = [colours[0]], list(colours[1:])
    while rest:
        best = max(rest, key=lambda c: min(distance(c, o) for o in order))
        order.append(best)
        rest.remove(best)
    return order


def prefix_min(order: list[str], k: int) -> float:
    """The smallest distance between any two of the first k colours."""
    return min(distance(a, b) for a, b in combinations(order[:k], 2))


PALETTE = greedy_order(TABLEAU_20)


def css() -> str:
    return "\n".join(f"  --paragraphic-{i}: {c};" for i, c in enumerate(PALETTE, 1))


if __name__ == "__main__":
    print(css())
