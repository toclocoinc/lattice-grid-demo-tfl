/**
 * The TfL Unified API: the feeds this demo reads, how a response is turned
 * into flat rows, polling, and the saved copy's shape.
 *
 * One module, shared three ways. The page imports it to read the API live in
 * the browser; `tools/build-snapshot.mjs` imports it under Node to take the
 * saved copy; `tools/verify.mjs` imports it to know what the page was given.
 * Nothing in here touches the DOM or the grid.
 *
 * The API is keyless for this demo. Everything below about it was established
 * by real requests from Node on 16 September 2026, and is written up in the
 * README:
 *
 *   - every feed here answers with no `app_key`, and every answer carries
 *     `Access-Control-Allow-Origin: *`, so a page on GitHub Pages reads it
 *     directly;
 *   - the anonymous limit is about 50 requests a minute: the 46th request in
 *     four seconds answered 429 with `Retry-After: 31`, and the block cleared
 *     30 seconds later. This page makes 18 a minute;
 *   - TfL caches each answer for up to 60 seconds at its edge, so polling
 *     faster than that only re-reads the cache.
 */

/** The API root. */
export const BASE = 'https://api.tfl.gov.uk';

/** The host, for a check that wants to know whether a request went to the API. */
export const API_HOST = 'api.tfl.gov.uk';

/** The modes whose line status the page shows, as the API spells them. */
export const MODES = 'tube,dlr,overground,elizabeth-line';

/** A readable name for each mode. */
export const MODE_LABELS = {
  tube: 'Tube',
  dlr: 'DLR',
  overground: 'Overground',
  'elizabeth-line': 'Elizabeth line',
};

/**
 * The stations whose arrivals the page follows: busy interchanges, and three
 * modes among them so the arrivals table is not only the Tube. `id` is the
 * NaPTAN id the API takes; `name` is what the page shows.
 */
export const STATIONS = [
  { id: '940GZZLUKSX', name: "King's Cross St. Pancras", mode: 'tube' },
  { id: '940GZZLUOXC', name: 'Oxford Circus', mode: 'tube' },
  { id: '940GZZLUWLO', name: 'Waterloo', mode: 'tube' },
  { id: '940GZZLULVT', name: 'Liverpool Street', mode: 'tube' },
  { id: '940GZZLUBNK', name: 'Bank', mode: 'tube' },
  { id: '940GZZLUVIC', name: 'Victoria', mode: 'tube' },
  { id: '910GLIVST', name: 'Liverpool Street (Elizabeth line and Overground)', mode: 'rail' },
  { id: '910GHGHI', name: 'Highbury & Islington (Overground)', mode: 'rail' },
];

/** How often each feed is asked. TfL's edge cache holds an answer for up to 60 s. */
export const STATUS_POLL_MS = 60 * 1000;
export const ARRIVALS_POLL_MS = 30 * 1000;
export const BIKES_POLL_MS = 60 * 1000;

/**
 * How long a train stays in the arrivals table after it was due: the rolling
 * window's span, measured from each prediction's own expected arrival. It is
 * the grid's own `maxAge`, so the row leaves whether or not another poll has
 * landed. Twenty seconds is long enough to see a train go from "due" to
 * "arrived" and short enough that the table is always the next half hour.
 */
export const ARRIVAL_GRACE_MS = 20 * 1000;

/**
 * How long an arrival stays in the log behind the arrivals chart: ten minutes
 * past its due time. The same stream, a second viewer with its own window.
 */
export const ARRIVED_LOG_MS = 10 * 60 * 1000;

/**
 * When the saved copy stands in for the live feeds, it is shown as though it
 * were fetched this many milliseconds ago: the first few minutes of saved
 * predictions have then already "arrived", so the arrivals chart has
 * something to draw and the table is already ageing rows out. The page says
 * so under the title.
 */
export const REPLAY_LEAD_MS = 4 * 60 * 1000;

/* ------------------------------------------------------------------ */
/* Severity                                                            */
/* ------------------------------------------------------------------ */

