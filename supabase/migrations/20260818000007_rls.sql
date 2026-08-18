-- =============================================================================
-- Migration: Row Level Security — isolamento multi-tenant + acesso B2C
-- PBI 1 (issue #2) — Database Core & B2C
--
-- Modelo de acesso:
--  * STAFF (funcionário): JWT carrega app_metadata.tenant_id -> acesso às
--    linhas do próprio tenant via public.current_tenant_id().
--  * CLIENTE B2C: acesso apenas às próprias linhas (auth_user_id = auth.uid()).
--  * ANÔNIMO: leitura pública do cardápio (tenants/products ativos).
--  * service_role (backend Fastify): ignora RLS por padrão.
--
-- Performance: funções de auth sempre em subselect — `(select ...)` — para o
-- Postgres avaliá-las 1x por statement (cache de initplan), não por linha.
-- Uma única política permissiva por ação/tabela (OR interno) para evitar
-- overhead de múltiplas políticas.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Integridade da denormalização: tenant_id de endereços e itens é derivado do
-- registro pai, nunca confiado ao cliente.
-- Contrato: triggers BEFORE INSERT/UPDATE (sem parâmetros externos).
-- -----------------------------------------------------------------------------
create or replace function public.sync_address_tenant()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  select c.tenant_id into strict new.tenant_id
  from public.customers c
  where c.id = new.customer_id;
  return new;
end;
$$;

create trigger customer_addresses_sync_tenant
  before insert or update of customer_id on public.customer_addresses
  for each row execute function public.sync_address_tenant();

create or replace function public.sync_order_item_tenant()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  select o.tenant_id into strict new.tenant_id
  from public.orders o
  where o.id = new.order_id;
  return new;
end;
$$;

create trigger order_items_sync_tenant
  before insert or update of order_id on public.order_items
  for each row execute function public.sync_order_item_tenant();

-- -----------------------------------------------------------------------------
-- Habilita RLS em todas as tabelas
-- -----------------------------------------------------------------------------
alter table public.tenants            enable row level security;
alter table public.roles              enable row level security;
alter table public.users              enable row level security;
alter table public.products           enable row level security;
alter table public.customers          enable row level security;
alter table public.customer_addresses enable row level security;
alter table public.orders             enable row level security;
alter table public.order_items        enable row level security;
alter table public.tenant_counters    enable row level security;
-- tenant_counters: SEM políticas (deny all) — acesso só via SECURITY DEFINER
-- (next_order_number) e service_role.

-- -----------------------------------------------------------------------------
-- tenants
-- -----------------------------------------------------------------------------
create policy tenants_select on public.tenants
  for select to anon, authenticated
  using (
    is_active                                      -- cardápio público
    or id = (select public.current_tenant_id())    -- staff vê o próprio tenant mesmo inativo
  );

create policy tenants_staff_update on public.tenants
  for update to authenticated
  using (id = (select public.current_tenant_id()))
  with check (id = (select public.current_tenant_id()));
-- insert/delete de tenants: somente service_role (onboarding pelo backend).

-- -----------------------------------------------------------------------------
-- roles
-- -----------------------------------------------------------------------------
create policy roles_select on public.roles
  for select to authenticated
  using (
    tenant_id is null                              -- papéis de sistema
    or tenant_id = (select public.current_tenant_id())
  );

create policy roles_staff_insert on public.roles
  for insert to authenticated
  with check (tenant_id = (select public.current_tenant_id()));

create policy roles_staff_update on public.roles
  for update to authenticated
  using (tenant_id = (select public.current_tenant_id()))
  with check (tenant_id = (select public.current_tenant_id()));

create policy roles_staff_delete on public.roles
  for delete to authenticated
  using (tenant_id = (select public.current_tenant_id()));
-- Papéis de sistema (tenant_id null) são imutáveis para tenants por construção.

-- -----------------------------------------------------------------------------
-- users (staff)
-- -----------------------------------------------------------------------------
create policy users_select on public.users
  for select to authenticated
  using (
    tenant_id = (select public.current_tenant_id())
    or id = (select auth.uid())                    -- todo funcionário vê o próprio registro
  );

create policy users_staff_update on public.users
  for update to authenticated
  using (tenant_id = (select public.current_tenant_id()))
  with check (tenant_id = (select public.current_tenant_id()));
-- insert/delete de funcionários: somente service_role (onboarding grava o
-- claim app_metadata.tenant_id via Admin API — granularidade por papel
-- será refinada no módulo de Gestão de Pessoas).

-- -----------------------------------------------------------------------------
-- products
-- -----------------------------------------------------------------------------
create policy products_select on public.products
  for select to anon, authenticated
  using (
    is_active                                      -- cardápio público (esgotados aparecem como indisponíveis)
    or tenant_id = (select public.current_tenant_id())
  );

create policy products_staff_insert on public.products
  for insert to authenticated
  with check (tenant_id = (select public.current_tenant_id()));

create policy products_staff_update on public.products
  for update to authenticated
  using (tenant_id = (select public.current_tenant_id()))
  with check (tenant_id = (select public.current_tenant_id()));

create policy products_staff_delete on public.products
  for delete to authenticated
  using (tenant_id = (select public.current_tenant_id()));

-- -----------------------------------------------------------------------------
-- customers
-- -----------------------------------------------------------------------------
create policy customers_select on public.customers
  for select to authenticated
  using (
    auth_user_id = (select auth.uid())             -- o próprio cliente
    or tenant_id = (select public.current_tenant_id())
  );

-- Cadastro progressivo: o cliente cria o próprio vínculo com o tenant.
create policy customers_self_insert on public.customers
  for insert to authenticated
  with check (auth_user_id = (select auth.uid()));

create policy customers_update on public.customers
  for update to authenticated
  using (
    auth_user_id = (select auth.uid())
    or tenant_id = (select public.current_tenant_id())
  )
  with check (
    auth_user_id = (select auth.uid())
    or tenant_id = (select public.current_tenant_id())
  );

-- Defesa em profundidade: cliente só altera colunas de perfil. Pontos de
-- fidelidade e verificação de WhatsApp são creditados pelo backend
-- (service_role, que não passa por grants de coluna).
revoke update on table public.customers from anon, authenticated;
grant update (name, whatsapp) on table public.customers to authenticated;

-- -----------------------------------------------------------------------------
-- customer_addresses (CRUD pelo dono; leitura pelo staff do tenant)
-- -----------------------------------------------------------------------------
create policy addresses_select on public.customer_addresses
  for select to authenticated
  using (
    exists (
      select 1 from public.customers c
      where c.id = customer_id and c.auth_user_id = (select auth.uid())
    )
    or tenant_id = (select public.current_tenant_id())
  );

create policy addresses_owner_insert on public.customer_addresses
  for insert to authenticated
  with check (
    exists (
      select 1 from public.customers c
      where c.id = customer_id and c.auth_user_id = (select auth.uid())
    )
  );

create policy addresses_owner_update on public.customer_addresses
  for update to authenticated
  using (
    exists (
      select 1 from public.customers c
      where c.id = customer_id and c.auth_user_id = (select auth.uid())
    )
  )
  with check (
    exists (
      select 1 from public.customers c
      where c.id = customer_id and c.auth_user_id = (select auth.uid())
    )
  );

create policy addresses_owner_delete on public.customer_addresses
  for delete to authenticated
  using (
    exists (
      select 1 from public.customers c
      where c.id = customer_id and c.auth_user_id = (select auth.uid())
    )
  );

-- -----------------------------------------------------------------------------
-- orders
-- A política de SELECT também governa as subscriptions Realtime: o cliente
-- recebe eventos apenas dos próprios pedidos; o KDS, apenas do próprio tenant.
-- -----------------------------------------------------------------------------
create policy orders_select on public.orders
  for select to authenticated
  using (
    tenant_id = (select public.current_tenant_id())
    or exists (
      select 1 from public.customers c
      where c.id = customer_id and c.auth_user_id = (select auth.uid())
    )
  );

create policy orders_insert on public.orders
  for insert to authenticated
  with check (
    tenant_id = (select public.current_tenant_id()) -- staff: lançamento interno
    or (
      -- cliente: só cria pedido próprio, no tenant do próprio vínculo,
      -- em estado inicial e sem "autopagamento"
      status in ('draft', 'placed')
      and payment_status = 'pending'
      and exists (
        select 1 from public.customers c
        where c.id = customer_id
          and c.auth_user_id = (select auth.uid())
          and c.tenant_id = orders.tenant_id
      )
    )
  );

create policy orders_staff_update on public.orders
  for update to authenticated
  using (tenant_id = (select public.current_tenant_id()))
  with check (tenant_id = (select public.current_tenant_id()));
-- Transições de status pelo cliente (ex.: cancelar) passam pelo backend.
-- delete: nunca (histórico imutável; cancelamento é status).

-- -----------------------------------------------------------------------------
-- order_items
-- -----------------------------------------------------------------------------
create policy items_select on public.order_items
  for select to authenticated
  using (
    tenant_id = (select public.current_tenant_id())
    or exists (
      select 1
      from public.orders o
      join public.customers c on c.id = o.customer_id
      where o.id = order_id and c.auth_user_id = (select auth.uid())
    )
  );

create policy items_insert on public.order_items
  for insert to authenticated
  with check (
    tenant_id = (select public.current_tenant_id())
    or exists (
      -- cliente adiciona itens apenas em pedido próprio ainda não confirmado
      select 1
      from public.orders o
      join public.customers c on c.id = o.customer_id
      where o.id = order_id
        and c.auth_user_id = (select auth.uid())
        and o.status in ('draft', 'placed')
    )
  );

create policy items_staff_update on public.order_items
  for update to authenticated
  using (tenant_id = (select public.current_tenant_id()))
  with check (tenant_id = (select public.current_tenant_id()));

create policy items_staff_delete on public.order_items
  for delete to authenticated
  using (tenant_id = (select public.current_tenant_id()));

-- -----------------------------------------------------------------------------
-- Realtime: rastreamento de pedidos sem refresh (cliente e KDS).
-- Guardado: a publicação só existe em ambientes Supabase.
-- -----------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.orders;
    alter publication supabase_realtime add table public.order_items;
  end if;
end;
$$;
