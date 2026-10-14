# ADOHRE voting: session handoff

Written 2026-10-14. Use this to continue in a new session.

## What this is

A voting app for the ADOHRE association: a static site (`index.html`, `style.css`, `app.js`) plus Supabase (Postgres, row-level security, SECURITY DEFINER functions). A GitHub Actions workflow publishes it to GitHub Pages. Runs locally at http://localhost:3000 via the preview server (`.claude/launch.json`).

## Git state: read this first

Only commit `0d40325` has been pushed to `main`. **Everything since is uncommitted local work**: polls with positions, poll statuses, several active polls, QR attendance sign-in, admin password login, attendees as voters, dashboards, UI changes, README and the SQL files. The question "commit and push?" was never answered. Do not commit or push without a clear yes.

Uncommitted files: `README.md`, `app.js`, `index.html`, `style.css`, `supabase/schema.sql`, `supabase/seed.example.sql`, new `supabase/auth_hook.sql`, `supabase/reset_data.sql`, `supabase/set_admin_password.sql`, `.claude/launch.json`, and this file.

## How it works

### Voters (no email codes, no voter list)

1. Staff fill the **attendance form** on the admin side: full name (required) plus an email and/or a cellphone number.
2. The only check is for duplicates (same email, or same cellphone by its last 10 digits). A duplicate shows: "Already recorded. Email or cellphone number already registered." with a View QR code button.
3. Recording creates the voter (the `attendance` table *is* the voter list) and shows a **QR code** (name and QR only, no contact details, also in print). The link is `<site>?q=<64 hex token>`.
4. The voter scans the QR, lands on the site, and types the email **or** cellphone number staff entered. It must match the person the QR was issued to. The server does the check; the QR never contains the email or number.
5. 5 wrong tries lock that QR for 15 minutes. On success a session starts and lasts until the voter signs out or an admin revokes access. Up to 5 devices per voter.
6. The voter lands on **Active polls** and picks a poll to vote in.

### Admins

- Sign in at `<site>#admin` with **email and password** (Supabase Auth). The emailed code was removed because Supabase to Brevo SMTP took about 23 seconds.
- Admin sidebar: **Manage Polls**, **Attendance**, **Sign out**. The voter pages are not shown in the admin menu.
- Attendance list: View QR, Revoke access (logs the voter out on every device), Restore access, Unlock QR, Remove attendance. Removal is blocked for anyone who already voted (they could be recorded again and vote twice), so revoke them instead.

### Polls

- **Question**: 2 to 15 choices, single selection (default) or multiple selections.
- **Election**: up to 20 positions, up to 15 candidates each, and a per-position maximum votes per voter (up to 15). A voter may leave a position blank but must pick at least one candidate overall.
- Statuses: **Not Active**, **Active**, **Closed**, **Cancelled** (voided, final). Several polls can be Active at once.
- Results are hidden while a poll is Active (live per-candidate counts can reveal how someone voted). Turnout is live. A per-poll option can show live results.
- Admin dashboards show Present, Voted and Yet to vote.
- Every add, remove, edit and status change asks for confirmation.

## What you must still do on the real Supabase

1. Run **`supabase/schema.sql`** in the SQL Editor (safe to re-run). It converts the old `allowed_voters` list into `attendance` and **drops `allowed_voters`**. Members who never attended and never voted are lost; export that table first if you want a record.
2. Run **`supabase/set_admin_password.sql`**: edit the email and password lines, run it, then delete the password from the editor and delete the saved snippet.
3. Recommended: turn **off** "Allow new users to sign up" in Supabase Authentication settings. Optionally run `supabase/auth_hook.sql` and enable it under Authentication > Hooks > Before User Created.
4. Optional: **`supabase/reset_data.sql`** clears polls and votes and keeps voters and admins. A commented-out line at the end also forgets every attendee.
5. Deploy: push to `main` (after approving). GitHub Pages on a free plan needs a **public** repo (Settings > Pages > Source = GitHub Actions), then set the Supabase Site URL to the Pages address.
6. QR links point to the address the admin page is opened from. Open the admin page on the live site (not `localhost`) when making real QR codes, or set `PUBLIC_URL` at the top of `app.js`.

## Not verified

- Nothing has been tested against the real Supabase project, and no real phone has scanned a QR.
- The password script hashes with Supabase's `extensions.crypt`; the test database had no bcrypt, so a stand-in was used.
- Testing was done on an in-memory Postgres (PGlite) with a stand-in for `auth.jwt()`, and the UI was driven in the preview browser with stubbed backend calls. Those test files lived in the session's scratchpad and are **not** in the repo. Final results there: 122 database checks and three upgrade suites (your current layout, the older email-keyed layout, the oldest layout) all passed.

## Open items

- An earlier message was cut off at "they will also view their…". It was never clarified. Voters currently see only their name in the sidebar.
- The attendance list still shows each person's name, number and email to admins. Hiding it there was offered, not requested.

## Files

| File | Purpose |
| --- | --- |
| `index.html`, `style.css`, `app.js` | The whole frontend. Supabase URL and publishable key are at the top of `app.js`; the QR library loads from cdnjs with an integrity hash. |
| `supabase/schema.sql` | Full schema and functions; upgrades older layouts in place. |
| `supabase/seed.example.sql` | Example admin and two example polls. |
| `supabase/set_admin_password.sql` | Sets or resets an admin password. |
| `supabase/auth_hook.sql` | Optional guard so only admin emails can create a login. |
| `supabase/reset_data.sql` | Clears polls and votes, keeps voters and admins. |
| `.github/workflows/deploy.yml` | Checks the code and publishes `index.html`, `style.css`, `app.js` to GitHub Pages. |
| `README.md` | Setup and usage. |

## Working notes for the next session

- Long Bash heredocs containing quotes break in this environment: write scripts with the Write tool and run Python with `-X utf8`.
- The preview browser caches `app.js`: fetch it with `cache: 'reload'`, then reload the page.
- The user prefers short UI wording, no contact details on the QR, print or duplicate message, and a confirmation prompt for any add, remove or edit.
