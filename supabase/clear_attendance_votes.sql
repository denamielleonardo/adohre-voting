-- CLEAR attendance and votes: delete every attendee (the voters), their QR codes and signed-in
-- devices, and all vote records, so you can start a fresh round (for example after testing).
-- This cannot be undone. Run it in the Supabase SQL Editor.
--
-- Cleared:  public.attendance (everyone recorded, with their QR codes and passwords),
--           public.voter_sessions (voters are signed out everywhere),
--           public.ballots (what was chosen) and public.votes_cast (who voted in which poll).
-- Kept:     your polls, positions and options (with their current status), the admins, admin logins
--           in Supabase Auth, the schema and all functions.
--
-- Every QR code printed or shown so far stops working: record attendance again for fresh ones.
-- To remove the polls as well, use reset_data.sql.

begin;

-- One statement so the foreign keys between these tables are satisfied; ids start again at 1.
truncate table
  public.ballots,
  public.votes_cast,
  public.voter_sessions,
  public.attendance
restart identity;

commit;

-- Check: all four should be 0; polls and admins are untouched.
select
  (select count(*) from public.attendance)     as attendance,
  (select count(*) from public.voter_sessions) as sessions,
  (select count(*) from public.votes_cast)     as votes_cast,
  (select count(*) from public.ballots)        as ballots,
  (select count(*) from public.polls)          as polls_kept,
  (select count(*) from public.admins)         as admins_kept;