/**
 * TfL's status severity codes, from `Line/Meta/Severity`. The number is a
 * code, not a scale: 10 is good service, 20 is the overnight "service
 * closed", and 0 is "special service". `SEVERITY_ORDER` is the page's own
 * ordering of them, worst first, used to rank lines and to pick the worst of
 * a line's several statuses.
 */
export const SEVERITY = {
  0: 'Special Service',
  1: 'Closed',
  2: 'Suspended',
  3: 'Part Suspended',
  4: 'Planned Closure',
  5: 'Part Closure',
  6: 'Severe Delays',
  7: 'Reduced Service',
  8: 'Bus Service',
  9: 'Minor Delays',
  10: 'Good Service',
  11: 'Part Closed',
  12: 'Exit Only',
  13: 'No Step Free Access',
  14: 'Change of frequency',
  15: 'Diverted',
  16: 'Not Running',
  17: 'Issues Reported',
  18: 'No Issues',
  19: 'Information',
  20: 'Service Closed',
};

export const SEVERITY_ORDER = [1, 2, 16, 3, 4, 5, 11, 6, 8, 15, 7, 9, 14, 17, 12, 13, 0, 19, 18, 20, 10];

/** The four bands the page colours a status by. */
export const LEVELS = {
  good: [10, 18, 19],
  minor: [9, 7, 14, 17, 12, 13, 0],
  severe: [1, 2, 3, 4, 5, 6, 8, 11, 15, 16],
  closed: [20],
};

export const LEVEL_LABELS = { good: 'Good service', minor: 'Minor disruption', severe: 'Severe disruption', closed: 'Service closed' };

/** The band a severity code falls in. */
export function levelOf(severity) {
  for (const [level, codes] of Object.entries(LEVELS)) if (codes.includes(severity)) return level;
  return 'minor';
}

/** Where a severity code sits in the worst-first order; unknown codes rank as minor. */
export function rankOf(severity) {
  const at = SEVERITY_ORDER.indexOf(severity);
  return at < 0 ? SEVERITY_ORDER.indexOf(9) : at;
}

/** The status descriptions in a band, for a formatting rule on the text column. */
export function descriptionsOf(level) {
  return LEVELS[level].map((code) => SEVERITY[code]);
}

/* ------------------------------------------------------------------ */
/* Fetching                                                            */
/* ------------------------------------------------------------------ */

/**
 * Fetch one API answer as JSON.
 *
 * A 429 is the anonymous rate limit; the error carries the `Retry-After`
 * the API asked for, so a caller can wait exactly that long rather than
 * guessing.
 *
 * @param {string} url the address
 * @param {object} [options]
 * @param {AbortSignal} [options.signal]
 * @param {Function} [options.fetch] a fetch to use instead of the global one
 * @returns {Promise<any>} the parsed body
 */
export async function fetchJson(url, { signal, fetch: fetchFn } = {}) {
  const doFetch = fetchFn || globalThis.fetch;
  const response = await doFetch(url, { signal, cache: 'no-store', headers: { accept: 'application/json' } });
  if (!response.ok) {
    const error = new Error(`TfL answered ${response.status}${response.status === 429 ? ', the rate limit' : ''}`);
    error.status = response.status;
    const retry = Number(response.headers.get('retry-after'));
    if (Number.isFinite(retry) && retry > 0) error.retryAfterMs = retry * 1000;
    throw error;
  }
  return response.json();
}

/** The line status address. `detail=true` carries the reason text for a disruption. */
export function statusUrl() {
  return `${BASE}/Line/Mode/${MODES}/Status?detail=true`;
}

/** The arrivals address for one station. The API does not take several ids at once here: that is a 404. */
export function arrivalsUrl(stationId) {
  return `${BASE}/StopPoint/${encodeURIComponent(stationId)}/Arrivals`;
}

/** Every cycle hire docking station, with its live counts. About 2 MB, 86 kB compressed. */
export function bikePointsUrl() {
  return `${BASE}/BikePoint`;
}

/* ------------------------------------------------------------------ */
/* Shaping                                                             */
/* ------------------------------------------------------------------ */

