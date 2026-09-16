/**
 * Save a real read of the TfL feeds to `data/snapshot/`, so the dashboard can
 * also be opened with no network at all.
 *
 * Run it with `npm run snapshot`. It is a development tool: nothing the page
 * loads imports it. It uses exactly the fetching and shaping the page uses,
 * imported from `src/tfl-api.js`, so the saved copy is what the page would
 * have fetched itself: ten requests, one for the line status, one per
 * station for the arrivals, one for the docking stations.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { STATIONS, fetchInitial } from '../src/tfl-api.js';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', 'data', 'snapshot');

const started = Date.now();
console.log('Asking TfL for the line status, the arrivals at eight stations and every docking station...');

const initial = await fetchInitial({
  onProgress: (message) => console.log(`  ${message}`),
  signal: AbortSignal.timeout(60000),
});

const seconds = Number(((Date.now() - started) / 1000).toFixed(1));

/* Sorted so the files are stable between runs when nothing changed. */
initial.lines.sort((a, b) => (a.id < b.id ? -1 : 1));
initial.arrivals.sort((a, b) => a.due - b.due || (a.key < b.key ? -1 : 1));
initial.bikes.sort((a, b) => Number(a.id.split('_')[1]) - Number(b.id.split('_')[1]));

const perStation = {};
for (const station of STATIONS) perStation[station.id] = initial.arrivals.filter((row) => row.station === station.id).length;

const meta = {
  fetchedAt: new Date(initial.fetchedAt).toISOString(),
  fetchedAtMs: initial.fetchedAt,
  seconds,
  requests: initial.requests,
  source: 'Transport for London Unified API',
  sourceUrl: 'https://api.tfl.gov.uk/',
  attribution: [
    'Powered by TfL Open Data',
    'Contains OS data © Crown copyright and database rights 2016',
    'Geomni UK Map data © and database rights [2019]',
  ],
  licence: "TfL's Transport Data Service terms, based on the Open Government Licence v2.0",
  licenceUrl: 'https://tfl.gov.uk/corporate/terms-and-conditions/transport-data-service',
  stations: STATIONS,
  counts: {
    lines: initial.lines.length,
    arrivals: initial.arrivals.length,
    predictions: initial.predictions,
    bikes: initial.bikes.length,
    perStation,
  },
  firstDue: initial.arrivals.length ? new Date(initial.arrivals[0].due).toISOString() : null,
  lastDue: initial.arrivals.length ? new Date(initial.arrivals[initial.arrivals.length - 1].due).toISOString() : null,
};

await mkdir(outDir, { recursive: true });
await writeFile(join(outDir, 'lines.json'), JSON.stringify(initial.lines));
await writeFile(join(outDir, 'arrivals.json'), JSON.stringify(initial.arrivals));
await writeFile(join(outDir, 'bikes.json'), JSON.stringify(initial.bikes));
await writeFile(join(outDir, 'meta.json'), JSON.stringify(meta, null, 2));

console.log(`\nSaved ${initial.lines.length} lines, ${initial.arrivals.length} arrivals and ${initial.bikes.length} docking stations in ${seconds}s, ${initial.requests} requests.`);
for (const station of STATIONS) console.log(`  ${station.name}: ${perStation[station.id]} predictions`);
console.log(`Arrivals due from ${meta.firstDue} to ${meta.lastDue}.`);
