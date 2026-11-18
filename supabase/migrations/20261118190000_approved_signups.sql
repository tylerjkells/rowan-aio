-- Approved sign-ups
--
-- People create their own accounts (and choose their own passwords) from
-- Rowan, but only with an email a hub administrator approved first. Each
-- approval works once. The check runs in the database on every new account,
-- so it holds whether the account comes from the app or from the Supabase
-- dashboard's Add user.

create table if not exists public.hub_admins (
  user_id uuid primary key references auth.users (id) on delete cascade,
  added_at timestamptz not null default now()
);

comment on table public.hub_admins is 'Rowan AIO: people who may approve new accounts. Added by hand.';

alter table public.hub_admins enable row level security;

drop policy if exists "People see their own admin row" on public.hub_admins;
create policy "People see their own admin row" on public.hub_admins
  for select to authenticated
  using ((select auth.uid()) = user_id);

revoke all on public.hub_admins from anon;
revoke insert, update, delete, truncate on public.hub_admins from authenticated;
grant select on public.hub_admins to authenticated;

create table if not exists public.signup_allowlist (
  email text primary key check (email = lower(email) and position('@' in email) > 1),
  added_at timestamptz not null default now(),
  added_by uuid default auth.uid() references auth.users (id) on delete set null,
  -- when the account was created; an approval works once
  used_at timestamptz
);

comment on table public.signup_allowlist is
  'Rowan AIO: emails approved to create an account. Each approval works once.';

alter table public.signup_allowlist enable row level security;

-- only administrators see or change approvals
create or replace function public.is_hub_admin()
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select exists (select 1 from public.hub_admins a where a.user_id = (select auth.uid()))
$$;

drop policy if exists "Admins see approvals" on public.signup_allowlist;
create policy "Admins see approvals" on public.signup_allowlist
  for select to authenticated using ((select public.is_hub_admin()));

drop policy if exists "Admins approve" on public.signup_allowlist;
create policy "Admins approve" on public.signup_allowlist
  for insert to authenticated with check ((select public.is_hub_admin()));

drop policy if exists "Admins renew approvals" on public.signup_allowlist;
create policy "Admins renew approvals" on public.signup_allowlist
  for update to authenticated
  using ((select public.is_hub_admin()))
  with check ((select public.is_hub_admin()));

drop policy if exists "Admins withdraw approvals" on public.signup_allowlist;
create policy "Admins withdraw approvals" on public.signup_allowlist
  for delete to authenticated using ((select public.is_hub_admin()));

revoke all on public.signup_allowlist from anon;
revoke truncate on public.signup_allowlist from authenticated;
grant select, insert, update, delete on public.signup_allowlist to authenticated;
revoke all on function public.is_hub_admin() from public, anon;
grant execute on function public.is_hub_admin() to authenticated;

-- Every new account: its email must hold an unused approval, which it uses up.
create or replace function public.rowan_check_signup()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.signup_allowlist
  set used_at = now()
  where email = lower(coalesce(new.email, '')) and used_at is null;
  if not found then
    raise exception 'Rowan: % is not approved for an account', coalesce(new.email, '(no email)')
      using errcode = '42501';
  end if;
  return new;
end;
$$;

revoke all on function public.rowan_check_signup() from public, anon, authenticated;

drop trigger if exists rowan_check_signup on auth.users;
create trigger rowan_check_signup
  before insert on auth.users
  for each row execute function public.rowan_check_signup();
