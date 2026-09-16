# Charter Ops — web app (Next.js + Supabase + Vercel)

The Supabase project is already live and provisioned: schema, RLS policies matching the four
roles, Realtime enabled on `flights`/`allotments`, and demo fleet/tour-operator data seeded.
This app is what's left — a Next.js frontend that reads and writes it directly, protected by
Supabase Auth + Row-Level Security rather than a custom backend.

**Project ref:** `kxezzfgmjkqlxtwbsdng` — open it at
https://supabase.com/dashboard/project/kxezzfgmjkqlxtwbsdng

## 1. Push this to GitHub

```bash
git init
git add .
git commit -m "Charter ops web app"
gh repo create charter-ops-web --private --source=. --push
# or, without the gh CLI: create an empty repo on github.com, then
git remote add origin https://github.com/<you>/charter-ops-web.git
git push -u origin main
```

## 2. Create your login

No auth users exist yet, and everyone — including you — now creates their own account through
the app itself, no admin step required for that part:

1. Open the deployed app's `/login` page and click **Create one**. Enter your name, email, and
   a password (min. 8 characters) — no email confirmation step, the account is usable
   immediately via `app/api/auth/signup/route.js`.
2. That gives you a profile row defaulted to role `commercial` (see the `handle_new_user`
   trigger in the migration) — the signup route deliberately never accepts a role from the
   client, so nobody can grant themselves anything higher by tampering with the request. To set
   your *own* real role for this first account (nobody exists yet to promote you from the
   Team tab), run this once in the Supabase dashboard's **SQL Editor**:
   ```sql
   update public.profiles set role = 'management' where id =
     (select id from auth.users where email = 'you@yourcompany.com');
   ```
   Valid roles: `commercial`, `tour_operator_liaison`, `ops_coordinator`, `management`.
3. From here on, everyone else just signs themselves up the same way (step 1) — you don't need
   to create their logins for them. Once they've signed up, open the **Team** tab (visible only
   to `management`) and change their role from the default `commercial` to whatever fits. The
   **+ Add teammate** button still exists too, for cases where you'd rather hand someone a
   temporary password yourself instead of having them sign up — both paths land in the same
   `profiles` table, use whichever fits the situation.

**Worth knowing:** self-signup with no email confirmation means anyone who reaches your `/login`
page and knows *an* email address (not necessarily their own) can create an account with
`commercial`-level access to your schedule and rates. That's a deliberate simplicity tradeoff,
not an oversight — if this deployment is reachable by anyone outside your company, consider
adding an email-domain check in `route.js` (e.g. reject anything not ending `@yourcompany.com`)
or putting the app behind Vercel's password/SSO protection.

## 3. Deploy to Vercel

1. Push to GitHub (step 1), then in Vercel: **Add New → Project → Import** your repo.
2. Under **Environment Variables**, add:
   | Key | Value |
   |---|---|
   | `NEXT_PUBLIC_SUPABASE_URL` | `https://kxezzfgmjkqlxtwbsdng.supabase.co` |
   | `NEXT_PUBLIC_SUPABASE_ANON_KEY` | `sb_publishable_ysVFnbaHeFTvcpKOkayRng__UYdbpWU` |
   | `SUPABASE_SERVICE_ROLE_KEY` | from Supabase dashboard → Project Settings → API → `service_role` secret — **server-only**, do not prefix with `NEXT_PUBLIC_` |
   | `CRON_SECRET` | any random string — protects the cron endpoint from being called by randoms |
   | `APIFREAKS_API_KEY` | free key from https://apifreaks.com/signup (Timezone Lookup API) — resolves airport codes not in the static list; server-only |
   | `ANTHROPIC_API_KEY` | from console.anthropic.com — powers the floating chat assistant (`/api/chat`). Optional: the app runs fine without it, the assistant just shows an error if asked anything. Server-only, never `NEXT_PUBLIC_`. |
