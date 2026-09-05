/* SVG rendering of the kd-tree: pan/zoom, depth-limited expansion, and
 * per-node styling for the query path and the kNN search frontier. */
(function (global) {
  'use strict';

  var NS = 'http://www.w3.org/2000/svg';
  var BOX_W = 116, BOX_H = 34, H_GAP = 12, V_GAP = 68;

  function el(name, attrs, parent) {
    var n = document.createElementNS(NS, name);
    for (var k in attrs) if (attrs[k] != null) n.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(n);
    return n;
  }

  function TreeView(svg, onSelect) {
    this.svg = svg;
    this.onSelect = onSelect;
    this.root = el('g', {}, svg);
    this.edges = el('g', {}, this.root);
    this.nodes = el('g', {}, this.root);
    this.tx = 0; this.ty = 0; this.scale = 1;
    this.content = null;
    this.expandedIds = new Set();   // subtrees the user drilled into by clicking
    this._bindPanZoom();
  }

  TreeView.prototype._apply = function () {
    this.root.setAttribute('transform',
      'translate(' + this.tx + ',' + this.ty + ') scale(' + this.scale + ')');
  };

  TreeView.prototype._bindPanZoom = function () {
    var self = this, dragging = false, sx = 0, sy = 0, moved = 0;
    this.svg.addEventListener('wheel', function (e) {
      e.preventDefault();
      var r = self.svg.getBoundingClientRect();
      var mx = e.clientX - r.left, my = e.clientY - r.top;
      var f = Math.exp(-e.deltaY * 0.0015);
      var ns = Math.min(4, Math.max(0.04, self.scale * f));
      f = ns / self.scale;
      self.tx = mx - (mx - self.tx) * f;
      self.ty = my - (my - self.ty) * f;
      self.scale = ns;
      self._apply();
    }, { passive: false });

    this.svg.addEventListener('pointerdown', function (e) {
      if (e.button !== 0) return;
      dragging = true; moved = 0; sx = e.clientX; sy = e.clientY;
      self.svg.classList.add('dragging');
    });
    // Listen on the document rather than capturing the pointer: capture would
    // redirect the following click away from the node the user pressed on.
    document.addEventListener('pointermove', function (e) {
      if (!dragging) return;
      var dx = e.clientX - sx, dy = e.clientY - sy;
      moved += Math.abs(dx) + Math.abs(dy);
      sx = e.clientX; sy = e.clientY;
      self.tx += dx; self.ty += dy;
      self._apply();
    });
    document.addEventListener('pointerup', function () {
      if (!dragging) return;
      dragging = false;
      self.svg.classList.remove('dragging');
      self._suppressClick = moved > 4;
    });
  };

  /* opts: {pathIds, targetId, visited, pruned, maxDepth, selectedId} */
  TreeView.prototype.render = function (tree, opts) {
    opts = opts || {};
    this.edges.textContent = '';
    this.nodes.textContent = '';
    this.lastTree = tree;
    this.lastOpts = opts;
    if (!tree || !tree.root) { this.content = null; return; }

    var pathIds = opts.pathIds || new Set();
    var maxDepth = opts.maxDepth == null ? 7 : opts.maxDepth;
    var slot = 0, laid = [];

    var self0 = this;
    function expanded(n) {
      if (n.points) return false;
      return n.depth < maxDepth || self0.expandedIds.has(n.id) ||
             pathIds.has(n.id) || pathIds.has(n.left.id) || pathIds.has(n.right.id);
    }

    (function layout(n) {
      var e = expanded(n);
      var item = { node: n, collapsed: !e && !n.points, x: 0, y: n.depth * V_GAP };
      if (e) {
        var l = layout(n.left), r = layout(n.right);
        item.x = (l.x + r.x) / 2;
        item.kids = [l, r];
      } else {
        item.x = slot * (BOX_W + H_GAP);
        slot++;
      }
      laid.push(item);
      return item;
    })(tree.root);

    var minX = Infinity, maxX = -Infinity, maxY = -Infinity;
    laid.forEach(function (it) {
      if (it.x < minX) minX = it.x;
      if (it.x > maxX) maxX = it.x;
      if (it.y > maxY) maxY = it.y;
    });

    var self = this;
    laid.forEach(function (it) {
      if (!it.kids) return;
      it.kids.forEach(function (kid, i) {
        var cls = 'edge';
        if (pathIds.has(it.node.id) && pathIds.has(kid.node.id)) cls += ' on-path';
        var x1 = it.x, y1 = it.y + BOX_H / 2;
        var x2 = kid.x, y2 = kid.y - BOX_H / 2;
        var my = (y1 + y2) / 2;
        el('path', {
          class: cls,
          d: 'M' + x1 + ',' + y1 + ' C' + x1 + ',' + my + ' ' + x2 + ',' + my +
             ' ' + x2 + ',' + y2
        }, self.edges);
        el('text', {
          x: (x1 + x2) / 2 + (i === 0 ? -14 : 14), y: my + 3,
          'text-anchor': 'middle', class: 'sub',
          fill: pathIds.has(kid.node.id) ? '#ff6b6b' : '#8b94a7',
          'font-size': 9, 'font-family': 'ui-monospace, monospace'
        }, self.edges).textContent = i === 0 ? '≤' : '>';
      });
    });

    laid.forEach(function (it) {
      var n = it.node;
      var cls = 'node';
      if (n.points) cls += ' leaf';
      if (it.collapsed) cls += ' collapsed';
      if (n.points && opts.visited && opts.visited.has(n.id)) cls += ' opened';
      if (pathIds.has(n.id)) cls += ' on-path';
      if (n.id === opts.targetId) cls += ' target';
      if (n.id === opts.selectedId) cls += ' selected';
      var g = el('g', {
        class: cls,
        transform: 'translate(' + (it.x - BOX_W / 2) + ',' + (it.y - BOX_H / 2) + ')'
      }, self.nodes);
      g.__nodeId = n.id;

      if (opts.pruned && opts.pruned.has(n.id)) g.setAttribute('opacity', '0.32');

      el('rect', {
        class: 'body', x: 0, y: 0, width: BOX_W, height: BOX_H, rx: 6
      }, g);

      var opened = n.points && opts.visited && opts.visited.has(n.id);
      el('title', {}, g).textContent = it.collapsed
        ? n.count + ' venues below here — click to expand'
        : (n.points ? 'leaf with ' + n.count + ' venues' :
           'internal node, ' + n.count + ' venues') + ' — click to zoom the map to it';

      var line1, line2;
      if (it.collapsed) {
        line1 = '▾ expand';
        line2 = n.count + ' pts · d' + n.depth;
      } else if (n.points) {
        line1 = (opened ? '◆ ' : '') + 'leaf · ' + n.count + ' pts';
        line2 = n.points.length === 1 && n.points[0].name
          ? trunc(n.points[0].name, 17) : 'depth ' + n.depth;
      } else {
        line1 = (n.axis === 0 ? 'lon' : 'lat') + ' ≤ ' + n.split.toFixed(5);
        line2 = n.count + ' pts · d' + n.depth;
      }
      var t1 = el('text', {
        x: BOX_W / 2, y: 14, 'text-anchor': 'middle',
        class: n.axis === 0 ? 'axis-x' : (n.axis === 1 ? 'axis-y' : '')
      }, g);
      t1.textContent = line1;
      var t2 = el('text', { x: BOX_W / 2, y: 26, 'text-anchor': 'middle', class: 'sub' }, g);
      t2.textContent = line2;

      if (opts.hitCounts && opts.hitCounts[n.id]) {
        el('circle', { cx: BOX_W - 6, cy: 6, r: 5, fill: '#4da3ff' }, g);
        el('text', {
          x: BOX_W - 6, y: 9, 'text-anchor': 'middle', 'font-size': 8, fill: '#0f1115'
        }, g).textContent = opts.hitCounts[n.id];
      }

      g.addEventListener('click', function (ev) {
        ev.stopPropagation();
        if (self._suppressClick) { self._suppressClick = false; return; }
        if (self.onSelect) self.onSelect(n, it.collapsed);
      });
    });

    this.content = {
      minX: minX - BOX_W / 2 - 20, maxX: maxX + BOX_W / 2 + 20,
      minY: -BOX_H, maxY: maxY + BOX_H
    };
  };

  TreeView.prototype.fit = function () {
    if (!this.content) return;
    var r = this.svg.getBoundingClientRect();
    var w = this.content.maxX - this.content.minX;
    var h = this.content.maxY - this.content.minY;
    if (w <= 0 || h <= 0 || !r.width) return;
    this.scale = Math.min(4, Math.max(0.03, Math.min(r.width / w, r.height / h) * 0.94));
    this.tx = r.width / 2 - (this.content.minX + w / 2) * this.scale;
    this.ty = r.height / 2 - (this.content.minY + h / 2) * this.scale;
    this._apply();
  };

  TreeView.prototype.expand = function (nodeId) { this.expandedIds.add(nodeId); };
  TreeView.prototype.collapse = function (nodeId) { this.expandedIds.delete(nodeId); };
  TreeView.prototype.isExpanded = function (nodeId) { return this.expandedIds.has(nodeId); };
  TreeView.prototype.resetExpansion = function () { this.expandedIds.clear(); };

  /* Centre the view on one node; pass a scale to set the zoom level too. */
  TreeView.prototype.focusOn = function (nodeId, scale) {
    var boxes = this.nodes.childNodes, g = null;
    for (var i = 0; i < boxes.length; i++) {
      if (boxes[i].__nodeId === nodeId) { g = boxes[i]; break; }
    }
    if (!g) return false;
    var m = /translate\(([-\d.]+),([-\d.]+)\)/.exec(g.getAttribute('transform'));
    if (!m) return false;
    var r = this.svg.getBoundingClientRect();
    if (scale) this.scale = scale;
    this.tx = r.width / 2 - (+m[1] + BOX_W / 2) * this.scale;
    // a third of the way down, so the children below stay in view
    this.ty = r.height / 3 - (+m[2] + BOX_H / 2) * this.scale;
    this._apply();
    return true;
  };

  function trunc(s, n) { return s.length > n ? s.slice(0, n - 1) + '…' : s; }

  global.TreeView = TreeView;
})(window);
