/**
 * The dashboard: one arriving stream from TfL, and every view built on it.
 *
 * The data router is the hub. Nothing here fetches anything and nothing here
 * imports the grid: every factory is handed in.
 *
 * How the pieces fit together:
 *
 *   the feeds  ->  the router  ->  the Lines table       ->  its tiles, the severity chart
 *                              ->  the Arrivals table    ->  its tiles
 *                              ->  the arrived log       ->  the arrivals-per-minute chart
 *                              ->  the Bike points table ->  its tiles
 *                                                        ->  a derived grid, by area  ->  the docks chart
 *
 * Every record carries a `kind`, which is what the router partitions on. A
 * line status and a docking station are upserted by id on each poll. An
 * arrival is upserted by train-and-platform on each poll and never deleted:
 * the Arrivals table is a stream source with the grid's own rolling window,
 * so a train leaves the table on its own, twenty seconds after it was due.
 * The arrived log is a second, headless viewer of the same route with a
 * ten-minute window, and the arrivals chart reads that.
 */

import {
  ARRIVAL_GRACE_MS,
  ARRIVED_LOG_MS,
  LEVEL_LABELS,
  STATIONS,
  descriptionsOf,
} from './tfl-api.js';

/** What the location column reads once TfL has withdrawn a prediction. */
export const WITHDRAWN_TEXT = 'Prediction withdrawn by TfL';

/** How many areas the docks chart shows. */
export const AREA_CHART_LIMIT = 10;

/** Make an element with a class and optional text, the long way round. */
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

/** One number, written the way a reader expects to see it. */
function commas(value) {
  return Number(value || 0).toLocaleString('en-GB');
}

