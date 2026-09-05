/* Minimal 2-d kd-tree over geographic points.
 * x = longitude, y = latitude.  Longitude spread is scaled by cos(lat) so the
 * axis choice reflects real-world distance rather than raw degrees.
 *
 * Invariant: node.split is the largest coordinate on the left side, so the
 * descent rule `value <= split -> left` always lands a point in a leaf that
 * really holds it, even when many points share a coordinate. */
(function (global) {
  'use strict';

  function swap(a, i, j) { var t = a[i]; a[i] = a[j]; a[j] = t; }

  function quickselect(idx, pts, lo, hi, k, key) {
    while (hi > lo) {
      if (hi - lo < 12) {
        for (var i = lo + 1; i <= hi; i++) {
          var v = idx[i], vk = pts[v][key], j = i - 1;
          while (j >= lo && pts[idx[j]][key] > vk) { idx[j + 1] = idx[j]; j--; }
          idx[j + 1] = v;
        }
        return;
      }
      var mid = (lo + hi) >> 1;
      if (pts[idx[mid]][key] < pts[idx[lo]][key]) swap(idx, mid, lo);
      if (pts[idx[hi]][key] < pts[idx[lo]][key]) swap(idx, hi, lo);
      if (pts[idx[hi]][key] < pts[idx[mid]][key]) swap(idx, hi, mid);
      var pivot = pts[idx[mid]][key];
      swap(idx, mid, hi - 1);
      var a = lo, b = hi - 1;
      for (;;) {
        while (pts[idx[++a]][key] < pivot) {}
        while (pts[idx[--b]][key] > pivot) { if (b === lo) break; }
        if (a >= b) break;
        swap(idx, a, b);
      }
      swap(idx, a, hi - 1);
      if (a >= k) hi = a - 1;
      if (a <= k) lo = a + 1;
    }
  }

  /* Dutch-flag partition of [lo..hi] around `pivot`, returning
   * {lt, eq} = counts of values strictly below / equal to the pivot. */
  function partition3(idx, pts, lo, hi, key, pivot) {
    var i = lo, lt = lo, gt = hi;
    while (i <= gt) {
      var v = pts[idx[i]][key];
      if (v < pivot) swap(idx, lt++, i++);
      else if (v > pivot) swap(idx, i, gt--);
      else i++;
    }
    return { lt: lt - lo, eq: gt - lt + 1 };
  }

  /* opts.rule : 'median'   split at the median point   (balanced counts)
   *             'midpoint' split the region in half      (equal areas)
   * opts.axis : 'widest'    the axis with the larger real-world spread
   *             'alternate' x, y, x, y, ... by depth
   *
   * Midpoint splitting cannot separate points at identical coordinates, so it
   * needs a depth cap; median splitting detects the tie and emits a leaf. */
  var MIDPOINT_MAX_DEPTH = 64;

  function build(points, leafSize, rootCell, opts) {
    opts = opts || {};
    var rule = opts.rule === 'midpoint' ? 'midpoint' : 'median';
    var axisRule = opts.axis === 'alternate' ? 'alternate' : 'widest';
    leafSize = Math.max(1, leafSize | 0);
    var n = points.length;
    var idx = new Int32Array(n);
    for (var i = 0; i < n; i++) idx[i] = i;

    var stats = { nodes: 0, leaves: 0, maxDepth: 0, points: n, leafSize: leafSize,
                  emptyLeaves: 0, cappedLeaves: 0, rule: rule, axis: axisRule };
    var nextId = 0;

    function tightBounds(lo, hi) {
      var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (var i = lo; i <= hi; i++) {
        var p = points[idx[i]];
        if (p.x < minX) minX = p.x;
        if (p.x > maxX) maxX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.y > maxY) maxY = p.y;
      }
      return { minX: minX, minY: minY, maxX: maxX, maxY: maxY };
    }

    /* Pick a split index in [lo..hi-1] on `key`, or null if the axis is
     * constant.  Everything at or below the returned index is <= split. */
    function chooseSplit(lo, hi, key) {
      var count = hi - lo + 1;
      var target = (lo + hi) >> 1;
      quickselect(idx, points, lo, hi, target, key);
      var pivot = points[idx[target]][key];
      var p = partition3(idx, points, lo, hi, key, pivot);
      if (p.lt === 0 && p.eq === count) return null;      // constant axis
      var loEnd = lo + p.lt - 1;                           // strictly-less block
      var eqEnd = lo + p.lt + p.eq - 1;                    // less-or-equal block
      if (p.lt === 0) return eqEnd;                        // equals must go left
      if (eqEnd === hi) return loEnd;                      // equals must go right
      // Both are legal: take whichever balances the two sides better.
      var half = count / 2;
      return Math.abs((loEnd - lo + 1) - half) <= Math.abs((eqEnd - lo + 1) - half)
        ? loEnd : eqEnd;
    }

    /* Reorders [lo..hi] so everything <= split comes first; returns the index
     * of the last such element (lo-1 if none, hi if all). */
    function partitionAt(lo, hi, key, split) {
      var i = lo, j = hi;
      while (i <= j) {
        if (points[idx[i]][key] <= split) i++;
        else { swap(idx, i, j); j--; }
      }
      return i - 1;
    }

    function emptyLeaf(depth, cell) {
      stats.nodes++; stats.leaves++; stats.emptyLeaves++;
      if (depth > stats.maxDepth) stats.maxDepth = depth;
      return { id: nextId++, depth: depth, count: 0, cell: cell,
               bbox: { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity },
               axis: -1, split: null, left: null, right: null, parent: null, points: [] };
    }

    function makeLeaf(node, lo, hi) {
      stats.leaves++;
      node.points = [];
      for (var i = lo; i <= hi; i++) node.points.push(points[idx[i]]);
      return node;
    }

    function rec(lo, hi, depth, cell) {
      var node = {
        id: nextId++,
        depth: depth,
        count: hi - lo + 1,
        cell: cell,
        bbox: tightBounds(lo, hi),
        axis: -1,
        split: null,
        left: null,
        right: null,
        parent: null,
        points: null
      };
      stats.nodes++;
      if (depth > stats.maxDepth) stats.maxDepth = depth;
      if (node.count <= leafSize) return makeLeaf(node, lo, hi);

      var b = node.bbox;
      var spanX = (b.maxX - b.minX) * Math.cos((b.minY + b.maxY) / 2 * Math.PI / 180);
      var spanY = b.maxY - b.minY;
      var axis = axisRule === 'alternate' ? (depth % 2) : (spanX >= spanY ? 0 : 1);
      var key = axis === 0 ? 'x' : 'y';
      var mid, split, i, v;

      if (rule === 'midpoint') {
        if (depth >= MIDPOINT_MAX_DEPTH) {      // duplicate coordinates: give up
          stats.cappedLeaves++;
          return makeLeaf(node, lo, hi);
        }
        split = axis === 0 ? (cell.minX + cell.maxX) / 2 : (cell.minY + cell.maxY) / 2;
        mid = partitionAt(lo, hi, key, split);
        node.axis = axis;
        node.split = split;
        var lc0, rc0;
        if (axis === 0) {
          lc0 = { minX: cell.minX, minY: cell.minY, maxX: split, maxY: cell.maxY };
          rc0 = { minX: split, minY: cell.minY, maxX: cell.maxX, maxY: cell.maxY };
        } else {
          lc0 = { minX: cell.minX, minY: cell.minY, maxX: cell.maxX, maxY: split };
          rc0 = { minX: cell.minX, minY: split, maxX: cell.maxX, maxY: cell.maxY };
        }
        // An empty half is normal here — keep halving until the points separate.
        node.left = mid < lo ? emptyLeaf(depth + 1, lc0) : rec(lo, mid, depth + 1, lc0);
        node.right = mid === hi ? emptyLeaf(depth + 1, rc0) : rec(mid + 1, hi, depth + 1, rc0);
        node.left.parent = node;
        node.right.parent = node;
        return node;
      }

      mid = chooseSplit(lo, hi, key);
      if (mid === null) {                       // try the other axis instead
        axis = 1 - axis;
        key = axis === 0 ? 'x' : 'y';
        mid = chooseSplit(lo, hi, key);
        if (mid === null) return makeLeaf(node, lo, hi);  // all points identical
      }

      split = -Infinity;
      for (i = lo; i <= mid; i++) {
        v = points[idx[i]][key];
        if (v > split) split = v;
      }
      node.axis = axis;
      node.split = split;

      var lc, rc;
      if (axis === 0) {
        lc = { minX: cell.minX, minY: cell.minY, maxX: split, maxY: cell.maxY };
        rc = { minX: split, minY: cell.minY, maxX: cell.maxX, maxY: cell.maxY };
      } else {
        lc = { minX: cell.minX, minY: cell.minY, maxX: cell.maxX, maxY: split };
        rc = { minX: cell.minX, minY: split, maxX: cell.maxX, maxY: cell.maxY };
      }
      node.left = rec(lo, mid, depth + 1, lc);
      node.right = rec(mid + 1, hi, depth + 1, rc);
      node.left.parent = node;
      node.right.parent = node;
      return node;
    }

    var cell0 = rootCell || (n ? tightBounds(0, n - 1)
                               : { minX: 0, minY: 0, maxX: 0, maxY: 0 });
    var root = n ? rec(0, n - 1, 0, cell0) : null;
    return { root: root, stats: stats, leafSize: leafSize };
  }

  /* Path from the root down to the leaf whose region contains (x, y).
   * Returns [{node, wentLeft}], leaf last with wentLeft = null. */
  function locate(root, x, y) {
    var path = [], node = root;
    while (node) {
      if (node.points) { path.push({ node: node, wentLeft: null }); break; }
      var left = (node.axis === 0 ? x : y) <= node.split;
      path.push({ node: node, wentLeft: left });
      node = left ? node.left : node.right;
    }
    return path;
  }

  /* Exact nearest neighbour (branch-and-bound), for labelling the query. */
  function nearest(root, x, y) {
    var best = null, bestD = Infinity;
    var scale = Math.cos(y * Math.PI / 180);
    function d2(p) {
      var dx = (p.x - x) * scale, dy = p.y - y;
      return dx * dx + dy * dy;
    }
    function cellDist2(c) {
      var dx = x < c.minX ? c.minX - x : (x > c.maxX ? x - c.maxX : 0);
      var dy = y < c.minY ? c.minY - y : (y > c.maxY ? y - c.maxY : 0);
      dx *= scale;
      return dx * dx + dy * dy;
    }
    (function walk(node) {
      if (!node || cellDist2(node.bbox) > bestD) return;
      if (node.points) {
        for (var i = 0; i < node.points.length; i++) {
          var dd = d2(node.points[i]);
          if (dd < bestD) { bestD = dd; best = node.points[i]; }
        }
        return;
      }
      var first = (node.axis === 0 ? x : y) <= node.split ? node.left : node.right;
      walk(first);
      walk(first === node.left ? node.right : node.left);
    })(root);
    return { point: best, dist: best ? Math.sqrt(bestD) * 111320 : null };
  }


  /* k nearest neighbours by branch-and-bound.  Records which nodes were
   * visited and which subtrees were pruned so the UI can show the search. */
  function knn(root, x, y, k) {
    k = Math.max(1, k | 0);
    var scale = Math.cos(y * Math.PI / 180);
    var heap = [];                 // max-heap on dist2, at most k entries
    var visited = new Set(), pruned = new Set();
    var examined = 0, leavesVisited = 0;
    // The points whose distance was actually computed, so the UI can show the
    // work the search did.  Capped: a huge k should not hold a second copy of
    // the dataset.
    var tested = [], TESTED_CAP = 50000;
    var openedLeaves = [];         // the leaf nodes whose points we measured

    function worst() { return heap.length ? heap[0].d : Infinity; }
    function push(p, d) {
      if (heap.length < k) { heap.push({ p: p, d: d }); siftUp(heap.length - 1); }
      else if (d < heap[0].d) { heap[0] = { p: p, d: d }; siftDown(0); }
    }
    function siftUp(i) {
      while (i > 0) {
        var par = (i - 1) >> 1;
        if (heap[par].d >= heap[i].d) break;
        var t = heap[par]; heap[par] = heap[i]; heap[i] = t; i = par;
      }
    }
    function siftDown(i) {
      for (;;) {
        var l = 2 * i + 1, r = l + 1, m = i;
        if (l < heap.length && heap[l].d > heap[m].d) m = l;
        if (r < heap.length && heap[r].d > heap[m].d) m = r;
        if (m === i) break;
        var t = heap[m]; heap[m] = heap[i]; heap[i] = t; i = m;
      }
    }
    function cellDist2(c) {
      var dx = x < c.minX ? c.minX - x : (x > c.maxX ? x - c.maxX : 0);
      var dy = y < c.minY ? c.minY - y : (y > c.maxY ? y - c.maxY : 0);
      dx *= scale;
      return dx * dx + dy * dy;
    }

    (function walk(node) {
      if (!node) return;
      if (heap.length === k && cellDist2(node.bbox) > worst()) {
        pruned.add(node.id);
        return;
      }
      visited.add(node.id);
      if (node.points) {
        leavesVisited++;
        openedLeaves.push(node);
        for (var i = 0; i < node.points.length; i++) {
          var p = node.points[i];
          var dx = (p.x - x) * scale, dy = p.y - y;
          examined++;
          if (tested.length < TESTED_CAP) tested.push(p);
          push(p, dx * dx + dy * dy);
        }
        return;
      }
      var first = (node.axis === 0 ? x : y) <= node.split ? node.left : node.right;
      walk(first);
      walk(first === node.left ? node.right : node.left);
    })(root);

    var results = heap.slice().sort(function (a, b) { return a.d - b.d; })
      .map(function (e) {
        return { point: e.p, dist: Math.sqrt(e.d) * 111320 };
      });
    return {
      results: results,
      visited: visited,
      pruned: pruned,
      tested: tested,
      openedLeaves: openedLeaves,
      testedCapped: examined > tested.length,
      examined: examined,
      leavesVisited: leavesVisited,
      radius: results.length ? results[results.length - 1].dist : 0
    };
  }

  /* Same answer as knn(), without the heap.
   *
   * Phase 1 descends to the query point's leaf and climbs until the subtree
   * holds at least k points, then sorts them: the k-th distance is a valid
   * upper bound on the true k-th nearest.  Phase 2 walks back up, testing one
   * sibling per level against that radius and letting it shrink on the way.
   *
   * Trades ~30% more distance computations at large k for no heap code, and
   * returns its results already sorted. */
  function knnClimb(root, x, y, k) {
    k = Math.max(1, k | 0);
    var scale = Math.cos(y * Math.PI / 180);
    var cand = [], r2 = Infinity;
    var visited = new Set(), pruned = new Set();
    var tested = [], openedLeaves = [], TESTED_CAP = 50000;
    var examined = 0, leavesVisited = 0, sorts = 0;

    function dist2(p) {
      var dx = (p.x - x) * scale, dy = p.y - y;
      return dx * dx + dy * dy;
    }
    function boxDist2(c) {
      var dx = x < c.minX ? c.minX - x : (x > c.maxX ? x - c.maxX : 0);
      var dy = y < c.minY ? c.minY - y : (y > c.maxY ? y - c.maxY : 0);
      dx *= scale;
      return dx * dx + dy * dy;
    }
    function settle() {
      sorts++;
      cand.sort(function (a, b) { return a.d - b.d; });
      if (cand.length > k) cand.length = k;
      // Until k candidates exist there is no k-th distance to prune by.
      r2 = cand.length === k ? cand[k - 1].d : Infinity;
    }
    function measure(node) {
      visited.add(node.id);
      leavesVisited++;
      openedLeaves.push(node);
      for (var i = 0; i < node.points.length; i++) {
        var p = node.points[i];
        examined++;
        if (tested.length < TESTED_CAP) tested.push(p);
        var d = dist2(p);
        if (d <= r2) cand.push({ p: p, d: d });
      }
    }

    if (!root) return emptyResult(k);

    /* ---- phase 1: seed ---- */
    var node = root;
    while (!node.points) {
      visited.add(node.id);
      node = (node.axis === 0 ? x : y) <= node.split ? node.left : node.right;
    }
    while (node.count < k && node.parent) node = node.parent;
    var seedNode = node;
    (function collect(n) {
      if (!n) return;
      if (n.points) { measure(n); return; }
      visited.add(n.id);
      collect(n.left);
      collect(n.right);
    })(seedNode);
    settle();

    /* ---- phase 2: climb, one sibling per level ---- */
    var cur = seedNode;
    while (cur.parent) {
      var parent = cur.parent;
      var sibling = parent.left === cur ? parent.right : parent.left;
      visited.add(parent.id);
      if (boxDist2(sibling.bbox) <= r2) {
        (function search(n) {
          if (!n) return;
          if (boxDist2(n.bbox) > r2) { pruned.add(n.id); return; }
          if (n.points) {
            measure(n);
            if (cand.length >= 2 * k) settle();
            return;
          }
          visited.add(n.id);
          var near = (n.axis === 0 ? x : y) <= n.split ? n.left : n.right;
          search(near);
          search(near === n.left ? n.right : n.left);
        })(sibling);
        settle();
      } else {
        pruned.add(sibling.id);
      }
      cur = parent;
    }
    settle();

    return {
      results: cand.map(function (e) {
        return { point: e.p, dist: Math.sqrt(e.d) * 111320 };
      }),
      visited: visited, pruned: pruned, tested: tested,
      openedLeaves: openedLeaves,
      testedCapped: examined > tested.length,
      examined: examined, leavesVisited: leavesVisited,
      sorts: sorts, seedCount: seedNode.count, seedDepth: seedNode.depth,
      radius: cand.length ? Math.sqrt(cand[cand.length - 1].d) * 111320 : 0
    };
  }

  function emptyResult() {
    return { results: [], visited: new Set(), pruned: new Set(), tested: [],
             openedLeaves: [], testedCapped: false, examined: 0,
             leavesVisited: 0, sorts: 0, seedCount: 0, seedDepth: 0, radius: 0 };
  }

  function eachNode(root, fn) {
    var stack = root ? [root] : [];
    while (stack.length) {
      var n = stack.pop();
      fn(n);
      if (n.left) stack.push(n.left);
      if (n.right) stack.push(n.right);
    }
  }

  /* All points under a node (leaves are the only holders). */
  function collect(node, limit) {
    var out = [];
    eachNode(node, function (n) {
      if (n.points && (!limit || out.length < limit)) out.push.apply(out, n.points);
    });
    return limit ? out.slice(0, limit) : out;
  }

  global.KD = {
    build: build, locate: locate, nearest: nearest,
    knn: knn, knnClimb: knnClimb,
    eachNode: eachNode, collect: collect
  };
})(window);
