/**
 * Load the demo in a real browser and check that it works.
 *
 * Serves the project and opens the saved copy, so the check never depends on
 * TfL being reachable. Beyond "it drew something", it asserts the things
 * this demo exists to show:
 *
 *   - every headline figure agrees with the saved copy, recomputed here in
 *     Node from the saved files rather than read back off the page;
 *   - the three charts drew marks, not empty axes;
 *   - choosing a station narrows the arrivals and the tiles follow;
 *   - grouping works on the open arrivals stream, after the window has
 *     evicted rows: only the live trains, once each, and a group's members
 *     can be rolled up with `rows.leavesOf`;
 *   - the rolling window takes a train out of the table once it has
 *     arrived, keeps one that has not, and the arrived log keeps both;
 *   - the window reads each row's current due time, so a train moved into
 *     the past leaves and a train delayed ten minutes stays;
 *   - a train the feed re-sends with new values shows them, in the cells,
 *     on the page and in the figures;
 *   - a prediction TfL withdraws is marked and leaves through the same
 *     window;
 *   - the three credit lines TfL's terms require are on the page word for
 *     word;
 *   - there is no watermark on localhost.
 *
 * It then blocks the API in the browser and opens the default page, to prove
 * a visitor gets the saved copy, and is told so, when TfL cannot be reached.
 *
 * `--live` also opens the default page with the API reachable, fetches the
 * same feeds from the API here in Node, and insists the live page's figures
 * agree with them; then it waits for three arrivals polls and insists that
 * predictions arrived and trains aged out, with the keys before and after.
 * That needs the internet and about two and a half minutes, so it is not
 * part of the deployment gate.
 *
 * Exits non-zero when any of that fails, so it can gate a deployment.
 *
 * Usage: node tools/verify.mjs [--live] [--shots <dir>]
 */

import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { startServer } from './serve.mjs';
import {
  API_HOST,
  ARRIVAL_GRACE_MS,
  ARRIVED_LOG_MS,
  REPLAY_LEAD_MS,
  STATIONS,
  arrivalsUrl,
  bikePointsUrl,
  fetchJson,
  levelOf,
  rankOf,
  statusUrl,
} from '../src/tfl-api.js';
import { AREA_CHART_LIMIT } from '../src/dashboard.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const args = process.argv.slice(2);
const shotIndex = args.indexOf('--shots');
const shotDir = shotIndex >= 0 ? resolve(args[shotIndex + 1]) : null;
const live = args.includes('--live');

/* The grid's retention is a bound, not a guillotine: a row lives up to a
   tenth of the span past it, plus one tick of the eviction timer (a quarter
   of the span, clamped to a second). Counts near the boundary are checked
   against that range rather than a point. */
const SLACK_MS = ARRIVAL_GRACE_MS * 0.1 + Math.min(1000, Math.max(50, ARRIVAL_GRACE_MS / 4)) + 500;

const CREDITS = [
  'Powered by TfL Open Data',
  'Contains OS data © Crown copyright and database rights 2016',
  'Geomni UK Map data © and database rights [2019]',
];

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/snap/bin/chromium',
].filter(Boolean);

/** The first browser on this machine that actually exists. */
async function findChrome() {
  for (const path of CHROME_CANDIDATES) {
    try {
      await access(path);
      return path;
    } catch {}
  }
  throw new Error(`No browser found. Tried:\n  ${CHROME_CANDIDATES.join('\n  ')}\nSet CHROME_PATH to point at one.`);
}

/**
 * This check talks to the browser over a WebSocket, which Node only provides
 * as a global from version 22. Say so plainly rather than failing later with
 * an unexplained missing name.
 */
function requireModernNode() {
  if (typeof WebSocket === 'undefined') {
    throw new Error(
      `This check needs Node 22 or newer. You are running ${process.version}, which has no built in WebSocket.`,
    );
  }
}

/** A free TCP port, asked of the operating system. */
function freePort() {
  return new Promise((ok, reject) => {
    const probe = createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => ok(port));
    });
  });
}

const failures = [];
const notes = [];

/** Record a check and its outcome. */
function check(ok, description, detail) {
  if (ok) {
    notes.push(`  ok   ${description}${detail ? ` (${detail})` : ''}`);
  } else {
    failures.push(`${description}${detail ? ` (${detail})` : ''}`);
    notes.push(`  FAIL ${description}${detail ? ` (${detail})` : ''}`);
  }
}

/* ------------------------------------------------------------------ */
/* The independent recomputation, in Node.                             */
/* ------------------------------------------------------------------ */

/** The headline figures for a set of line rows, as the tiles should show them. */
function lineFigures(lines) {
  let good = 0;
  let disrupted = 0;
  let severe = 0;
  let worst = null;
  for (const row of lines) {
    if (row.level === 'good') good += 1;
    if (row.level === 'minor' || row.level === 'severe') {
      disrupted += 1;
      if (!worst || row.rank < worst.rank) worst = row;
    }
    if (row.level === 'severe') severe += 1;
  }
  return { lines: lines.length, good, disrupted, severe, worst: worst ? `${worst.name}: ${worst.status}` : null };
}

/** The headline figures for a set of docking station rows. */
function bikeFigures(bikes) {
  let available = 0;
  let empty = 0;
  let noBikes = 0;
  const byArea = new Map();
  for (const row of bikes) {
    available += row.bikes || 0;
    empty += row.empty || 0;
    if (row.installed && row.bikes === 0) noBikes += 1;
    byArea.set(row.area, (byArea.get(row.area) || 0) + (row.docks || 0));
  }
  const areas = [...byArea.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, AREA_CHART_LIMIT);
  return { stations: bikes.length, available, empty, noBikes, areas };
}

/**
 * The arrivals the table should hold at `now`: those due later than the
 * window's edge, strictly and with the eviction slack, and the ones due in
 * the next five minutes.
 */
function arrivalFigures(arrivals, now) {
  const strict = arrivals.filter((row) => now - row.due <= ARRIVAL_GRACE_MS);
  const slack = arrivals.filter((row) => now - row.due <= ARRIVAL_GRACE_MS + SLACK_MS);
  const due5 = arrivals.filter((row) => !row.withdrawn && row.due >= now && row.due - now <= 5 * 60 * 1000);
  const arrived = arrivals.filter((row) => row.due <= now && now - row.due <= ARRIVED_LOG_MS);
  return { strict: strict.length, slack: slack.length, due5: due5.length, arrived: arrived.length };
}

/**
 * A `due` reading from the grid, in milliseconds. A datetime column answers
 * with the grid's wall-clock text, to the second, or with the number the feed
 * carried, so both are read back the way the page itself reads them and
 * compared to the second.
 */
function msOf(value) {
  return typeof value === 'number' ? value : Date.parse(value);
}

/** Two figures agree exactly, or within a tolerance. */
function near(a, b, tolerance = 0) {
  if (a == null || b == null) return a == null && b == null;
  return Math.abs(Number(a) - Number(b)) <= tolerance;
}

