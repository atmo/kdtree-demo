/* Venue source: Overture Maps "places" theme, read straight from S3.
 *
 * The release is ~10 GB of GeoParquet spread over 16 files, but it is sorted
 * spatially and every row group carries bbox.{xmin,xmax,ymin,ymax} statistics.
 * So a bounding-box query is: pick the file (from the small shipped index),
 * read that file's footer, keep only the row groups whose statistics overlap
 * the box, and range-request just those rows for just the columns we need —
 * a few MB out of 10 GB, with no server and no API key.
 *
 * The bucket sends `Access-Control-Allow-Origin: *` and supports HTTP range
 * requests, which is what makes this possible from a browser at all. */
(function (global) {
  'use strict';

  var LIB = {
    hyparquet: 'https://cdn.jsdelivr.net/npm/hyparquet@1.29.2/+esm',
    compressors: 'https://cdn.jsdelivr.net/npm/hyparquet-compressors@1.1.1/+esm'
  };
  var COLUMNS = ['geometry', 'names', 'categories', 'confidence'];

  /* `lib` lets you self-host the reader instead of using jsDelivr; `reader`
   * lets you hand in an already-loaded one (bundled, or from npm in tests). */
  var config = { minConfidence: 0, lib: LIB, reader: null };

  function Cancelled() { this.name = 'Cancelled'; this.message = 'Cancelled.'; }
  Cancelled.prototype = Object.create(Error.prototype);

  var libPromise = null;
  function loadLib() {
    if (config.reader) return Promise.resolve(config.reader);
    if (!libPromise) {
      libPromise = Promise.all([import(config.lib.hyparquet),
                                import(config.lib.compressors)])
        .then(function (mods) {
          return { pq: mods[0], compressors: mods[1].compressors };
        })
        .catch(function (err) {
          libPromise = null;                 // let a later attempt retry
          throw new Error('could not load the Parquet reader from jsDelivr (' +
            (err && err.message ? err.message : err) + ')');
        });
    }
    return libPromise;
  }

  function index() {
    var ix = global.OVERTURE_INDEX;
    if (!ix) throw new Error('data/overture-index.js is missing');
    return ix;
  }

  /* ---------- byte source ---------- */

  var lengths = Object.create(null);          // url -> content length

  function asCancelled(err, ctx) {
    var aborted = (ctx.signal && ctx.signal.aborted) ||
      (err && (err.name === 'AbortError' || /abort/i.test(err.message || '')));
    return aborted ? new Cancelled() : err;
  }

  /* A fresh handle per job: the byte counter and the abort signal belong to
   * the job, so a handle must never outlive it (only the parsed metadata is
   * worth caching between jobs). */
  function makeFile(url, ctx) {
    function head() {
      if (lengths[url]) return Promise.resolve(lengths[url]);
      return fetch(url, { method: 'HEAD', signal: ctx.signal }).then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status + ' for ' + short(url));
        var len = +res.headers.get('content-length');
        if (!len) throw new Error('no content-length for ' + short(url));
        lengths[url] = len;
        return len;
      }).catch(function (err) { throw asCancelled(err, ctx); });
    }
    return head().then(function (byteLength) {
      return {
        byteLength: byteLength,
        slice: function (start, end) {
          if (ctx.signal && ctx.signal.aborted) return Promise.reject(new Cancelled());
          var last = (end == null ? byteLength : end) - 1;
          return fetch(url, {
            headers: { Range: 'bytes=' + start + '-' + last },
            signal: ctx.signal
          }).then(function (res) {
            if (!res.ok) throw new Error('HTTP ' + res.status + ' for ' + short(url));
            return res.arrayBuffer();
          }).then(function (buf) {
            ctx.bytes += buf.byteLength;
            if (ctx.onBytes) ctx.onBytes(ctx.bytes);
            return buf;
          }).catch(function (err) { throw asCancelled(err, ctx); });
        }
      };
    });
  }

  function short(url) { return url.split('/').pop().slice(0, 24) + '…'; }

  /* ---------- metadata (cached for the session) ---------- */

  var metaCache = Object.create(null);       // file key -> parsed footer

  function metadata(file, ctx) {
    var url = index().base + file.k;
    return makeFile(url, ctx).then(function (f) {
      if (metaCache[file.k]) return { meta: metaCache[file.k], file: f, url: url };
      return loadLib().then(function (lib) {
        return lib.pq.parquetMetadataAsync(f).then(function (meta) {
          metaCache[file.k] = meta;
          return { meta: meta, file: f, url: url };
        });
      });
    }).catch(function (err) { throw asCancelled(err, ctx); });
  }

  /* ---------- row-group pruning ---------- */

  function statIndex(meta) {
    var cols = meta.row_groups[0].columns;
    var ix = {};
    ['bbox.xmin', 'bbox.xmax', 'bbox.ymin', 'bbox.ymax'].forEach(function (n) {
      ix[n] = cols.findIndex(function (c) {
        return c.meta_data.path_in_schema.join('.') === n;
      });
    });
    if (Object.keys(ix).some(function (k) { return ix[k] < 0; })) {
      throw new Error('this Parquet file has no bbox statistics');
    }
    return ix;
  }

  /* Contiguous runs of row groups whose statistics overlap the box. */
  function runs(meta, bbox) {
    var ix = statIndex(meta);
    var out = [], start = 0, cur = null, rows = 0, bytes = 0, groupBytes = 0;
    meta.row_groups.forEach(function (g) {
      var n = Number(g.num_rows);
      var st = function (k) { return g.columns[ix[k]].meta_data.statistics; };
      var hit =
        Number(st('bbox.xmax').max_value) >= bbox.west &&
        Number(st('bbox.xmin').min_value) <= bbox.east &&
        Number(st('bbox.ymax').max_value) >= bbox.south &&
        Number(st('bbox.ymin').min_value) <= bbox.north;
      if (hit) {
        rows += n;
        groupBytes += Number(g.total_byte_size);
        g.columns.forEach(function (c) {
          var p = c.meta_data.path_in_schema[0];
          if (COLUMNS.indexOf(p) >= 0) bytes += Number(c.meta_data.total_compressed_size);
        });
        if (cur && cur.to === start) cur.to = start + n;
        else { cur = { from: start, to: start + n }; out.push(cur); }
      } else {
        cur = null;
      }
      start += n;
    });
    // `bytes` is the compressed size of the columns we ask for — a floor.
    // The reader coalesces nearby byte ranges, so real transfer lands between
    // that and `groupBytes`, the total size of the row groups touched.
    return { runs: out, rows: rows, bytes: bytes, groupBytes: groupBytes };
  }

  /* Files whose extent overlaps the box, most promising first. */
  function candidates(bbox) {
    return index().files.filter(function (f) {
      return f.b[2] >= bbox.west && f.b[0] <= bbox.east &&
             f.b[3] >= bbox.south && f.b[1] <= bbox.north;
    }).map(function (f) {
      var ovX = Math.min(f.b[2], bbox.east) - Math.max(f.b[0], bbox.west);
      var ovY = Math.min(f.b[3], bbox.north) - Math.max(f.b[1], bbox.south);
      return { f: f, overlap: Math.max(0, ovX) * Math.max(0, ovY) };
    }).sort(function (a, b) { return b.overlap - a.overlap; })
      .map(function (e) { return e.f; });
  }

  /* ---------- public API ---------- */

  function context(hooks) {
    return {
      signal: hooks.signal,
      bytes: 0,
      onBytes: function (n) {
        if (hooks.onBytes) hooks.onBytes(n);
      }
    };
  }

  /* What a download would cost, from row-group statistics alone.  Reads each
   * candidate file's footer, which the download then reuses. */
  function estimate(bbox, opts, hooks) {
    hooks = hooks || {};
    var ctx = context(hooks);
    var files = candidates(bbox);
    if (!files.length) return Promise.resolve({ rows: 0, files: 0, groups: 0, bytes: 0 });
    var rows = 0, groups = 0, dataBytes = 0, groupBytes = 0, used = 0, done = 0;

    function step(i) {
      if (i >= files.length) {
        return {
          rows: rows, files: used, groups: groups,
          bytes: dataBytes, maxBytes: groupBytes,
          metaBytes: ctx.bytes, approximate: true
        };
      }
      if (hooks.onProgress) {
        hooks.onProgress(done, files.length, 'reading footer ' + (i + 1) + '/' + files.length);
      }
      return metadata(files[i], ctx).then(function (entry) {
        var r = runs(entry.meta, bbox);
        if (r.rows) {
          used++; rows += r.rows; groups += r.runs.length;
          dataBytes += r.bytes; groupBytes += r.groupBytes;
        }
        done++;
        if (hooks.onProgress) hooks.onProgress(done, files.length, null);
        return step(i + 1);
      });
    }
    return Promise.resolve().then(function () { return step(0); });
  }

  function fetchVenues(bbox, opts, hooks) {
    hooks = hooks || {};
    var ctx = context(hooks);
    var files = candidates(bbox);
    var points = [], scanned = 0, planned = 0, done = 0, truncated = false;

    if (!files.length) {
      return Promise.resolve({ points: [], truncated: false, batches: 0, planned: 0,
        scanned: 0, bytes: 0 });
    }

    function progress(note) {
      if (hooks.onProgress) hooks.onProgress(done, Math.max(planned, 1), note);
    }

    function readRun(lib, entry, run) {
      return lib.pq.parquetReadObjects({
        file: entry.file,
        compressors: lib.compressors,
        columns: COLUMNS,
        rowStart: run.from,
        rowEnd: run.to
      }).catch(function (err) { throw asCancelled(err, ctx); })
      .then(function (rows) {
        scanned += rows.length;
        for (var i = 0; i < rows.length; i++) {
          var r = rows[i];
          var g = r.geometry;                       // decoded to GeoJSON already
          if (!g || g.type !== 'Point') continue;
          var lon = g.coordinates[0], lat = g.coordinates[1];
          if (lon < bbox.west || lon > bbox.east ||
              lat < bbox.south || lat > bbox.north) continue;
          if (r.confidence != null && r.confidence < config.minConfidence) continue;
          var name = (r.names && r.names.primary) || '';
          if (opts.namedOnly && !name) continue;
          points.push({
            x: lon, y: lat, name: name,
            cat: (r.categories && r.categories.primary) || ''
          });
          if (points.length > opts.limit) { truncated = true; return; }
        }
      });
    }

    return loadLib().then(function (lib) {
      function nextFile(i) {
        if (i >= files.length || truncated) return;
        return metadata(files[i], ctx).then(function (entry) {
          var plan = runs(entry.meta, bbox);
          planned += plan.runs.length;
          progress(plan.runs.length
            ? 'file ' + (i + 1) + '/' + files.length + ': ' + plan.runs.length +
              ' row-group run' + (plan.runs.length === 1 ? '' : 's') + ', ~' +
              Math.round(plan.bytes / 1048576) + ' MB'
            : 'file ' + (i + 1) + '/' + files.length + ': nothing in range');

          function nextRun(j) {
            if (j >= plan.runs.length || truncated) return;
            return readRun(lib, entry, plan.runs[j]).then(function () {
              done++;
              progress(null);
              return nextRun(j + 1);
            });
          }
          return Promise.resolve().then(function () { return nextRun(0); })
            .then(function () { return nextFile(i + 1); });
        });
      }
      return Promise.resolve().then(function () { return nextFile(0); });
    }).then(function () {
      return {
        points: truncated ? points.slice(0, opts.limit) : points,
        truncated: truncated,
        batches: done,
        planned: planned,
        scanned: scanned,
        bytes: ctx.bytes
      };
    });
  }

  global.Overture = {
    fetchVenues: fetchVenues,
    estimate: estimate,
    candidates: candidates,
    runs: runs,
    Cancelled: Cancelled,
    config: config,
    release: function () { return index().release; }
  };
})(window);
