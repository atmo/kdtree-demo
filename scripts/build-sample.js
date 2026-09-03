/* Regenerates data/sample-berlin.js from Overture Places.
 * Usage: SPDIR=<dir with hyparquet installed> node scripts/build-sample.js  */
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
global.window = global;
new Function(fs.readFileSync(path.join(ROOT, 'data/overture-index.js'), 'utf8'))();
new Function('window', fs.readFileSync(path.join(ROOT, 'js/overture.js'), 'utf8'))(global);

const BOX = { south: 52.495, west: 13.355, north: 52.535, east: 13.425 };

(async () => {
  const pq = await import(process.env.SPDIR + '/node_modules/hyparquet/src/index.js');
  const { compressors } = await import(process.env.SPDIR + '/node_modules/hyparquet-compressors/src/index.js');
  Overture.config.reader = { pq, compressors };

  const res = await Overture.fetchVenues(BOX, { namedOnly: true, limit: 100000 }, {});
  const r = v => Math.round(v * 1e6) / 1e6;
  const payload = {
    name: 'Berlin Mitte',
    bbox: BOX,
    attribution: 'Overture Maps Foundation · ODbL / CDLA-Permissive-2.0',
    release: Overture.release(),
    fetched: new Date().toISOString().slice(0, 10),
    p: res.points.map(p => [r(p.y), r(p.x), p.name, p.cat])
  };
  const js = `/* Sample venue set for the kd-tree demo — ${res.points.length} named places in\n` +
    `   central Berlin, from Overture Maps release ${payload.release}.\n` +
    `   ${payload.attribution}. Loaded on demand by "load sample".\n` +
    `   Regenerate with scripts/build-sample.js. */\n` +
    `window.SAMPLE_VENUES = ${JSON.stringify(payload)};\n`;
  fs.writeFileSync(path.join(ROOT, 'data/sample-berlin.js'), js);
  console.log(`wrote ${res.points.length} venues, ${(js.length / 1024).toFixed(0)} KB`);
})();
