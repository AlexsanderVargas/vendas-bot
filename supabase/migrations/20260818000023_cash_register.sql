-- =============================================================================
-- Migration: PDV e caixa — sessões, movimentos e conciliação
-- Fase 5 / PBI (issue #27) — Financeiro e Caixa
-- =============================================================================

create type public.cash_session_status as enum ('open', 'closed');

create type public.cash_movement_type as enum (
  'opening',    -- fundo de troco
  'supply',     -- suprimento (entrada de dinheiro no caixa)
  'withdrawal', -- sangria (retirada)
  'sale',       -- recebimento de venda
  'refund',     -- devolução ao cliente
  'closing'     -- ajuste de fechamento
);

create type public.payment_method as enum (
  'cash', 'credit_card', 'debit_card', 'pix', 'meal_voucher', 'online', 'other'
);

-- -----------------------------------------------------------------------------
-- cash_sessions: um turno de caixa por operador.
-- -----------------------------------------------------------------------------
create table public.cash_sessions (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references public.tenants (id) on delete cascade,
  opened_by        uuid not null references auth.users (id) on delete restrict,
  closed_by        uuid references auth.users (id) on delete set null,
  status           public.cash_session_status not null default 'open',
  opening_amount   numeric(12,2) not null default 0
                   constraint sessions_opening_non_negative check (opening_amount >= 0),
  -- Preenchidos no fechamento: contado pelo operador x apurado pelo sistema.
  counted_amount   numeric(12,2)
                   constraint sessions_counted_non_negative check (counted_amount is null or counted_amount >= 0),
  expected_amount  numeric(12,2),
  difference       numeric(12,2),
  notes            text,
  opened_at        timestamptz not null default now(),
  closed_at        timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint sessions_closed_has_data check (
    status = 'open' or (closed_at is not null and counted_amount is not null))
);

-- Um caixa aberto por operador por vez.
create unique index cash_sessions_one_open_per_user
  on public.cash_sessions (opened_by) where status = 'open';
create index cash_sessions_tenant_idx on public.cash_sessions (tenant_id, opened_at desc);

create trigger cash_sessions_set_updated_at
  before update on public.cash_sessions
  for each row execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- cash_movements: extrato do turno.
-- -----------------------------------------------------------------------------
create table public.cash_movements (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants (id) on delete cascade,
  session_id  uuid not null references public.cash_sessions (id) on delete cascade,
  order_id    uuid references public.orders (id) on delete set null,
  type        public.cash_movement_type not null,
  method      public.payment_method not null default 'cash',
  amount      numeric(12,2) not null constraint movements_amount_positive check (amount > 0),
  reason      text,
  created_by  uuid references auth.users (id) on delete set null,
  created_at  timestamptz not null default now()
);

create index cash_movements_session_idx on public.cash_movements (session_id, created_at);
create index cash_movements_order_idx on public.cash_movements (order_id) where order_id is not null;

-- tenant_id derivado da sessão.
create or replace function public.sync_cash_movement_tenant()
returns trigger language plpgsql set search_path = '' as $$
begin
  select s.tenant_id into strict new.tenant_id
  from public.cash_sessions s where s.id = new.session_id;
  return new;
end;
$$;

create trigger cash_movements_sync_tenant
  before insert or update of session_id on public.cash_movements
  for each row execute function public.sync_cash_movement_tenant();

-- Caixa fechado não recebe mais lançamento.
create or replace function public.guard_closed_session()
returns trigger language plpgsql set search_path = '' as $$
begin
  if exists (select 1 from public.cash_sessions s
             where s.id = new.session_id and s.status = 'closed') then
    raise exception 'caixa já fechado não aceita movimentação'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger cash_movements_guard_closed
  before insert on public.cash_movements
  for each row execute function public.guard_closed_session();

-- -----------------------------------------------------------------------------
-- open_cash_session(p_opening_amount numeric, p_notes text)
-- Contrato ESTÁVEL: -> jsonb { "ok": bool, "error": text|null, "sessionId": uuid|null }
--   error: 'nao_autorizado' | 'sessao_ja_aberta'
-- -----------------------------------------------------------------------------
create or replace function public.open_cash_session(
  p_opening_amount numeric default 0,
  p_notes          text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant  uuid := public.current_tenant_id();
  v_session uuid;
begin
  if v_tenant is null then
    return jsonb_build_object('ok', false, 'error', 'nao_autorizado', 'sessionId', null);
  end if;

  if exists (select 1 from public.cash_sessions
             where opened_by = auth.uid() and status = 'open') then
    return jsonb_build_object('ok', false, 'error', 'sessao_ja_aberta', 'sessionId', null);
  end if;

  insert into public.cash_sessions (tenant_id, opened_by, opening_amount, notes)
  values (v_tenant, auth.uid(), p_opening_amount, p_notes)
  returning id into v_session;

  if p_opening_amount > 0 then
    insert into public.cash_movements (tenant_id, session_id, type, method, amount, reason, created_by)
    values (v_tenant, v_session, 'opening', 'cash', p_opening_amount, 'Fundo de troco', auth.uid());
  end if;

  return jsonb_build_object('ok', true, 'error', null, 'sessionId', v_session);
end;
$$;

-- -----------------------------------------------------------------------------
-- cash_session_summary(p_session_id uuid)
-- Contrato ESTÁVEL: -> jsonb
--   { "openingAmount": numeric, "sales": numeric, "supplies": numeric,
--     "withdrawals": numeric, "refunds": numeric, "expectedCash": numeric,
--     "byMethod": { "<method>": numeric }, "movementCount": int }
--
--   expectedCash considera SÓ dinheiro: cartão e PIX não ficam na gaveta, e
--   somá-los inflaria a conferência do operador.
-- -----------------------------------------------------------------------------
create or replace function public.cash_session_summary(p_session_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_session public.cash_sessions%rowtype;
  v_result  jsonb;
begin
  select * into v_session from public.cash_sessions where id = p_session_id;
  if not found then
    return jsonb_build_object('openingAmount', 0, 'sales', 0, 'supplies', 0,
      'withdrawals', 0, 'refunds', 0, 'expectedCash', 0,
      'byMethod', '{}'::jsonb, 'movementCount', 0);
  end if;

  select jsonb_build_object(
    'openingAmount', v_session.opening_amount,
    'sales', coalesce(sum(amount) filter (where type = 'sale'), 0),
    'supplies', coalesce(sum(amount) filter (where type = 'supply'), 0),
    'withdrawals', coalesce(sum(amount) filter (where type = 'withdrawal'), 0),
    'refunds', coalesce(sum(amount) filter (where type = 'refund'), 0),
    'expectedCash', v_session.opening_amount
      + coalesce(sum(amount) filter (where type in ('sale', 'supply') and method = 'cash'), 0)
      - coalesce(sum(amount) filter (where type in ('withdrawal', 'refund') and method = 'cash'), 0),
    'byMethod', coalesce(
      (select jsonb_object_agg(method, total) from (
         select method::text, sum(amount) as total
         from public.cash_movements
         where session_id = p_session_id and type = 'sale'
         group by method) as m), '{}'::jsonb),
    'movementCount', count(*)
  ) into v_result
  from public.cash_movements
  where session_id = p_session_id;

  return v_result;
end;
$$;

-- -----------------------------------------------------------------------------
-- close_cash_session(p_session_id uuid, p_counted_amount numeric, p_notes text)
-- Contrato ESTÁVEL: -> jsonb { "ok": bool, "error": text|null,
--   "expectedCash": numeric|null, "countedAmount": numeric|null,
--   "difference": numeric|null }
--   difference > 0 = sobra; < 0 = falta.
--   error: 'sessao_nao_encontrada' | 'nao_autorizado' | 'sessao_ja_fechada'
-- -----------------------------------------------------------------------------
create or replace function public.close_cash_session(
  p_session_id     uuid,
  p_counted_amount numeric,
  p_notes          text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_session  public.cash_sessions%rowtype;
  v_summary  jsonb;
  v_expected numeric(12,2);
  v_diff     numeric(12,2);
begin
  select * into v_session from public.cash_sessions where id = p_session_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'sessao_nao_encontrada',
      'expectedCash', null, 'countedAmount', null, 'difference', null);
  end if;

  if coalesce(v_session.tenant_id = public.current_tenant_id(), false) is false then
    return jsonb_build_object('ok', false, 'error', 'nao_autorizado',
      'expectedCash', null, 'countedAmount', null, 'difference', null);
  end if;

  if v_session.status = 'closed' then
    return jsonb_build_object('ok', false, 'error', 'sessao_ja_fechada',
      'expectedCash', v_session.expected_amount, 'countedAmount', v_session.counted_amount,
      'difference', v_session.difference);
  end if;

  v_summary := public.cash_session_summary(p_session_id);
  v_expected := (v_summary->>'expectedCash')::numeric;
  v_diff := round(p_counted_amount - v_expected, 2);

  update public.cash_sessions
  set status = 'closed', closed_by = auth.uid(), closed_at = now(),
      counted_amount = p_counted_amount, expected_amount = v_expected,
      difference = v_diff, notes = coalesce(p_notes, notes)
  where id = p_session_id;

  return jsonb_build_object('ok', true, 'error', null,
    'expectedCash', v_expected, 'countedAmount', p_counted_amount, 'difference', v_diff);
end;
$$;

grant execute on function public.open_cash_session(numeric, text) to authenticated;
grant execute on function public.cash_session_summary(uuid) to authenticated;
grant execute on function public.close_cash_session(uuid, numeric, text) to authenticated;

-- ------------------------------------ RLS ------------------------------------
alter table public.cash_sessions  enable row level security;
alter table public.cash_movements enable row level security;

create policy cash_sessions_staff_all on public.cash_sessions
  for all to authenticated
  using (tenant_id = (select public.current_tenant_id()))
  with check (tenant_id = (select public.current_tenant_id()));

create policy cash_movements_staff_all on public.cash_movements
  for all to authenticated
  using (tenant_id = (select public.current_tenant_id()))
  with check (tenant_id = (select public.current_tenant_id()));
