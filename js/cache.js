/* localStorage cache for downloaded venue sets.
 * One entry per (bbox, filters) key; coordinates rounded to ~0.1 m. */
(function (global) {
  'use strict';

  var PREFIX = 'kdtree-demo:v1:';
  var INDEX_KEY = PREFIX + 'index';

  function round(v) { return Math.round(v * 1e6) / 1e6; }

  function keyFor(bbox, opts) {
    return PREFIX + [
      round(bbox.south), round(bbox.west), round(bbox.north), round(bbox.east),
      opts.namedOnly ? 'named' : 'all',
      opts.limit,
      opts.minConfidence || 0,
      opts.release || ''
    ].join('|');
  }

  function readIndex() {
    try { return JSON.parse(localStorage.getItem(INDEX_KEY) || '[]'); }
    catch (e) { return []; }
  }
  function writeIndex(list) {
    try { localStorage.setItem(INDEX_KEY, JSON.stringify(list)); } catch (e) {}
  }

  function touch(key, bytes) {
    var list = readIndex().filter(function (e) { return e.key !== key; });
    list.push({ key: key, bytes: bytes, ts: Date.now() });
    writeIndex(list);
  }

  function get(key) {
    var raw;
    try { raw = localStorage.getItem(key); } catch (e) { return null; }
    if (!raw) return null;
    try {
      var obj = JSON.parse(raw);
      if (!obj || !obj.p) return null;
      return {
        points: obj.p.map(function (r) {
          return { y: r[0], x: r[1], name: r[2] || '', cat: r[3] || '' };
        }),
        ts: obj.t,
        truncated: !!obj.tr,
        bytes: raw.length
      };
    } catch (e) { return null; }
  }

  function set(key, points, truncated) {
    var payload;
    try {
      payload = JSON.stringify({
        t: Date.now(),
        tr: !!truncated,
        p: points.map(function (p) { return [round(p.y), round(p.x), p.name, p.cat]; })
      });
    } catch (e) {
      return { ok: false, reason: 'too-large', points: points.length };
    }
    for (var attempt = 0; attempt < 6; attempt++) {
      try {
        localStorage.setItem(key, payload);
        touch(key, payload.length);
        return { ok: true, bytes: payload.length, evicted: attempt };
      } catch (e) {
        // Quota exceeded: drop the oldest cached set and retry.
        var list = readIndex()
          .filter(function (en) { return en.key !== key; })
          .sort(function (a, b) { return a.ts - b.ts; });
        if (!list.length) return { ok: false, reason: 'quota', bytes: payload.length };
        try { localStorage.removeItem(list[0].key); } catch (e2) {}
        writeIndex(list.slice(1));
      }
    }
    return { ok: false, reason: 'quota', bytes: payload.length };
  }

  function stats() {
    var list = readIndex(), bytes = 0, live = [];
    list.forEach(function (e) {
      var raw = null;
      try { raw = localStorage.getItem(e.key); } catch (e2) {}
      if (raw) { bytes += raw.length; live.push(e); }
    });
    if (live.length !== list.length) writeIndex(live);
    return { entries: live.length, bytes: bytes };
  }

  function clear() {
    readIndex().forEach(function (e) {
      try { localStorage.removeItem(e.key); } catch (e2) {}
    });
    try { localStorage.removeItem(INDEX_KEY); } catch (e) {}
  }

  global.VenueCache = {
    keyFor: keyFor, get: get, set: set, stats: stats, clear: clear
  };
})(window);