3. Deploy. Vercel will also pick up `vercel.json`'s cron entry automatically and start hitting
   `/api/cron/release-options` once a day (at 03:00 UTC) once deployed. Hobby-plan accounts are
   limited to **daily** cron schedules — Vercel will flat-out reject the deploy if the schedule
   is more frequent than that (this app originally shipped with an hourly schedule and hit
   exactly that error). If you're on Pro and want tighter timing, e.g. hourly, change the
   `"schedule"` string in `vercel.json` to `"0 * * * *"` before deploying.

## What's real vs. what's still a stand-in

**Real, live, production-grade:**
- Auth (Supabase Auth) and role storage (`public.profiles`)
- Every table's RLS policy enforcing the RBAC matrix — verified with `get_advisors` after
  writing them, not just assumed correct
- Realtime sync — two people with the app open both see a flight move or a seat get allocated
  within about a second, no polling
- The cron-driven option-release job, running whether or not anyone has a browser tab open
- UTC↔local time conversion for the schedule board, with a static list of known station
  timezones plus a fallback to the APIFreaks Timezone Lookup API (server-side, key never
  reaches the browser) for any airport code not in that list — results cached in
  `station_timezones` so each station is looked up against the external API at most once,
  ever, not per user or per page load
- Team management — a management-only **Team** tab to add teammates (creates their login
  directly, no SMTP needed) and change anyone's role, backed by a real RLS policy rather
  than a client-side-only gate
- Self-service sign-up — `/login` has a "Create one" path (`app/api/auth/signup/route.js`)
  so anyone can create their own account with no email-confirmation step; new accounts always
  land as `commercial` regardless of what the signup request claims, since the route never
  passes a role through to Supabase
- Bulk retime — shift dates and/or times (by minutes, or set an absolute new departure) across
  a whole filtered set of flights at once — e.g. a full season's clock change — with a
  preview-then-commit step, same pattern as the other bulk tools
- SCR (Slot Clearance Request) message generator — builds a plain-text message in the exact
  format IATA SSIM Chapter 6 defines, for requesting/changing/deleting airport slots with a
  coordinator. This only formats the message; sending it (by email, to the coordinator) is
  still a manual step, and the aircraft-type field is a best-effort guess worth double-checking
- Drag-and-drop rescheduling — drag a flight bar onto a different aircraft's row (or to a
  different time on the same row); the drawer opens automatically afterward so the move gets
  double-checked, not just trusted
- Duration-based bar sizing — a flight's width on the board reflects its actual block time,
  positioned at its real departure time within the day
- Per-destination operator rates (`contracts.rates_by_destination`, a JSONB column) — e.g.
  ANEX's $120/seat rate to SSH vs. its $115 default elsewhere — with UI to add/edit/remove them
  from the Tour Operators tab
- Tour operator CRUD — add single, bulk import (paste rows, preview, commit), and delete with
  an active-allotment guard (blocked at both the app layer and, since the FK has no cascade,
  at the database layer too)
- Currency is USD throughout, matching the real operators (ANEX, FS, JOIN UP, KOMPAS, ONE
  CLICK, PGS, SELFIE) seeded in migration `00009`
- New app shell — dark sidebar navigation (Dashboard, Schedule, Aircraft, Quotas, Tour
  Operators, Team) plus a top bar with real search (flights/operators) and a notifications bell
