-- Example data. Edit, then run in the SQL Editor after schema.sql.
-- Polls are normally created from the admin page (Manage Polls); the example polls below are optional.

insert into public.admins (email) values ('admin@example.com') on conflict do nothing;

-- There is no voter list to load. Voters are created by the attendance form (Admin > Attendance).

-- Example 1: a question (one position). max_votes 1 = only one selection.
with q as (
  insert into public.polls (title, description, kind)
  values ('Ratification of the By-Laws', 'Do you agree with the ratification of the by-laws?', 'question')
  returning id
), pos as (
  insert into public.poll_positions (poll_id, title, max_votes, sort_order)
  select id, 'Ratification of the By-Laws', 1, 1 from q
  returning id, poll_id
)
insert into public.poll_options (poll_id, position_id, label, sort_order)
select pos.poll_id, pos.id, o.label, o.ord
from pos, (values ('Yes', 1), ('No', 2), ('Abstain', 3)) as o(label, ord);

-- Example 2: an election with positions. Each position has its own candidates and its own
-- maximum votes per voter (up to 15 candidates and up to 15 votes per position).
with e as (
  insert into public.polls (title, description, kind)
  values ('Board Election 2026', 'Choose your candidates for each position.', 'candidates')
  returning id
), pos as (
  insert into public.poll_positions (poll_id, title, max_votes, sort_order)
  select e.id, p.title, p.max_votes, p.ord
  from e, (values ('President', 1, 1), ('Vice President', 1, 2), ('Directors', 7, 3)) as p(title, max_votes, ord)
  returning id, poll_id, title
)
insert into public.poll_options (poll_id, position_id, label, sort_order)
select pos.poll_id, pos.id, c.label, c.ord
from pos
join (values
  ('President', 'Candidate A', 1), ('President', 'Candidate B', 2), ('President', 'Candidate C', 3),
  ('Vice President', 'Candidate D', 1), ('Vice President', 'Candidate E', 2),
  ('Directors', 'Candidate F', 1), ('Directors', 'Candidate G', 2), ('Directors', 'Candidate H', 3),
  ('Directors', 'Candidate I', 4), ('Directors', 'Candidate J', 5), ('Directors', 'Candidate K', 6),
  ('Directors', 'Candidate L', 7), ('Directors', 'Candidate M', 8), ('Directors', 'Candidate N', 9)
) as c(position, label, ord) on c.position = pos.title;
