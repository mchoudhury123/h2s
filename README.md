# Home-to-School Transport CRM

A complete operations and management system for home-to-school transport companies: council contracts, children, schools, drivers, passenger assistants, compliance, daily journeys, cover staff, wages and profitability.

Two ideas shape it.

**Exception management.** The system already knows what is supposed to happen every day, so staff only record what was *different*.

**One system, many firms.** Each operating company registers its own account and sees only its own records. No firm can see another firm's children, staff or finances.

---

## Running it

You need Node.js 22.5 or newer. There is one dependency, the Postgres driver, and no build step: the interface is plain HTML, CSS and JavaScript.

```
npm install
npm start         # http://localhost:4000
```

Open that address and choose **Create an account**. You give a business name, your email address and a password, and your firm is set up and ready to use.

To load a demo business with realistic data to look around:

```
npm run seed
```

That creates "Northgate Home-to-School Transport" with twelve children, seven contracts and thirteen staff. Sign in as `demo@northgate-transport.example` with the password `demo1234`. It never touches any real business that has registered.

### Filling your own business with demo data

To show the system to colleagues using your own account rather than the sample one:

```
npm run demo -- --list                            see the businesses on this system
npm run demo -- "Your Business Name"              fill that one with demo data
npm run demo -- "Your Business Name" --replace    clear its records first
npm run demo -- --id 7                            when two businesses share a name
npm run demo -- --id 7 --patterns                 add only the weekly patterns
```

It builds a Tyne and Wear operation: four councils, nine special schools, twelve routes, twenty-seven children, seventeen drivers and passenger assistants, a fortnight of absences and cover, and documents set up so the compliance lights show green, amber and red together. Two of the routes have a week that is not the same every day, including a Friday split into a 1pm and a 3pm collection, and three children have their own timetable, including a college week and days not attended.

`--patterns` adds only the weekly schedules and child timetables, skipping any already set up. Use it on a business that was filled before those existed.

It only ever touches the business you name. Without `--replace` it keeps what you have already entered and works around it, so a driver you added yourself is given a vehicle and a route. With `--replace` it clears that business's records first, so use it only on a business you are happy to empty. Sign-in accounts are never removed either way.

### Businesses and accounts

Every operating firm is separate. Registering creates the firm and its first account in one step.

There are **no roles**. Everyone who can sign in administers their own firm and sees everything belonging to it: children, staff, compliance, wages, profitability, reports and the audit log. To let a colleague in, go to **Settings then Who can sign in** and add them with their email address and a password. They get the same access, to the same firm, and nothing else.

An email address belongs to one account in one firm. Signing in finds the account, and the account fixes which firm's records you see for the whole session.

### Emptying or removing a business

```
npm run business -- --list                    every business, its accounts and its records
npm run business -- --empty  --id 7           show what emptying would remove
npm run business -- --empty  --id 7 --yes     remove every record; keep the business,
                                              its accounts, its settings and its audit log
npm run business -- --delete --id 7 --yes     remove the business entirely, accounts included
```

Nothing changes without `--yes`. Before anything is removed, every row belonging to that business is written to `data/backups/` as JSON, which is not committed, so a mistake can be put back by hand. Emptying is for handing a firm a clean system after showing it demo data; deleting is for a firm that should no longer exist.

### How the separation is enforced

Every table of firm data carries an `organisation_id`, and every query filters on it. That is the kind of thing that is easy to get almost right, so three things make a mistake fail loudly instead of quietly leaking:

- The firm is taken from the session and never from anything the browser sends, so it cannot be changed by editing a request.
- Writing a row of firm data without an organisation is refused by the data layer, and updating or deleting one is scoped to the owning firm in the SQL itself.
- With `H2S_STRICT_TENANCY=1`, which the test suites set, any statement that touches a table of firm data without mentioning `organisation_id` throws. The few deliberately system-wide statements, such as looking up an email address at sign-in, say so in a comment and are exempt.

`npm run test:isolation` then proves it end to end. It registers two businesses, fills both with records, and attacks every endpoint from one using the other's record ids. Seventy-seven checks cover lists, reads by id, writes, deletes, forged links between firms, search, the calendar, the dashboard, wages, profitability, the staff pool, compliance, the audit log, every report, team accounts and settings.

### Which database it uses

The CRM runs on either SQLite or Postgres, and the application code is the same for both.

