# London's tube, rail and cycle hire, live from TfL

A live dashboard of the status of every Tube, DLR, Overground and Elizabeth
line, the next trains at eight busy stations, and every cycle hire docking
station in London, built on Lattice Grid and reading the Transport for London
Unified API directly from the browser, with no key and no server in the middle.

**[See it running](https://toclocoinc.github.io/lattice-grid-demo-tfl/)**

| | |
| --- | --- |
| Grid on npm | [@toclocoinc/lattice-grid](https://www.npmjs.com/package/@toclocoinc/lattice-grid) |
| This demo | [toclocoinc/lattice-grid-demo-tfl](https://github.com/toclocoinc/lattice-grid-demo-tfl) |
| Product site | [latticegrid.dev](https://www.latticegrid.dev) |
| Data | [TfL Unified API](https://api.tfl.gov.uk/), under TfL's [transport data service terms](https://tfl.gov.uk/corporate/terms-and-conditions/transport-data-service) |

Powered by TfL Open Data. Contains OS data © Crown copyright and database
rights 2016. Geomni UK Map data © and database rights [2019].

## What it shows

One arriving stream of data in a data router, and four viewers on it: a table
of line status, a table of the next trains, a table of docking stations, and a
log of arrivals with no screen of its own that a chart reads. Each table has a
strip of headline figures and a chart, and every one of them follows its table:
choose a station, or group, sort or filter a table, and the figures and the
chart move with it.

This is the genuinely live one. The page opens on TfL's answer, then keeps
asking: line status and docking stations once a minute, arrivals every thirty
seconds. What arrives goes through the router as a keyed diff, so a line whose
status changed is repainted, a train whose prediction moved is updated in
place, and a docking station whose counts changed lights up for a moment.

**Lines.** Nineteen lines, one row each: the mode, the status, its band, TfL's
severity code, the reason text for a disruption, and when it was read. Opens
worst first. The status column is coloured by band, which is a conditional
formatting rule the grid holds and the Formatting panel lets a reader change.
Group by mode, status or band.

**Arrivals.** Every train TfL currently predicts at King's Cross St. Pancras,
Oxford Circus, Waterloo, Liverpool Street (Tube, and the rail station's
Elizabeth line and Overground platforms), Bank, Victoria and Highbury &
Islington: the line, the platform, where it is going, when it is due, how many
minutes away it is, and where it is now. A station selector narrows the table
to one station, and the station is in the address (`?station=940GZZLUKSX`).
Group by line, station or platform.

**The rolling window.** The arrivals table keeps a train for twenty seconds
after it was due and then lets it go, on its own, whether or not another poll
has landed. That is the grid's own window: the table's source is a stream
(`source: { mode: 'stream', maxAge: 20000, ageBy: 'due' }`), and `ageBy` names
the clock the window reads, each prediction's own expected arrival. A train
still on its way has a negative age and is never touched; a train that was due
twenty seconds ago is evicted by the grid's timer. Filtering, sorting and
grouping work on the open stream (grid 1.62.0), which is what makes the
station selector and the Group-by buttons possible on a windowed table. The
readout at the top counts the evictions the grid reports.

**Why the grid's window and not one kept by the page.** The window is a fact
about each row's own timestamp, and the grid can evict on a timer while the
feed is silent; a window kept by the page would need its own timer, its own
map of rows and a delete per row, all of which the grid already has. The one
thing the grid's window cannot do is take out a prediction TfL has *withdrawn*
early (a train re-timed, or a prediction that simply vanished from the feed),
because that is not a fact about a timestamp. The page handles that through
the same window: a prediction that is missing from an answer predicted later
than the page last saw it is upserted with `withdrawn: true`, greyed, and
left to the window, which takes it out twenty seconds after its last due time,
the same way it takes out a train that arrived. (The page cannot hurry that by
pulling the due time to now: the window reads the time a row was first
inserted with, F-1317-3 below.) A live stream refuses deletes, so nothing is
ever deleted from the arrivals route. TfL answers from an edge cache that
can be up to a minute old, so an answer can be *older* than the one before;
a key missing from an older answer is not withdrawn, which is why the
prediction's own timestamp is the ordering clock.

**Two windows on one stream.** The arrivals-per-minute chart wants trains that
have *arrived*, which the twenty-second window has already let go of. So the
arrivals route has a second viewer, a headless grid with the same stream
source and a ten-minute window past each train's due time. The chart reads
the trains in it that are past their due time, bucketed by minute. The router
fans each arrival to both (`overlap: true`); each viewer declares its own
window.

**Bike points.** Every docking station, eight hundred of them: bikes, e-bikes,
standard bikes, empty docks, total docks, the area, and when the counts last
changed. A station with no bikes is coloured red, one with no empty dock
amber. A toggle narrows the table to the stations with no bikes. The docks
chart is a grid derived from the table (`source: { mode: 'derived', from,
follow: 'filtered', groupBy: 'area', limit: 10 }`), so it narrows with the
table's filter.

**Headline figures.** A KPI panel binds to one grid and reads what that grid
currently matches, so a strip that reads three grids is three panels side by
side, each `createKPI(host, { grid, rowKey, fields, tiles })` on its own table:
lines with good service, lines disrupted, severe disruption; trains in the
window, trains due in the next five minutes, seconds since the last update;
bikes available, empty docks, stations with no bikes, docking stations. Two
readings are phrases rather than numbers, the worst disruption on the network
with TfL's reason text and the next train at the chosen station, so they are
drawn by hand from the bound panels' own rows each time a panel re-reads its
table. A bound panel hands a tile the grid's value for each column, and for a
datetime column that is the grid's wall-clock text rather than the feed's
number, so the next-train reading reads it back into an instant first.

**A feed that can fail.** If a poll cannot reach TfL the page says so and keeps
showing what it already had. If TfL answers 429, the anonymous rate limit,
every feed pauses for exactly the `Retry-After` the API asked for and the
readout says until when. If TfL cannot be reached at all when the page opens,
it shows the saved copy that ships with the demo, replayed, and says so at the
top.

## The API, as measured

Everything below was established by real requests from Node on 16 September
2026, not read from the documentation alone.

- **Keyless.** `Line/Mode/tube,dlr,overground,elizabeth-line/Status`,
  `StopPoint/{id}/Arrivals` and `BikePoint` all answer 200 with no `app_key`.
  This demo sends none.
- **CORS: yes.** Every answer carries `Access-Control-Allow-Origin: *`, and a
  preflight `OPTIONS` with `Origin: https://toclocoinc.github.io` answers
  `Access-Control-Allow-Methods: GET`, `Access-Control-Max-Age: 300`. A page
  on GitHub Pages reads the API directly, and this one does.
- **The anonymous rate limit is about 50 requests a minute.** Seventy
  requests were fired in quick succession: the first 45 answered 200 in
  3.7 seconds, the 46th and every one after answered
  `429 {"statusCode": 429, "message": "Rate limit is exceeded. Try again in
  31 seconds."}` with `Retry-After: 31`. The block cleared 30 seconds after
  it began; a request at 20 seconds still answered 429 with
  `Retry-After: 10`. No rate-limit header appears on a successful answer.
  TfL's terms ask registered users to stay under 500 calls a minute per
  feed; the FAQ names the registered product "500 Requests per min". This
  page makes 18 requests a minute in steady state: one for the line status
  and one for the docking stations each minute, and one per station for the
  arrivals every thirty seconds. Two copies of the page in two tabs make 36;
  a third would meet the limit, and the page then pauses for the
  `Retry-After` and says so.
- **One request per station.** `StopPoint/{a},{b},{c}/Arrivals` is a 404
  (`EntityNotFoundException`), so the arrivals are eight requests in
  parallel.
- **Response sizes.** Line status 18 kB (133 kB with `?detail=true`, which
  carries the reason text this page shows); arrivals 31 to 58 kB per station
  (33 to 85 predictions); `BikePoint` 2.1 MB for 800 docking stations,
  86 kB compressed on the wire. Every answer is gzip-encoded.
- **Cadence.** Every answer carries `Cache-Control: public, must-revalidate,
  max-age=30, s-maxage=60` and TfL's Varnish reports `X-TTL: 60`: an answer
  can be served from the edge for up to a minute, and the `Age` header says
  how old it is. Polling one station every ten seconds for two minutes, the
  predictions' own `timestamp` changed at 11:13:14, 11:14:08, 11:14:15,
  11:14:39, 11:15:15 and 11:16:02: TfL regenerates a station's predictions
  every 30 to 60 seconds, and between two polls the set of trains changed by
  one to five. Line status carries `modified` stamps that change only when a
  status changes. Docking station counts carry a `modified` stamp per
  station; across 800 stations those spanned four hours, so a station's
  counts change every few minutes on average. Polling arrivals every thirty
  seconds and the other two every minute is therefore as often as anything
  new can be read.
- **Identity.** A prediction's `id` is stable from poll to poll for the same
  train (269 of 269 keys kept their id across two polls 35 seconds apart),
  but it is not unique: a Waterloo & City shuttle is predicted at both Bank
  platforms with one id, and a Circle train on both rails. The page keys an
  arrival on line, vehicle, station and platform. DLR predictions carry no
  vehicle id, so the prediction id stands in there.
- **Modes at one station.** A rail station id such as `910GLIVST` answers
  with Elizabeth line and Overground predictions together; a Tube station id
  such as `940GZZLULVT` answers with the Tube lines only. Elizabeth line
  predictions can carry `Platform Unknown`, and Overground predictions reach
  two hours ahead where the Tube's reach thirty minutes.
- **Attribution.** TfL's transport data service terms, which are based on
  version 2.0 of the Open Government Licence, require these statements where
  the data is published or used, in these words: "Powered by TfL Open Data",
  "Contains OS data © Crown copyright and database rights 2016" and "Geomni UK
  Map data © and database rights [2019]". All three are on the page and at
  the top of this file, exactly as the terms give them, square brackets
  included.

## Running it

You need Node. Nothing is compiled and there is no build step.

```
npm install
npm start
```

The server prints the address to open, for example `http://localhost:41234/`.
It picks a free port each time so it will not clash with anything else you
have running.

| Address | What you get |
| --- | --- |
| `/` | live, reading the TfL Unified API and polling |
| `/?source=snapshot` | the saved copy in `data/snapshot`, replayed, no network needed |
| `/?station=940GZZLUKSX` | open the arrivals narrowed to one station |

The saved copy lives in `data/snapshot/` and records when it was taken. It is
replayed as though it had been fetched four minutes ago, so the first few
minutes of saved predictions have already arrived, the arrivals chart has
something to draw, and the table is already ageing trains out; the page says
so under the title. To take a fresh one:

```
npm run snapshot
```

## Files

```
index.html                page shell
main.js                   works out where the data comes from, then starts
src/licence.js            the key for the demo's own published address
src/tfl-api.js            the API: the feeds, the shaping, polling, the saved copy's shape
src/dashboard.js          the views: router, tables, tiles, charts, tabs
styles.css                the page around the grid
tools/serve.mjs           a small static file server
tools/build-snapshot.mjs  save a real read of the feeds into data/snapshot
tools/verify.mjs          open it in a real browser and check it
data/snapshot/            a saved read, so the demo works with no network
.github/workflows/        publish on push
```

## Checking it

```
npm run verify              # the saved copy, and the fallback with the API blocked
npm run verify -- --live    # also the live page, against the raw feeds, for three polls
npm run verify -- --shots out/   # the same, saving screenshots
```

`npm run verify` needs Node 22 and a Chrome or Chromium on the machine. It is
not a smoke test: it recomputes every headline figure from the saved files in
Node and compares it with what the page shows; checks the docks-by-area chart
area by area and the severity chart line by line; narrows the arrivals to
King's Cross and insists the tiles and the next-train reading followed; pushes
two trains through the router, one due in ten minutes and one due nineteen
seconds ago, and insists the window kept the first and took the second out
while the arrived log kept both; answers a poll without one train and insists
it was marked withdrawn and left through the window; groups the open stream;
insists the three credit lines are on the page word for word; and insists
there is no watermark on localhost. It then blocks the API in the browser,
opens the default page, and insists the saved copy is on screen and says why.
None of that needs the internet, so it gates the deployment. `--live` opens
the default page with the API reachable, reads the same feeds in Node at the
same moment, reduces the raw JSON without going through the page's code and
insists the tiles agree; then waits for three arrivals polls and insists that
new predictions arrived, existing ones were updated in place, and trains aged
out through the grid's window, with the keys before and after.

## Known grid defects, left visible

The verification reports these under their finding ids rather than failing
on them, so they stay visible on every run and turn to "ok" the day the grid
fixes them.

- **F-1317-1.** Grouping an open stream after its window has evicted rows
  brings the evicted rows back and shows the live ones twice: on the
  Arrivals tab, once a few trains have aged out, "Group by line" shows the
  trains that arrived as well as the ones still due, each still-due train
  under its line twice, and the status bar counts the live rows plus every
  row the stream ever held. The tiles stay right. Ungrouping restores the
  table. Grouping *before* any eviction is fine.
- **F-1317-2.** `rows.leavesOf()` on a grouped open stream returns no rows
  and warns that the grid "groups elsewhere", so a host cannot roll up a
  group's members on a windowed table.
- **F-1317-3.** The rolling window reads the `ageBy` value a row was
  *first inserted with*. An update that moves a train's due time later
  (a delay) does not keep it: it is evicted twenty seconds after its first
  predicted time while TfL still predicts it, and the next poll puts it
  back as a new row; the readout counts those. An update that moves the due
  time earlier does not hurry it out either.
- **F-1317-4.** A row added to an open stream through `rows.apply({ add })`
  after the stream's first chunk reads, through the grid's own cell reads
  (`rows.value`, `rows.text`, the projection a bound KPI panel or a chart
  sees), the values of the row at the *same position in the first chunk*:
  with three rows in the first chunk and two added later, the fourth row
  reads the first row's cells and the fifth the second's, while `row.data`
  on each carries the right values. An update to the row corrects it; rows
  the stream yields itself are right; a memory source over the same batches
  is right throughout. On the live page a train that appears after the
  first load shows another train's due time and destination until the next
  poll updates it, and the arrivals-per-minute chart, which buckets each
  train by the minute the grid reads for it, puts such a train under the
  wrong minute. The verification reads every arrival both ways and reports
  the disagreement under this id.

## Licence

The code in this repository is available under the MIT licence. See
[LICENSE](LICENSE).

Powered by TfL Open Data. Contains OS data © Crown copyright and database
rights 2016. Geomni UK Map data © and database rights [2019]. The data is
provided under TfL's [transport data service terms](https://tfl.gov.uk/corporate/terms-and-conditions/transport-data-service).

Lattice Grid itself is a separate commercial product with its own terms. It
is free to use on localhost, with no key and no watermark, so a copy of this
repository runs unrestricted on your own machine. This demo carries a key for
its own published address only, which is why you will find one in the
source. Keys for your own sites come from
[latticegrid.dev](https://www.latticegrid.dev).
