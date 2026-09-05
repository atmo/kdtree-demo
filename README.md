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
| `query` | which kNN algorithm runs — `optimal · heap` or `simplified · sort + climb` |
| `build` | how the tree is built — `optimal · median + widest` or `simplified · midpoint + alternating`. Switching rebuilds the tree |
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

## Optimal vs simplified, side by side

Both switches in the top bar pick between a version that is careful and one
that is naive. The code below is the essential difference in each case; every
number was measured in one run over the bundled 20 526-venue Berlin set at
leaf size 16.

### Building the tree

<table>
<tr>
<th align="left">optimal &mdash; median + widest axis</th>
<th align="left">simplified &mdash; midpoint + alternating</th>
</tr>
<tr>
<td valign="top">

<pre lang="js">
// axis — the one with the larger
// REAL-WORLD spread (lon x cos lat)
var spanX = (b.maxX - b.minX) * cosLat;
var spanY = b.maxY - b.minY;
var axis  = spanX &gt;= spanY ? 0 : 1;

// split — the median point.
// quickselect to the middle slot, then
// a 3-way partition groups the ties
var mid = chooseSplit(lo, hi, key);
if (mid === null) {        // axis constant
  axis = 1 - axis;         // try the other
  mid  = chooseSplit(lo, hi, key);
  if (mid === null)        // all identical
    return makeLeaf(node, lo, hi);
}
// the boundary is the LARGEST value on
// the left, so `v &lt;= split` is exact
split = max(points[lo..mid][key]);

// both children always hold points
node.left  = rec(lo,     mid, d+1, lc);
node.right = rec(mid+1,  hi,  d+1, rc);
</pre>

</td>
<td valign="top">

<pre lang="js">
// axis — just alternate x, y, x, y
var axis = depth % 2;




// split — the middle of the REGION,
// wherever the points happen to be
split = axis === 0
  ? (cell.minX + cell.maxX) / 2
  : (cell.minY + cell.maxY) / 2;
var mid = partitionAt(lo, hi, key, split);

// points at identical coordinates never
// separate, so the recursion needs a cap
if (depth &gt;= MIDPOINT_MAX_DEPTH)
  return makeLeaf(node, lo, hi);


// either child may come back empty
node.left  = mid &lt;  lo ? emptyLeaf(d+1, lc)
                       : rec(lo, mid, d+1, lc);
node.right = mid === hi ? emptyLeaf(d+1, rc)
                        : rec(mid+1, hi, d+1, rc);
</pre>

</td>
</tr>
</table>

| | optimal | simplified |
|---|---|---|
| build time | 42 ms | **19 ms** |
| depth | **12** | 64 — the cap |
| nodes | **4 071** | 5 451 |
| leaves | 2 036 | 2 726 |
| empty leaves | **0** | 545 |
| leaves that hit the depth cap | **0** | 10 |
| mean split balance (0.5 = even) | **0.4885** | 0.2499 |
| mean venues per leaf | 10.1 | 7.5 |

Simplified builds **2× faster** — no median selection, just arithmetic on the
cell. What it buys with that is a tree a third larger, 545 leaves holding
nothing, and a depth of 64 instead of 12. The balance figure explains the
shape: median splitting puts almost exactly half the points on each side
(0.4885), while halving the region puts a quarter on one side and
three-quarters on the other (0.2499), because venues are not spread evenly
through a city.

The 10 capped leaves are the real hazard. 3 608 of these venues share a
coordinate with another one, the biggest pile-up being 56 at a single point,
and **halving a region can never separate points that sit on top of each
other**. Without `MIDPOINT_MAX_DEPTH` that recursion does not terminate.
Median splitting detects the tie through its 3-way partition and emits a leaf.

### Searching

<table>
<tr>
<th align="left">optimal &mdash; heap, one pass</th>
<th align="left">simplified &mdash; sort a seed, then climb</th>
</tr>
<tr>
<td valign="top">

<pre lang="js">
// one pass, nearest child first,
// with a bounded max-heap of k

if (heap.length === k &amp;&amp;
    cellDist2(node.bbox) &gt; worst()) {
  pruned.add(node.id);      // whole subtree
  return;
}

if (node.points) {
  for (var i = 0; i &lt; node.points.length; i++)
    push(p, dist2(p));      // sift into heap
  return;                   // radius tightens
}                           // on every insert

var first = (node.axis === 0 ? x : y)
          &lt;= node.split ? node.left : node.right;
walk(first);                // near side first
walk(first === node.left ? node.right
                         : node.left);
</pre>

</td>
<td valign="top">

<pre lang="js">
// phase 1 — earn a radius by SORTING
var node = leaf containing q;
while (node.count &lt; k &amp;&amp; node.parent)
  node = node.parent;       // climb to &gt;= k
collect(node);              // measure them all
settle();                   // sort -&gt; r2

// phase 2 — walk back up, one sibling
// per level, r2 shrinking as we go
var cur = node;
while (cur.parent) {
  var sib = sibling of cur;
  if (boxDist2(sib.bbox) &lt;= r2) {
    search(sib);            // range scan
    settle();               // re-sort, tighten
  }
  cur = cur.parent;
}
settle();                   // results sorted
</pre>

</td>
</tr>
</table>

All four combinations return exactly the right answer — verified against brute
force on 200 queries at each k below (`yes` in every row):

| build | query | k=10 | k=100 | k=500 |
|---|---|---|---|---|
| optimal | heap | **7.1 µs** · 43 examined | **38.2 µs** · 227 | **219.7 µs** · 898 |
| optimal | climb | 10.8 µs · 45 | 62.3 µs · 289 | 311.7 µs · 1 125 |
| simplified | heap | 8.8 µs · 40 | 40.9 µs · 216 | 211.8 µs · 868 |
| simplified | climb | 10.7 µs · 44 | 67.1 µs · 290 | 352.4 µs · 1 210 |

Two things stand out, and neither is what you would guess.

**The build strategy barely affects query speed.** Simplified trees even
examine slightly *fewer* points (216 vs 227 at k=100) — halved regions are
squarish, and a square cell wraps a circular search radius better than a
median-split sliver. Its deeper tree then costs more node visits, and the two
effects cancel. The case against midpoint splitting is termination and memory,
not throughput.

**The search algorithm is where the real gap is**, and it widens with k:
×1.5 at k=10, ×1.6 at k=100. The cause is visible in the `examined` column —
289 versus 227 at k=100. Phase 1 measures the entire seed subtree (about
1.3 × k points) with `r2 = Infinity`, before any radius exists to prune with.
The heap gets a usable radius after its first leaf and starts pruning
immediately. At k=1 the effect reverses and climb wins, because both examine
identical points and appending to an array beats sifting a heap.

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
