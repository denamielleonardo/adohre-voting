# adohre-voting

Free, anonymous email-OTP voting for ~100-200 pre-registered voters. Static frontend (`index.html`, `style.css`, `app.js`) plus Supabase (Postgres + Auth). No custom backend.

## Setup

1. Create a project at supabase.com.
2. SQL Editor: run [supabase/schema.sql](supabase/schema.sql), then your edited copy of [supabase/seed.example.sql](supabase/seed.example.sql) (admins, positions, candidates, voters).
3. Authentication > Providers: enable Email. Authentication > Email Templates > "Magic Link" (and "Confirm signup"): include `{{ .Token }}` in the body so the email shows the code, e.g. `Your voting code: {{ .Token }}`.
4. Authentication > SMTP: connect Resend or Brevo. The built-in sender is heavily rate-limited, so do this before voting day.
5. Put the project URL and **anon** key in the top of [app.js](app.js). Never use the `service_role` key.
6. Deploy: push to `main`. [.github/workflows/deploy.yml](.github/workflows/deploy.yml) checks the code and publishes `index.html`, `style.css` and `app.js` to GitHub Pages. One-time: repo Settings > Pages > Source = **GitHub Actions**. Then in Supabase, Authentication > URL Configuration, set Site URL to the Pages address. Voters open the root URL; admins open `<url>#admin`.

## Admin tasks (SQL Editor)

```sql
update public.election set is_open = false;          -- close voting
-- clear test data before the real vote:
delete from public.ballots;
update public.allowed_voters set has_voted = false;
```

## Security notes

- Tables have RLS enabled and no client grants; the browser can only call the functions in `schema.sql`.
- `ballots` has no voter reference or timestamp. `cast_vote` flips `has_voted` and inserts ballots in one transaction.
- `shouldCreateUser: true` means anyone can request a code for any email (only listed voters can actually vote). To stop outsiders triggering emails, add a Supabase "Before user created" auth hook that rejects emails not in `allowed_voters`/`admins`.
- Free Supabase projects pause after a week idle; restore a day or two before voting.
