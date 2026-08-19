-- Stub do ambiente Supabase para validar as migrations em PostgreSQL local.
-- Reproduz o que o Supabase provê: schema auth, auth.uid(), auth.jwt() e os
-- papéis anon / authenticated / service_role.
create schema if not exists extensions;
create schema if not exists auth;

create table if not exists auth.users (
  id uuid primary key default gen_random_uuid(),
  email text
);

-- Claims simulados por GUC de sessão (o PostgREST usa o mesmo mecanismo).
-- O PostgREST publica os claims em request.jwt.claims; o GUC individual
-- request.jwt.claim.sub é o atalho usado pelas asserções deste diretório.
-- Ler os dois deixa o stub fiel ao Supabase sem quebrar os testes.
create or replace function auth.uid() returns uuid
language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claims', true)::jsonb ->> 'sub', ''),
    nullif(current_setting('request.jwt.claim.sub', true), '')
  )::uuid;
$$;

create or replace function auth.jwt() returns jsonb
language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb);
$$;

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
end $$;

grant usage on schema public, extensions, auth to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
grant select on auth.users to anon, authenticated;
