-- RESET: delete all polls, votes and ballots so you can start over (for example after testing).
-- KEEPS the attendees (the voters), their QR codes and their signed-in sessions, and the admins.
-- This cannot be undone. Run it in the Supabase SQL Editor.
--
-- Cleared:  polls, positions, options, ballots and the records of who voted in what, and the old
--           email-code accounts of non-admin users in Supabase Auth.
-- Kept:     public.attendance (the voters), their sessions, public.admins, admin logins in Supabase Auth,
--           the schema and all functions.
--
-- To start with NO voters at all (also forget everyone who attended), run the second statement below too:
-- it removes every attendee, QR code and session.

begin;

-- One statement so the foreign keys between these tables are satisfied; ids start again at 1.
truncate table
  public.ballots,
  public.votes_cast,
  public.poll_options,
  public.poll_positions,
  public.polls
restart identity;

-- Old email-code accounts from before QR sign-in. Admin accounts are kept.
do $$
begin
  if to_regclass('auth.users') is not null then
    delete from auth.users
     where lower(email) not in (select email from public.admins);
  end if;
end $$;

commit;

-- OPTIONAL: forget every attendee too (QR codes stop working, everyone is signed out).
-- Remove the two dashes at the start of the next line to run it, or run it on its own.
-- truncate table public.voter_sessions, public.votes_cast, public.attendance restart identity;

-- Check: polls and votes are empty; voters and admins are untouched.
select
  (select count(*) from public.polls)          as polls,
  (select count(*) from public.ballots)        as ballots,
  (select count(*) from public.votes_cast)     as votes_cast,
  (select count(*) from public.attendance)     as voters_kept,
  (select count(*) from public.voter_sessions) as sessions_kept,
  (select count(*) from public.admins)         as admins_kept;
