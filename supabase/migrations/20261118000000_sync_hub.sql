-- Rowan AIO sync hub
--
-- One row per synced document: a meeting, a workspace file (planner, links,
-- ...), the portable part of Settings, or the manifest entry for an
-- attachment or recording held in the `sync` storage bucket. Every row is
-- private to the person who owns it.
--
-- Clients only read the table. Writes go through sync_push, which applies a
-- change only if it was made from the row's current revision; otherwise it
-- refuses, the client pulls the newer version, merges, and tries again. Two
-- devices can therefore never silently overwrite each other.

create sequence if not exists public.sync_rev;

create table if not exists public.sync_docs (
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  collection text not null check (collection in ('meeting', 'file', 'settings', 'blob', 'audio')),
  doc_id text not null check (char_length(doc_id) between 1 and 300),
  body jsonb,
  deleted boolean not null default false,
  rev bigint not null default nextval('public.sync_rev'),
  updated_at timestamptz not null default now(),
  device text,
  primary key (user_id, collection, doc_id)
);

comment on table public.sync_docs is
  'Rowan AIO sync: one row per synced document, private to its owner. Written only through sync_push.';

create index if not exists sync_docs_changes_idx on public.sync_docs (user_id, updated_at, rev);

alter table public.sync_docs enable row level security;

drop policy if exists "Owners read their documents" on public.sync_docs;
create policy "Owners read their documents" on public.sync_docs
  for select to authenticated
  using ((select auth.uid()) = user_id);

revoke all on public.sync_docs from anon;
revoke insert, update, delete, truncate on public.sync_docs from authenticated;
grant select on public.sync_docs to authenticated;

-- What changed after a point, oldest first, without bodies.
create or replace function public.sync_changes(
  since_at timestamptz,
  since_rev bigint,
  max_rows integer default 500
)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select coalesce(jsonb_agg(to_jsonb(c) order by c.updated_at, c.rev), '[]'::jsonb)
  from (
    select s.collection, s.doc_id, s.rev, s.deleted, s.updated_at
    from public.sync_docs s
    where s.user_id = (select auth.uid())
      and (s.updated_at, s.rev) > (since_at, since_rev)
    order by s.updated_at, s.rev
    limit least(greatest(max_rows, 1), 1000)
  ) c
$$;

-- Full rows for the documents asked for: [{collection, doc_id}, ...].
create or replace function public.sync_get(refs jsonb)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'collection', s.collection,
        'doc_id', s.doc_id,
        'rev', s.rev,
        'deleted', s.deleted,
        'updated_at', s.updated_at,
        'body', s.body
      )
    ),
    '[]'::jsonb
  )
  from public.sync_docs s
  join jsonb_to_recordset(refs) as r(collection text, doc_id text)
    on s.collection = r.collection and s.doc_id = r.doc_id
  where s.user_id = (select auth.uid())
$$;

