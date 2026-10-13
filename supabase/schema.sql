-- Voting system schema. Run once in the Supabase SQL Editor.
-- Safe to re-run: tables use IF NOT EXISTS, functions use CREATE OR REPLACE.

create table if not exists public.allowed_voters (
  email     text primary key check (email = lower(email)),
  has_voted boolean not null default false
);

create table if not exists public.admins (
  email text primary key check (email = lower(email))
);

create table if not exists public.positions (
  id         serial primary key,
  title      text not null,
  sort_order int  not null default 0
);

create table if not exists public.candidates (
  id          serial primary key,
  position_id int  not null references public.positions(id) on delete cascade,
  name        text not null
);

-- Anonymous: no voter reference, no timestamp, random id (no insertion-order link).
create table if not exists public.ballots (
  id           uuid primary key default gen_random_uuid(),
  position_id  int not null references public.positions(id),
  candidate_id int not null references public.candidates(id)
);

-- Single row. Set is_open = false to close voting.
create table if not exists public.election (
  singleton boolean primary key default true check (singleton),
  is_open   boolean not null default true
);
insert into public.election default values on conflict do nothing;

-- Lock everything down. Clients never touch tables directly, only the functions below.
alter table public.allowed_voters enable row level security;
alter table public.admins         enable row level security;
alter table public.positions      enable row level security;
alter table public.candidates     enable row level security;
alter table public.ballots        enable row level security;
alter table public.election       enable row level security;

revoke all on public.allowed_voters, public.admins, public.positions,
              public.candidates, public.ballots, public.election
  from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Functions (SECURITY DEFINER; identity comes from the verified JWT email)
-- ---------------------------------------------------------------------------

create or replace function public.is_admin()
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.admins where email = lower(auth.jwt() ->> 'email')
  );
$$;

-- What the signed-in user can do: { is_admin, is_voter, has_voted, is_open }
create or replace function public.my_status()
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object(
    'is_admin',  public.is_admin(),
    'is_voter',  exists (select 1 from public.allowed_voters
                         where email = lower(auth.jwt() ->> 'email')),
    'has_voted', coalesce((select has_voted from public.allowed_voters
                           where email = lower(auth.jwt() ->> 'email')), false),
    'is_open',   (select is_open from public.election)
  );
$$;

-- Ballot layout for the voting form.
create or replace function public.get_ballot()
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select coalesce(jsonb_agg(
    jsonb_build_object(
      'id', p.id,
      'title', p.title,
      'candidates', (select coalesce(jsonb_agg(
                       jsonb_build_object('id', c.id, 'name', c.name) order by c.id), '[]')
                     from public.candidates c where c.position_id = p.id)
    ) order by p.sort_order, p.id), '[]')
  from public.positions p
  where auth.jwt() ->> 'email' is not null;
$$;

-- choices: { "<position_id>": <candidate_id>, ... }. A position may be left out to abstain.
create or replace function public.cast_vote(choices jsonb)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_email text := lower(auth.jwt() ->> 'email');
  v_pos   text;
  v_cand  text;
begin
  if v_email is null then
    raise exception 'Not signed in';
  end if;
  if not (select is_open from public.election) then
    raise exception 'Voting is closed';
  end if;
  if jsonb_typeof(choices) is distinct from 'object' or choices = '{}'::jsonb then
    raise exception 'No choices submitted';
  end if;

  -- Atomic one-vote guard: only one concurrent call can flip the flag.
  update public.allowed_voters set has_voted = true
   where email = v_email and has_voted = false;
  if not found then
    raise exception 'You are not eligible or have already voted';
  end if;

  for v_pos, v_cand in select key, value #>> '{}' from jsonb_each(choices) loop
    if not exists (select 1 from public.candidates
                    where id = v_cand::int and position_id = v_pos::int) then
      raise exception 'Invalid choice for position %', v_pos;
    end if;
    insert into public.ballots (position_id, candidate_id)
    values (v_pos::int, v_cand::int);
  end loop;
  -- Any exception above rolls back the has_voted flip too.
end;
$$;

create or replace function public.get_turnout()
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
begin
  if not public.is_admin() then raise exception 'Admins only'; end if;
  return jsonb_build_object(
    'total',  (select count(*) from public.allowed_voters),
    'voted',  (select count(*) from public.allowed_voters where has_voted),
    'is_open', (select is_open from public.election)
  );
end;
$$;

create or replace function public.get_results()
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
begin
  if not public.is_admin() then raise exception 'Admins only'; end if;
  return (
    select coalesce(jsonb_agg(
      jsonb_build_object(
        'id', p.id,
        'title', p.title,
        'candidates', (select coalesce(jsonb_agg(
                         jsonb_build_object(
                           'id', c.id, 'name', c.name,
                           'votes', (select count(*) from public.ballots b
                                      where b.candidate_id = c.id))
                         order by c.id), '[]')
                       from public.candidates c where c.position_id = p.id)
      ) order by p.sort_order, p.id), '[]')
    from public.positions p
  );
end;
$$;

-- Only signed-in users may call these; anon may not.
revoke execute on all functions in schema public from public, anon;
grant execute on function
  public.is_admin(), public.my_status(), public.get_ballot(), public.cast_vote(jsonb),
  public.get_turnout(), public.get_results()
  to authenticated;
