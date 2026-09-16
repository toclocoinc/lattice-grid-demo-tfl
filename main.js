/**
 * The entry point: work out where the data should come from, fetch it, hand
 * it to the dashboard, and then keep it moving.
 *
 * Three ways to open the page:
 *
 *   (nothing)              live, reading the TfL Unified API and polling
 *   ?source=snapshot       the saved copy in `data/snapshot`, replayed
 *   ?station=940GZZLUKSX   open the arrivals narrowed to one station
 *
 * When the API cannot be reached the page opens the saved copy instead and
 * says so at the top, rather than showing an error.
 */

import { createGrid, createHeadlessGrid, setLicence } from './node_modules/@toclocoinc/lattice-grid/lattice-grid.esm.min.js';
import { createChart } from './node_modules/@toclocoinc/lattice-grid/modules/charts.esm.min.js';
import { createKPI } from './node_modules/@toclocoinc/lattice-grid/modules/kpi.esm.min.js';
import { createTabs } from './node_modules/@toclocoinc/lattice-grid/modules/tabs.esm.min.js';
import { createDataRouter } from './node_modules/@toclocoinc/lattice-grid/modules/data-router.esm.min.js';
import { DEMO_LICENCE } from './src/licence.js';
import { buildDashboard } from './src/dashboard.js';
import { REPLAY_LEAD_MS, STATIONS, fetchInitial, shiftToNow, startPolling } from './src/tfl-api.js';

/* Applied before anything is drawn, because a grid that already exists keeps
   whatever licence was in force when it was built. */
setLicence(DEMO_LICENCE);

const TITLE = "London's tube, rail and cycle hire, live from TfL";

const root = document.querySelector('#app');
const params = new URLSearchParams(location.search);
const mode = params.get('source') === 'snapshot' ? 'snapshot' : 'live';
const wantedStation = STATIONS.some((s) => s.id === params.get('station')) ? params.get('station') : null;

/** Draw the waiting state, and return a function that updates its message. */
function showProgress(first) {
  root.textContent = '';
  const panel = document.createElement('div');
  panel.className = 'loading';
  const title = document.createElement('h1');
  title.textContent = TITLE;
  const message = document.createElement('p');
  message.className = 'loading-message';
  message.textContent = first;
  const bar = document.createElement('div');
  bar.className = 'loading-bar';
  const fill = document.createElement('div');
  fill.className = 'loading-fill';
  bar.append(fill);
  panel.append(title, message, bar);
  root.append(panel);
  return (text, fraction) => {
    message.textContent = text;
    fill.style.width = `${Math.round((fraction || 0) * 100)}%`;
  };
}

/** Say what went wrong, in words a reader can act on. */
function showError(error) {
  root.textContent = '';
  const panel = document.createElement('div');
  panel.className = 'loading';
  const title = document.createElement('h1');
  title.textContent = 'The TfL data could not be loaded';
  const message = document.createElement('p');
  message.className = 'loading-message';
  message.textContent = String((error && error.message) || error);
  const hint = document.createElement('p');
  hint.className = 'loading-message';
  hint.textContent = 'You can open the same dashboard from the saved copy by adding ?source=snapshot to the address.';
  panel.append(title, message, hint);
  root.append(panel);
  console.error('[tfl demo]', error);
}

/** Read the saved copy that ships with the demo. */
async function loadSnapshot() {
  const files = await Promise.all(
    ['meta', 'lines', 'arrivals', 'bikes'].map(async (name) => {
      const response = await fetch(`./data/snapshot/${name}.json`, { cache: 'no-store' });
      if (!response.ok) throw new Error(`The saved copy is missing ${name}.json.`);
      return response.json();
    }),
  );
  const [meta, lines, arrivals, bikes] = files;
  return { meta: { ...meta, live: false }, data: { lines, arrivals, bikes } };
}

async function start() {
  const started = performance.now();
  try {
    let data;
    let meta;

    if (mode === 'snapshot') {
      const update = showProgress('Reading the saved copy...');
      const saved = await loadSnapshot();
      meta = saved.meta;
      data = saved.data;
      update('Building the dashboard...', 1);
    } else {
      const update = showProgress('Asking TfL...');
      try {
        const initial = await fetchInitial({ onProgress: update, signal: AbortSignal.timeout(60000) });
        data = { lines: initial.lines, arrivals: initial.arrivals, bikes: initial.bikes };
        meta = { live: true, fetchedAt: initial.fetchedAt, requests: initial.requests, predictions: initial.predictions };
      } catch (liveError) {
        /* The API is out of our hands, so a bad day for it should not be a
           blank page here. The saved copy shows the same dashboard, and the
           masthead says plainly that is what you are looking at. */
        console.warn('[tfl demo] the live fetch failed, falling back to the saved copy:', liveError);
        update('TfL could not be reached. Opening the saved copy...', 1);
        const saved = await loadSnapshot();
        data = saved.data;
        meta = { ...saved.meta, live: false, fellBack: true };
      }
    }

    const fetched = performance.now();

    /*
     * The saved copy is shifted forward so it reads as though it were fetched
     * a few minutes ago, whether it was asked for by name or is standing in
     * for an API that could not be reached. The arrivals are predictions
     * with a rolling window on them, so without the shift every saved train
     * would be hours late and gone at once. The page says so under the title.
     */
    if (!meta.live) {
      const shifted = shiftToNow(data, meta.fetchedAtMs, Date.now(), REPLAY_LEAD_MS);
      data = shifted.data;
      meta.shiftMs = shifted.shiftMs;
      meta.leadMs = REPLAY_LEAD_MS;
      meta.fetchedAt = meta.fetchedAtMs;
    }

    const built = buildDashboard({
      root,
      createGrid,
      createHeadlessGrid,
      createChart,
      createKPI,
      createTabs,
      createDataRouter,
      data,
      meta,
      station: wantedStation,
    });

    /* Not started after a fallback: the saved arrivals have been shifted in
       time, and a poll that later got through would mix real predictions in
       with them. The masthead says that reloading tries the API again. */
    let poller = null;
    if (mode === 'live' && meta.live) {
      poller = startPolling({
        onPoll: (feed, result) => built.onPoll(feed, result),
        onError: (feed, error) => built.onPollError(feed, error),
        onThrottle: (until) => built.onThrottle(until),
      });
      built.poller = poller;
    }

    const finished = performance.now();
    const timings = {
      mode,
      fellBack: !!meta.fellBack,
      lines: data.lines.length,
      arrivals: data.arrivals.length,
      bikes: data.bikes.length,
      requests: meta.requests || 0,
      fetchMs: Math.round(fetched - started),
      buildMs: Math.round(finished - fetched),
      totalMs: Math.round(finished - started),
    };

    window.__tflDemo = Object.assign(built, { meta, timings, ready: true });
    console.log('[tfl demo] ready', timings);
  } catch (error) {
    window.__tflDemo = { ready: false, error: String((error && error.message) || error) };
    showError(error);
  }
}

start();