| | When it is used | Good for |
|---|---|---|
| SQLite | No `DATABASE_URL` set | A single office, local development, no setup |
| Postgres | `DATABASE_URL` set in `.env` | Supabase, several people, access from more than one machine |

One database holds every firm's records, kept apart by `organisation_id`. To point it at Supabase, copy `.env.example` to `.env` and fill in the connection string from Supabase under **Project Settings > Database > Connection string**:

```
DATABASE_URL=postgresql://postgres:YOUR-PASSWORD@db.YOUR-PROJECT.supabase.co:5432/postgres
```

Then:

```
npm run db:check              # confirm the connection and see what is there
npm run db:push               # create the tables and copy the local data across
npm start                     # now running on Supabase
```

`npm run db:push` only reads the local SQLite file, never changes it, and refuses to write over a Supabase database that already holds records unless you pass `--replace`. Use `-- --schema-only` to create the tables without copying anything.

`.env` is listed in `.gitignore` and must never be committed. If a password does reach the repository, reset it under **Project Settings > Database**.

Two things worth knowing about Supabase connections. The direct host, `db.<project>.supabase.co`, resolves over IPv6 only; on an IPv4 network use the Session pooler string that Supabase lists on the same page. And every query is now a network round trip rather than a local file read, so the dashboard and wage pages are slower than on SQLite. The queries that would have run once per staff member are batched for exactly this reason.

### Hosting it on Vercel

The repository is ready to deploy as it is. Vercel serves `public/` as static files and runs `api/index.js` for everything under `/api/`, which is the same request handler the local server uses.

Set one environment variable in **Project Settings then Environment Variables**, for Production, Preview and Development:

| Name | Value |
|---|---|
| `DATABASE_URL` | your Supabase **Transaction pooler** connection string, port 6543 |

Use the Transaction pooler rather than the direct connection. A serverless function is created and destroyed around each request, so it needs a pooler that expects short-lived connections. Supabase shows it under **Project Settings then Database then Connection string**.

Two optional ones:

| Name | Value | Why |
|---|---|---|
| `H2S_SECURE_COOKIE` | `1` | Marks the session cookie Secure. Set this once you are on HTTPS, which Vercel gives you. |
| `PGPOOL_MAX` | a number | Connections per instance. Defaults to 1 on a serverless host, which is correct. |

Do not set `PORT`; the host provides it.

Three things had to change for this to work, and all three are done:

- **Sessions live in the database.** Each request may be served by a different instance, so an in-memory session table would sign people out at random.
- **Uploaded documents are stored in the database**, up to 8 MB each. A serverless filesystem is read-only and thrown away between requests. One backup now covers the records and their paperwork together.
- **Migrations run once per instance**, on the first request it serves, rather than at boot.

`npm run test:serverless` proves all of this without deploying. It runs the entry point in a real process, kills it, starts another, and checks the session still works, that an uploaded file comes back from a different instance, and that nothing was written to disk.

### Tests

```
npm test                 # 112 business-rule tests
npm run test:isolation   # 92 checks that one firm cannot reach another's data
npm run test:auth        # registration, sign-in and separation, in a browser
npm run test:serverless  # sessions and uploads across instance restarts
npm run test:browser     # every page in a real browser, fails on any console error
npm run test:workflow    # create records through the forms, through to payroll
npm run test:schedules   # weekly schedules and child timetables, in a browser
```

The browser suites expect Chrome at the default Windows location and the server already running. The walkthrough suites (`test:browser`, `test:workflow` and `test:schedules`) sign in as the seeded sample business, so run them against a local SQLite server after `npm run seed`, or point them at a filled business of your own with `USER_EMAIL` and `USER_PASS`. A live database with only a real, empty firm on it has nothing for them to walk through.

`npm test` never touches live data. On SQLite it builds a temporary file; on Postgres it creates a temporary schema and drops it afterwards, and refuses to run at all if that isolation fails.

`npm run test:isolation` and `npm run test:auth` register temporary businesses, then delete them and everything belonging to them. `npm run test:workflow` drives the real interface, so it creates records in the demo business and deletes them again. None of them can affect a firm they did not create.

---

## How the system thinks

Everything hangs off one chain, and each link is also searchable on its own:

```
Council  →  Contract / route  →  School  →  Children
                    ↓
          Driver  +  Passenger assistant
                    ↓
          The normal week: how many journeys each day, and
          which children are on each one
                    ↓
          Expected journeys, generated for every date
                    ↓
          Exceptions: absence, cover, cancellation
                    ↓
          Staff pay  →  Contract profitability
```

