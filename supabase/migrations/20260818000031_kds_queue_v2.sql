-- =============================================================================
-- Migration: Fila da cozinha com a origem do pedido
-- Fase 7 / PBI (issue #40) — Integração com marketplaces
--
-- A cozinha precisa distinguir um pedido do iFood de um pedido próprio: o
-- prazo, o fluxo de retirada e o código que o entregador informa são
-- diferentes.
--
-- REGRA 5 (contratos estáveis): public.kds_queue() NÃO é alterada — mudar as
-- colunas de retorno quebraria quem já a consome. Esta migration adiciona uma
-- v2 com as colunas novas; a v1 permanece válida e funcionando.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- kds_queue_v2(p_tenant_id uuid)
-- Contrato ESTÁVEL: -> setof (order_id uuid, order_number bigint, origin text,
--   external_display_id text, channel text, table_label text, item_id uuid,
--   product_name text, quantity numeric, notes text, selected_options jsonb,
--   prep_status text, waiting_seconds integer)
--
--   Mesma fila da v1, acrescida da origem e do código do parceiro.
-- -----------------------------------------------------------------------------
create or replace function public.kds_queue_v2(p_tenant_id uuid)
returns table (
  order_id            uuid,
  order_number        bigint,
  origin              text,
  external_display_id text,
  channel             text,
  table_label         text,
  item_id             uuid,
  product_name        text,
  quantity            numeric,
  notes               text,
  selected_options    jsonb,
  prep_status         text,
  waiting_seconds     integer
)
language sql
stable
security definer
set search_path = ''
as $$
  select o.id, o.order_number, o.origin::text, o.external_display_id,
         o.channel::text, t.label,
         oi.id, oi.product_name, oi.quantity, oi.notes, oi.selected_options,
         oi.prep_status::text,
         greatest(0, extract(epoch from (now() - oi.created_at))::integer)
  from public.order_items oi
  join public.orders o on o.id = oi.order_id
  left join public.dining_tables t on t.id = o.table_id
  where oi.tenant_id = p_tenant_id
    and oi.requires_prep
    and oi.prep_status in ('pending', 'preparing')
    and o.status in ('placed', 'confirmed', 'preparing', 'ready')
  order by oi.created_at;
$$;

grant execute on function public.kds_queue_v2(uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- marketplace_orders_report(p_tenant_id uuid, p_from date, p_to date)
-- Contrato ESTÁVEL: -> setof (origin text, order_count int, revenue numeric,
--   average_ticket numeric)
--   Compara o desempenho de cada canal no período.
-- -----------------------------------------------------------------------------
create or replace function public.marketplace_orders_report(
  p_tenant_id uuid,
  p_from      date default (current_date - 30),
  p_to        date default current_date
)
returns table (
  origin         text,
  order_count    integer,
  revenue        numeric,
  average_ticket numeric
)
language sql
stable
security definer
set search_path = ''
as $$
  select o.origin::text, count(*)::integer, coalesce(sum(o.total), 0),
         case when count(*) = 0 then 0 else round(coalesce(sum(o.total), 0) / count(*), 2) end
  from public.orders o
  where o.tenant_id = p_tenant_id
    and o.status in ('delivered', 'completed')
    and o.created_at::date between p_from and p_to
  group by o.origin
  order by 3 desc;
$$;

grant execute on function public.marketplace_orders_report(uuid, date, date) to authenticated;