const meta = JSON.parse(await readFile(join(root, 'data', 'snapshot', 'meta.json'), 'utf8'));
const savedLines = JSON.parse(await readFile(join(root, 'data', 'snapshot', 'lines.json'), 'utf8'));
const savedArrivals = JSON.parse(await readFile(join(root, 'data', 'snapshot', 'arrivals.json'), 'utf8'));
const savedBikes = JSON.parse(await readFile(join(root, 'data', 'snapshot', 'bikes.json'), 'utf8'));
const expectedLines = lineFigures(savedLines);
const expectedBikes = bikeFigures(savedBikes);
console.log(`Saved copy: ${savedLines.length} lines, ${savedArrivals.length} arrivals, ${savedBikes.length} docking stations; taken ${meta.fetchedAt}`);
console.log(`  expected line tiles: good ${expectedLines.good}, disrupted ${expectedLines.disrupted}, severe ${expectedLines.severe}, worst ${expectedLines.worst}`);
console.log(`  expected bike tiles: ${expectedBikes.available} bikes, ${expectedBikes.empty} empty docks, ${expectedBikes.noBikes} with no bikes`);

let browser;
let browserPid = null;
let profile;
let server;
const realStart = Date.now();

try {
  requireModernNode();
  const chromePath = await findChrome();
  const started = await startServer(0);
  server = started.server;
  const origin = `http://127.0.0.1:${started.port}`;
  console.log(`Browser: ${chromePath}`);
  console.log(`Serving: ${origin}`);

  profile = await mkdtemp(join(tmpdir(), 'tfl-demo-verify-'));
  /* A port of the operating system's choosing, so two checks running side by
     side on one machine cannot land on the same debugging socket. */
  const port = await freePort();
  /* Its own process group, so the whole browser tree can be taken down
     together rather than leaving orphaned renderers behind. Only the browser
     this check started is ever signalled. */
  browser = spawn(chromePath, [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--no-sandbox',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--hide-scrollbars',
    '--window-size=1440,900',
    'about:blank',
  ], { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  browserPid = browser.pid;
  browser.stderr.on('data', () => {});

  let wsUrl;
  for (let i = 0; i < 150 && !wsUrl; i += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) wsUrl = (await response.json()).webSocketDebuggerUrl;
    } catch {}
    if (!wsUrl) await sleep(200);
  }
  if (!wsUrl) throw new Error('the browser never opened its debugging port');

  const socket = new WebSocket(wsUrl);
  await new Promise((done, fail) => {
    socket.onopen = done;
    socket.onerror = () => fail(new Error('could not attach to the browser'));
  });

  let nextId = 0;
  const pending = new Map();
  let consoleErrors = [];
  let pageErrors = [];
  const requested = [];

  /* A browser that goes away mid-run, killed from outside or crashed, would
     otherwise leave every call waiting for an answer that never comes. Fail
     the run instead of hanging it. */
  socket.onclose = () => {
    for (const { reject } of pending.values()) reject(new Error('the browser went away before it answered'));
    pending.clear();
  };

  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.id != null && pending.has(message.id)) {
      const { resolve: ok, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(JSON.stringify(message.error)));
      else ok(message.result);
      return;
    }
    if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
      consoleErrors.push(message.params.args.map((a) => a.value ?? a.description ?? a.type).join(' '));
    }
    if (message.method === 'Runtime.exceptionThrown') {
      const details = message.params.exceptionDetails;
      pageErrors.push(details.exception?.description || details.text);
    }
    if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error') {
      consoleErrors.push(message.params.entry.text);
    }
    if (message.method === 'Network.requestWillBeSent') {
      requested.push(message.params.request.url);
    }
  };

  const send = (method, params = {}, sessionId) =>
    new Promise((ok, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve: ok, reject });
      socket.send(JSON.stringify({ id, method, params, sessionId }));
    });

  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const call = (method, params) => send(method, params, sessionId);

  await call('Page.enable');
  await call('Runtime.enable');
  await call('Log.enable');
  await call('Network.enable');
  await call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

  const evaluate = async (expression) => {
    const result = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.text + ' ' + (result.exceptionDetails.exception?.description || ''));
    }
    return result.result.value;
  };

  const waitFor = async (expression, timeout, what) => {
    const until = Date.now() + timeout;
    while (Date.now() < until) {
      let value;
      try {
        value = await evaluate(expression);
      } catch {}
      if (value) return value;
      await sleep(250);
    }
    throw new Error(`timed out waiting for ${what}`);
  };

  /** Open a URL with a clean error log and wait for the dashboard to report in. */
  const open = async (url, label) => {
    consoleErrors = [];
    pageErrors = [];
    console.log(`\n--- ${label} ---\n${url}`);
    await call('Page.navigate', { url });
    await waitFor('!!(window.__tflDemo)', 120000, `${label} to load`);
    const state = await evaluate('({ ready: window.__tflDemo.ready, error: window.__tflDemo.error || null })');
    if (!state.ready) throw new Error(`${label} reported a failure: ${state.error}`);
    await waitFor('window.__tflDemo.linesGrid && window.__tflDemo.linesGrid.rows.count() > 0', 60000, `${label} rows`);
    /* A moment for the stream grids to settle their first chunk. */
    await sleep(600);
  };

  /** Save a screenshot, when a directory was asked for. */
  const shoot = async (name) => {
    if (!shotDir) return;
    await mkdir(shotDir, { recursive: true });
    const { data } = await call('Page.captureScreenshot', { format: 'png' });
    const file = join(shotDir, `${name}.png`);
    await writeFile(file, Buffer.from(data, 'base64'));
    console.log(`  shot ${file}`);
  };

  /** Complain about anything the page logged. */
  const noErrors = (label) => {
    check(consoleErrors.length === 0, `${label}: no console errors`, consoleErrors.slice(0, 3).join(' | '));
    check(pageErrors.length === 0, `${label}: no page errors`, pageErrors.slice(0, 3).join(' | '));
  };

  /** The tiles, the named readings, the counts and the chart points, as the page shows them. */
  const readFigures = () => evaluate(`(() => {
    const d = window.__tflDemo;
    const tiles = (id) => Object.fromEntries(d.kpis[id].tiles().map((t) => [t.id, t.value]));
    const keys = []; d.arrivalsGrid.rows.forEachAll((r) => { if (r && r.data) keys.push(r.data.key); });
    const points = (i) => { const data = d.charts[i] && d.charts[i].data(); const s = (data && data.series && data.series[0] && data.series[0].points) || []; return s.map((p) => [p.rowKey != null ? p.rowKey : p.x, p.y]); };
    const named = [...document.querySelectorAll('.kpi-named')].map((n) => [n.querySelector('.kpi-named-value').textContent, n.querySelector('.kpi-named-label').textContent]);
    return {
      lines: d.linesGrid.rows.count(),
      arrivals: d.arrivalsGrid.rows.count(),
      arrivalsTotal: d.arrivalsGrid.rows.totalCount(),
      arrivalKeys: keys,
      logTotal: d.arrivedLog.rows.totalCount(),
      bikes: d.bikesGrid.rows.count(),
      bikesTotal: d.bikesGrid.rows.totalCount(),
      lineTiles: tiles('lines'), arrivalTiles: tiles('arrivals'), bikeTiles: tiles('bikes'),
      worst: named[0], next: named[1],
      severityPoints: points(0), arrivedPoints: points(1), areaPoints: points(2),
      station: d.station,
      selectValue: d.stationSelect.value,
      status: JSON.parse(JSON.stringify(d.status)),
      fellBack: !!(d.timings && d.timings.fellBack),
      badges: [...document.querySelectorAll('[role=tab]')].map((t) => t.textContent.trim()),
      freshness: (document.querySelector('.freshness') || {}).textContent || null,
      badge: (document.querySelector('.head-note .pill') || {}).textContent || null,
      credits: [...document.querySelectorAll('.foot .attribution')].map((p) => p.textContent),
      watermark: d.linesGrid.licence.watermark(),
      licenceState: d.linesGrid.licence.state(),
      polling: !!d.poller,
    };
  })()`);

  /* =================================================================== */
  /* 1. The saved copy, cross-checked against the saved files.            */
  /* =================================================================== */

  await open(`${origin}/index.html?source=snapshot`, 'saved copy');

  const snap = await evaluate(`(() => {
    const d = window.__tflDemo;
    return {
      columns: d.linesGrid.columns.visible().length,
      painted: document.querySelectorAll('.lattice [role="row"]').length,
      charts: d.charts.length,
      shiftMs: d.meta.shiftMs,
      leadMs: d.meta.leadMs,
      mounted: ['lines', 'arrivals', 'bikes'].map((id) => d.tabs.isMounted(id)),
      timings: d.timings,
    };
  })()`);
  const first = await readFigures();
  const now = Date.now();
  /* The page shifted the saved arrivals by `shiftMs`; the same shift here. */
  const shiftedArrivals = savedArrivals.map((row) => ({ ...row, due: row.due + snap.shiftMs }));
  const expectedArrivals = arrivalFigures(shiftedArrivals, now);
  console.log(`  ${first.lines} lines, ${first.arrivals} arrivals, ${first.bikes} docking stations; ${snap.painted} painted rows, ${snap.charts} charts; badge "${first.badge}"`);
  console.log(`  ${first.freshness}`);
  console.log(`  timings ${JSON.stringify(snap.timings)}`);
  console.log(`  line tiles ${JSON.stringify(first.lineTiles)}; arrival tiles ${JSON.stringify(first.arrivalTiles)}; bike tiles ${JSON.stringify(first.bikeTiles)}`);
  console.log(`  worst: ${first.worst && first.worst.join(' | ')}; next: ${first.next && first.next.join(' | ')}`);

  check(snap.mounted.every(Boolean), 'saved copy: all three tables exist from the start', snap.mounted.join(','));
  check(first.lines === savedLines.length, 'saved copy: the Lines table holds every saved line', `${first.lines} against ${savedLines.length}`);
  check(first.bikesTotal === savedBikes.length, 'saved copy: the Bike points table holds every saved docking station', `${first.bikesTotal} against ${savedBikes.length}`);
  check(
    first.arrivalsTotal >= expectedArrivals.strict && first.arrivalsTotal <= expectedArrivals.slack,
    'saved copy: the Arrivals table holds the saved trains still inside the window',
    `${first.arrivalsTotal}, expected between ${expectedArrivals.strict} and ${expectedArrivals.slack} of ${savedArrivals.length}`,
  );
  check(first.logTotal === savedArrivals.length, 'saved copy: the arrived log holds every saved train (its window is ten minutes)', `${first.logTotal} against ${savedArrivals.length}`);
  check(snap.painted > 0, 'saved copy: the table painted rows', `${snap.painted}`);
  check(snap.charts === 3, 'saved copy: all three charts were built', `${snap.charts}`);
  check(first.badge === 'Saved copy', 'saved copy: the badge says it is the saved copy', `"${first.badge}"`);
  check(/copy saved on/.test(first.freshness || ''), 'saved copy: the readout says when the copy was taken', first.freshness);
  check(first.watermark === false, 'saved copy: no watermark on localhost', `state ${first.licenceState}`);
  check(
    first.credits.length === 3 && CREDITS.every((line, i) => first.credits[i] === line),
    'saved copy: the three credit lines TfL requires are on the page, word for word',
    first.credits.join(' / '),
  );
  check(Math.abs((now - REPLAY_LEAD_MS) - (meta.fetchedAtMs + snap.shiftMs)) < 5000, 'saved copy: the copy is shown as fetched four minutes ago', `lead ${snap.leadMs} ms, shift ${snap.shiftMs} ms`);

  /* ---- the headline figures against the saved files ---- */

  check(first.lineTiles.good === expectedLines.good, 'saved copy: lines with good service matches', `${first.lineTiles.good} against ${expectedLines.good}`);
  check(first.lineTiles.disrupted === expectedLines.disrupted, 'saved copy: lines disrupted matches', `${first.lineTiles.disrupted} against ${expectedLines.disrupted}`);
  check(first.lineTiles.severe === expectedLines.severe, 'saved copy: severe disruption matches', `${first.lineTiles.severe} against ${expectedLines.severe}`);
  check(
    expectedLines.worst ? first.worst[0] === expectedLines.worst : /Good service on every line/.test(first.worst[0]),
    'saved copy: the worst disruption is named correctly',
    `"${first.worst[0]}" against ${expectedLines.worst}`,
  );
  check(first.bikeTiles.bikes === expectedBikes.available, 'saved copy: bikes available matches', `${first.bikeTiles.bikes} against ${expectedBikes.available}`);
  check(first.bikeTiles.empty === expectedBikes.empty, 'saved copy: empty docks matches', `${first.bikeTiles.empty} against ${expectedBikes.empty}`);
  check(first.bikeTiles.noBikes === expectedBikes.noBikes, 'saved copy: stations with no bikes matches', `${first.bikeTiles.noBikes} against ${expectedBikes.noBikes}`);
  check(first.bikeTiles.stations === expectedBikes.stations, 'saved copy: docking stations matches', `${first.bikeTiles.stations} against ${expectedBikes.stations}`);
  check(
    first.arrivalTiles.trains >= expectedArrivals.strict && first.arrivalTiles.trains <= expectedArrivals.slack,
    'saved copy: trains in the window matches',
    `${first.arrivalTiles.trains}, expected between ${expectedArrivals.strict} and ${expectedArrivals.slack}`,
  );
  check(near(first.arrivalTiles.due5, expectedArrivals.due5, 1), 'saved copy: due in the next five minutes matches', `${first.arrivalTiles.due5} against ${expectedArrivals.due5}`);
  check(/^Next train at/.test(first.next[1]) && first.next[0] !== 'No data', 'saved copy: the next train is named', first.next.join(' | '));
  const areaShown = first.areaPoints.map(([area, docks]) => `${area}=${docks}`).join(', ');
  const areaWant = expectedBikes.areas.map(([area, docks]) => `${area}=${docks}`).join(', ');
  check(areaShown === areaWant, 'saved copy: the docks-by-area chart matches, in order', `${areaShown} | expected ${areaWant}`);
  const severityShown = new Map(first.severityPoints);
  const severityAgree = savedLines.filter((row) => severityShown.get(row.name) === row.severity || severityShown.get(row.key) === row.severity).length;
  check(severityAgree === savedLines.length, 'saved copy: the severity chart has every line at its code', `${severityAgree} of ${savedLines.length}`);
  const arrivedTotal = first.arrivedPoints.reduce((n, [, y]) => n + (y || 0), 0);
  check(
    arrivedTotal >= expectedArrivals.arrived - 2 && arrivedTotal <= expectedArrivals.arrived + 2,
    'saved copy: the arrivals-per-minute chart counts the trains that have arrived in the lead',
    `${arrivedTotal} across ${first.arrivedPoints.length} minutes, expected about ${expectedArrivals.arrived}`,
  );
  check(
    first.badges.some((b) => /^Lines/.test(b) && b.includes(String(savedLines.length))) && first.badges.some((b) => /^Bike points/.test(b) && b.includes(String(savedBikes.length))),
    'saved copy: the tab badges carry the row counts',
    first.badges.join(' / '),
  );

  /* Built is not drawn. A chart whose points all carry a null measure puts an
     empty pair of axes on the page and reports no error, so each one is asked
     what it actually plotted. */
  const drawn = await evaluate(`(() => window.__tflDemo.charts.map((c, i) => {
    const data = c.data();
    const series = (data && data.series) || [];
    const points = series.reduce((n, s) => n + ((s.points || []).length), 0);
    const withValue = series.reduce((n, s) => n + (s.points || []).filter((p) => p.y != null && p.y !== 0).length, 0);
    const svg = c.element;
    const marks = svg ? svg.querySelectorAll('rect, circle, path').length : 0;
    const bars = svg ? [...svg.querySelectorAll('rect.lat-chartview__mark')].filter((r) => +r.getAttribute('height') > 0 && +r.getAttribute('width') > 0).length : 0;
    return { i, points, withValue, marks, bars };
  }))()`);
  for (const c of drawn) {
    console.log(`  chart ${c.i}: ${c.points} points, ${c.withValue} with a value, ${c.marks} marks, ${c.bars} bars`);
    check(c.withValue > 0, `saved copy: chart ${c.i} plotted values rather than empty axes`, `${c.withValue} of ${c.points} points carry a measure`);
    check(c.bars > 0, `saved copy: chart ${c.i} drew bars`, `${c.bars} bars`);
  }
  check(drawn[0] && drawn[0].bars === savedLines.length, 'saved copy: the severity chart has a bar per line', `${drawn[0] && drawn[0].bars}`);
  check(drawn[2] && drawn[2].bars === Math.min(AREA_CHART_LIMIT, expectedBikes.areas.length), 'saved copy: the docks chart has ten bars', `${drawn[2] && drawn[2].bars}`);
  noErrors('saved copy');
  await shoot('01-saved-copy');

  /* ---- choosing a station narrows the arrivals ---- */

  const ksx = STATIONS[0];
  await evaluate(`window.__tflDemo.tabs.activate('arrivals')`);
  await sleep(400);
  await evaluate(`window.__tflDemo.selectStation(${JSON.stringify(ksx.id)})`);
  await sleep(900);
  const narrowed = await readFigures();
  const other = await evaluate(`(() => { let n = 0; window.__tflDemo.arrivalsGrid.rows.forEach((r) => { if (r && r.data && r.data.station !== ${JSON.stringify(ksx.id)}) n += 1; }); return { n, url: location.search, painted: document.querySelectorAll('.lattice [role="row"]').length }; })()`);
  const nowKsx = Date.now();
  const expectedKsx = arrivalFigures(shiftedArrivals.filter((row) => row.station === ksx.id), nowKsx);
  console.log(`  narrowed to ${ksx.name}: ${first.arrivals} rows -> ${narrowed.arrivals}; next: ${narrowed.next.join(' | ')}`);
  check(narrowed.arrivals < first.arrivals, 'choosing a station narrows the arrivals table', `${first.arrivals} -> ${narrowed.arrivals}`);
  check(other.n === 0, 'every remaining arrival is at the chosen station');
  check(
    narrowed.arrivalTiles.trains >= expectedKsx.strict && narrowed.arrivalTiles.trains <= expectedKsx.slack,
    'the trains tile follows the station',
    `${narrowed.arrivalTiles.trains}, expected between ${expectedKsx.strict} and ${expectedKsx.slack}`,
  );
  check(narrowed.next[1].includes(ksx.name), 'the next-train reading names the chosen station', narrowed.next[1]);
  check(narrowed.station === ksx.id && narrowed.selectValue === ksx.id, 'the selector shows the chosen station');
  check(other.url.includes(`station=${ksx.id}`), 'the chosen station is in the address', other.url);
  check(other.painted > 0, 'the arrivals table painted rows on its tab', `${other.painted}`);
  await shoot('02-arrivals-kings-cross');
  await evaluate(`window.__tflDemo.selectStation('')`);
  await sleep(700);
  const restored = await readFigures();
  check(restored.arrivals >= first.arrivals - 5, 'choosing all stations restores the table', `${restored.arrivals} of ${first.arrivals} (some may have aged out meanwhile)`);

  /* ---- the rolling window: a train that has arrived leaves, one that has not stays ---- */

  /*
   * Two rows go in through the router, exactly the path a poll takes. One is
   * due in ten minutes; the other was due almost twenty seconds ago, three
   * seconds from the far edge of the window. Both must be admitted. Waiting
   * for the second to cross the edge has to take it out and leave the first,
   * which is the window ageing a row out rather than a push being refused.
   * The arrived log, the same route with a ten-minute window, keeps both.
   */
  const window20 = await evaluate(`(async () => {
    const d = window.__tflDemo;
    const now = Date.now();
    const GRACE = ${ARRIVAL_GRACE_MS};
    const base = { kind: 'arrival', predictionId: null, vehicleId: 'check', station: ${JSON.stringify(ksx.id)}, stationName: ${JSON.stringify(ksx.name)},
      lineId: 'victoria', lineName: 'Victoria', mode: 'Tube', platform: 'Check', direction: '', towards: 'Window check', destination: 'Window check',
      location: 'A check', timeToStation: 0, predictedAt: now - 3600000, fetchedAt: now, withdrawn: false, count: 1 };
    const fresh = { ...base, key: 'window-check-fresh', due: now + 600000, dueMinute: '00:00' };
    const expiring = { ...base, key: 'window-check-expiring', due: now - GRACE + 3000, dueMinute: '00:01' };
    const evictedBefore = d.status.arrivalsEvicted;
    /* Through the same ingest a poll uses: the answer is every train the
       table holds plus the two check rows, so nothing reads as withdrawn. */
    const heldRows = [];
    d.arrivalsGrid.rows.forEachAll((r) => { if (r && r.data) heldRows.push(r.data); });
    const seeded = d.ingest('arrival', [...heldRows, fresh, expiring]);
    await new Promise((r) => setTimeout(r, 300));
    const held = (id) => !!d.arrivalsGrid.rows.byKey(id);
    const logged = (id) => !!d.arrivedLog.rows.byKey(id);
    const admitted = { fresh: held('window-check-fresh'), expiring: held('window-check-expiring'), log: logged('window-check-expiring') };
    const totalBefore = d.arrivalsGrid.rows.totalCount();
    await new Promise((r) => setTimeout(r, 3000 + ${Math.round(SLACK_MS)} + 500));
    const settled = { fresh: held('window-check-fresh'), expiring: held('window-check-expiring'), logFresh: logged('window-check-fresh'), logExpiring: logged('window-check-expiring') };
    return { seeded, admitted, settled, totalBefore, totalAfter: d.arrivalsGrid.rows.totalCount(), evicted: d.status.arrivalsEvicted - evictedBefore };
  })()`);
  console.log(`  window: seeded ${JSON.stringify(window20.seeded)}, admitted ${JSON.stringify(window20.admitted)}, after the edge ${JSON.stringify(window20.settled)}, evicted ${window20.evicted}, total ${window20.totalBefore} -> ${window20.totalAfter}`);
  check(window20.seeded.added === 2 && window20.seeded.withdrawn === 0, 'an answer carrying every held train withdraws nothing', JSON.stringify(window20.seeded));
  check(window20.admitted.fresh && window20.admitted.expiring, 'the window admits both trains while both are inside it', JSON.stringify(window20.admitted));
  check(window20.settled.expiring === false, 'the window takes a train out once it is twenty seconds past due', 'the table no longer holds it');
  check(window20.settled.fresh === true, 'the window keeps the train that is still on its way');
  check(window20.evicted >= 1, 'the page counted the eviction the grid reported', `${window20.evicted}`);
  check(window20.settled.logExpiring && window20.settled.logFresh, 'the arrived log, with its ten-minute window, keeps both', JSON.stringify(window20.settled));

  /* A row added to the open stream after its first chunk: what the grid
     reads for its cells against what the row carries. */
  const lateAdd = await evaluate(`(() => { const d = window.__tflDemo; const r = d.arrivalsGrid.rows.byKey('window-check-fresh'); return r ? { data: r.data.due, value: d.arrivalsGrid.rows.value(r.key, 'due'), text: d.arrivalsGrid.rows.text(r.key, 'due'), towards: d.arrivalsGrid.rows.text(r.key, 'towards'), dataTowards: r.data.towards } : null; })()`);
  console.log(`  late-added row reads: ${JSON.stringify(lateAdd)}`);
  check(
    !!lateAdd && near(msOf(lateAdd.value), lateAdd.data, 1000) && lateAdd.towards === lateAdd.dataTowards,
    'a row added to the open stream in a later chunk reads its own cells',
    `text() due ${lateAdd && lateAdd.text}, towards "${lateAdd && lateAdd.towards}" for a row whose data says ${lateAdd && new Date(lateAdd.data).toISOString()} "${lateAdd && lateAdd.dataTowards}"`,
  );

  /* ---- a train the feed re-sends with new values ---- */

  /*
   * A poll that moves a train's destination and due time is an upsert on a
   * key the stream already holds. The new values have to be what the cells
   * read, what the row on screen says, and what the bound figures panel
   * sees, without waiting for another poll.
   */
  const resent = await evaluate(`(async () => {
    const d = window.__tflDemo;
    const row = d.arrivalsGrid.rows.byKey('window-check-fresh');
    const before = { towards: d.arrivalsGrid.rows.text(row.key, 'towards'), due: d.arrivalsGrid.rows.text(row.key, 'due'), value: d.arrivalsGrid.rows.value(row.key, 'due'), index: row.index };
    const due = Date.now() + 900000;
    d.router.apply([{ op: 'upsert', row: { ...row.data, towards: 'Re-sent check', destination: 'Re-sent check', due, dueMinute: '00:09' } }]);
    await new Promise((r) => setTimeout(r, 400));
    d.kpis.arrivals.refresh();
    let kpiSeen = 0;
    d.kpis.arrivals.rows.forEach((r) => { if (r && r.towards === 'Re-sent check') kpiSeen += 1; });
    d.arrivalsGrid.scroll.toCell('window-check-fresh', 'towards', 'center');
    await new Promise((r) => setTimeout(r, 400));
    const cell = (col) => [...document.querySelectorAll('.lattice [data-key="window-check-fresh"] [data-col="' + col + '"]')].map((c) => c.textContent.trim());
    return {
      before,
      due,
      towards: d.arrivalsGrid.rows.text('window-check-fresh', 'towards'),
      text: d.arrivalsGrid.rows.text('window-check-fresh', 'due'),
      value: d.arrivalsGrid.rows.value('window-check-fresh', 'due'),
      data: d.arrivalsGrid.rows.byKey('window-check-fresh').data.towards,
      index: d.arrivalsGrid.rows.byKey('window-check-fresh').index,
      kpiSeen,
      painted: cell('towards'),
      paintedDue: cell('due'),
    };
  })()`);
  console.log(`  re-sent row: was ${JSON.stringify(resent.before)}, now towards "${resent.towards}" due ${resent.text} (value ${JSON.stringify(resent.value)}); painted ${JSON.stringify(resent.painted)} ${JSON.stringify(resent.paintedDue)}; the figures panel sees it ${resent.kpiSeen} time(s); its place in the sort: ${resent.before.index} -> ${resent.index}`);
  check(resent.towards === 'Re-sent check' && resent.data === 'Re-sent check', 'a train the feed re-sends reads its new destination through the grid', `cell "${resent.towards}", row data "${resent.data}", was "${resent.before.towards}"`);
  check(near(msOf(resent.value), resent.due, 1000), 'a train the feed re-sends reads its new due time through the grid', `cell ${JSON.stringify(resent.value)} against ${new Date(resent.due).toISOString()}, was ${resent.before.due}`);
  check(resent.painted.length > 0 && resent.painted.every((t) => t === 'Re-sent check'), 'the re-sent train shows its new destination on the page', resent.painted.join(' | ') || 'the row was not painted');
  check(
    resent.paintedDue.length > 0 && resent.paintedDue.every((t) => t === resent.text) && resent.text !== resent.before.due,
    'the re-sent train shows its new due time on the page',
    `${resent.paintedDue.join(' | ') || 'the row was not painted'}, was ${resent.before.due}`,
  );
  check(resent.kpiSeen === 1, 'the bound figures panel sees the re-sent values', `${resent.kpiSeen} row(s) carry the new destination`);

  /* ---- a prediction TfL withdraws is marked ---- */

  /*
   * The next poll's answer is every train the page holds except the fresh
   * check row, predicted a moment later than anything held. That is what a
   * withdrawal looks like from the feed's side. The row must be marked, and
   * keep its due time: the window takes it out twenty seconds after that.
   */
  const withdrawn = await evaluate(`(async () => {
    const d = window.__tflDemo;
    const now = Date.now();
    const rows = [];
    d.arrivalsGrid.rows.forEachAll((r) => { if (r && r.data && r.data.key !== 'window-check-fresh') rows.push({ ...r.data, predictedAt: now }); });
    const outcome = d.ingest('arrival', rows);
    outcome.answered = rows.length;
    await new Promise((r) => setTimeout(r, 300));
    const row = d.arrivalsGrid.rows.byKey('window-check-fresh');
    const marked = row ? { withdrawn: row.data.withdrawn, location: row.data.location, dueKept: row.data.due > now + 500000 } : null;
    return { outcome, marked, stillLogged: !!d.arrivedLog.rows.byKey('window-check-fresh') };
  })()`);
  console.log(`  withdrawal: ${JSON.stringify(withdrawn)}`);
  check(withdrawn.outcome.withdrawn === 1, 'a prediction missing from a newer answer is counted as withdrawn', `${withdrawn.outcome.withdrawn}`);
  check(withdrawn.marked && withdrawn.marked.withdrawn === true && /withdrawn/i.test(withdrawn.marked.location) && withdrawn.marked.dueKept, 'the withdrawn prediction is marked and keeps its due time', JSON.stringify(withdrawn.marked));
  check(withdrawn.stillLogged, 'the arrived log still holds it, and the chart leaves it out as withdrawn');

  /* ---- the window reads the due time a row currently carries ---- */

  /*
   * Two trains go in through the router, both well inside the window: one
   * due in ten minutes, one due in three seconds. Then, as a poll would, one
   * is re-timed into the past (a train that has already gone) and the other
   * ten minutes out (a delay). The window reads the time each row now
   * carries, so the first is taken out within the slack although it was
   * admitted due in ten minutes, and the second is kept although it would
   * have aged out three seconds after it arrived.
   *
   * The rows that are expected to leave are only ever asked about by key,
   * never dereferenced: by the time the check reads them they are gone.
   */
  const retimed = await evaluate(`(async () => {
    const d = window.__tflDemo;
    const now = Date.now();
    const GRACE = ${ARRIVAL_GRACE_MS};
    const base = { kind: 'arrival', predictionId: null, vehicleId: 'check', station: ${JSON.stringify(ksx.id)}, stationName: ${JSON.stringify(ksx.name)},
      lineId: 'victoria', lineName: 'Victoria', mode: 'Tube', platform: 'Check', direction: '', towards: 'Delay check', destination: 'Delay check',
      location: 'A check', timeToStation: 180, predictedAt: now, fetchedAt: now, withdrawn: false, count: 1 };
    const evictedBefore = d.status.arrivalsEvicted;
    d.router.apply([
      { op: 'upsert', row: { ...base, key: 'window-check-early', due: now + 600000, dueMinute: '00:04' } },
      { op: 'upsert', row: { ...base, key: 'window-check-delayed', due: now + 3000, dueMinute: '00:02' } },
    ]);
    await new Promise((r) => setTimeout(r, 300));
    const earlyRow = d.arrivalsGrid.rows.byKey('window-check-early');
    const delayedRow = d.arrivalsGrid.rows.byKey('window-check-delayed');
    const admitted = {
      early: !!earlyRow && earlyRow.data.due > now + 500000,
      delayed: !!delayedRow && delayedRow.data.due < now + 10000,
    };
    /* The re-timing: one into the past, one ten minutes out. */
    d.router.apply([
      { op: 'upsert', row: { ...base, key: 'window-check-early', due: now - GRACE - 5000, dueMinute: '00:05' } },
      { op: 'upsert', row: { ...base, key: 'window-check-delayed', due: now + 600000, dueMinute: '00:03' } },
    ]);
    await new Promise((r) => setTimeout(r, 200));
    const delayedAfter = d.arrivalsGrid.rows.byKey('window-check-delayed');
    const landed = { delayed: !!delayedAfter && delayedAfter.data.due > now + 500000 };
    await new Promise((r) => setTimeout(r, 3000 + GRACE + ${Math.round(SLACK_MS)} + 500));
    return {
      admitted,
      landed,
      earlyGone: !d.arrivalsGrid.rows.byKey('window-check-early'),
      delayedHeld: !!d.arrivalsGrid.rows.byKey('window-check-delayed'),
      evicted: d.status.arrivalsEvicted - evictedBefore,
    };
  })()`);
  console.log(`  re-timed: ${JSON.stringify(retimed)}`);
  check(retimed.admitted.early && retimed.admitted.delayed, 'both check trains were admitted with the due times they carried', JSON.stringify(retimed.admitted));
  check(retimed.landed.delayed, 'the delay landed on the row', `due moved ten minutes out: ${retimed.landed.delayed}`);
  check(retimed.earlyGone, 'a train re-timed into the past leaves the window, though it was admitted due in ten minutes', `gone: ${retimed.earlyGone}, ${retimed.evicted} evictions counted meanwhile`);
  check(retimed.delayedHeld, 'a train delayed by ten minutes stays in the window, though it was admitted due in three seconds', `held: ${retimed.delayedHeld}`);

  /* ---- grouping on the open stream ---- */

  /*
   * Done after the window checks on purpose: the table has now evicted
   * rows, so this groups a stream that has aged rows out. Only the live
   * trains may appear, once each, and a group's members must be readable
   * with `rows.leavesOf` so a host can roll a group up itself.
   *
   * The window keeps working while this runs, so a train can age out
   * between the reading before and the reading after. The counts are
   * therefore held to that range rather than to one number. A table that
   * showed a train twice, or brought an evicted one back, would land well
   * outside it, and the keys are checked for both besides.
   */
  const liveBefore = await evaluate("({ total: window.__tflDemo.arrivalsGrid.rows.totalCount(), trains: window.__tflDemo.kpis.arrivals.value('trains') })");
  await evaluate("window.__tflDemo.arrivalsGrid.columns.group(['lineName'])");
  await sleep(900);
  const grouped = await evaluate(`(() => {
    const d = window.__tflDemo;
    const g = d.arrivalsGrid;
    let groups = 0;
    const leafKeys = [];
    const groupKeys = [];
    g.rows.expandAll();
    g.rows.forEach((r) => {
      if (r && r.group) { groups += 1; groupKeys.push({ key: r.key, leafCount: r.leafCount }); }
      else if (r && r.data && r.data.key) leafKeys.push(r.data.key);
    });
    /* Roll each group up from its own members, the way a host would. */
    let leavesOfTotal = 0;
    let emptyGroups = 0;
    const leavesOfKeys = [];
    for (const group of groupKeys) {
      const members = g.rows.leavesOf(group.key) || [];
      if (!members.length) emptyGroups += 1;
      leavesOfTotal += members.length;
      for (const m of members) if (m && m.data) leavesOfKeys.push(m.data.key);
    }
    const sameCount = groupKeys.filter((group) => (g.rows.leavesOf(group.key) || []).length === group.leafCount).length;
    return {
      groups,
      leaves: leafKeys.length,
      distinct: new Set(leafKeys).size,
      evictedBack: leafKeys.filter((k) => k === 'window-check-expiring' || k === 'window-check-early').length,
      byKeyEvicted: !!g.rows.byKey('window-check-expiring') || !!g.rows.byKey('window-check-early'),
      match: g.rows.matchCount(),
      total: g.rows.totalCount(),
      trains: d.kpis.arrivals.value('trains'),
      leavesOfTotal,
      leavesOfDistinct: new Set(leavesOfKeys).size,
      emptyGroups,
      sameCount,
    };
  })()`);
  await evaluate('window.__tflDemo.arrivalsGrid.columns.group([])');
  await sleep(500);
  const ungrouped = await evaluate("({ rows: window.__tflDemo.arrivalsGrid.rows.count(), total: window.__tflDemo.arrivalsGrid.rows.totalCount(), resurrected: !!window.__tflDemo.arrivalsGrid.rows.byKey('window-check-expiring') })");
  /* The live count can only fall while this runs, so anything between the
     reading after and the reading before is the live count. */
  const liveRange = (n) => n >= ungrouped.total && n <= liveBefore.total;
  console.log(`  grouped by line: ${grouped.groups} groups, ${grouped.leaves} leaves (${grouped.distinct} distinct), match ${grouped.match}, total ${grouped.total}, tile ${grouped.trains}; leavesOf returned ${grouped.leavesOfTotal} rows (${grouped.leavesOfDistinct} distinct) over ${grouped.groups} groups, ${grouped.emptyGroups} empty, ${grouped.sameCount} agreeing with leafCount`);
  console.log(`  live rows ${liveBefore.total} before grouping, ${ungrouped.total} after ungrouping; an evicted key is back: ${grouped.evictedBack > 0 || grouped.byKeyEvicted}`);
  check(grouped.groups > 0, 'grouping the open arrivals stream by line produces group rows', `${grouped.groups} groups`);
  check(liveRange(grouped.leaves), 'grouping the open stream shows the live trains and no more', `${grouped.leaves} leaves for between ${ungrouped.total} and ${liveBefore.total} live rows`);
  check(grouped.leaves === grouped.distinct, 'grouping the open stream shows each live train once', `${grouped.leaves} leaves, ${grouped.distinct} distinct keys`);
  check(grouped.evictedBack === 0 && !grouped.byKeyEvicted, 'grouping brings back none of the trains the window evicted', `${grouped.evictedBack} evicted keys among the leaves`);
  check(liveRange(grouped.total), "the grouped table's own count is the live rows", `${grouped.total} against between ${ungrouped.total} and ${liveBefore.total}`);
  check(liveRange(grouped.trains), 'the rows under the groups still count towards the tiles', `${grouped.trains} against between ${ungrouped.total} and ${liveBefore.total}`);
  check(grouped.leavesOfTotal > 0 && grouped.emptyGroups === 0, "rows.leavesOf answers on the grouped stream, for every group", `${grouped.leavesOfTotal} rows over ${grouped.groups} groups, ${grouped.emptyGroups} groups empty`);
  check(grouped.sameCount === grouped.groups, "rows.leavesOf returns as many members as the group heading counts", `${grouped.sameCount} of ${grouped.groups} groups agree`);
  check(liveRange(grouped.leavesOfDistinct), 'rolling every group up covers the live trains, once each', `${grouped.leavesOfDistinct} distinct members of ${grouped.leavesOfTotal}`);
  check(!ungrouped.resurrected && ungrouped.total <= grouped.total, 'ungrouping restores the live rows', `${ungrouped.total} rows`);
  await shoot('03-grouped-by-line');

  noErrors('saved copy, after the checks');
  const snapshotCalls = requested.filter((url) => url.includes(API_HOST));
  check(snapshotCalls.length === 0, 'the saved-copy page made no request to the API', `${snapshotCalls.length} requests`);

  /* =================================================================== */
  /* 2. What a visitor gets when TfL cannot be reached.                  */
  /* =================================================================== */

  /*
   * The API is blocked in the browser rather than asked politely to fail, so
   * this exercises the same path a real outage takes and the demo carries no
   * test-only code. A failed request does log to the console, so the check
   * here is that nothing was thrown and the saved copy is on screen saying
   * so.
   */
  await call('Network.setBlockedURLs', { urls: [`*${API_HOST}*`] });
  requested.length = 0;
  await open(`${origin}/index.html`, 'default page, with the API unreachable');
  const fallback = await readFigures();
  const fallbackNotice = await evaluate(`(() => { const n = document.querySelector('.notice'); return n && !n.hidden ? n.textContent.trim() : null; })()`);
  console.log(`  ${fallback.lines} lines, ${fallback.arrivals} arrivals, ${fallback.bikes} docking stations; badge "${fallback.badge}", fell back: ${fallback.fellBack}`);
  check(fallback.fellBack, 'fallback: the page recorded that it fell back to the saved copy');
  console.log(`  notice: ${fallbackNotice}`);
  check(requested.filter((url) => url.includes(API_HOST)).length > 0, 'fallback: the page did try the API', `${requested.filter((url) => url.includes(API_HOST)).length} requests attempted`);
  check(fallback.lines === savedLines.length && fallback.bikesTotal === savedBikes.length, 'fallback: the saved copy is on screen', `${fallback.lines} lines, ${fallback.bikesTotal} docking stations`);
  check(fallback.badge === 'Saved copy', 'fallback: the badge reads "Saved copy"', `"${fallback.badge}"`);
  check(!!fallbackNotice && /could not be reached/i.test(fallbackNotice), 'fallback: the page says TfL was unreachable', fallbackNotice);
  check(/copy saved on/.test(fallback.freshness || ''), "fallback: the saved copy's date is shown", fallback.freshness);
  check(!fallback.polling, 'fallback: no poll is started against an API that could not be reached');
  check(fallback.lineTiles.good === expectedLines.good && fallback.bikeTiles.bikes === expectedBikes.available, 'fallback: the tiles read the saved copy');
  check(pageErrors.length === 0, 'fallback: no page errors', pageErrors.slice(0, 3).join(' | '));
  await shoot('04-fallback');
  await call('Network.setBlockedURLs', { urls: [] });

  if (live) {
    /* ================================================================= */
    /* 3. Live: the page's figures against the raw API, reduced in Node; */
    /*    then three polls, to see trains arrive and age out.            */
    /* ================================================================= */

    requested.length = 0;
    await open(`${origin}/index.html`, 'default page, live');
    const liveStart = Date.now();
    const before = await readFigures();
    console.log(`  live: ${before.lines} lines, ${before.arrivals} arrivals (${before.arrivalKeys.length} keys), ${before.bikes} docking stations; badge "${before.badge}"`);
    console.log(`  ${before.freshness}`);
    check(!before.fellBack && before.badge === 'Live', 'live: the rows came from TfL, not the saved copy', `"${before.badge}"`);
    check(before.watermark === false, 'live: no watermark on localhost');
    check(before.polling, 'live: polling is running');
    const initialCalls = requested.filter((url) => url.includes(API_HOST)).length;
    check(initialCalls === 2 + STATIONS.length, 'live: the first load was one request per feed and one per station', `${initialCalls}`);

    /* The raw feeds, read here at the same moment and reduced without going
       through the page's code: the line severity codes, the bike counts and
       the predictions straight off the JSON. */
    console.log('\n--- fetching the raw feeds in Node, for the cross-check ---');
    const rawStatus = await fetchJson(statusUrl(), { signal: AbortSignal.timeout(30000) });
    const rawBikes = await fetchJson(bikePointsUrl(), { signal: AbortSignal.timeout(30000) });
    const rawArrivals = (await Promise.all(STATIONS.map((s) => fetchJson(arrivalsUrl(s.id), { signal: AbortSignal.timeout(30000) })))).flat();
    const rawAt = Date.now();
    const rawLines = rawStatus.map((line) => {
      const worst = line.lineStatuses.reduce((w, s) => (rankOf(s.statusSeverity) < rankOf(w.statusSeverity) ? s : w), line.lineStatuses[0]);
      return { name: line.name, severity: worst.statusSeverity, status: worst.statusSeverityDescription, level: levelOf(worst.statusSeverity), rank: rankOf(worst.statusSeverity) };
    });
    const rawLineFigures = lineFigures(rawLines);
    const prop = (place, key) => Number((place.additionalProperties.find((p) => p.key === key) || {}).value);
    const rawBikeRows = rawBikes.map((place) => ({
      bikes: prop(place, 'NbBikes'), empty: prop(place, 'NbEmptyDocks'), docks: prop(place, 'NbDocks'),
      installed: (place.additionalProperties.find((p) => p.key === 'Installed') || {}).value === 'true',
      area: (place.commonName.split(',').pop() || '').trim(),
    }));
    const rawBikeFigures = bikeFigures(rawBikeRows);
    const rawDue = rawArrivals.map((p) => Date.parse(p.expectedArrival)).filter(Number.isFinite);
    const rawInWindow = rawDue.filter((due) => rawAt - due <= ARRIVAL_GRACE_MS).length;
    const rawDue5 = rawDue.filter((due) => due >= rawAt && due - rawAt <= 5 * 60 * 1000).length;
    const rawNextKsx = rawArrivals
      .filter((p) => p.naptanId === ksx.id && Date.parse(p.expectedArrival) >= rawAt - 15000)
      .sort((a, b) => Date.parse(a.expectedArrival) - Date.parse(b.expectedArrival))
      .slice(0, 3)
      .map((p) => `${p.lineName} to ${p.towards}`);
    console.log(`  raw: ${rawLines.length} lines, ${rawArrivals.length} predictions (${rawInWindow} inside the window), ${rawBikes.length} docking stations`);

    /* The page again, as close to the raw read as possible. */
    await evaluate(`window.__tflDemo.selectStation(${JSON.stringify(ksx.id)})`);
    await sleep(600);
    const page = await readFigures();
    await evaluate(`window.__tflDemo.selectStation('')`);

    const table = [
      ['Lines with good service', page.lineTiles.good, rawLineFigures.good, near(page.lineTiles.good, rawLineFigures.good)],
      ['Lines disrupted', page.lineTiles.disrupted, rawLineFigures.disrupted, near(page.lineTiles.disrupted, rawLineFigures.disrupted)],
      ['Severe disruption', page.lineTiles.severe, rawLineFigures.severe, near(page.lineTiles.severe, rawLineFigures.severe)],
      ['Worst disruption', page.worst[0], rawLineFigures.worst || 'Good service on every line in view', rawLineFigures.worst ? page.worst[0] === rawLineFigures.worst : /Good service/.test(page.worst[0])],
      ['Bikes available', page.bikeTiles.bikes, rawBikeFigures.available, near(page.bikeTiles.bikes, rawBikeFigures.available, Math.ceil(rawBikeFigures.available * 0.02))],
      ['Empty docks', page.bikeTiles.empty, rawBikeFigures.empty, near(page.bikeTiles.empty, rawBikeFigures.empty, Math.ceil(rawBikeFigures.empty * 0.02))],
      ['Stations with no bikes', page.bikeTiles.noBikes, rawBikeFigures.noBikes, near(page.bikeTiles.noBikes, rawBikeFigures.noBikes, 5)],
      ['Docking stations', page.bikeTiles.stations, rawBikeFigures.stations, near(page.bikeTiles.stations, rawBikeFigures.stations, 2)],
      ['Trains in the window (all stations)', before.arrivalTiles.trains, rawInWindow, near(before.arrivalTiles.trains, rawInWindow, Math.ceil(rawInWindow * 0.15))],
      ['Due in the next 5 minutes', before.arrivalTiles.due5, rawDue5, near(before.arrivalTiles.due5, rawDue5, Math.ceil(rawDue5 * 0.3) + 2)],
      [`Next train at ${ksx.name}`, page.next[0], rawNextKsx.join(' / '), rawNextKsx.some((t) => page.next[0].startsWith(t))],
    ];
    console.log('\n  KPI cross-check, page against the raw feeds read in Node:');
    console.log('  | Figure | Page | Raw feed | Agree |');
    console.log('  | --- | --- | --- | --- |');
    for (const [label, shown, raw, ok] of table) {
      console.log(`  | ${label} | ${shown} | ${raw} | ${ok ? 'yes' : 'NO'} |`);
      check(ok, `live: ${label} agrees with the raw feed`, `page ${shown}, raw ${raw}`);
    }

    /* ---- three polls ---- */

    console.log(`\n--- waiting for three arrivals polls (about ${(3 * 30)} seconds) ---`);
    await waitFor('window.__tflDemo.status.polls.arrivals >= 3', 150000, 'three arrivals polls');
    await sleep(1500);
    const after = await readFigures();
    const beforeKeys = new Set(before.arrivalKeys);
    const afterKeys = new Set(after.arrivalKeys);
    const gone = before.arrivalKeys.filter((k) => !afterKeys.has(k));
    const arrived = after.arrivalKeys.filter((k) => !beforeKeys.has(k));
    const elapsed = Math.round((Date.now() - liveStart) / 1000);
    console.log(`  after ${elapsed}s and ${after.status.polls.arrivals} arrivals polls (${after.status.polls.lines} status, ${after.status.polls.bikes} bike): ${before.arrivals} -> ${after.arrivals} rows`);
    console.log(`  keys: ${before.arrivalKeys.length} before, ${after.arrivalKeys.length} after; ${gone.length} gone, ${arrived.length} new`);
    console.log(`  gone (first five): ${gone.slice(0, 5).join(', ')}`);
    console.log(`  new (first five): ${arrived.slice(0, 5).join(', ')}`);
    console.log(`  counters: ${JSON.stringify({ added: after.status.arrivalsAdded, updated: after.status.arrivalsUpdated, withdrawn: after.status.arrivalsWithdrawn, evicted: after.status.arrivalsEvicted, logEvicted: after.status.logEvicted })}`);
    console.log(`  ${after.freshness}`);
    const liveCalls = requested.filter((url) => url.includes(API_HOST)).length;
    console.log(`  ${liveCalls} requests to the API in ${elapsed}s`);
    check(after.status.polls.arrivals >= 3, 'live: at least three arrivals polls landed', `${after.status.polls.arrivals}`);
    check(after.status.arrivalsAdded > 0 && arrived.length > 0, 'live: new predictions arrived through the router', `${after.status.arrivalsAdded} added, ${arrived.length} new keys in the table`);
    check(after.status.arrivalsUpdated > 0, 'live: existing predictions were updated in place', `${after.status.arrivalsUpdated} updates`);
    check(after.status.arrivalsEvicted > 0 && gone.length > 0, "live: trains aged out through the grid's own window", `${after.status.arrivalsEvicted} evicted by the grid, ${gone.length} keys gone from the table`);
    check(after.badge === 'Live' && /aged out/.test(after.freshness || ''), 'live: the readout reports the arrivals and the evictions', after.freshness);
    check(liveCalls <= 2 + STATIONS.length + (STATIONS.length * 4) + 4, 'live: the request rate stayed inside the anonymous limit', `${liveCalls} in ${elapsed}s`);
    const mismatch = await evaluate(`(() => { const d = window.__tflDemo; const now = Date.now();
      let stale = 0, checked = 0; const examples = [];
      d.arrivalsGrid.rows.forEachAll((r) => { if (!r || !r.data) return; checked++; const v = d.arrivalsGrid.rows.value(r.key, 'due'); if (Date.parse(v) !== r.data.due && v !== r.data.due) { stale++; if (examples.length < 2) examples.push(r.key + ': shows ' + d.arrivalsGrid.rows.text(r.key, 'due') + ', data ' + new Date(r.data.due).toISOString()); } });
      const rows = d.arrivedRows(); const buckets = {}; for (const r of rows) buckets[r.dueMinute] = (buckets[r.dueMinute] || 0) + 1;
      const c = d.charts[1]; const pts = ((c.data() || {}).series || [{}])[0].points || []; const shown = {}; for (const p of pts) shown[p.x] = p.y;
      const agree = Object.keys(buckets).length === Object.keys(shown).length && Object.keys(buckets).every((k) => shown[k] === buckets[k]);
      return { stale, checked, examples, buckets, shown, agree }; })()`);
    console.log(`  cells read against row data: ${mismatch.stale} of ${mismatch.checked} rows disagree; ${mismatch.examples.join(' | ')}`);
    console.log(`  arrivals chart: ${JSON.stringify(mismatch.shown)} against the rows it was given ${JSON.stringify(mismatch.buckets)}`);
    check(mismatch.checked > 0 && mismatch.stale === 0, 'live: every arrival reads its own cells through the grid', `${mismatch.stale} of ${mismatch.checked} rows read another row's due; ${mismatch.examples.join(' | ')}`);
    check(Object.keys(mismatch.buckets).length > 0 && mismatch.agree, 'live: the arrivals-per-minute chart buckets the rows it was given by their own minute', `chart ${JSON.stringify(mismatch.shown)}, rows ${JSON.stringify(mismatch.buckets)}`);
    noErrors('live');
    await shoot('05-live');
  }

  socket.close();
} catch (error) {
  failures.push(String((error && error.stack) || error));
} finally {
  /* Take the whole browser tree down, not just the process that was spawned:
     a surviving renderer is an orphan nobody will reap. Only the browser this
     check started. */
  if (browserPid) {
    try { process.kill(-browserPid, 'SIGKILL'); } catch {}
    try { process.kill(browserPid, 'SIGKILL'); } catch {}
  }
  if (server) server.close();
  await sleep(400);
  if (profile) await rm(profile, { recursive: true, force: true });
}

console.log('\nChecks:');
for (const note of notes) console.log(note);
console.log(`\nReal time: ${Math.round((Date.now() - realStart) / 1000)}s`);

if (failures.length) {
  console.error(`\nFAILED (${failures.length}):`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log(`\nAll ${notes.length} checks passed.`);
process.exit(0);
