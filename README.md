# adohre-voting

Anonymous voting with attendance-gated access: whoever staff record on the attendance form is a voter. Static frontend (`index.html`, `style.css`, `app.js`) plus Supabase (Postgres + Auth). No custom backend, and no emails are needed to sign in.

## How people get in

**Voters** (no email codes, no voter list to prepare):

1. **Attendance.** At the registration desk, staff fill in the **attendance form** on the admin side: the person's first, middle (optional) and last name, their email and/or cellphone number, and a password of at least 8 characters that the voter will use to sign in. Recording it makes that person a voter. The only check is for duplicates (the same email or the same cellphone number already recorded). A QR code unique to that person appears.
2. **Scan.** The voter scans the QR with their phone. It opens this site.
3. **Verify.** They type the **email or cellphone number staff entered for them** and their **password**. It must match the person the QR was issued to (the check happens on the server; the QR itself carries only a secret token, never the email or number).
4. **Vote.** They stay signed in on that phone until they sign out. They land on **Active polls**.

**Admins** sign in at `<url>#admin` with their email and a password (Supabase Auth). No email is sent, so there is no waiting for a code.

## Setup

1. Create a project at supabase.com.
2. SQL Editor: run [supabase/schema.sql](supabase/schema.sql), then your edited copy of [supabase/seed.example.sql](supabase/seed.example.sql) (it adds the admin and two example polls).
3. **There is no voter list.** Nothing to import: voters are created on the day by the attendance form (see below).
4. **Admin password.** Each admin needs a login in Supabase Auth with a password:
   - Edit [supabase/set_admin_password.sql](supabase/set_admin_password.sql): put the admin's email and a long password (12+ characters) in the two marked lines, run it in the SQL Editor, then **delete the password from the editor and delete the saved snippet** (the editor keeps what you ran). Run it again any time to reset a forgotten password.
   - The admin must be listed in `public.admins` and must already have a login. If they have never signed in, create it first: Authentication > Users > Add user (tick **Auto Confirm User**). That form can also set the password directly, in which case the script is not needed.
5. **Lock sign-ups** (recommended): Authentication > Sign In / Providers > turn **off** "Allow new users to sign up". Nobody can then create an account through the public API. Alternatively, or as well, run [supabase/auth_hook.sql](supabase/auth_hook.sql) and enable it under Authentication > Hooks > Before User Created (Postgres function `public.hook_before_user_created`) so only admin emails can ever create a login.
6. Put the project URL and **anon** key in the top of [app.js](app.js). Never use the `service_role` key. Optionally set `PUBLIC_URL` there (see below).
7. Deploy: push to `main`. [.github/workflows/deploy.yml](.github/workflows/deploy.yml) checks the code and publishes `index.html`, `style.css` and `app.js` to GitHub Pages. One-time: repo Settings > Pages > Source = **GitHub Actions**. Then in Supabase, Authentication > URL Configuration, set Site URL to the Pages address.

**QR code address.** QR codes point to the address the admin page is opened from. Open the admin page on the live site (not `localhost`) when generating real QR codes, or set `PUBLIC_URL` in `app.js` to the live address.

## Attendance (admin)

**Attendance** in the sidebar (or `<url>#admin/attendance`):

- The **Attendance form** has three fields: full name, email address and cellphone number. The name is required, and so is at least one of the email or the number (the voter types one of them to sign in after scanning, so enter it carefully). Phone numbers match on their last 10 digits, so `09171234567`, `+63 917 123 4567` and `917-123-4567` are the same number.
- Click **Record attendance** and confirm. The person is recorded and the **QR code appears** for them to scan, with **Copy link** and **Print**.
- **Duplicates are the only check.** If the email or the cellphone number is already recorded, nobody is added: the form says who it belongs to and offers **View their QR code**. Two different people may share a name.
- The **Attendance list** shows everyone recorded, how many devices they are signed in on, and their state. **View QR** shows a member's code again whenever they need to scan it again.
- **Revoke access** logs the voter out on every device immediately and blocks their QR until you **Restore access**. **Remove attendance** deletes a mistaken entry: the QR stops working and they are logged out, and they can be recorded again. Someone who has already voted cannot be removed (they could be recorded again and vote twice): revoke them instead.
- After 5 wrong tries on a QR it **locks for 15 minutes**; **Unlock QR code** (or Restore) clears it.
- Each action asks for confirmation. Poll dashboards show how many voters are present, how many have voted and how many are yet to vote.

## Polls

Admins sign in at `<url>#admin` (or use **Manage Polls** in the sidebar) to run any number of polls in a day:

- **New poll** creates a poll that starts **Not Active**. Two types:
  - **Question**: e.g. Yes / No / Abstain (2 to 15 choices). **Only 1 selection** is the default; choose **Multiple selections** to let voters pick up to N answers (2 to 15).
  - **Election**: a normal candidate election with **positions** (President, Vice President, Directors, ...). Each position has its own list of up to 15 candidates and its own **maximum votes per voter** (1 to 15, set by the admin). Use **+ Add position** for more positions (up to 20). Voters pick up to that many candidates in each position, may leave a position blank, and must pick at least one candidate overall.
- Statuses: **Not Active** (new, not started), **Active** (open for voting), **Closed** (ended, results shown) and **Cancelled** (voided, final). **Activate**, **Close**, **Reopen** and **Cancel poll** each ask for confirmation, as do creating and saving a poll. Several polls can be Active at the same time. Members who already voted in a poll cannot vote twice in it, even after a reopen.
- Voters stay signed in and land on **Active polls**: a list of every open poll (the ones they have not voted in first), each marked "Vote now" or "Voted". New polls appear by themselves (checked every 15 seconds).
- Results stay hidden while a poll is Active, because live per-candidate counts can reveal how an individual voted. Turnout is live. Results show per position when you close the poll (tick "show live results" on a poll only if you accept the trade-off).
- **Clear votes** wipes one poll's votes (for testing); **Delete** removes a poll.

## Upgrading the database

Re-running [supabase/schema.sql](supabase/schema.sql) is safe. It upgrades older layouts in place:

- The old member list (`allowed_voters`) is folded into attendance and then dropped. Everyone who had attendance keeps their name, contact details, QR code and sessions. Members who voted but had no attendance keep a revoked record so their "voted" marks stay. Members who never attended and never voted are dropped.
- Polls created before positions existed become polls with one position each.
- The old one-Active-poll rule and the email-code voter functions are removed.

Admins are always kept. (The very first single-election layout is replaced and its test ballots are dropped.)

## Security notes

- Tables have RLS enabled and no client grants; the browser can only call the functions in `schema.sql`. Voter functions accept a session token; admin functions need a signed-in admin.
- `ballots` has no voter reference or timestamp. `votes_cast` records only *that* a voter voted in a poll (attendance id, poll id), never what they chose. `cast_vote` records both in one transaction.
- Admin passwords are stored hashed by Supabase Auth. Supabase limits repeated sign-in attempts. Use a long, unique password.
- The QR token is a 64-character random secret; a session token is another 64-character secret, stored only as a hash. A QR alone is not enough: the typed email or number must match the person it was issued to, and 5 wrong tries lock it for 15 minutes.
- Treat a displayed or printed QR like a key to that member's vote: do not post it. If one is exposed, **Revoke access** or **Remove attendance** and record attendance again for a fresh code.
- Up to 5 devices can be signed in per member at once; the oldest are dropped.
- Free Supabase projects pause after a week idle; restore a day or two before voting.