**Information is entered once.** A child's school, driver, PA, vehicle and route all come from the contract they travel on. Reassign the driver on a contract and every child's profile, the calendar, the wage calculation and the school page all change at the same moment, because none of them store a copy.

**Journeys are never created by hand.** A contract has operating days, a start date and an end date, and it may have a weekly schedule saying how many journeys each weekday really has. From those the system generates the journeys for every date, forever. Nobody confirms a normal day.

**Not every day is one out and one back.** A contract can run three journeys on a Friday and two on a Tuesday, and a child can finish at 12:30 on a Friday or not attend at all on a Wednesday. Both are described once, as a normal week, and everything downstream follows: the calendar, the wages and the profitability. A day a child never attends is a normal day off, not an absence, and it does not stop the contract running for everybody else.

**Exceptions are the only data entry.** A child did not travel, a driver was absent, a cover driver stepped in, the school closed. Each exception changes what was operated, which changes who gets paid, which changes what the contract earned. One entry, three consequences, automatically.

---

## What each part does

### Dashboard

Live counts of contracts, children, drivers, PAs, schools and councils; what is running today; absences and cover in use today; contracts missing staff; compliance problems; expected income, staff cost and gross profit for today, this week and this month. Every figure is a link into the records behind it.

### Universal search

One box at the top of every page, or press `/` from anywhere. Search a child, school, contract code, driver, PA, postcode, address or council reference. Results are grouped by record type. Arrow keys and Enter move through them without touching the mouse.

Search a school and you see its children and contracts. Search a driver and you see their profile and every contract they run.

### Operations calendar

A grid of contracts against dates. Each cell shows that day's journeys colour-coded: green operated, amber a child absent, purple cover staff used, red not run. A two-journey day reads as AM and PM; a busier day names each journey. A cell also says how many children have a normal day off. Filter by contract, school or staff member; switch between week, fortnight and month.

Click any cell to open that contract on that date. The panel lists the journeys that really run that day, so recording "Child A absent from the 1pm collection" is one more click, and a child is only ever offered the journeys they travel on. Driver absent, cover assigned, school closed, journey cancelled, a one-off extra journey, pay override and free-text notes are all in the same panel, with everything already recorded for that day listed underneath so it can be undone.

Every absence asks the question that matters: is this a one-off, or has the normal week changed? One choice records today. The other opens the weekly timetable, from a date you pick, leaving every earlier day exactly as it was.

### The normal week

Two screens describe what is supposed to happen, and the rest of the system reads them.

**A contract's weekly schedule** gives each weekday the journeys it really runs, so the contract page says:

```
MON   2 Trips   08:00 AM school drop-off · 15:10 PM school collection
TUE   2 Trips   08:00 AM school drop-off · 15:10 PM school collection
WED   2 Trips   08:00 AM school drop-off · 15:10 PM school collection
THU   2 Trips   08:00 AM school drop-off · 15:10 PM school collection
FRI   3 Trips   08:00 AM school drop-off · 13:00 1pm early collection (2 children only)
                                         · 15:00 3pm collection (1 child only)
```

Each journey has a name, a type, its times, optionally the children who are on it, and optionally its own pay and income. Set it up once and the calendar generates those journeys by itself.

**A child's weekly timetable** says when that child travels:

```
MON   09:00 – 15:00
TUE   09:00 – 15:00
WED   Does Not Attend          normal day off — not an absence
THU   09:00 – 15:00
FRI   09:00 – 12:30
```

Choose "Same all week" for one start and finish time, or "Different times by day" for a college or part-time week. Any day can be marked Does Not Attend.

A contract with no weekly schedule behaves exactly as it always has: one journey out and one back on each of its operating days. A child with no timetable travels whenever their contract runs. Nothing needs setting up until something differs from that.

**Both are dated.** Saving next term's pattern from the first day of term leaves this term alone. Journeys, wages and profitability already worked out from an earlier pattern are never recalculated, because each date reads the version that was in force on it. Every version is listed and any of them can be removed.

**Pay follows the journeys.** The contract's day rate buys a normal day, so a two-journey day splits it in half. A Friday with a third journey pays that journey at the same rate rather than making all three worth less, and a journey can be given its own figure that overrides all of it. Pay is worked out per contract and per journey, never per child: one child's day off does not cancel a journey the others are still on.

### Children