- Dashboard rebuilt — real KPI cards (flights, seats sold, load factor, active operators, all
  computed from live data, no invented trend percentages), an Upcoming/Recent/Aircraft-status
  table, and a **real Leaflet + OpenStreetMap route map** (migration `00011` isn't needed for
  this part — station coordinates are a plain JS lookup, `STATION_LATLNG`, in the component)
  plotting your actual current routes. Free, no API key. Runs client-side only via
  `next/dynamic` with `ssr: false`, which is the standard fix for Leaflet under Next.js (it
  touches `window`/`document` at import time, so it can't run during server-side rendering).
- Tasks and Notifications — real Supabase tables (migration `00011`), not local-only state.
  Notifications are generated automatically on real actions (flight added, seats allocated,
  operator added, aircraft added) so the feed reflects what's actually happening in the app,
  not placeholder text
- Aircraft tab — add/edit/remove fleet aircraft directly (reuses the existing `resources`
  table and its RLS policy — no new schema needed)
- Quotas tab — an aggregate roll-up of existing allotments per tour operator (seats + revenue
  + destination breakdown); no new data, just a different view of what Schedule/Tour Operators
  already track

**Still simplified, flagged honestly:**
- The bulk-import UI still expects pre-parsed rows (paste-in CSV shape), not an uploaded
  `.xlsx` roster grid — porting the grid-parsing logic discussed earlier into a Route Handler
  is the next real piece of work, not a UI tweak.
- Row-level *operator* scoping (a liaison seeing only their assigned tour operators, not all of
  them) isn't in the RLS yet — right now every `tour_operator_liaison` sees every operator.
  Adding a `user_tour_operator` join table and tightening the `allotments`/`tour_operators`
  policies to check it is a follow-up, not a rewrite.
- No password reset flow, invite emails, or multi-factor — Supabase Auth supports all of these,
  they're just not wired into this UI yet.
- The route map only plots stations listed in `STATION_LATLNG` (the same 11 stations already
  used elsewhere in the app) — a route to/from any other airport code won't appear on the map
  until its coordinates are added there. It says so on the map itself when this happens, rather
  than silently dropping the route.
- Finance (revenue/invoicing reporting) and Documents (file storage) from the reference design
  are not built — Finance needs a decision on what it should actually show, and Documents needs
  real file upload (Supabase Storage), not just a metadata register.
- **Chat assistant** — a floating widget (bottom-left, on every tab) backed by `/api/chat` and
  the Claude API. It can look up real flights, allotment totals, operator rates, and fleet
  status via tool use, but can't change anything. Runs the query using the *asking user's own*
  Supabase session token (not the service-role key), so RLS guarantees it never surfaces
  anything that user couldn't already see in the app. **Conversation history is now persisted**
  per user in the `chat_messages` table (migration `00013`) — reopening the widget or
  refreshing the page picks up where you left off. Needs `ANTHROPIC_API_KEY` set to actually
  respond (see above); without it, the widget still opens but shows a clear error rather than
  failing silently.
- **Scheduling engine** (Schedule → More → Scheduling engine) — a real assignment algorithm,
  not a mock: define one or more route requirements (route, aircraft type or "any", days of
  week, times, date range), and it expands every requirement into individual dated legs, then
  greedily assigns each to whichever eligible aircraft has flown the fewest legs so far in
  this run — spreading load across the fleet instead of dumping it all on one tail. It respects
  the maintenance schedule (see below) and never double-books a tail already flying that day,
  including against other requirements assigned earlier in the same run. This is honestly a
  greedy heuristic processed in date order, not a global optimizer — it never goes back to
  reshuffle an earlier pick to make a later requirement fit better. Same SCR-first,
  confirm-to-create flow as everywhere else.
- **Maintenance schedule** (Aircraft tab) — new UI over a table that already existed in the
  schema but never had a screen: add/remove date-range blocks per aircraft with an optional
  reason. The scheduling engine treats a grounded aircraft as ineligible for the whole span,
  inclusive of both dates.
- **Excel roster importer** — Bulk Import now has an "Upload Excel roster" mode alongside the
  existing CSV paste, parsing the actual per-aircraft weekly grid format (one sheet per tail,
  flight number and route string in adjacent cells under each weekday column) via the `xlsx`
  package (SheetJS), entirely client-side. This was built and verified against a real roster
  file, not a guessed structure — critically, the week-block spacing in that file is **not**
  uniform (usually 12 rows apart, but 10/11/13 rows around month or season boundaries), so
  blocks are found dynamically by scanning for the row where a plain day-of-month number
  actually appears, never assumed to repeat at a fixed interval. Dates are computed by
  advancing a single anchor Monday 7 days per detected block — this was cross-checked against
  every block's own stated day-of-month across all 10 real tail sheets with zero mismatches,
  which is what "verified" means here, not just "ran once." Sheets that don't map to a tail in
  your `resources` table (summary sheets, aircraft types outside the regular fleet) are skipped
  and named in the preview, not silently dropped, and non-flight annotations in the grid
  (tour-operator labels, NOTAMs) are counted and excluded rather than misread as flights.
