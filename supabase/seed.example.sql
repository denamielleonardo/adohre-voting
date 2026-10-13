-- Example data. Edit, then run in the SQL Editor after schema.sql.

insert into public.admins (email) values ('admin@example.com');

insert into public.positions (title, sort_order) values
  ('President', 1),
  ('Secretary', 2);

insert into public.candidates (position_id, name)
select p.id, c.name
from (values
  ('President', 'Candidate A'),
  ('President', 'Candidate B'),
  ('Secretary', 'Candidate C'),
  ('Secretary', 'Candidate D')
) as c(title, name)
join public.positions p on p.title = c.title;

-- Voters: either use the Table Editor > allowed_voters > Import CSV
-- (one column named "email", lowercase), or insert directly:
insert into public.allowed_voters (email) values
  ('voter1@example.com'),
  ('voter2@example.com');
