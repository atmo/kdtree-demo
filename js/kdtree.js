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

  function build(points, leafSize, rootCell) {
    leafSize = Math.max(1, leafSize | 0);
    var n = points.length;
    var idx = new Int32Array(n);
    for (var i = 0; i < n; i++) idx[i] = i;

    var stats = { nodes: 0, leaves: 0, maxDepth: 0, points: n, leafSize: leafSize };
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
      var axis = spanX >= spanY ? 0 : 1;
      var key = axis === 0 ? 'x' : 'y';

      var mid = chooseSplit(lo, hi, key);
      if (mid === null) {                       // try the other axis instead
        axis = 1 - axis;
        key = axis === 0 ? 'x' : 'y';
        mid = chooseSplit(lo, hi, key);
        if (mid === null) return makeLeaf(node, lo, hi);  // all points identical
      }

      var split = -Infinity;
      for (var i = lo; i <= mid; i++) {
        var v = points[idx[i]][key];
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
      testedCapped: examined > tested.length,
      examined: examined,
      leavesVisited: leavesVisited,
      radius: results.length ? results[results.length - 1].dist : 0
    };
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
    build: build, locate: locate, nearest: nearest, knn: knn,
    eachNode: eachNode, collect: collect
  };
})(window);
