/* Leaflet map: bbox selection, query-point picking, venue plotting and
 * drawing of the kd-tree's split lines and cells. */
(function (global) {
  'use strict';

  function MapView(elId, handlers) {
    this.handlers = handlers || {};
    // zoomSnap 0 lets fitBounds land on a fractional zoom, so a region can
    // fill a chosen fraction of the view exactly instead of being rounded
    // down to the next integer level (which can leave it half the size).
    this.map = L.map(elId, {
      preferCanvas: true, zoomControl: true, zoomSnap: 0, zoomDelta: 0.5
    }).setView([52.5163, 13.3777], 14);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxNativeZoom: 19,      // deepest real tiles; beyond this they upscale
      maxZoom: 22,            // leaf cells can be a few tens of metres across
      attribution: '&copy; OpenStreetMap contributors'
    }).addTo(this.map);

    // Canvas and SVG layers do not interleave by insertion order, so each
    // group gets its own pane with an explicit z-index.  The tree's split
    // lines and cells must read on top of the venue dots.
    var panes = [['venues', 400], ['tested', 410], ['splits', 450],
                 ['cells', 460], ['results', 470], ['box', 480]];
    var self = this;
    panes.forEach(function (p) {
      var pane = self.map.createPane(p[0]);
      pane.style.zIndex = p[1];
      // venue dots have popups and result markers have tooltips; the purely
      // decorative layers must not swallow clicks meant for the map
      pane.style.pointerEvents =
        (p[0] === 'venues' || p[0] === 'results') ? 'auto' : 'none';
    });

    this.renderer = L.canvas({ padding: 0.3, pane: 'venues' });
    this.testedRenderer = L.canvas({ padding: 0.3, pane: 'tested' });
    this.venueLayer = L.layerGroup([], { pane: 'venues' }).addTo(this.map);
    this.testedLayer = L.layerGroup([], { pane: 'tested' }).addTo(this.map);
    this.splitLayer = L.layerGroup([], { pane: 'splits' }).addTo(this.map);
    this.cellLayer = L.layerGroup([], { pane: 'cells' }).addTo(this.map);
    this.resultLayer = L.layerGroup([], { pane: 'results' }).addTo(this.map);
    this.boxLayer = L.layerGroup([], { pane: 'box' }).addTo(this.map);

    this.mode = 'point';
    this.bboxRect = null;
    this.queryMarker = null;
    this._bindBoxDraw();
    this._bindClick();
  }

  MapView.prototype.setMode = function (mode) {
    this.mode = mode;
    var c = this.map.getContainer();
    c.style.cursor = mode === 'idle' ? '' : 'crosshair';
  };

  MapView.prototype._bindClick = function () {
    var self = this;
    this.map.on('click', function (e) {
      if (self._suppressClick) { self._suppressClick = false; return; }
      if (self.mode !== 'point') return;
      if (self.handlers.onPoint) self.handlers.onPoint(e.latlng);
    });
  };

  MapView.prototype._bindBoxDraw = function () {
    var self = this, start = null, ghost = null;
    var container = this.map.getContainer();

    container.addEventListener('mousedown', function (e) {
      if (self.mode !== 'box' || e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      self.map.dragging.disable();
      start = self.map.mouseEventToLatLng(e);
      ghost = L.rectangle(L.latLngBounds(start, start), {
        pane: 'box',
        color: '#4da3ff', weight: 1.5, dashArray: '5 4', fill: true,
        fillOpacity: 0.08, interactive: false
      }).addTo(self.boxLayer);
    }, true);

    container.addEventListener('mousemove', function (e) {
      if (!start || !ghost) return;
      ghost.setBounds(L.latLngBounds(start, self.map.mouseEventToLatLng(e)));
    }, true);

    function finish(e) {
      if (!start) return;
      var end = self.map.mouseEventToLatLng(e);
      var bounds = L.latLngBounds(start, end);
      start = null;
      self.map.dragging.enable();
      if (ghost) { self.boxLayer.removeLayer(ghost); ghost = null; }
      var sz = self.map.latLngToContainerPoint(bounds.getNorthEast())
        .distanceTo(self.map.latLngToContainerPoint(bounds.getSouthWest()));
      if (sz < 12) return;                     // treat as a stray click
      self._suppressClick = true;              // don't also pick a point
      self.setBBox(bounds);
      if (self.handlers.onBBox) self.handlers.onBBox(self.getBBox());
    }
    container.addEventListener('mouseup', finish, true);

    this.map.on('mouseout', function () {});
  };

  MapView.prototype.setBBox = function (bounds) {
    this.boxLayer.clearLayers();
    this.bboxRect = L.rectangle(bounds, {
      pane: 'box',
      color: '#4da3ff', weight: 1.5, fill: false, interactive: false
    }).addTo(this.boxLayer);
  };

  MapView.prototype.getBBox = function () {
    if (!this.bboxRect) return null;
    var b = this.bboxRect.getBounds();
    return {
      south: b.getSouth(), west: b.getWest(),
      north: b.getNorth(), east: b.getEast(),
      bounds: b
    };
  };

  MapView.prototype.useCurrentView = function () {
    this.setBBox(this.map.getBounds().pad(-0.06));
    return this.getBBox();
  };

  MapView.prototype.showVenues = function (points, drawLimit) {
    this.venueLayer.clearLayers();
    var group = [];
    // Draw at most `drawLimit` markers, evenly spread through the set.
    var stride = drawLimit && points.length > drawLimit
      ? Math.ceil(points.length / drawLimit) : 1;
    for (var i = 0; i < points.length; i += stride) {
      var p = points[i];
      var m = L.circleMarker([p.y, p.x], {
        renderer: this.renderer,
        pane: 'venues',
        radius: 3.5,
        weight: 0.6,                 // thin, but enough to separate dots
        color: '#000',
        opacity: 0.9,
        fillColor: '#9aa6b8',
        fillOpacity: 0.9
      });
      m.bindPopup((p.name || '(unnamed)') + '<br><span style="opacity:.6">' +
        (p.cat || '') + '</span>');
      group.push(m);
    }
    L.layerGroup(group, { pane: 'venues' }).addTo(this.venueLayer);
    return group.length;
  };

  /* The venues whose distance the search actually computed. */
  MapView.prototype.showTested = function (points, drawLimit) {
    this.testedLayer.clearLayers();
    if (!points || !points.length) return 0;
    var stride = drawLimit && points.length > drawLimit
      ? Math.ceil(points.length / drawLimit) : 1;
    var group = [];
    for (var i = 0; i < points.length; i += stride) {
      group.push(L.circleMarker([points[i].y, points[i].x], {
        renderer: this.testedRenderer,
        pane: 'tested',
        radius: 4,
        weight: 0.8,
        color: '#000',
        opacity: 0.9,
        fillColor: '#c084fc',        // violet: not used by any other layer
        fillOpacity: 0.95,
        interactive: false
      }));
    }
    L.layerGroup(group, { pane: 'tested' }).addTo(this.testedLayer);
    return group.length;
  };

  /* Split lines for every internal node down to `maxDepth`. */
  MapView.prototype.showSplits = function (tree, maxDepth, pathIds) {
    this.splitLayer.clearLayers();
    if (!tree || !tree.root) return;
    var lines = [], budget = 4000;
    (function walk(n) {
      if (!n || n.points || budget <= 0) return;
      var onPath = pathIds && pathIds.has(n.id);
      if (n.depth > maxDepth && !onPath) return;
      budget--;
      var c = n.cell, coords;
      if (n.axis === 0) coords = [[c.minY, n.split], [c.maxY, n.split]];
      else coords = [[n.split, c.minX], [n.split, c.maxX]];
      lines.push(L.polyline(coords, {
        pane: 'splits',
        color: onPath ? '#ff6b6b' : '#4da3ff',
        weight: onPath ? 2.4 : Math.max(0.5, 1.6 - n.depth * 0.12),
        opacity: onPath ? 0.95 : Math.max(0.18, 0.7 - n.depth * 0.05),
        interactive: false
      }));
      walk(n.left); walk(n.right);
    })(tree.root);
    L.layerGroup(lines, { pane: 'splits' }).addTo(this.splitLayer);
  };

  MapView.prototype.highlightCell = function (cell, style) {
    this.cellLayer.clearLayers();
    if (!cell) return;
    L.rectangle([[cell.minY, cell.minX], [cell.maxY, cell.maxX]],
      Object.assign({
        pane: 'cells',
        color: '#ffb454', weight: 2, fillColor: '#ffb454',
        fillOpacity: 0.12, interactive: false
      }, style || {})).addTo(this.cellLayer);
  };

  /* Zoom so the region occupies `fill` of the shorter viewport axis. */
  MapView.prototype.zoomToCell = function (cell, fill) {
    if (!cell) return;
    fill = fill || 0.8;
    var pad = 1e-7;           // a degenerate cell still needs some extent
    var b = L.latLngBounds(
      [Math.min(cell.minY, cell.maxY - pad), Math.min(cell.minX, cell.maxX - pad)],
      [Math.max(cell.maxY, cell.minY + pad), Math.max(cell.maxX, cell.minX + pad)]);
    var size = this.map.getSize();
    var margin = Math.max(0, (1 - fill) / 2);
    this.map.fitBounds(b, {
      paddingTopLeft: [size.x * margin, size.y * margin],
      paddingBottomRight: [size.x * margin, size.y * margin],
      maxZoom: 22,
      animate: true
    });
  };

  /* Centre on one venue and ring it, without disturbing the result markers. */
  MapView.prototype.focusVenue = function (p, zoom) {
    // Move the view first: that is the point of the call, and it must happen
    // even if decorating the marker fails.
    this.map.setView([p.y, p.x],
      Math.max(this.map.getZoom(), zoom || 18), { animate: true });
    if (this.pickMarker) this.map.removeLayer(this.pickMarker);
    this.pickMarker = L.circleMarker([p.y, p.x], {
      pane: 'results',
      radius: 11, color: '#ffb454', weight: 3,
      fill: true, fillColor: '#ffb454', fillOpacity: 0.18
    }).addTo(this.map);
    var label = (p.name || '(unnamed)') + (p.cat ? ' · ' + p.cat : '');
    if (this.pickMarker.bindTooltip) this.pickMarker.bindTooltip(label);
    if (this.pickMarker.openTooltip) this.pickMarker.openTooltip();
  };

  MapView.prototype.clearVenueFocus = function () {
    if (this.pickMarker) { this.map.removeLayer(this.pickMarker); this.pickMarker = null; }
  };

  MapView.prototype.showQuery = function (latlng) {
    if (this.queryMarker) this.map.removeLayer(this.queryMarker);
    this.queryMarker = L.circleMarker(latlng, {
      pane: 'results',
      radius: 7, color: '#ff6b6b', weight: 3, fillColor: '#ff6b6b', fillOpacity: 0.5
    }).addTo(this.map);
  };

  MapView.prototype.showResults = function (latlng, results, radiusMeters) {
    this.resultLayer.clearLayers();
    if (!results || !results.length) return;
    var layers = [];
    if (radiusMeters > 0) {
      layers.push(L.circle(latlng, {
        pane: 'results',
        radius: radiusMeters, color: '#4ade80', weight: 1.2,
        dashArray: '4 4', fill: false, interactive: false
      }));
    }
    results.forEach(function (r, i) {
      layers.push(L.polyline([latlng, [r.point.y, r.point.x]], {
        pane: 'results',
        color: '#4ade80', weight: 1, opacity: 0.5, interactive: false
      }));
      var m = L.circleMarker([r.point.y, r.point.x], {
        pane: 'results',
        radius: 6, color: '#4ade80', weight: 2,
        fillColor: '#0f1115', fillOpacity: 0.9
      });
      m.bindTooltip('#' + (i + 1) + ' ' + (r.point.name || '(unnamed)') +
        ' — ' + Math.round(r.dist) + ' m');
      layers.push(m);
    });
    L.layerGroup(layers, { pane: 'results' }).addTo(this.resultLayer);
  };

  MapView.prototype.clearData = function () {
    this.clearVenueFocus();
    this.venueLayer.clearLayers();
    this.testedLayer.clearLayers();
    this.splitLayer.clearLayers();
    this.cellLayer.clearLayers();
    this.resultLayer.clearLayers();
  };

  global.MapView = MapView;
})(window);