Full profile: personal details, home address, parent and emergency contacts, school, contract, council reference, all four journey times, medical information, SEN and additional needs, mobility and wheelchair requirements, behavioural and communication needs, allergies, safeguarding and risk information, notes and uploaded documents.

The profile also shows who they travel with, their assigned driver and PA, and their absence history. Safeguarding and risk notes are displayed prominently rather than buried.

### Contracts and routes

Contract code, council, school, every child travelling, assigned driver and PA, vehicle, route, standard timings, operating days, start and end dates, status, and the normal weekly schedule with the number of journeys on each day. Financially: income per day, driver pay, PA pay, other direct costs, expected profit and margin, plus actual performance for the current month drawn from journeys that really operated.

Three children in one vehicle each keep their own profile and all appear under the same contract.

### Drivers and passenger assistants

For a driver: contact details, emergency contact, vehicle registration, make, model, passenger seats, wheelchair accessibility, licensing authority, badge number, DBS, pay rates and documents. For a PA: contact details, DBS, safeguarding and PA training, documents and pay.

Open a driver and you immediately see who they transport, which schools they serve, which contracts they run, what they are paid and whether their paperwork is valid.

### Compliance traffic lights

Green, amber and red are **calculated**, never set by hand.

| Colour | Meaning |
|---|---|
| Green | Every required document is present and in date |
| Amber | A required document expires within the warning window |
| Red | A required document is missing, expired or marked invalid |

The warning window defaults to 30 days and is configurable in Settings, as is the list of documents required for drivers and for PAs. A driver's compliance includes their vehicle's MOT, insurance and licence. Expiring documents appear on the dashboard and link straight to the record.

### Cover drivers and PAs

The example from the brief, exactly as the system handles it:

> John normally drives and is paid £60 per day. He cannot work Tuesday. Ahmed covers and is paid £75.

Recording that absence with Ahmed as cover means John is not paid for Tuesday, Ahmed is paid £75 for Tuesday only, and John remains the permanent driver on the contract. Cover can be for the whole day or a single journey, and the rate can be overridden.

Tick **Paid immediately** and the system writes a payment record at the same time. The next wage calculation shows the £75 earned and the £75 already paid, so the amount due is zero. It cannot be paid twice.

To find cover, the staff pool searches by proximity to the route, compliance status, whether the person is already working that day, and for drivers by seats and wheelchair accessibility.

### Wage calculation

Choose a date range and calculate for one person, one contract, selected staff, all drivers, all PAs or the whole company.

Every figure is explained. A breakdown shows normal journeys grouped by contract and rate, each cover journey with its date and rate, every journey that was not paid and why, and every payment already made. The bottom line is the amount due.

```
Normal scheduled journeys              £713.00
  15/09/26  BEWICK 1 AM — AM school drop-off (Driver)          £33.00
  15/09/26  BEWICK 1 PM — PM school collection (Driver)        £33.00
  ...
  18/09/26  BEWICK 1 Trip 1 — AM school drop-off (Driver)      £33.00
  18/09/26  BEWICK 1 Trip 2 — 1pm early collection (Driver)    £33.00
  18/09/26  BEWICK 1 Trip 3 — 3pm collection (Driver)          £33.00

Cover journeys                          £75.00
  10/09/26  COVER Driver THORNHILL PARK 1 full day   [paid immediately]

Payments already made                  -£75.00
  10/09/26  Cover paid immediately on 10/09/2026

AMOUNT DUE                             £713.00
```

Each journey is its own line, so the Friday that runs three of them is visibly paid for three.

"Mark period as paid" records a payment for each person so the same period can never be paid again.

### Contract financials

Income minus driver cost minus PA cost minus other direct costs equals gross profit, with the margin percentage. Costs come from journeys that actually operated, not from the theoretical schedule, so absences and cancellations are already reflected.

View profitability by day, week, month or any date range, and by contract, school, council or the whole business.

### Schools

Name, address, postcode, telephone, contact, email, opening and closing times and notes. Each school page automatically lists the children attending, the contracts travelling there, and the drivers and PAs who serve it.

### Staff pool

Drivers and PAs who are available but not on a permanent contract, alongside anyone already assigned. Records vehicle, seats, wheelchair accessibility, licensing authority, compliance, stated availability and preferred working areas. Search by proximity to a postcode or a school.

Proximity compares the outward part of the postcode, so SR2 against SR3. It is an approximation for sorting candidates, not a road distance.

### Documents

