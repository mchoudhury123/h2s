# Home-to-School Transport CRM

A complete operations and management system for a home-to-school transport company: council contracts, children, schools, drivers, passenger assistants, compliance, daily journeys, cover staff, wages and profitability.

The system is built around **exception management**. It already knows what is supposed to happen every day, so staff only record what was *different*.

---

## Running it

You need Node.js 22.5 or newer. There is one dependency, the Postgres driver, and no build step: the interface is plain HTML, CSS and JavaScript.

```
npm install
npm run seed      # demo data
npm start         # http://localhost:4000
```

Sign in with `admin` / `admin123`. Change that password under Settings once you are in.

The demo data also includes `manager`, `ops`, `finance` and `viewer` accounts, each with the password shown on the sign-in screen, so you can see how each role differs.

To start from an empty system instead, skip `npm run seed`. The tables and an administrator account are created on first launch.

### Which database it uses

The CRM runs on either SQLite or Postgres, and the application code is the same for both.

| | When it is used | Good for |
|---|---|---|
| SQLite | No `DATABASE_URL` set | A single office, local development, no setup |
| Postgres | `DATABASE_URL` set in `.env` | Supabase, several people, access from more than one machine |

To point it at Supabase, copy `.env.example` to `.env` and fill in the connection string from Supabase under **Project Settings > Database > Connection string**:

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

### Tests

```
npm test              # 63 business-rule tests
npm run test:browser  # every page in a real browser, fails on any console error
npm run test:roles    # role restrictions and both themes
npm run test:workflow # create records through the forms, through to payroll
```

The browser suites expect Chrome at the default Windows location and the server already running. `npm test` builds its own throwaway database, so it can be run against either backend.

---

## How the system thinks

Everything hangs off one chain, and each link is also searchable on its own:

```
Council  →  Contract / route  →  School  →  Children
                    ↓
          Driver  +  Passenger assistant
                    ↓
          Daily journeys (AM and PM)
                    ↓
          Exceptions: absence, cover, cancellation
                    ↓
          Staff pay  →  Contract profitability
```

**Information is entered once.** A child's school, driver, PA, vehicle and route all come from the contract they travel on. Reassign the driver on a contract and every child's profile, the calendar, the wage calculation and the school page all change at the same moment, because none of them store a copy.

**Journeys are never created by hand.** A contract has operating days, a start date and an end date. From those the system generates an AM and a PM journey for every operating day, forever. Nobody confirms a normal day.

**Exceptions are the only data entry.** A child did not travel, a driver was absent, a cover driver stepped in, the school closed. Each exception changes what was operated, which changes who gets paid, which changes what the contract earned. One entry, three consequences, automatically.

---

## What each part does

### Dashboard

Live counts of contracts, children, drivers, PAs, schools and councils; what is running today; absences and cover in use today; contracts missing staff; compliance problems; expected income, staff cost and gross profit for today, this week and this month. Every figure is a link into the records behind it.

### Universal search

One box at the top of every page, or press `/` from anywhere. Search a child, school, contract code, driver, PA, postcode, address or council reference. Results are grouped by record type. Arrow keys and Enter move through them without touching the mouse.

Search a school and you see its children and contracts. Search a driver and you see their profile and every contract they run.

### Operations calendar

A grid of contracts against dates. Each cell shows the AM and PM journey colour-coded: green operated, amber a child absent, purple cover staff used, red not run. Filter by contract, school or staff member; switch between week, fortnight and month.

Click any cell to open that contract on that date. From there, recording "Child A absent PM" is one more click. Driver absent, cover assigned, school closed, journey cancelled, pay override and free-text notes are all in the same panel, with everything already recorded for that day listed underneath so it can be undone.

### Children

Full profile: personal details, home address, parent and emergency contacts, school, contract, council reference, all four journey times, medical information, SEN and additional needs, mobility and wheelchair requirements, behavioural and communication needs, allergies, safeguarding and risk information, notes and uploaded documents.

The profile also shows who they travel with, their assigned driver and PA, and their absence history. Safeguarding and risk notes are displayed prominently rather than buried.

### Contracts and routes

Contract code, council, school, every child travelling, assigned driver and PA, vehicle, route, AM and PM timings, operating days, start and end dates, status. Financially: income per day, driver pay, PA pay, other direct costs, expected profit and margin, plus actual performance for the current month drawn from journeys that really operated.

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
Normal scheduled journeys              £682.00
  11 days   PORTLAND 1 — 22 journeys at £62.00/day

Cover journeys                          £75.00
  10/09/26  COVER Driver THORNHILL PARK 1 full day   [paid immediately]

Payments already made                  -£75.00
  10/09/26  Cover paid immediately on 10/09/2026

AMOUNT DUE                             £682.00
```

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

### Roles

| Role | Access |
|---|---|
| Administrator | Everything, including users and settings |
| Manager | Operations, contracts, staff, calendar, finance and reports |
| Operations staff | Children, contracts, drivers, PAs and calendar, with no financial figures |
| Finance | Wages, contract income and financial reporting |
| Read only | View permitted information, change nothing |

Financial figures are removed on the server, not hidden in the browser, so an operations user cannot reach them by any route. Every important change is written to an audit log recording what changed, the previous value, the new value, when, and who did it.

---

## Layout

```
server/
  db.js                 one async interface over whichever database is in use
  schema.js             the table definitions, rendered per database
  env.js                loads .env
  drivers/
    sqlite.js           local file, via Node's built-in driver
    postgres.js         Supabase, via pg
  http.js               request parsing, static files, CSV
  routes.js             the API
  reports.js            report builders
  seed.js               demo data
  services/
    calendar.js         journey generation and exception evaluation
    wages.js            wage calculation
    finance.js          profitability
    compliance.js       traffic lights
    dashboard.js        dashboard figures and alerts
    search.js           universal search
    auth.js             sessions, roles, permissions
    audit.js            change history
public/
  index.html
  css/app.css
  js/                   core, ui, and the three view modules
scripts/
  test-rules.js         business-rule tests
  smoke.js              browser walkthrough
  check-roles.js        permission and theme checks
  check-workflow.js     end-to-end workflow through the forms
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
- A new report is one entry in the `BUILDERS` map in `reports.js`; it gets CSV export and on-screen viewing for free.
- A new column goes in `schema.js` once and renders correctly for both databases.

Queries are written once with `?` placeholders and a few portable spellings (`string_agg`, `CAST(x AS TEXT)`). The Postgres driver rewrites placeholders to `$1, $2`; the SQLite driver rewrites `string_agg` to `group_concat`. Dates and timestamps are stored as text in both, so comparisons and JSON output are identical and no timezone conversion happens anywhere.

### Notes for production

This runs as-is for a single office. Before putting it on the open internet you would want HTTPS in front of it, a stronger session store than the in-memory one, and rate limiting on sign-in.

On Supabase, the database is backed up by Supabase itself, but `uploads/` is still a local folder on whichever machine runs the server, so that needs its own backup. Row Level Security is not used: the CRM connects as the database owner and enforces permissions in the application, which is why the connection string must stay private.
