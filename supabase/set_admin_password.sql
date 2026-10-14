-- Set (or reset) an administrator's password. Run in the Supabase SQL Editor.
--
-- 1. Change the two values below: v_email (the admin's email) and v_password (a long password).
-- 2. Run it. You should see "Success. No rows returned".
-- 3. Then CLEAR the password from the SQL Editor: delete the text from the query and delete the
--    saved snippet (the editor keeps a history of what you ran).
-- 4. Sign in on the admin page with that email and password.
--
-- Run it again any time to reset a forgotten password. The password is stored hashed (bcrypt) by
-- Supabase Auth; it is never kept in plain text.
-- The admin must already be listed in public.admins, and must already have a login: it does if
-- they signed in before, or create one with Authentication > Users > Add user (tick "Auto Confirm
-- User").

do $$
declare
  v_email    text := lower(btrim('admin@example.com'));            -- <-- CHANGE: the admin email
  v_password text := 'CHANGE-THIS-TO-A-LONG-PASSWORD';             -- <-- CHANGE: at least 12 characters
  v_rows     int;
begin
  if length(v_password) < 12 or v_password = 'CHANGE-THIS-TO-A-LONG-PASSWORD' then
    raise exception 'Choose a password of at least 12 characters: edit v_password at the top of this script.';
  end if;
  if not exists (select 1 from public.admins where email = v_email) then
    raise exception '% is not an administrator yet. Add them first: insert into public.admins (email) values (''%'');', v_email, v_email;
  end if;

  update auth.users
     set encrypted_password = extensions.crypt(v_password, extensions.gen_salt('bf')),
         email_confirmed_at = coalesce(email_confirmed_at, now()),
         updated_at         = now()
   where lower(email) = v_email;
  get diagnostics v_rows = row_count;

  if v_rows = 0 then
    raise exception 'No login exists for % yet. Create one in Authentication > Users > Add user (tick Auto Confirm User), then run this script again.', v_email;
  end if;
end $$;