/** `'12:34'` for an instant, in the reader's own time zone. */
export function minuteKey(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** `'Bank'` for `'Bank Underground Station'`: the name a board would show. */
export function shortStation(name) {
  if (!name) return null;
  return String(name)
    .replace(/\s+(Underground|Rail|DLR)\s+Station$/i, '')
    .replace(/\s+\(London\)/, '')
    .trim();
}

/**
 * One line's status as the row the page holds.
 *
 * A line can carry several statuses at once (a part suspension and severe
 * delays, say). The row shows the worst of them by `SEVERITY_ORDER`, keeps
 * the count, and carries every reason joined.
 *
 * @param {object} line one member of the `Line/Mode/.../Status` answer
 * @param {number} fetchedAt when the answer arrived
 * @returns {object|null} the row, or null when the line has no usable identity
 */
export function toLine(line, fetchedAt) {
  if (!line || !line.id) return null;
  const statuses = Array.isArray(line.lineStatuses) && line.lineStatuses.length
    ? line.lineStatuses
    : [{ statusSeverity: 10, statusSeverityDescription: SEVERITY[10] }];
  let worst = statuses[0];
  for (const status of statuses) if (rankOf(status.statusSeverity) < rankOf(worst.statusSeverity)) worst = status;
  const severity = Number(worst.statusSeverity);
  const reasons = statuses.map((s) => s.reason).filter(Boolean);
  return {
    kind: 'line',
    key: line.id,
    id: line.id,
    name: line.name || line.id,
    mode: MODE_LABELS[line.modeName] || line.modeName || 'Unknown',
    severity,
    status: SEVERITY[severity] || worst.statusSeverityDescription || 'Unknown',
    level: levelOf(severity),
    rank: rankOf(severity),
    statuses: statuses.length,
    reason: reasons.length ? [...new Set(reasons)].join(' ') : '',
    updatedAt: fetchedAt,
    /* Always 1. It is what a chart adds up and a group subtotal counts. */
    count: 1,
  };
}

/**
 * One arrival prediction as the row the page holds.
 *
 * The key is the train at the platform: line, vehicle, station and platform.
 * The same vehicle can be predicted at two platforms of one station (a
 * Waterloo & City shuttle is predicted both ways at Bank; a Circle train is
 * predicted on both rails), so the platform is part of the identity. A DLR
 * prediction carries no vehicle id, so the prediction's own id stands in.
 *
 * @param {object} p one member of a `StopPoint/{id}/Arrivals` answer
 * @param {number} fetchedAt when the answer arrived
 * @returns {object|null} the row, or null when the prediction has no usable time
 */
export function toArrival(p, fetchedAt) {
  if (!p || !p.naptanId || !p.lineId) return null;
  const due = Date.parse(p.expectedArrival);
  if (!Number.isFinite(due)) return null;
  const vehicle = p.vehicleId || p.id || '';
  const station = STATIONS.find((s) => s.id === p.naptanId);
  return {
    kind: 'arrival',
    key: `${p.lineId}:${vehicle}@${p.naptanId}#${p.platformName || ''}`,
    predictionId: p.id || null,
    vehicleId: p.vehicleId || null,
    station: p.naptanId,
    stationName: station ? station.name : shortStation(p.stationName) || p.naptanId,
    lineId: p.lineId,
    lineName: p.lineName || p.lineId,
    mode: MODE_LABELS[p.modeName] || p.modeName || 'Unknown',
    platform: p.platformName || '',
    direction: p.direction || '',
    towards: p.towards || shortStation(p.destinationName) || '',
    destination: shortStation(p.destinationName) || '',
    location: p.currentLocation || '',
    timeToStation: Number.isFinite(Number(p.timeToStation)) ? Number(p.timeToStation) : null,
    due,
    dueMinute: minuteKey(due),
    /* When TfL made the prediction. It is the ordering clock: a poll can
       answer from TfL's cache with an older set than the one before, and this
       is how that is told apart from a withdrawn prediction. */
    predictedAt: Number.isFinite(Date.parse(p.timestamp)) ? Date.parse(p.timestamp) : fetchedAt,
    fetchedAt,
    withdrawn: false,
    count: 1,
  };
}

/** The value of one of a bike point's `additionalProperties`, by key. */
function property(place, key) {
  const found = (place.additionalProperties || []).find((p) => p.key === key);
  return found ? found.value : null;
}

/**
 * One cycle hire docking station as the row the page holds.
 *
 * The counts live in `additionalProperties` as strings; the area is the part
 * of the name after the comma (`'River Street , Clerkenwell'`).
 *
 * @param {object} place one member of the `BikePoint` answer
 * @returns {object|null} the row, or null when the place has no id
 */
export function toBikePoint(place) {
  if (!place || !place.id) return null;
  const number = (key) => {
    const n = Number(property(place, key));
    return Number.isFinite(n) ? n : null;
  };
  const flag = (key) => property(place, key) === 'true';
  const name = String(place.commonName || place.id).replace(/\s+,/g, ',').trim();
  const comma = name.lastIndexOf(',');
  let modified = 0;
  for (const p of place.additionalProperties || []) {
    const at = Date.parse(p.modified);
    if (Number.isFinite(at) && at > modified) modified = at;
  }
  return {
    kind: 'bike',
    key: place.id,
    id: place.id,
    name,
    area: comma > 0 ? name.slice(comma + 1).trim() : 'Unknown',
    bikes: number('NbBikes'),
    standard: number('NbStandardBikes'),
    ebikes: number('NbEBikes'),
    empty: number('NbEmptyDocks'),
    docks: number('NbDocks'),
    installed: flag('Installed'),
    locked: flag('Locked'),
    temporary: flag('Temporary'),
    lat: typeof place.lat === 'number' ? place.lat : null,
    lon: typeof place.lon === 'number' ? place.lon : null,
    modified: modified || null,
    count: 1,
  };
}

/* ------------------------------------------------------------------ */
/* The feeds                                                           */
/* ------------------------------------------------------------------ */

/** The line status for every mode, as rows. */
export async function fetchLines(options) {
  const body = await fetchJson(statusUrl(), options);
  const fetchedAt = Date.now();
  const rows = [];
  for (const line of Array.isArray(body) ? body : []) {
    const row = toLine(line, fetchedAt);
    if (row) rows.push(row);
  }
  return { rows, fetchedAt, requests: 1 };
}

/**
 * The arrivals at every station in {@link STATIONS}, as rows: one request per
 * station, in parallel.
 */
export async function fetchArrivals(options) {
  const answers = await Promise.all(STATIONS.map((station) => fetchJson(arrivalsUrl(station.id), options)));
  const fetchedAt = Date.now();
  const rows = [];
  let predictions = 0;
  for (const body of answers) {
    for (const p of Array.isArray(body) ? body : []) {
      predictions += 1;
      const row = toArrival(p, fetchedAt);
      if (row) rows.push(row);
    }
  }
  return { rows, fetchedAt, requests: STATIONS.length, predictions };
}

/** Every docking station, as rows. */
export async function fetchBikePoints(options) {
  const body = await fetchJson(bikePointsUrl(), options);
  const fetchedAt = Date.now();
  const rows = [];
  for (const place of Array.isArray(body) ? body : []) {
    const row = toBikePoint(place);
    if (row) rows.push(row);
  }
  return { rows, fetchedAt, requests: 1 };
}

/**
 * Read the three feeds the page starts from, in parallel: ten requests.
 *
 * @param {{signal?: AbortSignal, onProgress?: Function}} [opts]
 * @returns {Promise<{lines: object[], arrivals: object[], bikes: object[], fetchedAt: number, requests: number, predictions: number}>}
 */
export async function fetchInitial(opts = {}) {
  const report = opts.onProgress || (() => {});
  report('Asking TfL for the line status, the arrivals and the docking stations...', 0.1);
  const [lines, arrivals, bikes] = await Promise.all([fetchLines(opts), fetchArrivals(opts), fetchBikePoints(opts)]);
  report('Building the dashboard...', 0.9);
  return {
    lines: lines.rows,
    arrivals: arrivals.rows,
    bikes: bikes.rows,
    fetchedAt: Math.max(lines.fetchedAt, arrivals.fetchedAt, bikes.fetchedAt),
    requests: lines.requests + arrivals.requests + bikes.requests,
    predictions: arrivals.predictions,
  };
}

/* ------------------------------------------------------------------ */
/* Polling                                                             */
/* ------------------------------------------------------------------ */

/**
 * Poll the three feeds on their own clocks and report each result.
 *
 * Line status and bike points every minute, arrivals every thirty seconds:
 * eighteen requests a minute against an anonymous limit measured at about
 * fifty. When TfL answers 429 anyway (two copies of the page in two tabs,
 * say), every feed pauses for the `Retry-After` the API asked for, and
 * `onThrottle` says until when.
 *
 * @param {object} opts
 * @param {(feed: string, result: object) => void} opts.onPoll called with each successful poll
 * @param {(feed: string, error: Error) => void} [opts.onError] called when a poll fails
 * @param {(until: number) => void} [opts.onThrottle] called when the API asked for a pause
 * @param {object} [opts.intervals] per-feed intervals in ms, for a check that wants them shorter
 * @returns {{stop: Function, pollNow: Function, polls: object}} a handle that stops the polling
 */
export function startPolling({ onPoll, onError, onThrottle, intervals = {} }) {
  let stopped = false;
  let pausedUntil = 0;
  const controller = new AbortController();
  const polls = { lines: 0, arrivals: 0, bikes: 0 };
  const feeds = {
    lines: { every: intervals.lines || STATUS_POLL_MS, run: fetchLines },
    arrivals: { every: intervals.arrivals || ARRIVALS_POLL_MS, run: fetchArrivals },
    bikes: { every: intervals.bikes || BIKES_POLL_MS, run: fetchBikePoints },
  };
  const timers = [];

  const runOnce = async (name) => {
    if (stopped) return;
    if (Date.now() < pausedUntil) return;
    const feed = feeds[name];
    try {
      const result = await feed.run({ signal: controller.signal });
      polls[name] += 1;
      if (!stopped) onPoll(name, { ...result, poll: polls[name] });
    } catch (error) {
      if (stopped) return;
      if (error && error.status === 429) {
        pausedUntil = Date.now() + (error.retryAfterMs || 30000);
        if (onThrottle) onThrottle(pausedUntil);
      }
      if (onError) onError(name, error);
    }
  };

  for (const name of Object.keys(feeds)) {
    timers.push(setInterval(() => runOnce(name), feeds[name].every));
  }

  return {
    polls,
    stop() {
      stopped = true;
      for (const timer of timers) clearInterval(timer);
      controller.abort();
    },
    pollNow: (name) => (name ? runOnce(name) : Promise.all(Object.keys(feeds).map(runOnce))),
  };
}

/* ------------------------------------------------------------------ */
/* The saved copy                                                      */
/* ------------------------------------------------------------------ */

/**
 * Shift a saved copy forward in time so it reads as though it were fetched
 * `leadMs` ago rather than whenever it was taken.
 *
 * Only the arrivals move: a prediction's due time is what the rolling window
 * reads, and unshifted every saved train would be hours late and leave the
 * table at once. Line status and docking stations keep their saved times, so
 * the page can say when they were really read.
 *
 * @param {{lines: object[], arrivals: object[], bikes: object[]}} data the saved rows
 * @param {number} fetchedAtMs when the copy was taken
 * @param {number} [now] the moment to shift to
 * @param {number} [leadMs] how far into the copy "now" should land
 * @returns {{data: object, shiftMs: number}} shifted copies, and the shift applied
 */
export function shiftToNow(data, fetchedAtMs, now = Date.now(), leadMs = REPLAY_LEAD_MS) {
  const shiftMs = now - leadMs - fetchedAtMs;
  return {
    shiftMs,
    data: {
      lines: data.lines,
      bikes: data.bikes,
      arrivals: data.arrivals.map((row) => ({
        ...row,
        due: row.due + shiftMs,
        dueMinute: minuteKey(row.due + shiftMs),
        predictedAt: row.predictedAt + shiftMs,
        fetchedAt: row.fetchedAt + shiftMs,
      })),
    },
  };
}
