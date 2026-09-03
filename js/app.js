/* Wires map, cache, Overture download, kd-tree build and kNN search together. */
(function () {
  'use strict';

  var SETTINGS_KEY = 'kdtree-demo:v2:settings';
  var DRAW_LIMIT = 30000;   // Leaflet markers the map will draw before sampling

  var $ = function (id) { return document.getElementById(id); };
  var state = {
    bbox: null,
    points: [],
    tree: null,
    query: null,        // L.LatLng
    search: null,       // knn result
    pathIds: new Set(),
    targetLeafId: null,
    selectedId: null,
    source: '',
    abort: null,          // AbortController for the running Overture job
    partial: 0,           // items seen so far in that job
    path: [],            // root -> leaf descent for the current query point
    focusIndex: 0,       // which node on that path the tree view is parked on
    estimate: null,      // cost estimate from the Parquet row-group statistics
    estimateKey: null    // the box+filter that estimate belongs to
  };

  var mapView, treeView;

  function settings() {
    return {
      leafSize: clampInt($('leaf-size').value, 1, 2000, 8),
      k: clampInt($('k-value').value, 1, 500, 10),
      maxDepth: clampInt($('max-depth').value, 1, 30, 7),
      limit: clampInt($('max-venues').value, 1, 5000000, 1000000),
      namedOnly: $('named-only').checked,
      minConfidence: clampFloat($('min-conf').value, 0, 1, 0),
      showSplits: $('show-splits').checked,
      showVenues: $('show-venues').checked
    };
  }
  function clampFloat(v, lo, hi, dflt) {
    var n = parseFloat(v);
    if (!isFinite(n)) return dflt;
    return Math.min(hi, Math.max(lo, n));
  }
  function clampInt(v, lo, hi, dflt) {
    var n = parseInt(String(v).replace(/\s/g, ''), 10);
    if (!isFinite(n)) return dflt;
    return Math.min(hi, Math.max(lo, n));
  }

  function saveSettings() {
    var s = settings();
    if (state.bbox) {
      s.bbox = {
        south: state.bbox.south, west: state.bbox.west,
        north: state.bbox.north, east: state.bbox.east
      };
    }
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch (e) {}
  }
  function loadSettings() {
    var s;
    try { s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null'); } catch (e) {}
    if (!s) return null;
    if (s.leafSize) $('leaf-size').value = s.leafSize;
    if (s.k) $('k-value').value = s.k;
    if (s.maxDepth) $('max-depth').value = s.maxDepth;
    if (s.limit) $('max-venues').value = fmtNum(s.limit);
    if (typeof s.namedOnly === 'boolean') $('named-only').checked = s.namedOnly;
    if (s.minConfidence != null) $('min-conf').value = s.minConfidence;
    return s;
  }

  function status(msg, kind) {
    var e = $('status');
    e.textContent = msg;
    e.style.color = kind === 'error' ? '#ff8a8a'
      : (kind === 'ok' ? '#4ade80' : '');
  }

  function updateCacheInfo() {
    var st = VenueCache.stats();
    $('cache-info').textContent = 'cache: ' + st.entries + ' set' +
      (st.entries === 1 ? '' : 's') + ' · ' + fmtBytes(st.bytes);
  }

  /* performance.now() is clamped to ~0.1 ms in browsers, so a single kNN call
   * reads as 0. Repeat it briefly and report the per-query cost instead. */
  function timeQuery(fn) {
    var t0 = performance.now();
    var out = fn();
    var single = performance.now() - t0;
    var reps = 1, elapsed = single;
    if (single < 1) {
      var t1 = performance.now();
      reps = 0;
      do { fn(); reps++; elapsed = performance.now() - t1; }
      while (elapsed < 4 && reps < 2000);
    }
    return { value: out, ms: elapsed / reps, reps: reps };
  }

  /* 1.5 -> "1.50 ms", 0.05 -> "50.0 µs", 0.00004 -> "40 ns" */
  function fmtDuration(ms) {
    if (ms >= 1) return ms.toFixed(2) + ' ms';
    if (ms >= 0.001) return (ms * 1000).toFixed(1) + ' µs';
    return Math.round(ms * 1e6) + ' ns';
  }

  /* 1000000 -> "1 000 000", used everywhere numbers are shown. */
  function fmtNum(n) {
    return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  }

  /* Keeps a text input grouped as you type, without moving the caret. */
  function groupDigits(el) {
    el.addEventListener('input', function () {
      var caret = el.selectionStart;
      var digitsBefore = el.value.slice(0, caret).replace(/\D/g, '').length;
      var digits = el.value.replace(/\D/g, '').replace(/^0+(?=\d)/, '');
      el.value = digits ? fmtNum(digits) : '';
      var pos = 0, seen = 0;
      while (pos < el.value.length && seen < digitsBefore) {
        if (/\d/.test(el.value[pos])) seen++;
        pos++;
      }
      el.setSelectionRange(pos, pos);
    });
  }

  function fmtBytes(n) {
    return n < 1024 ? n + ' B'
      : n < 1048576 ? (n / 1024).toFixed(0) + ' KB'
      : (n / 1048576).toFixed(1) + ' MB';
  }

  function setMode(mode) {
    $('btn-select-box').classList.toggle('active', mode === 'box');
    $('btn-pick').classList.toggle('active', mode === 'point');
    mapView.setMode(mode);
  }

  function requestOpts() {
    var s = settings();
    return {
      namedOnly: s.namedOnly,
      limit: s.limit,
      minConfidence: s.minConfidence,
      release: Overture.release()
    };
  }

  /* ---------- progress / cancellation ---------- */

  function startJob(label) {
    state.abort = new AbortController();
    $('progress').hidden = false;
    $('progress-fill').style.width = '0%';
    $('progress-fill').classList.add('indeterminate');
    $('progress-label').textContent = label;
    $('btn-download').disabled = true;
    $('btn-count').disabled = true;
    state.bytes = 0;
    return {
      signal: state.abort.signal,
      onProgress: onProgress,
      onPartial: function (n) { state.partial = n; },
      onBytes: function (n) { state.bytes = n; }
    };
  }

  function onProgress(done, total, note) {
    var fill = $('progress-fill');
    if (total > 1 || done > 0) {
      fill.classList.remove('indeterminate');
      fill.style.width = Math.round(100 * done / Math.max(1, total)) + '%';
    }
    var bits = [];
    if (total > 1) bits.push('step ' + Math.min(done + 1, total) + '/' + total);
    if (state.bytes) bits.push(fmtBytes(state.bytes) + ' read');
    if (note) bits.push(note);
    $('progress-label').textContent = bits.join(' · ');
  }

  function endJob() {
    state.abort = null;
    state.partial = 0;
    state.bytes = 0;
    $('progress').hidden = true;
    $('progress-fill').classList.remove('indeterminate');
    $('btn-download').disabled = false;
    $('btn-count').disabled = false;
  }

  function isCancelled(err) {
    return err instanceof Overture.Cancelled ||
      (err && (err.name === 'Cancelled' || err.name === 'AbortError'));
  }

  /* ---------- how many venues are in the box ---------- */

  function boxKey() {
    if (!state.bbox) return null;
    var b = state.bbox;
    return [b.south, b.west, b.north, b.east, settings().namedOnly].join('|');
  }

  function loadedInBox() {
    if (!state.bbox) return 0;
    var b = state.bbox, n = 0;
    for (var i = 0; i < state.points.length; i++) {
      var p = state.points[i];
      if (p.y >= b.south && p.y <= b.north && p.x >= b.west && p.x <= b.east) n++;
    }
    return n;
  }

  function updateBoxCount() {
    var e = $('box-count');
    if (!state.bbox) {
      e.textContent = 'no box selected';
      e.className = 'chip empty';
      e.title = 'draw a box on the map, or press "use view"';
      return;
    }
    e.className = 'chip';
    var haveEst = state.estimate && state.estimateKey === boxKey();
    var parts = [];
    if (!state.points.length) {
      parts.push('no venues downloaded yet');
    } else {
      var inBox = loadedInBox();
      parts.push(inBox === state.points.length
        ? fmtNum(inBox) + ' venues in box'
        : fmtNum(inBox) + ' in box (of ' + fmtNum(state.points.length) + ' downloaded)');
    }
    if (haveEst && state.estimate.rows) {
      parts.push('~' + fmtNum(state.estimate.rows) + ' candidates');
    }
    e.textContent = parts.join(' · ');
    e.title = haveEst && state.estimate.rows
      ? 'rows in the Parquet row groups that overlap this box (' +
        fmtBytes(state.estimate.bytes) + '–' + fmtBytes(state.estimate.maxBytes) +
        ' to read); most fall outside it and are filtered out after reading'
      : 'downloaded venues that fall inside the selected box';
  }

  function estimateInBox() {
    if (!state.bbox) { status('Select a bounding box first.', 'error'); return; }
    var s = settings();
    var key = boxKey();
    var hooks = startJob('reading Parquet footers…');
    status('Checking what this box costs…');
    Overture.estimate(state.bbox, requestOpts(), hooks)
      .then(function (res) {
        state.estimate = res;
        state.estimateKey = key;
        updateBoxCount();
        if (!res.rows) {
          status('No Overture data covers that box.', 'error');
          return;
        }
        status('This box needs ' + res.groups + ' row-group run' +
          (res.groups === 1 ? '' : 's') + ' from ' + res.files + ' file' +
          (res.files === 1 ? '' : 's') + ': ' + fmtNum(res.rows) +
          ' candidate rows, ' + fmtBytes(res.bytes) + '–' + fmtBytes(res.maxBytes) +
          ' to read' +
          ' (footers cost ' + fmtBytes(res.metaBytes) + ', now cached)' +
          (res.rows > s.limit * 4
            ? ' — the "max venues" limit of ' + fmtNum(s.limit) + ' may cut it short.'
            : '.'), 'ok');
      })
      .catch(function (err) {
        status(isCancelled(err) ? 'Estimate cancelled.' : explain(err),
          isCancelled(err) ? '' : 'error');
      })
      .then(endJob);
  }

  /* ---------- data ---------- */

  function download() {
    if (!state.bbox) { status('Select a bounding box first.', 'error'); return; }
    var s = settings();
    var opts = requestOpts();
    var key = VenueCache.keyFor(state.bbox, opts);

    var cached = VenueCache.get(key);
    if (cached) {
      state.source = 'cache (' + new Date(cached.ts).toLocaleString() + ')';
      usePoints(cached.points, cached.truncated);
      status('Loaded ' + fmtNum(cached.points.length) + ' venues from localStorage.', 'ok');
      updateBoxCount();
      return;
    }

    var hooks = startJob('opening Overture…');
    status('Reading Overture Places for this box…');
    Overture.fetchVenues(state.bbox, opts, hooks)
      .then(function (res) {
        state.source = 'overture ' + Overture.release();
        // Build the tree first: caching is a convenience and must never delay
        // (or, if it throws, prevent) the thing the user actually asked for.
        usePoints(res.points, res.truncated);
        updateBoxCount();
        var base = 'Got ' + fmtNum(res.points.length) + ' venues from ' +
          fmtNum(res.scanned) + ' rows scanned · ' +
          fmtBytes(res.bytes) + ' read over ' + res.batches + ' range request' +
          (res.batches === 1 ? '' : 's') +
          (res.truncated ? ' — stopped at the "max venues" limit' : '');
        status(base + ' · caching…', 'ok');
        // Serialising a large set takes a moment; let the tree paint first.
        setTimeout(function () {
          var stored = VenueCache.set(key, res.points, res.truncated);
          updateCacheInfo();
          status(base + (stored.ok
            ? ' · cached ' + fmtBytes(stored.bytes)
            : stored.reason === 'too-large'
              ? ' · too large for localStorage to serialise'
              : ' · not cached (localStorage full)'), 'ok');
        }, 0);
      })
      .catch(function (err) {
        status(isCancelled(err) ? 'Download cancelled.' : explain(err),
          isCancelled(err) ? '' : 'error');
      })
      .then(endJob);
  }

  /* A venue set bundled with the demo, so it works with no network at all.
   * Injected as a <script> rather than fetched, so it also works over file://. */
  function loadSample() {
    if (global_SAMPLE()) return applySample();
    $('btn-sample').disabled = true;
    status('Loading bundled sample…');
    var tag = document.createElement('script');
    tag.src = 'data/sample-berlin.js';
    tag.onload = function () { $('btn-sample').disabled = false; applySample(); };
    tag.onerror = function () {
      $('btn-sample').disabled = false;
      status('Could not load data/sample-berlin.js — is it next to index.html?',
        'error');
    };
    document.head.appendChild(tag);
  }

  function global_SAMPLE() { return window.SAMPLE_VENUES; }

  function applySample() {
    var d = global_SAMPLE();
    if (!d) { status('Sample data is missing.', 'error'); return; }
    var b = L.latLngBounds([d.bbox.south, d.bbox.west], [d.bbox.north, d.bbox.east]);
    mapView.setBBox(b);
    state.bbox = mapView.getBBox();
    mapView.map.fitBounds(b, { padding: [20, 20] });
    state.estimate = null;
    state.estimateKey = null;
    state.source = 'bundled sample';
    usePoints(d.p.map(function (r) {
      return { y: r[0], x: r[1], name: r[2] || '', cat: r[3] || '' };
    }), false);
    updateBoxCount();
    saveSettings();
    status('Loaded ' + fmtNum(d.p.length) + ' bundled venues (' + d.name + ', captured ' +
      d.fetched + ') — no network needed.', 'ok');
  }

  /* Plotting every venue stops being viable well before a million markers, so
   * beyond DRAW_LIMIT the map shows an evenly strided sample. The tree and the
   * search always use the full set. */
  function drawVenues() {
    if (!settings().showVenues) { mapView.venueLayer.clearLayers(); return 0; }
    return mapView.showVenues(state.points, DRAW_LIMIT);
  }

  function drawTested() {
    if (!state.search || !$('show-tested').checked) {
      mapView.testedLayer.clearLayers();
      return 0;
    }
    return mapView.showTested(state.search.tested, DRAW_LIMIT);
  }

  /* Hand a freshly loaded venue set to the map and the tree. */
  function usePoints(points, truncated) {
    state.points = points;
    state.truncated = truncated;
    if (!points.length) {
      state.tree = null;
      mapView.clearData();
      treeView.render(null);
      updateBoxCount();
      status('No venues found in that box. Try a bigger box, uncheck "named ' +
        'only", or lower the confidence filter.', 'error');
      return;
    }
    drawVenues();
    rebuild();
  }

  /* The failure modes here are the CDN, the S3 bucket, or the shipped index. */
  function explain(err) {
    var m = String(err && err.message || err);
    if (/Parquet reader|jsDelivr|import/i.test(m)) {
      return 'Could not load the Parquet reader from jsDelivr: ' + m +
        '. The demo needs it to read Overture — check the network, or press ' +
        '"load sample" to work offline.';
    }
    if (/overture-index/i.test(m)) {
      return 'data/overture-index.js did not load — it must sit next to ' +
        'index.html. Press "load sample" to work without it.';
    }
    if (/HTTP 40[34]/.test(m)) {
      return 'Overture returned ' + m + '. Release ' + Overture.release() +
        ' may have been rotated out; regenerate the index with ' +
        'scripts/build-overture-index.js.';
    }
    if (/Failed to fetch|NetworkError|CORS/i.test(m)) {
      return 'Network request to the Overture bucket failed (' + m + '). Note ' +
        'this needs a real http(s) origin — over file:// the browser blocks ' +
        'the range requests; use "load sample" instead.';
    }
    return 'Overture request failed: ' + m;
  }

  /* ---------- tree ---------- */

  function rebuild() {
    if (!state.points.length) return;
    var s = settings();
    var rootCell = state.bbox ? {
      minX: state.bbox.west, minY: state.bbox.south,
      maxX: state.bbox.east, maxY: state.bbox.north
    } : null;
    var t0 = performance.now();
    state.tree = KD.build(state.points, s.leafSize, rootCell);
    var ms = performance.now() - t0;
    state.buildMs = ms;
    // Node objects are new after a rebuild, so any selection is stale.
    state.selectedId = null;
    state.selectedNode = null;
    state.path = [];
    state.focusIndex = 0;
    if (treeView) treeView.resetExpansion();   // node ids are new after a rebuild
    mapView.cellLayer.clearLayers();
    if (state.query) runSearch();
    else {
      state.pathIds = new Set();
      state.targetLeafId = null;
      state.search = null;
      updateStepper();
      renderPathList();
      renderTree();
      renderSplits();
      mapView.cellLayer.clearLayers();
      mapView.resultLayer.clearLayers();
      renderDetail();
    }
    updateTreeStats();
  }

  function updateTreeStats() {
    if (!state.tree) { $('tree-stats').textContent = ''; return; }
    var st = state.tree.stats;
    $('tree-stats').textContent = fmtNum(st.points) + ' pts · ' + fmtNum(st.nodes) +
      ' nodes · ' + fmtNum(st.leaves) + ' leaves · depth ' + st.maxDepth +
      ' · leaf≤' + st.leafSize + ' · built in ' + fmtDuration(state.buildMs);
  }

  function renderTree() {
    var s = settings();
    var hits = {};
    if (state.search) {
      state.search.results.forEach(function (r) {
        var leaf = KD.locate(state.tree.root, r.point.x, r.point.y);
        var id = leaf[leaf.length - 1].node.id;
        hits[id] = (hits[id] || 0) + 1;
      });
    }
    treeView.render(state.tree, {
      pathIds: state.pathIds,
      targetId: state.targetLeafId,
      visited: state.search && state.search.visited,
      pruned: state.search && state.search.pruned,
      hitCounts: hits,
      maxDepth: s.maxDepth,
      selectedId: state.selectedId
    });
    $('tree-empty').style.display = state.tree ? 'none' : '';
    if (!state.keepView) treeView.fit();
  }

  function renderSplits() {
    var s = settings();
    if (!s.showSplits) { mapView.splitLayer.clearLayers(); return; }
    mapView.showSplits(state.tree, s.maxDepth, state.pathIds);
  }

  /* ---------- query ---------- */

  function runSearch() {
    if (!state.tree || !state.query) return;
    var s = settings();
    var x = state.query.lng, y = state.query.lat;
    var timed = timeQuery(function () {
      return KD.knn(state.tree.root, x, y, s.k);
    });
    var res = timed.value, ms = timed.ms;
    state.searchReps = timed.reps;

    var path = KD.locate(state.tree.root, x, y);
    state.path = path;
    state.pathIds = new Set(path.map(function (e) { return e.node.id; }));
    state.targetLeafId = path[path.length - 1].node.id;
    state.search = res;
    state.searchMs = ms;
    state.leafNode = path[path.length - 1].node;

    mapView.showQuery(state.query);
    drawTested();
    mapView.showResults(state.query, res.results, res.radius);
    renderSplits();
    renderTree();
    // Start at the root: the point of the demo is watching the descent.
    stepTo(0, { keepMapView: true });

    var brute = state.points.length;
    status('k=' + s.k + ' nearest found in ' + fmtDuration(ms) +
      (state.searchReps > 1 ? ' (mean of ' + fmtNum(state.searchReps) + ' runs)' : '') +
      ' · ' + fmtNum(res.examined) + ' of ' + fmtNum(brute) +
      ' venues tested (' + (100 * res.examined / brute).toFixed(1) +
      '%, violet on the map) · ' + res.pruned.size + ' subtrees pruned', 'ok');
  }

  /* ---------- stepping down the query path ---------- */

  /* Parks the tree view (and the map) on path node `i`, root = 0. */
  function stepTo(i, opts) {
    opts = opts || {};
    if (!state.path.length) return;
    i = Math.min(state.path.length - 1, Math.max(0, i));
    state.focusIndex = i;
    var node = state.path[i].node;
    state.selectedNode = node;
    state.selectedId = node.id;

    state.keepView = true;
    renderTree();
    state.keepView = false;
    treeView.focusOn(node.id, 1);

    mapView.highlightCell(node.cell, { color: node.points ? '#4ade80' : '#ffb454' });
    if (!opts.keepMapView) mapView.zoomToCell(node.cell);

    updateStepper();
    renderPathList();
    renderDetail();
  }

  /* Rough real-world size of a node's region, for the region list. */
  function cellSize(c) {
    var midLat = (c.minY + c.maxY) / 2 * Math.PI / 180;
    var w = (c.maxX - c.minX) * 111320 * Math.cos(midLat);
    var h = (c.maxY - c.minY) * 111320;
    return fmtLen(w) + ' × ' + fmtLen(h);
  }
  function fmtLen(m) {
    return m >= 1000 ? (m / 1000).toFixed(m >= 10000 ? 0 : 1) + ' km'
      : (m >= 10 ? Math.round(m) : m.toFixed(1)) + ' m';
  }

  /* Every region from the root down to the leaf holding the query point. */
  function renderPathList() {
    var list = $('path-list');
    list.textContent = '';
    if (!state.path.length) {
      var empty = document.createElement('div');
      empty.id = 'path-empty';
      empty.className = 'muted';
      empty.textContent = 'Pick a point on the map to see the regions it falls through.';
      list.appendChild(empty);
      return;
    }
    state.path.forEach(function (entry, i) {
      var n = entry.node;
      var row = document.createElement('button');
      row.type = 'button';
      row.className = 'path-row' + (i === state.focusIndex ? ' current' : '') +
        (n.points ? ' leaf' : '');
      row.title = 'depth ' + n.depth + ' · ' + fmtNum(n.count) + ' venues · region ' +
        cellSize(n.cell);

      var depth = document.createElement('span');
      depth.className = 'depth';
      depth.textContent = i;
      row.appendChild(depth);

      var rule = document.createElement('span');
      rule.className = 'rule';
      rule.textContent = n.points
        ? 'leaf · ' + fmtNum(n.count) + ' venues'
        : (n.axis === 0 ? 'lon' : 'lat') + ' ≤ ' + n.split.toFixed(5) +
          '  (' + fmtNum(n.count) + ')';
      row.appendChild(rule);

      var size = document.createElement('span');
      size.className = 'size';
      size.textContent = cellSize(n.cell);
      row.appendChild(size);

      var dir = document.createElement('span');
      dir.className = 'dir ' + (entry.wentLeft ? 'left' : 'right');
      dir.textContent = entry.wentLeft == null ? '◆' : (entry.wentLeft ? '≤' : '>');
      row.appendChild(dir);

      row.addEventListener('click', function () { stepTo(i); });
      // hovering previews the region without moving the map
      row.addEventListener('mouseenter', function () {
        mapView.highlightCell(n.cell, { color: '#9aa6b8', fillOpacity: 0.06 });
      });
      row.addEventListener('mouseleave', function () {
        var cur = state.path[state.focusIndex].node;
        mapView.highlightCell(cur.cell,
          { color: cur.points ? '#4ade80' : '#ffb454' });
      });
      list.appendChild(row);
    });

    var cur = list.children[state.focusIndex];
    if (cur && cur.scrollIntoView) cur.scrollIntoView({ block: 'nearest' });
  }

  function updateStepper() {
    var have = state.path.length > 0;
    var i = state.focusIndex;
    $('btn-up').disabled = !have || i === 0;
    $('btn-down').disabled = !have || i >= state.path.length - 1;
    $('step-label').textContent = have
      ? 'depth ' + i + ' / ' + (state.path.length - 1)
      : '—';
    $('step-label').title = have
      ? 'node ' + (i + 1) + ' of ' + state.path.length + ' on the path from the ' +
        'root to the leaf holding your point'
      : 'pick a point to walk the tree';
  }

  /* ---------- detail panel ---------- */

  function esc(s) {
    return String(s).replace(/[&<>]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c];
    });
  }

  function renderDetail() {
    var box = $('detail');
    box.textContent = '';

    if (state.selectedNode) {
      var n = state.selectedNode, c = n.cell;
      var onPath = state.pathIds.has(n.id);
      var head = document.createElement('div');
      var bits = [];
      bits.push('<div class="d-title">' +
        (onPath ? 'path step ' + state.focusIndex + ' — ' : '') +
        'node #' + n.id + (n.points ? ' (leaf)' : ' (internal)') + '</div>');
      if (onPath && !n.points) {
        var went = state.path[state.focusIndex] && state.path[state.focusIndex].wentLeft;
        if (went != null) {
          bits.push('the query point goes <b>' + (went ? '≤ left' : '> right') + '</b> here');
        }
      }
      bits.push('depth ' + n.depth + ' · ' + fmtNum(n.count) + ' venues · region ' +
        cellSize(n.cell));
      bits.push('cell lat [' + c.minY.toFixed(5) + ', ' + c.maxY.toFixed(5) + ']  lon [' +
        c.minX.toFixed(5) + ', ' + c.maxX.toFixed(5) + ']');
      head.innerHTML = bits.join('<br>');
      box.appendChild(head);

      if (n.points) {
        box.appendChild(sectionTitle('contents'));
        box.appendChild(venueList(n.points.map(function (p) {
          return { point: p };
        }), false));
      }
      var sep = document.createElement('div');
      sep.className = 'd-sep';
      box.appendChild(sep);
    }

    if (state.search) {
      var r = state.search;
      box.appendChild(sectionTitle(fmtNum(r.results.length) +
        ' nearest venues · radius ' + Math.round(r.radius) + ' m · ' +
        fmtDuration(state.searchMs)));
      box.appendChild(venueList(r.results, true));
      var foot = document.createElement('div');
      foot.className = 'd-sub';
      foot.textContent = 'visited ' + fmtNum(r.visited.size) + ' nodes · pruned ' +
        fmtNum(r.pruned.size) + ' · examined ' + fmtNum(r.examined) + ' points · ' +
        fmtNum(r.leavesVisited) + ' leaves opened';
      box.appendChild(foot);
    } else if (!state.selectedNode) {
      var hint = document.createElement('span');
      hint.className = 'muted';
      hint.textContent = 'Pick a point on the map to run a k-nearest search.';
      box.appendChild(hint);
    }
  }

  function sectionTitle(text) {
    var d = document.createElement('div');
    d.className = 'd-title';
    d.textContent = text;
    return d;
  }

  /* Clickable venue rows: clicking one centres the map on that venue. */
  function venueList(entries, ranked) {
    var list = document.createElement('div');
    list.className = 'venue-list';
    entries.forEach(function (e, i) {
      var p = e.point;
      var row = document.createElement('button');
      row.type = 'button';
      row.className = 'venue-row' +
        (state.focusedVenue === p ? ' current' : '');
      row.title = 'Show ' + (p.name || 'this venue') + ' on the map';

      if (ranked) {
        var rank = document.createElement('span');
        rank.className = 'rank';
        rank.textContent = (i + 1);
        row.appendChild(rank);
      }
      var name = document.createElement('span');
      name.className = 'vname';
      name.textContent = p.name || '(unnamed)';
      row.appendChild(name);

      if (e.dist != null) {
        var d = document.createElement('span');
        d.className = 'vdist';
        d.textContent = Math.round(e.dist) + ' m';
        row.appendChild(d);
      }
      var cat = document.createElement('span');
      cat.className = 'vcat';
      cat.textContent = p.cat || '';
      row.appendChild(cat);

      row.addEventListener('click', function () {
        state.focusedVenue = p;
        mapView.focusVenue(p);
        var rows = list.querySelectorAll('.venue-row');
        for (var j = 0; j < rows.length; j++) rows[j].classList.remove('current');
        row.classList.add('current');
      });
      list.appendChild(row);
    });
    return list;
  }

  /* ---------- init ---------- */

  function init() {
    var saved = loadSettings();

    mapView = new MapView('map', {
      onBBox: function (bbox) {
        state.bbox = bbox;
        saveSettings();
        updateBoxCount();
        status('Box selected: ' + fmtBBox(bbox) + '. Now download venues, or ' +
          'press "estimate" to see what it will cost.');
        setMode('point');
      },
      onPoint: function (latlng) {
        if (!state.tree) {
          status('Download venues and build a tree first.', 'error');
          return;
        }
        state.query = latlng;
        state.selectedNode = null;
        state.selectedId = null;
        state.keepView = true;
        runSearch();
        state.keepView = false;
      }
    });

    treeView = new TreeView($('tree-svg'), function (node, collapsed) {
      // A collapsed stub opens up, so every node in the tree is reachable by
      // clicking, without touching the global "depth shown" setting.
      if (collapsed) treeView.expand(node.id);

      // If it sits on the query path, go through the stepper so the region
      // list and the up/deeper buttons stay in sync.
      for (var i = 0; i < state.path.length; i++) {
        if (state.path[i].node.id === node.id) { stepTo(i); return; }
      }

      state.selectedNode = node;
      state.selectedId = node.id;
      mapView.zoomToCell(node.cell);
      mapView.highlightCell(node.cell, {
        color: node.points ? '#4ade80' : '#ffb454'
      });
      state.keepView = true;
      renderTree();
      state.keepView = false;
      treeView.focusOn(node.id, collapsed ? 1 : 0);
      renderDetail();
    });

    if (saved && saved.bbox) {
      var b = L.latLngBounds([saved.bbox.south, saved.bbox.west],
                             [saved.bbox.north, saved.bbox.east]);
      mapView.setBBox(b);
      state.bbox = mapView.getBBox();
      mapView.map.fitBounds(b, { padding: [20, 20] });
      status('Restored last bounding box. Download venues to continue.');
    }

    setMode('point');
    updateCacheInfo();
    updateBoxCount();
    updateStepper();
    renderPathList();

    $('btn-select-box').addEventListener('click', function () { setMode('box'); });
    $('btn-pick').addEventListener('click', function () { setMode('point'); });
    $('btn-use-view').addEventListener('click', function () {
      state.bbox = mapView.useCurrentView();
      saveSettings();
      updateBoxCount();
      status('Box set to current view: ' + fmtBBox(state.bbox));
    });
    $('btn-download').addEventListener('click', download);
    $('btn-sample').addEventListener('click', loadSample);
    $('btn-count').addEventListener('click', estimateInBox);
    $('btn-cancel').addEventListener('click', function () {
      if (state.abort) state.abort.abort();
    });
    $('btn-rebuild').addEventListener('click', function () { rebuild(); saveSettings(); });
    $('btn-fit').addEventListener('click', function () { treeView.fit(); });
    $('btn-up').addEventListener('click', function () { stepTo(state.focusIndex - 1); });
    $('btn-down').addEventListener('click', function () { stepTo(state.focusIndex + 1); });
    document.addEventListener('keydown', function (e) {
      var t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
      if (e.key === 'ArrowDown') { stepTo(state.focusIndex + 1); e.preventDefault(); }
      else if (e.key === 'ArrowUp') { stepTo(state.focusIndex - 1); e.preventDefault(); }
    });
    $('btn-clear-cache').addEventListener('click', function () {
      VenueCache.clear();
      updateCacheInfo();
      status('Cache cleared.');
    });

    $('leaf-size').addEventListener('change', function () { rebuild(); saveSettings(); });
    $('k-value').addEventListener('change', function () { runSearch(); saveSettings(); });
    $('max-depth').addEventListener('change', function () {
      renderTree(); renderSplits(); saveSettings();
    });
    $('show-splits').addEventListener('change', renderSplits);
    $('show-tested').addEventListener('change', drawTested);
    $('show-venues').addEventListener('change', function () {
      var drawn = drawVenues();
      if (drawn && drawn < state.points.length) {
        status('Showing ' + fmtNum(drawn) + ' of ' +
          fmtNum(state.points.length) + ' venues on the map; the tree ' +
          'and the search use all of them.');
      }
    });
    $('named-only').addEventListener('change', function () {
      updateBoxCount();
      saveSettings();
    });
    $('min-conf').addEventListener('change', saveSettings);
    groupDigits($('max-venues'));
    $('max-venues').addEventListener('change', saveSettings);

    window.addEventListener('resize', function () {
      if (state.tree) treeView.fit();
    });
  }

  function fmtBBox(b) {
    return '[' + b.south.toFixed(4) + ', ' + b.west.toFixed(4) + '] – [' +
      b.north.toFixed(4) + ', ' + b.east.toFixed(4) + ']';
  }

  document.addEventListener('DOMContentLoaded', init);
})();