Upload against children, drivers, PAs, contracts, vehicles and schools, each with a type, issue date, expiry date, status and notes. Expiry dates feed the compliance traffic lights automatically.

### Reports

Driver wages, PA wages, full payroll, full wage breakdown, contract profitability, contract income, journey and attendance, child absence, cover staff, compliance, expiring documents, child list, driver list, PA list, school contracts and the audit log.

View on screen, export to CSV for Excel, or print to PDF through the browser.

### Accounts

Everyone who can sign in administers their own firm. There are no roles and no restricted areas: if you can sign in, you can see and change everything belonging to your business, and nothing belonging to any other.

Add colleagues under **Settings then Who can sign in**. An account can be disabled without being deleted, and a business always keeps at least one active account.

Every important change is written to an audit log recording what changed, the previous value, the new value, when, and who did it. The log is per firm, like everything else.

---

## Layout

```
api/
  index.js              serverless entry point (Vercel and similar)
vercel.json             routes /api/* to that function
server/
  app.js                the request handler, with no server attached
  server.js             wraps it in a long-running server for local use
  db.js                 one async interface over whichever database is in use,
                        plus the guards that keep firms apart
  schema.js             the table definitions, rendered per database
  migrations.js         brings an older installation up to date in place
  env.js                loads .env
  drivers/
    sqlite.js           local file, via Node's built-in driver
    postgres.js         Supabase, via pg
  http.js               request parsing, static files, CSV
  routes.js             the API
  reports.js            report builders
  seed.js               demo data
  services/
    schedule.js         the normal week: contract patterns and child timetables
    calendar.js         journey generation and exception evaluation
    wages.js            wage calculation
    finance.js          profitability
    compliance.js       traffic lights
    dashboard.js        dashboard figures and alerts
    search.js           universal search
    auth.js             registration, sessions and accounts
    audit.js            change history
public/
  index.html
  css/app.css
  js/                   core, ui, and the four view modules
scripts/
  test-rules.js         business-rule tests
  test-isolation.js     proves one firm cannot reach another's data
  check-auth.js         registration, sign-in and separation in a browser
  smoke.js              browser walkthrough
  check-workflow.js     end-to-end workflow through the forms
  check-schedules.js    weekly schedules and child timetables in a browser
  demo-data.js          fills one named business with demo records
  business.js           lists, empties or removes a business, with a backup first
  db-check.js           connection and row counts
  db-push.js            copies SQLite into Postgres
data/                   SQLite database (created on first run)
uploads/                uploaded document files
.env                    credentials, never committed
```

### Adding to it

The database is normalised and every calculation reads from it rather than from stored totals, so new functionality does not require rebuilding the core.

- A new record type is a table plus one `crud()` call in `routes.js` and one view.
- A new kind of exception is a value in the `exceptions.type` check constraint plus a branch in `evaluateContractDay`. Wages and profitability pick it up without further changes.
- A journey is described by `plannedTrips` in `schedule.js` and evaluated by `evaluateContractDay`. Anything that changes what runs on a date belongs in the first; anything that changes what happened to it belongs in the second.
- A new report is one entry in the `BUILDERS` map in `reports.js`; it gets CSV export and on-screen viewing for free.
- A new column goes in `schema.js` once and renders correctly for both databases.
- A new table of firm data needs `organisation_id` and a place in `TENANT_TABLES`; the guards then insist every query filters on it.
- An upgrade to an existing installation goes in `migrations.js`, which runs at startup and is safe to run twice.

Queries are written once with `?` placeholders and a few portable spellings (`string_agg`, `CAST(x AS TEXT)`). The Postgres driver rewrites placeholders to `$1, $2`; the SQLite driver rewrites `string_agg` to `group_concat`. Dates and timestamps are stored as text in both, so comparisons and JSON output are identical and no timezone conversion happens anywhere.

### Notes for production

This runs as-is for a single office. Before putting it on the open internet you would want HTTPS in front of it and rate limiting on sign-in. Sessions already live in the database, so instances can come and go without signing anybody out.

On Supabase, the database is backed up by Supabase itself, and uploaded documents live in it too, so one backup covers everything. The `uploads/` folder is only read now, for files kept by an older self-hosted version.

Two things to know before several firms rely on it. Postgres Row Level Security is not used: the application enforces the separation between firms, which is why the connection string must stay private and why the isolation suite matters. And nothing verifies an email address at registration or offers a password reset, so a forgotten password currently needs someone with database access to set a new one.