-- Apply changes: [{collection, doc_id, body, deleted, base_rev}, ...].
-- Each is accepted only if base_rev is the row's current revision (or the
-- row is new); the result says, per document, whether it was accepted and
-- what the row's revision now is.
create or replace function public.sync_push(docs jsonb, device text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid := auth.uid();
  d jsonb;
  coll text;
  did text;
  is_deleted boolean;
  new_body jsonb;
  cur record;
  done record;
  res jsonb := '[]'::jsonb;
begin
  if uid is null then
    raise exception 'Sign in to sync' using errcode = '28000';
  end if;
  if jsonb_typeof(docs) <> 'array' or jsonb_array_length(docs) > 200 then
    raise exception 'sync_push takes an array of at most 200 documents' using errcode = '22023';
  end if;

  for d in select value from jsonb_array_elements(docs) loop
    coll := d->>'collection';
    did := d->>'doc_id';
    is_deleted := coalesce((d->>'deleted')::boolean, false);
    new_body := case when is_deleted then null else d->'body' end;

    select s.rev, s.deleted, s.updated_at into cur
    from public.sync_docs s
    where s.user_id = uid and s.collection = coll and s.doc_id = did
    for update;

    if not found then
      insert into public.sync_docs (user_id, collection, doc_id, body, deleted, device)
      values (uid, coll, did, new_body, is_deleted, sync_push.device)
      on conflict (user_id, collection, doc_id) do nothing
      returning rev, deleted, updated_at into done;
      if found then
        res := res || jsonb_build_object('collection', coll, 'doc_id', did, 'ok', true,
          'rev', done.rev, 'deleted', done.deleted, 'updated_at', done.updated_at);
      else
        -- another device created it a moment ago
        select s.rev, s.deleted, s.updated_at into cur
        from public.sync_docs s
        where s.user_id = uid and s.collection = coll and s.doc_id = did;
        res := res || jsonb_build_object('collection', coll, 'doc_id', did, 'ok', false,
          'rev', cur.rev, 'deleted', cur.deleted, 'updated_at', cur.updated_at);
      end if;
    elsif cur.rev = (d->>'base_rev')::bigint then
      update public.sync_docs s
      set body = new_body,
          deleted = is_deleted,
          device = sync_push.device,
          rev = nextval('public.sync_rev'),
          updated_at = now()
      where s.user_id = uid and s.collection = coll and s.doc_id = did
      returning s.rev, s.deleted, s.updated_at into done;
      res := res || jsonb_build_object('collection', coll, 'doc_id', did, 'ok', true,
        'rev', done.rev, 'deleted', done.deleted, 'updated_at', done.updated_at);
    else
      res := res || jsonb_build_object('collection', coll, 'doc_id', did, 'ok', false,
        'rev', cur.rev, 'deleted', cur.deleted, 'updated_at', cur.updated_at);
    end if;
  end loop;

  return res;
end;
$$;

-- How much of the hub this person is using, for the Settings page.
create or replace function public.sync_usage()
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select jsonb_build_object(
    'doc_bytes', (
      select coalesce(sum(pg_column_size(s.body)), 0)
      from public.sync_docs s
      where s.user_id = (select auth.uid())
    ),
    'file_bytes', (
      select coalesce(sum((o.metadata->>'size')::bigint), 0)
      from storage.objects o
      where o.bucket_id = 'sync'
        and (storage.foldername(o.name))[1] = (select auth.uid())::text
    )
  )
$$;

revoke all on function public.sync_changes(timestamptz, bigint, integer) from public, anon;
revoke all on function public.sync_get(jsonb) from public, anon;
revoke all on function public.sync_push(jsonb, text) from public, anon;
revoke all on function public.sync_usage() from public, anon;
grant execute on function public.sync_changes(timestamptz, bigint, integer) to authenticated;
grant execute on function public.sync_get(jsonb) to authenticated;
grant execute on function public.sync_push(jsonb, text) to authenticated;
grant execute on function public.sync_usage() to authenticated;

-- Recordings and attachments: one private bucket, one folder per person
-- (named by their user id). 50 MB per file, the free plan's ceiling.
insert into storage.buckets (id, name, public, file_size_limit)
values ('sync', 'sync', false, 52428800)
on conflict (id) do nothing;

drop policy if exists "Owners read their sync files" on storage.objects;
create policy "Owners read their sync files" on storage.objects
  for select to authenticated
  using (bucket_id = 'sync' and (storage.foldername(name))[1] = (select auth.uid())::text);

drop policy if exists "Owners add sync files" on storage.objects;
create policy "Owners add sync files" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'sync' and (storage.foldername(name))[1] = (select auth.uid())::text);

drop policy if exists "Owners replace sync files" on storage.objects;
create policy "Owners replace sync files" on storage.objects
  for update to authenticated
  using (bucket_id = 'sync' and (storage.foldername(name))[1] = (select auth.uid())::text)
  with check (bucket_id = 'sync' and (storage.foldername(name))[1] = (select auth.uid())::text);

drop policy if exists "Owners remove sync files" on storage.objects;
create policy "Owners remove sync files" on storage.objects
  for delete to authenticated
  using (bucket_id = 'sync' and (storage.foldername(name))[1] = (select auth.uid())::text);