/** A clock time, local to whoever is reading. */
function clockText(ms) {
  return new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

/** `'in 2 min'`, `'due now'` or `'arrived'`, from a due time. */
function dueText(due, now = Date.now()) {
  const seconds = Math.round((due - now) / 1000);
  if (seconds < -15) return 'arrived';
  if (seconds < 45) return 'due now';
  return `in ${Math.round(seconds / 60)} min`;
}

/**
 * A row's due time as an instant.
 *
 * A panel bound to a grid hands a tile a projection of each row through the
 * grid's own value pipeline, and the value of a datetime column there is the
 * grid's wall-clock text rather than the number the feed carried. It is read
 * back into milliseconds before anything does arithmetic on it.
 */
function dueOf(row) {
  return typeof row.due === 'number' ? row.due : Date.parse(row.due);
}

/** A stream source that carries nothing itself: every row reaches it through `rows.apply`. */
function idleStream(extra) {
  return {
    mode: 'stream',
    async *open({ signal }) {
      await new Promise((done) => signal.addEventListener('abort', done, { once: true }));
    },
    ...extra,
  };
}

/* ------------------------------------------------------------------ */
/* Columns                                                             */
/* ------------------------------------------------------------------ */

/** The line status columns. */
function lineColumns() {
  return [
    { id: 'name', field: 'name', title: 'Line', filter: { type: 'text' }, layout: { width: 170 } },
    { id: 'mode', field: 'mode', title: 'Mode', filter: { type: 'set' }, layout: { width: 120 } },
    {
      id: 'status',
      field: 'status',
      title: 'Status',
      filter: { type: 'set' },
      layout: { width: 150 },
    },
    {
      id: 'level',
      field: 'level',
      title: 'Band',
      lookup: { options: Object.entries(LEVEL_LABELS).map(([id, label]) => ({ id, label })) },
      filter: { type: 'set' },
      layout: { width: 140 },
    },
    {
      id: 'severity',
      field: 'severity',
      title: 'Severity code',
      type: 'number',
      filter: { type: 'number' },
      layout: { width: 110 },
    },
    {
      id: 'rank',
      field: 'rank',
      title: 'Rank (worst first)',
      type: 'number',
      filter: { type: 'number' },
      /* Worst first, which is what a status board should open on. It also
         orders the severity chart: a chart lays its categories out in the
         order the table walks its rows. */
      sort: { direction: 'asc' },
      layout: { width: 130, hidden: true },
    },
    { id: 'statuses', field: 'statuses', title: 'Statuses', type: 'number', filter: { type: 'number' }, layout: { width: 90, hidden: true } },
    { id: 'reason', field: 'reason', title: 'Reason', filter: { type: 'text' }, layout: { width: 520 } },
    {
      id: 'updatedAt',
      field: 'updatedAt',
      title: 'Read at',
      type: 'datetime',
      filter: { type: 'date' },
      layout: { width: 150 },
    },
    { id: 'count', field: 'count', title: 'Lines', type: 'number', total: 'sum', groupTotal: 'sum', filter: { type: 'none' }, layout: { width: 80, hidden: true } },
  ];
}

/** The arrival columns. */
function arrivalColumns() {
  return [
    {
      title: 'The train',
      columns: [
        { id: 'stationName', field: 'stationName', title: 'Station', filter: { type: 'set' }, layout: { width: 200 } },
        /* The NaPTAN id, hidden: the station selector filters on it, and the
           bound panel needs it as a column to hand the next-train reading. */
        { id: 'station', field: 'station', title: 'Station id', filter: { type: 'set' }, layout: { width: 120, hidden: true } },
        { id: 'lineName', field: 'lineName', title: 'Line', filter: { type: 'set' }, layout: { width: 130 } },
        { id: 'platform', field: 'platform', title: 'Platform', filter: { type: 'set' }, layout: { width: 170 } },
        { id: 'towards', field: 'towards', title: 'Towards', filter: { type: 'text' }, layout: { width: 200 } },
        { id: 'destination', field: 'destination', title: 'Destination', filter: { type: 'text' }, layout: { width: 200, hidden: true } },
        { id: 'vehicleId', field: 'vehicleId', title: 'Train', filter: { type: 'text' }, layout: { width: 80 } },
      ],
    },
    {
      title: 'When',
      columns: [
        {
          id: 'due',
          field: 'due',
          title: 'Due',
          type: 'datetime',
          filter: { type: 'date' },
          /* Soonest first. */
          sort: { direction: 'asc' },
          layout: { width: 150 },
        },
        {
          id: 'inMinutes',
          title: 'In (min)',
          /* Computed from the feed's own countdown at the last poll, so it
             moves every thirty seconds rather than every second. */
          value: {
            deps: ['timeToStation'],
            compute: (deps) => (typeof deps.timeToStation === 'number' ? Math.round(deps.timeToStation / 60) : null),
          },
          type: 'number',
          filter: { type: 'number' },
          layout: { width: 90 },
        },
        {
          id: 'timeToStation',
          field: 'timeToStation',
          title: 'Seconds away',
          type: 'number',
          filter: { type: 'number' },
          layout: { width: 110 },
        },
        { id: 'dueMinute', field: 'dueMinute', title: 'Due minute', filter: { type: 'set' }, layout: { width: 100, hidden: true } },
        { id: 'location', field: 'location', title: 'Where it is now', filter: { type: 'text' }, layout: { width: 260 } },
        { id: 'withdrawn', field: 'withdrawn', title: 'Withdrawn', type: 'boolean', filter: { type: 'boolean' }, layout: { width: 100, hidden: true } },
        { id: 'predictedAt', field: 'predictedAt', title: 'Predicted at', type: 'datetime', filter: { type: 'date' }, layout: { width: 150, hidden: true } },
        { id: 'mode', field: 'mode', title: 'Mode', filter: { type: 'set' }, layout: { width: 110, hidden: true } },
        { id: 'count', field: 'count', title: 'Trains', type: 'number', total: 'sum', groupTotal: 'sum', filter: { type: 'none' }, layout: { width: 80, hidden: true } },
      ],
    },
  ];
}

/** The docking station columns. */
function bikeColumns() {
  const count = (id, title, width) => ({
    id,
    field: id,
    title,
    type: 'number',
    filter: { type: 'number' },
    total: 'sum',
    groupTotal: 'sum',
    layout: { width: width || 100 },
  });
  return [
    { id: 'name', field: 'name', title: 'Docking station', filter: { type: 'text' }, layout: { width: 280 } },
    { id: 'area', field: 'area', title: 'Area', filter: { type: 'set' }, layout: { width: 160 } },
    { ...count('bikes', 'Bikes', 90), sort: { direction: 'desc' } },
    count('ebikes', 'E-bikes', 90),
    count('standard', 'Standard bikes', 120),
    count('empty', 'Empty docks', 110),
    count('docks', 'Docks', 90),
    { id: 'installed', field: 'installed', title: 'Installed', type: 'boolean', filter: { type: 'boolean' }, layout: { width: 90, hidden: true } },
    { id: 'locked', field: 'locked', title: 'Locked', type: 'boolean', filter: { type: 'boolean' }, layout: { width: 80, hidden: true } },
    { id: 'temporary', field: 'temporary', title: 'Temporary', type: 'boolean', filter: { type: 'boolean' }, layout: { width: 100, hidden: true } },
    { id: 'modified', field: 'modified', title: 'Counts changed', type: 'datetime', filter: { type: 'date' }, layout: { width: 150 } },
    { id: 'lat', field: 'lat', title: 'Latitude', type: 'number', format: { decimals: 5, thousandsSeparator: false }, filter: { type: 'number' }, layout: { width: 100, hidden: true } },
    { id: 'lon', field: 'lon', title: 'Longitude', type: 'number', format: { decimals: 5, thousandsSeparator: false }, filter: { type: 'number' }, layout: { width: 100, hidden: true } },
    { id: 'count', field: 'count', title: 'Stations', type: 'number', total: 'sum', groupTotal: 'sum', filter: { type: 'none' }, layout: { width: 90, hidden: true } },
  ];
}

/* ------------------------------------------------------------------ */
/* Formatting                                                          */
/* ------------------------------------------------------------------ */

/** The four bands' colours, shared by the status column and the tiles. */
const BAND_STYLES = {
  good: { background: '#1b5e20', color: '#ffffff' },
  minor: { background: '#f9a825', color: '#1b1b1b' },
  severe: { background: '#b3261e', color: '#ffffff' },
  closed: { background: '#5f6b7a', color: '#ffffff' },
};

/**
 * The traffic lights on the status column. These are conditional formatting
 * rules the grid holds as runtime state, so a reader can open the Formatting
 * panel and change them.
 */
function lineFormatting() {
  return {
    status: Object.keys(BAND_STYLES).map((level) => ({
      id: `status-${level}`,
      label: LEVEL_LABELS[level],
      when: { op: 'in', value: descriptionsOf(level) },
      style: { ...BAND_STYLES[level], fontWeight: '600' },
    })),
    severity: [
      { id: 'severity-good', label: 'Good service', when: { op: 'eq', value: 10 }, style: { color: '#1b5e20', fontWeight: '600' } },
      { id: 'severity-bad', label: 'Below good service', when: { op: 'lt', value: 10 }, style: { color: '#b3261e', fontWeight: '700' } },
    ],
  };
}

/** An arriving train stands out; a withdrawn prediction is struck through. */
function arrivalFormatting() {
  return {
    timeToStation: [
      { id: 'arriving', label: 'Arriving within a minute', when: { op: 'lt', value: 60 }, style: { color: '#1b5e20', fontWeight: '700' } },
    ],
    location: [
      { id: 'withdrawn', label: 'Prediction withdrawn by TfL', when: { op: 'eq', value: WITHDRAWN_TEXT }, style: { color: '#98a2b3', fontStyle: 'italic' } },
    ],
  };
}

/** No bikes, or no room to dock one, in colour. */
function bikeFormatting() {
  return {
    bikes: [
      { id: 'no-bikes', label: 'No bikes', when: { op: 'eq', value: 0 }, style: { background: '#b3261e', color: '#ffffff', fontWeight: '600' } },
      { id: 'few-bikes', label: 'Two bikes or fewer', when: { op: 'lte', value: 2 }, style: { color: '#b3261e', fontWeight: '600' } },
    ],
    empty: [
      { id: 'full', label: 'No empty docks', when: { op: 'eq', value: 0 }, style: { background: '#f9a825', color: '#1b1b1b', fontWeight: '600' } },
    ],
  };
}

/** The shared grid settings every table uses. */
function baseGridConfig(title, columns, formatting) {
  return {
    rowKey: 'key',
    columns,
    formatting,
    theme: 'light',
    density: 'compact',
    stripedRows: true,
    columnMenu: true,
    groupPanel: true,
    statusBar: true,
    find: true,
    grandTotalRow: 'bottom',
    groupDefaultExpanded: 0,
    toolPanel: { side: 'right', panels: ['filters', 'columns', 'formatting'] },
    selection: 'multiple',
    /* A changed status, a moved prediction or a changed dock count lights up
       for a moment rather than changing silently under the reader. */
    highlightOnChange: { colour: '#ffe8a3', duration: 2500 },
    title,
  };
}

/* ------------------------------------------------------------------ */
/* The dashboard                                                       */
/* ------------------------------------------------------------------ */

/**
 * Build the whole page into `root`.
 *
 * @param {object} options
 * @param {HTMLElement} options.root where the dashboard is drawn
 * @param {Function} options.createGrid the grid factory
 * @param {Function} options.createHeadlessGrid the factory for a grid with no DOM
 * @param {Function} options.createChart the charts module's factory
 * @param {Function} options.createKPI the KPI module's factory
 * @param {Function} options.createTabs the tabs module's factory
 * @param {Function} options.createDataRouter the data router module's factory
 * @param {{lines: object[], arrivals: object[], bikes: object[]}} options.data the rows to start with
 * @param {object} options.meta where the data came from, and when
 * @param {string|null} options.station the station id to open the arrivals on, or null for all
 * @returns {object} the pieces that were built, for a caller that wants them
 */
export function buildDashboard({
  root,
  createGrid,
  createHeadlessGrid,
  createChart,
  createKPI,
  createTabs,
  createDataRouter,
  data,
  meta,
  station,
}) {
  root.textContent = '';

  const built = {
    linesGrid: null,
    arrivalsGrid: null,
    bikesGrid: null,
    arrivedLog: null,
    areaGrid: null,
    router: null,
    kpis: {},
    charts: [],
    tabs: null,
    meta,
    station: null,
    status: {
      lastPoll: null,
      lastError: null,
      throttledUntil: null,
      polls: { lines: 0, arrivals: 0, bikes: 0 },
      readAt: { lines: null, arrivals: null, bikes: null },
      arrivalsAdded: 0,
      arrivalsUpdated: 0,
      arrivalsWithdrawn: 0,
      arrivalsReadded: 0,
      arrivalsEvicted: 0,
      logEvicted: 0,
      predictions: 0,
    },
  };

  /* ---------------- the masthead ---------------- */

  const header = el('header', 'head');
  const heading = el('div', 'head-text');
  heading.append(el('h1', null, "London's tube, rail and cycle hire, live from TfL"));
  heading.append(
    el(
      'p',
      'lede',
      'The status of every Tube, DLR, Overground and Elizabeth line, the next trains at eight busy ' +
        'stations, and every cycle hire docking station, read from the Transport for London Unified API ' +
        'and updated as it changes. A train leaves the arrivals table on its own once it has arrived.',
    ),
  );
  const notice = el('p', 'notice');
  notice.hidden = true;
  heading.append(notice);
  if (meta.fellBack) {
    notice.textContent = 'TfL could not be reached, so this is the saved copy. Reloading the page will try again.';
    notice.hidden = false;
  }
  header.append(heading);

  const provenance = el('div', 'head-note');
  const modePill = el('span', 'pill', meta.live ? 'Live' : 'Saved copy');
  const liveDot = el('span', 'dot');
  if (meta.live) modePill.prepend(liveDot);
  const freshness = el('span', 'freshness', 'Waiting for the first update...');
  provenance.append(modePill, freshness);
  header.append(provenance);
  root.append(header);

  /* ---------------- the tiles ---------------- */

  /*
   * Three panels, not one. A KPI panel binds to one grid and reads what that
   * grid currently matches, so a strip that reads three grids is three
   * panels side by side, each following its own table. Two readings are
   * phrases rather than numbers (the worst disruption, the next train), so
   * they are drawn by hand from the bound panels' own rows.
   */
  const kpiHost = el('section', 'kpi-strip');
  kpiHost.setAttribute('aria-label', 'Headline figures');
  const panelHosts = {};
  const named = {};
  for (const [id, label] of [['lines', 'Lines'], ['arrivals', 'Arrivals'], ['bikes', 'Cycle hire']]) {
    const group = el('div', `kpi-group kpi-group-${id}`);
    group.append(el('div', 'kpi-group-label', label));
    const panel = el('div', 'kpi-panel');
    group.append(panel);
    panelHosts[id] = panel;
    if (id !== 'bikes') {
      const tile = el('div', 'kpi-named');
      const value = el('div', 'kpi-named-value', 'No data');
      const caption = el('div', 'kpi-named-label', '');
      tile.append(value, caption);
      group.append(tile);
      named[id] = { value, caption };
    }
    kpiHost.append(group);
  }
  root.append(kpiHost);

  /* ---------------- the charts ---------------- */

  const chartHost = el('section', 'chart-wrap');
  chartHost.setAttribute('aria-label', 'Charts');
  const chartBoxes = [];
  for (let i = 0; i < 3; i += 1) {
    const box = el('div', 'chart-box');
    chartHost.append(box);
    chartBoxes.push(box);
  }
  root.append(chartHost);

  /* ---------------- the controls ---------------- */

  const actions = el('div', 'actions');
  root.append(actions);

  /* ---------------- the tables ---------------- */

  const tabsHost = el('section', 'tabs-host');
  root.append(tabsHost);

  const tabs = createTabs(tabsHost, {
    createGrid,
    createHeadlessGrid,
    ariaLabel: 'TfL views',
    tabs: [
      {
        id: 'lines',
        label: 'Lines',
        badge: true,
        config: { ...baseGridConfig('Line status', lineColumns(), lineFormatting()), rows: [] },
      },
      {
        id: 'arrivals',
        label: 'Arrivals',
        badge: true,
        /*
         * A stream source with the grid's own rolling window. `maxAge` is the
         * span and `ageBy` names the clock it reads: each prediction's own
         * expected arrival. A row is therefore evicted twenty seconds after
         * its train was due, on the grid's own timer, whether or not another
         * poll has landed; a prediction for a train still on its way has a
         * negative age and is never touched. Filtering, sorting and grouping
         * all work on the open stream (1.62.0), which is what makes the
         * station selector and the Group-by buttons possible on a windowed
         * table. The stream carries nothing itself: every row reaches it
         * through the router, as an upsert. It is never sent a delete,
         * because a live stream refuses removals; ageing out is its job.
         */
        config: {
          ...baseGridConfig('Next trains', arrivalColumns(), arrivalFormatting()),
          source: idleStream({ maxAge: ARRIVAL_GRACE_MS, ageBy: 'due' }),
        },
      },
      {
        id: 'bikes',
        label: 'Bike points',
        badge: true,
        config: { ...baseGridConfig('Cycle hire docking stations', bikeColumns(), bikeFormatting()), rows: [] },
      },
    ],
  });
  built.tabs = tabs;

  /*
   * A tab's grid is only built the first time its tab is opened. Every grid
   * here is a route of the router and has tiles bound to it from the start,
   * so the three are opened once each now, ending on the first.
   */
  tabs.activate('arrivals');
  tabs.activate('bikes');
  tabs.activate('lines');
  built.linesGrid = tabs.tab('lines');
  built.arrivalsGrid = tabs.tab('arrivals');
  built.bikesGrid = tabs.tab('bikes');

  /*
   * The arrived log: a second viewer of the arrivals route, with no DOM and
   * a ten-minute window past each train's due time. The arrivals chart reads
   * the trains in it that have arrived. Same stream, a different window.
   */
  const arrivedLog = createHeadlessGrid({
    rowKey: 'key',
    columns: [
      { id: 'key', field: 'key' },
      { id: 'stationName', field: 'stationName' },
      { id: 'station', field: 'station' },
      { id: 'lineName', field: 'lineName' },
      { id: 'due', field: 'due', type: 'number' },
      { id: 'dueMinute', field: 'dueMinute' },
      { id: 'withdrawn', field: 'withdrawn', type: 'boolean' },
      { id: 'count', field: 'count', type: 'number' },
    ],
    source: idleStream({ maxAge: ARRIVED_LOG_MS, ageBy: 'due' }),
  });
  built.arrivedLog = arrivedLog;

  /* ---------------- the router ---------------- */

  /*
   * One stream in, four viewers out. `overlap: true` is what lets an arrival
   * reach both the Arrivals table and the arrived log: without it a record
   * stops at the first route it matches.
   */
  const router = createDataRouter({ key: 'kind', rowKey: 'key', overlap: true });
  built.router = router;
  router.attach(built.linesGrid, 'line');
  router.attach(built.arrivalsGrid, 'arrival');
  router.attach(arrivedLog, 'arrival');
  router.attach(built.bikesGrid, 'bike');

  /* The grid says when its window takes a row out. */
  built.arrivalsGrid.on('stream:evicted', (event) => {
    built.status.arrivalsEvicted += Number(event.evicted) || 0;
    setFreshness();
  });
  arrivedLog.on('stream:evicted', (event) => {
    built.status.logEvicted += Number(event.evicted) || 0;
  });

  /* What each feed last delivered, by key, so a poll can be diffed against it. */
  const known = { line: new Map(), bike: new Map(), arrival: new Map() };

  /**
   * Put a feed's rows through the router.
   *
   * Lines and bike points are a full list each time, so a key that has gone
   * from the list is deleted. Arrivals are never deleted: a prediction that
   * TfL has withdrawn is upserted with `withdrawn: true` and its due time
   * pulled to now, so the grid's own window takes it out twenty seconds
   * later, the same way it takes out a train that arrived. A poll answered
   * from TfL's cache can carry an older set than the poll before, so a key
   * only counts as withdrawn when the new answer was predicted later than the
   * row was.
   *
   * @param {'line'|'arrival'|'bike'} kind which feed
   * @param {object[]} rows the feed's rows
   * @returns {{added: number, updated: number, removed: number, withdrawn: number}}
   */
  const ingest = (kind, rows) => {
    const held = known[kind];
    const deltas = [];
    const seen = new Set();
    const now = Date.now();
    let added = 0;
    let updated = 0;
    let withdrawn = 0;
    let readded = 0;
    let newest = 0;
    for (const row of rows) {
      seen.add(row.key);
      if (held.has(row.key)) {
        updated += 1;
        /* Still predicted by TfL, still held here, but no longer in the
           table: the window took it out at its first due time although a
           later poll had moved that time on (F-1317-3). It comes back as a
           new row, and is counted so the readout can say so. */
        if (kind === 'arrival' && row.due > now && built.arrivalsGrid && !built.arrivalsGrid.rows.byKey(row.key)) readded += 1;
      } else {
        added += 1;
      }
      held.set(row.key, row);
      deltas.push({ op: 'upsert', row });
      if (kind === 'arrival' && row.predictedAt > newest) newest = row.predictedAt;
    }
    const gone = [];
    for (const [key, row] of held) {
      if (seen.has(key)) continue;
      if (kind === 'arrival') {
        /* A train that was due has arrived, or been marked already: TfL
           drops it from the feed and the grid's window drops it from the
           table. It is forgotten here once it is well past the window, so
           this map stays the size of the feed. */
        if (row.due <= now || row.withdrawn) {
          if (now - row.due > ARRIVAL_GRACE_MS * 2) held.delete(key);
          continue;
        }
        /* Still on its way by our last reading, but absent from an answer
           predicted later than that reading: withdrawn. An answer older than
           the reading (TfL's cache) says nothing about it. The row is marked
           and keeps its last due time; the window takes it out twenty
           seconds after that, as it would had the train arrived. (Pulling
           the due time to now would not hurry it: the grid reads the time a
           row was first inserted with, F-1317-3.) */
        if (row.predictedAt >= newest) continue;
        const pulled = { ...row, withdrawn: true, location: WITHDRAWN_TEXT, timeToStation: 0 };
        held.set(key, pulled);
        deltas.push({ op: 'upsert', row: pulled });
        withdrawn += 1;
      } else {
        gone.push(key);
      }
    }
    for (const key of gone) {
      held.delete(key);
      deltas.push({ op: 'delete', row: { kind, key } });
    }
    if (deltas.length) router.apply(deltas);
    return { added, updated, removed: gone.length, withdrawn, readded };
  };
  built.ingest = ingest;

  /* The first load. */
  ingest('line', data.lines);
  ingest('arrival', data.arrivals);
  ingest('bike', data.bikes);
  built.status.predictions = data.arrivals.length;
  /* When the saved copy is shown as fetched a few minutes ago, the elapsed
     time tiles count from that moment rather than from the day the copy was
     really taken. */
  const readAt = meta.live ? meta.fetchedAt : Date.now() - (meta.leadMs || 0);
  built.status.readAt = { lines: readAt, arrivals: readAt, bikes: readAt };

  /* ---------------- the derived grid ---------------- */

  /*
   * Docks by area, derived from the bike points table and following its
   * filter: the ten areas with the most docks. A chart bound to the table
   * itself would draw eight hundred bars.
   */
  const areaGrid = createHeadlessGrid({
    rowKey: '__key',
    source: {
      mode: 'derived',
      from: built.bikesGrid,
      follow: 'filtered',
      groupBy: 'area',
      select: {
        docks: { of: 'docks', fn: 'sum' },
        bikes: { of: 'bikes', fn: 'sum' },
        stations: { fn: 'count' },
      },
      sort: [{ col: 'docks', dir: 'desc' }, { col: 'area', dir: 'asc' }],
      limit: AREA_CHART_LIMIT,
    },
    columns: [
      { id: 'area', field: 'area', title: 'Area' },
      { id: 'docks', field: 'docks', title: 'Docks', type: 'number' },
      { id: 'bikes', field: 'bikes', title: 'Bikes', type: 'number' },
      { id: 'stations', field: 'stations', title: 'Stations', type: 'number' },
    ],
  });
  built.areaGrid = areaGrid;

  /* ---------------- the tiles, one panel per table ---------------- */

  const linesKpi = createKPI(panelHosts.lines, {
    grid: built.linesGrid,
    rowKey: 'key',
    fields: ['name', 'status', 'level', 'rank', 'reason'],
    columns: 3,
    ariaLabel: 'Line status figures',
    tiles: [
      {
        id: 'good',
        label: 'Lines with good service',
        aggregation: 'count',
        filter: (row) => row.level === 'good',
        format: 'number',
      },
      {
        id: 'disrupted',
        label: 'Lines disrupted',
        aggregation: 'count',
        filter: (row) => row.level === 'minor' || row.level === 'severe',
        format: 'number',
        thresholds: { warn: 1, critical: 3, direction: 'lowerIsBetter' },
      },
      {
        id: 'severe',
        label: 'Severe disruption',
        aggregation: 'count',
        filter: (row) => row.level === 'severe',
        format: 'number',
        thresholds: { warn: 1, critical: 2, direction: 'lowerIsBetter' },
      },
    ],
  });
  built.kpis.lines = linesKpi;

  const arrivalsKpi = createKPI(panelHosts.arrivals, {
    grid: built.arrivalsGrid,
    rowKey: 'key',
    fields: ['station', 'stationName', 'lineName', 'towards', 'due', 'withdrawn'],
    columns: 3,
    ariaLabel: 'Arrivals figures',
    tiles: [
      { id: 'trains', label: 'Trains in the window', aggregation: 'count', format: 'number' },
      {
        id: 'due5',
        label: 'Due in the next 5 minutes',
        aggregation: 'count',
        filter: (row) => {
          const due = dueOf(row);
          return !row.withdrawn && due >= Date.now() && due - Date.now() <= 5 * 60 * 1000;
        },
        format: 'number',
      },
      {
        id: 'sincePoll',
        label: 'Seconds since the last update',
        aggregation: 'custom',
        format: { type: 'number', decimals: 0 },
        thresholds: { warn: 90, critical: 180, direction: 'lowerIsBetter' },
        compute: () => {
          const at = built.status.readAt.arrivals;
          if (!at) return null;
          return Math.max(0, Math.round((Date.now() - at) / 1000));
        },
      },
    ],
  });
  built.kpis.arrivals = arrivalsKpi;

  const bikesKpi = createKPI(panelHosts.bikes, {
    grid: built.bikesGrid,
    rowKey: 'key',
    fields: ['bikes', 'empty', 'installed'],
    columns: 4,
    ariaLabel: 'Cycle hire figures',
    tiles: [
      { id: 'bikes', label: 'Bikes available', aggregation: 'sum', field: 'bikes', format: 'number' },
      { id: 'empty', label: 'Empty docks', aggregation: 'sum', field: 'empty', format: 'number' },
      {
        id: 'noBikes',
        label: 'Stations with no bikes',
        aggregation: 'count',
        filter: (row) => row.installed && row.bikes === 0,
        format: 'number',
        thresholds: { warn: 40, critical: 100, direction: 'lowerIsBetter' },
      },
      { id: 'stations', label: 'Docking stations', aggregation: 'count', format: 'number' },
    ],
  });
  built.kpis.bikes = bikesKpi;

  /** Name the worst disruption on the network, from the lines panel's own rows. */
  const refreshWorst = () => {
    let worst = null;
    linesKpi.rows.forEach((row) => {
      if (row.level !== 'minor' && row.level !== 'severe') return;
      if (!worst || row.rank < worst.rank) worst = row;
    });
    if (!worst) {
      named.lines.value.textContent = 'Good service on every line in view';
      named.lines.caption.textContent = 'Worst disruption';
      return;
    }
    named.lines.value.textContent = `${worst.name}: ${worst.status}`;
    named.lines.caption.textContent = worst.reason ? `Worst disruption. ${worst.reason}` : 'Worst disruption';
    named.lines.caption.title = worst.reason || '';
  };
  linesKpi.on('change', refreshWorst);

  /** Name the next train at the chosen station, from the arrivals panel's own rows. */
  const refreshNext = () => {
    const now = Date.now();
    const chosen = built.station;
    let next = null;
    arrivalsKpi.rows.forEach((row) => {
      if (row.withdrawn) return;
      if (chosen && row.station !== chosen) return;
      const due = dueOf(row);
      if (due < now - 15000) return;
      if (!next || due < next.due) next = { ...row, due };
    });
    const where = chosen ? (STATIONS.find((s) => s.id === chosen) || {}).name : 'any of the eight stations';
    if (!next) {
      named.arrivals.value.textContent = 'No train predicted';
      named.arrivals.caption.textContent = `Next train at ${where}`;
      return;
    }
    named.arrivals.value.textContent = `${next.lineName} to ${next.towards || next.destination || '?'}, ${dueText(next.due, now)}`;
    named.arrivals.caption.textContent = `Next train at ${chosen ? where : next.stationName}, due ${clockText(next.due)}`;
  };
  arrivalsKpi.on('change', refreshNext);

  refreshWorst();
  refreshNext();

  /* Some tiles are about elapsed time, so they move on their own: the panels
     are asked to re-read their tables every fifteen seconds. */
  const clock = setInterval(() => {
    arrivalsKpi.refresh();
    refreshNext();
  }, 15000);

  /* ---------------- the charts ---------------- */

  /**
   * The trains that have arrived in the last ten minutes, from the arrived
   * log, soonest first. Read at draw time rather than derived, because a
   * derivation only recomputes when its source changes and "has arrived" is
   * a fact about the clock.
   */
  const arrivedRows = () => {
    const now = Date.now();
    const rows = [];
    arrivedLog.rows.forEach((row) => {
      if (!row || !row.data || row.data.withdrawn) return;
      if (row.data.due > now || now - row.data.due > ARRIVED_LOG_MS) return;
      rows.push(row.data);
    });
    rows.sort((a, b) => a.due - b.due);
    return rows;
  };
  built.arrivedRows = arrivedRows;

  const chartSpecs = [
    {
      grid: built.linesGrid,
      type: 'bar',
      x: 'name',
      y: 'severity',
      title: 'TfL severity code by line (10 is good service; lower is worse)',
      axis: { y: { title: 'Severity code', min: 0, max: 20 }, x: { labels: true, rotate: 'auto' } },
      legend: false,
    },
    {
      grid: arrivedLog,
      rows: arrivedRows,
      type: 'bar',
      x: 'dueMinute',
      y: 'count',
      title: 'Trains arrived per minute, last ten minutes (counted since the page opened)',
      axis: { y: 'Trains', x: { labels: true } },
      legend: false,
    },
    {
      grid: areaGrid,
      type: 'horizontalBar',
      x: 'area',
      y: 'docks',
      title: 'Docks by area, the ten largest',
      axis: { x: 'Docks' },
      margin: { left: 118 },
      legend: false,
    },
  ];

  chartSpecs.forEach((spec, index) => {
    try {
      built.charts.push(createChart({ container: chartBoxes[index], ...spec }));
    } catch (error) {
      chartBoxes[index].append(el('p', 'chart-error', `This chart could not be drawn: ${error.message}`));
      console.error('[tfl demo] chart', spec.type, error);
    }
  });

  /* "Has arrived" is about the clock, so the arrivals chart is redrawn on a
     timer as well as when the log changes. */
  const chartClock = setInterval(() => {
    if (built.charts[1]) built.charts[1].draw();
  }, 15000);

  /* ---------------- the controls ---------------- */

  const button = (label, onClick, className) => {
    const node = el('button', className || 'action', label);
    node.type = 'button';
    node.addEventListener('click', onClick);
    return node;
  };

  /* The station selector: a named filter on the Arrivals table, which its
     tiles and the next-train reading follow. */
  const stationSelect = el('select', 'station-select');
  stationSelect.setAttribute('aria-label', 'Station');
  const allOption = el('option', null, 'All eight stations');
  allOption.value = '';
  stationSelect.append(allOption);
  for (const entry of STATIONS) {
    const option = el('option', null, entry.name);
    option.value = entry.id;
    stationSelect.append(option);
  }
  built.stationSelect = stationSelect;

  /**
   * Narrow the arrivals to one station, or widen them back to all eight.
   *
   * @param {string|null} id a station id, or null or '' for all
   * @returns {boolean} whether the id named a station
   */
  built.selectStation = (id) => {
    const entry = STATIONS.find((s) => s.id === id) || null;
    built.station = entry ? entry.id : null;
    stationSelect.value = entry ? entry.id : '';
    /* A named row predicate: registering it is what activates it, and
       removing it by name leaves any other filter the reader has set
       untouched. */
    built.arrivalsGrid.filters.where('station', entry ? (row) => row.station === entry.id : null);
    const url = new URL(location.href);
    if (entry) url.searchParams.set('station', entry.id);
    else url.searchParams.delete('station');
    history.replaceState(null, '', url);
    refreshNext();
    return !!entry;
  };
  stationSelect.addEventListener('change', () => built.selectStation(stationSelect.value));

  const stationControls = [el('span', 'actions-label', 'Station'), stationSelect];
  actions.append(...stationControls);

  const group = (grid, ids) => () => grid() && grid().columns.group(ids);
  const perTab = {
    lines: [
      el('span', 'actions-label', 'Group by'),
      button('Mode', group(() => built.linesGrid, ['mode'])),
      button('Status', group(() => built.linesGrid, ['status'])),
      button('Band', group(() => built.linesGrid, ['level'])),
      button('No grouping', group(() => built.linesGrid, [])),
      el('span', 'actions-gap'),
      el('span', 'actions-label', 'Order by'),
      button('Worst first', () => built.linesGrid.sort.set([{ col: 'rank', dir: 'asc' }])),
      button('Line name', () => built.linesGrid.sort.set([{ col: 'name', dir: 'asc' }])),
    ],
    arrivals: [
      el('span', 'actions-gap'),
      el('span', 'actions-label', 'Group by'),
      button('Line', group(() => built.arrivalsGrid, ['lineName'])),
      button('Station', group(() => built.arrivalsGrid, ['stationName'])),
      button('Platform', group(() => built.arrivalsGrid, ['stationName', 'platform'])),
      button('No grouping', group(() => built.arrivalsGrid, [])),
      el('span', 'actions-gap'),
      el('span', 'actions-label', 'Order by'),
      button('Soonest first', () => built.arrivalsGrid.sort.set([{ col: 'due', dir: 'asc' }])),
      button('Line, then due', () => built.arrivalsGrid.sort.set([{ col: 'lineName', dir: 'asc' }, { col: 'due', dir: 'asc' }])),
    ],
    bikes: [
      el('span', 'actions-label', 'Group by'),
      button('Area', group(() => built.bikesGrid, ['area'])),
      button('No grouping', group(() => built.bikesGrid, [])),
      el('span', 'actions-gap'),
      el('span', 'actions-label', 'Order by'),
      button('Most bikes', () => built.bikesGrid.sort.set([{ col: 'bikes', dir: 'desc' }])),
      button('Most empty docks', () => built.bikesGrid.sort.set([{ col: 'empty', dir: 'desc' }])),
      button('Name', () => built.bikesGrid.sort.set([{ col: 'name', dir: 'asc' }])),
    ],
  };
  for (const nodes of Object.values(perTab)) actions.append(...nodes);

  const emptyButton = button('Only stations with no bikes', () => {
    const on = emptyButton.getAttribute('aria-pressed') === 'true';
    built.bikesGrid.filters.where('noBikes', on ? null : (row) => row.installed && row.bikes === 0);
    emptyButton.setAttribute('aria-pressed', String(!on));
    emptyButton.classList.toggle('on', !on);
  }, 'action toggle');
  emptyButton.setAttribute('aria-pressed', 'false');
  perTab.bikes.push(el('span', 'actions-gap'), emptyButton);
  actions.append(el('span', 'actions-gap'), emptyButton);
  built.emptyButton = emptyButton;

  /* The station selector belongs to the Arrivals tab; the rest to their own. */
  const showActionsFor = (id) => {
    for (const node of stationControls) node.hidden = id !== 'arrivals';
    for (const [tab, nodes] of Object.entries(perTab)) {
      for (const node of nodes) node.hidden = tab !== id;
    }
  };
  showActionsFor(tabs.activeId);
  tabs.on('tab:changed', (event) => showActionsFor(event.id));

  /* ---------------- the live readout ---------------- */

  /**
   * Say when the data last moved, and say plainly when it stopped.
   */
  function setFreshness() {
    const s = built.status;
    if (!meta.live) {
      const saved = new Date(meta.fetchedAt).toLocaleString('en-GB');
      freshness.textContent =
        `A copy saved on ${saved}, shown as though it were fetched ${Math.round((meta.leadMs || 0) / 60000)} minutes ago. ` +
        `${commas(s.arrivalsEvicted)} trains have aged out of the table since the page opened.`;
      freshness.className = 'freshness';
      return;
    }
    if (s.throttledUntil && Date.now() < s.throttledUntil) {
      freshness.textContent = `TfL asked for a pause (the anonymous rate limit). Polling resumes at ${clockText(s.throttledUntil)}.`;
      freshness.className = 'freshness failed';
      return;
    }
    if (s.lastError) {
      freshness.textContent = s.lastPoll
        ? `Could not reach TfL. Still showing what arrived at ${clockText(s.lastPoll)}.`
        : 'Could not reach TfL.';
      freshness.className = 'freshness failed';
      return;
    }
    const read = (name) => (s.readAt[name] ? clockText(s.readAt[name]) : 'not yet');
    freshness.textContent =
      `Line status read ${read('lines')}, arrivals ${read('arrivals')}, docking stations ${read('bikes')}. ` +
      `Since the page opened: ${commas(s.arrivalsAdded)} new predictions, ${commas(s.arrivalsUpdated)} moved, ` +
      `${commas(s.arrivalsWithdrawn)} withdrawn, ${commas(s.arrivalsEvicted)} trains aged out` +
      (s.arrivalsReadded ? `, ${commas(s.arrivalsReadded)} of them still on their way and put back.` : '.');
    freshness.className = 'freshness';
  }
  built.setFreshness = setFreshness;

  /**
   * Take a poll's result: apply it, refresh the figures and say so.
   *
   * @param {'lines'|'arrivals'|'bikes'} feed which feed answered
   * @param {object} result what {@link startPolling} reported
   */
  built.onPoll = (feed, result) => {
    const kind = { lines: 'line', arrivals: 'arrival', bikes: 'bike' }[feed];
    const outcome = ingest(kind, result.rows);
    built.status.lastPoll = result.fetchedAt || Date.now();
    built.status.lastError = null;
    built.status.throttledUntil = null;
    built.status.polls[feed] += 1;
    built.status.readAt[feed] = result.fetchedAt || Date.now();
    if (feed === 'arrivals') {
      built.status.arrivalsAdded += outcome.added;
      built.status.arrivalsUpdated += outcome.updated;
      built.status.arrivalsWithdrawn += outcome.withdrawn;
      built.status.arrivalsReadded += outcome.readded;
      built.status.predictions = result.predictions || result.rows.length;
    }
    liveDot.classList.add('beat');
    setTimeout(() => liveDot.classList.remove('beat'), 900);
    setFreshness();
    return outcome;
  };

  /**
   * Take a failed poll: keep the tables, say what happened.
   *
   * @param {string} feed which feed failed
   * @param {Error} error what went wrong
   */
  built.onPollError = (feed, error) => {
    built.status.lastError = `${feed}: ${String((error && error.message) || error)}`;
    setFreshness();
    console.warn('[tfl demo] a poll failed:', built.status.lastError);
  };

  /** TfL asked for a pause; say until when. */
  built.onThrottle = (until) => {
    built.status.throttledUntil = until;
    setFreshness();
  };

  setFreshness();

  /* ---------------- the footer ---------------- */

  /*
   * The credits TfL's transport data service terms require, in the words the
   * terms use. The Ordnance Survey and Geomni lines are required by the same
   * clause as the first, so all three are shown.
   */
  const footer = el('footer', 'foot');
  footer.append(el('p', 'attribution', 'Powered by TfL Open Data'));
  footer.append(el('p', 'attribution', 'Contains OS data © Crown copyright and database rights 2016'));
  footer.append(el('p', 'attribution', 'Geomni UK Map data © and database rights [2019]'));
  const line = el('p', null, 'Source: the ');
  const link = el('a', null, 'Transport for London Unified API');
  link.href = 'https://api.tfl.gov.uk/';
  link.rel = 'noopener';
  line.append(link);
  line.append(
    document.createTextNode(
      ', read directly from your browser with no key and no server in the middle: line status and docking ' +
        'stations once a minute, arrivals every thirty seconds. An arrival is a prediction, revised as the ' +
        'train moves; the table keeps a train for twenty seconds after it was due and then lets it go. ' +
        'Times are shown in your own time zone.',
    ),
  );
  footer.append(line);
  root.append(footer);

  /* The opening view. */
  built.selectStation(station);

  built.destroy = () => {
    clearInterval(clock);
    clearInterval(chartClock);
    for (const chart of built.charts) chart.destroy();
    for (const kpi of Object.values(built.kpis)) kpi.destroy();
    router.destroy();
    areaGrid.destroy();
    arrivedLog.destroy();
    tabs.destroy();
  };

  return built;
}
