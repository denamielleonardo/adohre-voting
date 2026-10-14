-- Guard for account creation. Voters do not use Supabase Auth (they get in with a QR code and their
-- registered email/phone) and admins sign in with a password, so only admin emails may ever create an
-- auth account. Optional if you turn off "Allow new users to sign up" in the Supabase Auth settings.
-- Run once in the SQL Editor, then enable it in the dashboard:
--   Authentication > Hooks > "Before User Created" > Postgres function >
--   schema "public", function "hook_before_user_created" > Create.

create or replace function public.hook_before_user_created(event jsonb)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_email text := lower(event -> 'user' ->> 'email');
begin
  if v_email is not null and exists (select 1 from public.admins where email = v_email) then
    return '{}'::jsonb;
  end if;

  return jsonb_build_object('error', jsonb_build_object(
    'http_code', 403,
    'message',   'This email is not an administrator. Voters sign in by scanning their QR code.'
  ));
end;
$$;

-- Only the auth system may call it.
grant execute on function public.hook_before_user_created(jsonb) to supabase_auth_admin;
revoke execute on function public.hook_before_user_created(jsonb) from authenticated, anon, public;
