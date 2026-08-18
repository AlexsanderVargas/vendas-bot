-- =============================================================================
-- Migration: Fidelidade (pontos/cashback) e avaliação NPS
-- Fase 2 / PBI (issue #12) — Cardápio Digital e Delivery B2C
-- =============================================================================

alter table public.tenants
  add column loyalty_enabled          boolean not null default false,
  -- Pontos creditados por real gasto (ex.: 1.0 = 1 ponto por R$ 1,00).
  add column loyalty_points_per_currency numeric(8,2) not null default 1
    constraint tenants_points_rate_non_negative check (loyalty_points_per_currency >= 0),
  -- Percentual do pedido devolvido como cashback (0 a 100).
  add column loyalty_cashback_percent numeric(5,2) not null default 0
    constraint tenants_cashback_range check (loyalty_cashback_percent between 0 and 100);

create type public.loyalty_transaction_type as enum ('earn', 'redeem', 'adjust', 'expire');

-- -----------------------------------------------------------------------------
-- loyalty_transactions: extrato de pontos. customers.loyalty_points é o saldo
-- materializado; este extrato é a memória de como se chegou nele.
-- -----------------------------------------------------------------------------
create table public.loyalty_transactions (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants (id) on delete cascade,
  customer_id uuid not null references public.customers (id) on delete cascade,
  order_id    uuid references public.orders (id) on delete set null,
  type        public.loyalty_transaction_type not null,
  points      integer not null,
  cashback    numeric(12,2) not null default 0
              constraint loyalty_cashback_non_negative check (cashback >= 0),
  description text,
  created_at  timestamptz not null default now(),
  -- Um crédito por pedido: torna o gatilho idempotente mesmo se disparar duas vezes.
  constraint loyalty_one_earn_per_order unique (order_id, type)
);

create index loyalty_transactions_customer_idx
  on public.loyalty_transactions (customer_id, created_at desc);
create index loyalty_transactions_tenant_idx
  on public.loyalty_transactions (tenant_id, created_at desc);

-- -----------------------------------------------------------------------------
-- order_reviews: NPS de 1 a 5 estrelas com comentário, uma por pedido.
-- -----------------------------------------------------------------------------
create table public.order_reviews (
  id          uuid primary key default gen_random_uuid(),
  order_id    uuid not null unique references public.orders (id) on delete cascade,
  tenant_id   uuid not null references public.tenants (id) on delete cascade,
  customer_id uuid not null references public.customers (id) on delete cascade,
  rating      smallint not null constraint reviews_rating_range check (rating between 1 and 5),
  comment     text constraint reviews_comment_len check (comment is null or char_length(comment) <= 1000),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index order_reviews_tenant_idx on public.order_reviews (tenant_id, created_at desc);
create index order_reviews_rating_idx on public.order_reviews (tenant_id, rating);

create trigger order_reviews_set_updated_at
  before update on public.order_reviews
  for each row execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- credit_order_loyalty()
-- Contrato: trigger AFTER UPDATE OF status em orders.
--   Credita pontos e cashback quando o pedido chega a entregue/finalizado.
--   Idempotente pela constraint loyalty_one_earn_per_order.
-- -----------------------------------------------------------------------------
create or replace function public.credit_order_loyalty()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant   public.tenants%rowtype;
  v_points   integer;
  v_cashback numeric(12,2);
begin
  if new.customer_id is null then return null; end if;
  if new.status not in ('delivered', 'completed') then return null; end if;
  if old.status in ('delivered', 'completed') then return null; end if;

  select * into v_tenant from public.tenants where id = new.tenant_id;
  if not found or not v_tenant.loyalty_enabled then return null; end if;

  -- A base é o subtotal: taxa de entrega não gera pontos.
  v_points := floor(new.subtotal * v_tenant.loyalty_points_per_currency)::integer;
  v_cashback := round(new.subtotal * v_tenant.loyalty_cashback_percent / 100.0, 2);

  if v_points <= 0 and v_cashback <= 0 then return null; end if;

  insert into public.loyalty_transactions
    (tenant_id, customer_id, order_id, type, points, cashback, description)
  values (new.tenant_id, new.customer_id, new.id, 'earn', v_points, v_cashback,
          'Crédito pelo pedido nº ' || new.order_number)
  on conflict (order_id, type) do nothing;

  if found then
    update public.customers
    set loyalty_points = loyalty_points + v_points
    where id = new.customer_id;
  end if;

  return null;
end;
$$;

create trigger orders_credit_loyalty
  after update of status on public.orders
  for each row execute function public.credit_order_loyalty();

-- -----------------------------------------------------------------------------
-- submit_order_review(p_order_id uuid, p_rating smallint, p_comment text)
-- Contrato ESTÁVEL: -> jsonb { "ok": bool, "error": text|null, "reviewId": uuid|null }
--   error: 'pedido_nao_encontrado' | 'nao_autorizado' | 'pedido_nao_concluido'
--        | 'ja_avaliado'
-- -----------------------------------------------------------------------------
create or replace function public.submit_order_review(
  p_order_id uuid,
  p_rating   smallint,
  p_comment  text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order     public.orders%rowtype;
  v_review_id uuid;
begin
  select * into v_order from public.orders where id = p_order_id;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'pedido_nao_encontrado', 'reviewId', null);
  end if;

  if not exists (
    select 1 from public.customers c
    where c.id = v_order.customer_id and c.auth_user_id = auth.uid()
  ) then
    return jsonb_build_object('ok', false, 'error', 'nao_autorizado', 'reviewId', null);
  end if;

  if v_order.status not in ('delivered', 'completed') then
    return jsonb_build_object('ok', false, 'error', 'pedido_nao_concluido', 'reviewId', null);
  end if;

  if exists (select 1 from public.order_reviews where order_id = p_order_id) then
    return jsonb_build_object('ok', false, 'error', 'ja_avaliado', 'reviewId', null);
  end if;

  insert into public.order_reviews (order_id, tenant_id, customer_id, rating, comment)
  values (p_order_id, v_order.tenant_id, v_order.customer_id, p_rating, nullif(trim(p_comment), ''))
  returning id into v_review_id;

  return jsonb_build_object('ok', true, 'error', null, 'reviewId', v_review_id);
end;
$$;

grant execute on function public.submit_order_review(uuid, smallint, text) to authenticated;

-- -----------------------------------------------------------------------------
-- tenant_nps(p_tenant_id uuid, p_since timestamptz)
-- Contrato ESTÁVEL: -> jsonb { "total": int, "average": numeric,
--   "promoters": int, "neutrals": int, "detractors": int, "nps": numeric }
--   Escala de 5 estrelas: 5 = promotor, 4 = neutro, 1-3 = detrator.
-- -----------------------------------------------------------------------------
create or replace function public.tenant_nps(
  p_tenant_id uuid,
  p_since     timestamptz default null
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with base as (
    select rating from public.order_reviews
    where tenant_id = p_tenant_id
      and (p_since is null or created_at >= p_since)
  ), contagem as (
    select count(*)::int as total,
           coalesce(round(avg(rating), 2), 0) as average,
           count(*) filter (where rating = 5)::int as promoters,
           count(*) filter (where rating = 4)::int as neutrals,
           count(*) filter (where rating <= 3)::int as detractors
    from base
  )
  select jsonb_build_object(
    'total', total, 'average', average,
    'promoters', promoters, 'neutrals', neutrals, 'detractors', detractors,
    'nps', case when total = 0 then 0
                else round((promoters - detractors)::numeric * 100 / total, 2) end)
  from contagem;
$$;

grant execute on function public.tenant_nps(uuid, timestamptz) to authenticated;

-- ------------------------------------ RLS ------------------------------------
alter table public.loyalty_transactions enable row level security;
alter table public.order_reviews        enable row level security;

create policy loyalty_select on public.loyalty_transactions
  for select to authenticated
  using (
    tenant_id = (select public.current_tenant_id())
    or exists (select 1 from public.customers c
               where c.id = customer_id and c.auth_user_id = (select auth.uid()))
  );
-- Escrita apenas pelo gatilho (SECURITY DEFINER) e service_role: pontos não
-- podem ser criados pelo cliente.

create policy reviews_select on public.order_reviews
  for select to anon, authenticated
  using (true); -- avaliações são públicas (reputação do estabelecimento)

create policy reviews_owner_update on public.order_reviews
  for update to authenticated
  using (exists (select 1 from public.customers c
                 where c.id = customer_id and c.auth_user_id = (select auth.uid())))
  with check (exists (select 1 from public.customers c
                      where c.id = customer_id and c.auth_user_id = (select auth.uid())));
-- INSERT apenas via submit_order_review, que valida pedido concluído e dono.
