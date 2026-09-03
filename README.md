# kd-tree demo

Pick a bounding box on a map, pull the venues inside it straight from
[Overture Maps](https://overturemaps.org/) **in the browser**, build a kd-tree
over them, then click a point to find its *k* nearest venues — with the search
drawn on both the map and the tree.

No build step, no bundler, no API key, no backend. Plain `<script>` tags,
Leaflet from a CDN, and a Parquet reader loaded on demand.

```sh
python3 -m http.server 8000     # then open http://localhost:8000
```

A real `http://` origin is required for the live source: browsers block
cross-origin range requests from `file://`. Opening `index.html` directly still
works for everything else, including **load sample**.

## Using it

1. **Select box** — drag a rectangle on the map, or press *use view* to take the
   current viewport.
2. **estimate** *(optional)* — reads the Parquet footers and reports what the
   box will cost before you commit: how many candidate rows, from how many row
   groups, and the byte range to expect. The footers it reads are cached, so a
   download straight after is faster.
3. **Download venues** — see [How the data gets here](#how-the-data-gets-here).
   Results are cached in `localStorage`, so the same box + settings never hits
   the network twice. Oldest sets are evicted at quota; *clear cache* wipes them.
   There is no size ceiling: any set is offered to `localStorage`, and one that
   does not fit simply reports that it was not cached. The tree is always built
   *before* caching is attempted, and the write is deferred a tick, so a large
   set appears immediately instead of waiting on serialisation.
4. **Pick point** — click anywhere on the map. The *k* nearest venues light up,
   the root-to-leaf path is highlighted in the tree, and the status bar reports
   how few venues the search actually had to test.

**load sample** skips the network entirely: `data/sample-berlin.js` holds 20 526
named places from central Berlin (1.3 MB, injected on demand, works over
`file://`). Use it offline, or to get a deep tree instantly.

## How the data gets here

Overture publishes its `places` theme as GeoParquet on S3 — the 2026-08-19
release is **16 files, 9.8 GB, ~73 M places**. The demo reads a few MB of that
from the browser, with no server in between, because:

- the bucket sends `Access-Control-Allow-Origin: *` and supports HTTP **range
  requests**, so a browser can read *parts* of a 600 MB file;
- the data is sorted spatially and every row group carries
  `bbox.{xmin,xmax,ymin,ymax}` **statistics**, so a bounding box prunes to a
  handful of row groups out of thousands;
- Parquet is **columnar**, so only `geometry`, `names`, `categories` and
  `confidence` are fetched — not the other 51 columns.

`data/overture-index.js` (2.9 KB) records each file's spatial extent, so the
browser opens the one file that covers your box instead of probing all 16 —
that alone is the difference between 1.6 MB and 18.9 MB of footer reads.

A real query, central Berlin, measured end to end:

| step | cost |
|---|---|
| pick the file (shipped index) | 0 bytes |
| read its footer | 1.6 MB, cached for the session |
| 2 of 256 row groups → 38 453 candidate rows | 4.5 MB |
| **result** | **20 526 places in the box, ~7 s cold** |

Regenerate the index when Overture cuts a new release:

```sh
node scripts/build-overture-index.js > data/overture-index.js
```

The Parquet reader is [hyparquet](https://github.com/hyparam/hyparquet) plus
`hyparquet-compressors` (for zstd), pulled from jsDelivr as ES modules at first
use. It decodes WKB geometry to GeoJSON for you. To self-host them, set
`Overture.config.lib`; to hand in your own already-loaded copy, set
`Overture.config.reader`.

### Why not Overpass?

The demo used the Overpass API first. Overpass queries live OSM with full tags,
which is genuinely better data — but it is a shared, queued, free service, and
public mirrors range from fast to dead on any given day. Overture on S3 never
queues, never rate-limits, and has no key. The trade: a monthly snapshot instead
of live data, Overture's own category taxonomy instead of raw OSM tags, and no
cheap "how many are there" query — *estimate* answers a related question
(how much data must I read) rather than an exact count.

## Progress and cancellation

Reads are chunked by row-group run, with a **progress bar** showing
`step 2/3 · 4.5 MB read`, and a **cancel** button that aborts the in-flight
range request immediately and leaves existing data intact.

Above 30 000 venues the map draws an evenly strided sample of them — plotting a
million Leaflet markers is not viable — while the tree and every search still
use the full set. The status bar says so when it happens.

## What you see

- **Venue counter** — the pill in the top bar: venues inside the current box,
  and `~38,453 candidates` once you press *estimate*. It reads
  `no venues downloaded yet` before a download and `0 in box (of 8000
  downloaded)` if you move the box off your data.
- **Map** — venues as grey dots, the kd-tree's split lines (red along the query
  path), the leaf cell containing your point, the *k* results in green with a
  radius circle.
- **Tree** — every node shows its split (`lon ≤ 13.40215`) and point count;
  leaves show their contents. The path to your point is red, subtrees the search
  pruned are dimmed, and result counts per leaf sit in blue badges. Scroll to
  zoom, drag to pan, *fit* to reset.
- **Region list** — every region the query point falls through, root to leaf,
  with each split rule, the venues it holds and the region's real size
  (`4.7 km × 4.5 km` down to `42 m × 29 m`). Click a row to jump to it; hover to
  preview that region on the map without moving the view.
- **Step controls** — `↑ up` / `deeper ↓` in the tree header (or the ↑/↓ arrow
  keys) walk the path one level at a time. Picking a point parks you at the
  root, so you can descend deliberately and watch the map region shrink.
- **Click any node** to zoom the map to the region it represents, sized to fill
  about 80% of the view (the map uses fractional zoom, so a region is never
  rounded down to half the screen). Collapsed `▾ expand` stubs open on click, so
  every node in the tree is reachable, and the view centres on whatever you
  clicked.
- **Click any venue row** — in the k-nearest list or a leaf's contents — to
  centre the map on that venue and ring it.
- **Tested venues** — the ones whose distance the search actually computed are
  drawn in violet, so you can see the work the pruning avoided: a handful of
  dots around your point, out of tens of thousands of grey ones. Toggle with
  the *tested* checkbox.

Query timing is reported in µs or ns. A single kNN call is far below
`performance.now()`'s ~0.1 ms clamp, so the demo repeats the query for a few
milliseconds and reports the per-query mean (`26.0 µs (mean of 154 runs)`)
rather than a misleading `0.00 ms`.

## Settings

| setting | effect |
|---|---|
| `k nearest` | how many neighbours to find |
| `leaf size` | max points per leaf; rebuilds the tree |
| `depth shown` | how deep the tree is drawn before subtrees collapse |
| `max venues` | cap on downloaded venues (default 1 000 000); the read stops once reached |
| `named only` | skip places with no name |
| `min confidence` | Overture's 0–1 score for whether the place really exists |

## Files

| file | role |
|---|---|
| `js/kdtree.js` | the tree: build, locate, kNN, nearest — no DOM, no deps |
| `js/overture.js` | bbox → Parquet row groups → venues |
| `js/cache.js` | `localStorage` venue sets with quota eviction |
| `js/mapview.js` | Leaflet: box drawing, splits, cells, results |
| `js/treeview.js` | SVG tree with pan/zoom and collapsing |
| `js/app.js` | wiring, settings, progress |
| `data/overture-index.js` | spatial index of the release's 16 files |
| `data/sample-berlin.js` | offline fallback dataset |
| `scripts/` | regenerate either data file |

## The kd-tree

Splits on the axis with the larger real-world spread (longitude scaled by
`cos(lat)`), at the median, until a node holds at most `leaf size` points.
`node.split` is the largest coordinate on the left, so the descent rule
`value <= split → left` always lands a point in a leaf that truly contains it,
even when many places share a coordinate.

kNN is branch-and-bound over a bounded max-heap: descend to the query point's
leaf, then only visit a sibling if its bounding box is closer than the current
*k*-th best. Verified against brute force for k = 1…200; on 20 526 venues a
k = 10 query typically tests **~25 points, about 0.1%**.

### Choosing a leaf size

Measured on 162 694 real venues, k = 100, 500 query points × 5 repeats:

| leaf size | 4 | 8 | **16** | **32** | **48** | 64 | 128 | 256 | 512 | 1024 |
|---|---|---|---|---|---|---|---|---|---|---|
| query (ms) | 0.063 | 0.049 | **0.043** | 0.045 | 0.045 | 0.051 | 0.051 | 0.048 | 0.058 | 0.081 |
| points examined | 186 | 199 | 223 | 261 | 320 | 320 | 416 | 553 | 804 | 1 248 |
| nodes in tree | 124 k | 65 k | 33 k | 16 k | 8 k | 8 k | 4 k | 2 k | 1 k | 0.5 k |

The optimum is a broad plateau: **16–48 is fastest, and anything from 8 to 256
is within ~20%**. Small leaves mean fewer distance computations but far more
node traversals and a much bigger tree; large leaves invert that. Around
`leaf ≈ k/3 … k/2` the two costs balance. 32 is a good default — mid-plateau,
half the nodes of 16, and a shallower tree to look at.

## Data

Overture Maps Foundation places — ODbL / CDLA-Permissive-2.0, incorporating
OpenStreetMap, Meta and Microsoft data. Map tiles © OpenStreetMap contributors.
