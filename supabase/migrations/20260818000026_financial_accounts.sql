-- =============================================================================
-- Migration: Contas a pagar e a receber
-- Fase 5 / PBI (issue #29) — Financeiro e Caixa
-- =============================================================================

create type public.account_direction as enum ('payable', 'receivable');

create type public.account_status as enum ('open', 'partially_paid', 'paid', 'overdue', 'canceled');

-- -----------------------------------------------------------------------------
-- expense_categories: plano de contas simplificado, base do DRE.
-- -----------------------------------------------------------------------------
create table public.expense_categories (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.tenants (id) on delete cascade,
  name       text not null constraint expense_categories_name_len check (char_length(name) between 1 and 80),
  /** Agrupa no DRE: custo variável acompanha a receita; fixo, não. */
  is_fixed   boolean not null default true,
  is_active  boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint expense_categories_unique unique (tenant_id, name)
);

create trigger expense_categories_set_updated_at
  before update on public.expense_categories
  for each row execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- financial_accounts: um título a pagar ou a receber.
-- -----------------------------------------------------------------------------
create table public.financial_accounts (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants (id) on delete cascade,
  direction     public.account_direction not null,
  status        public.account_status not null default 'open',
  supplier_id   uuid references public.suppliers (id) on delete set null,
  order_id      uuid references public.orders (id) on delete set null,
  category_id   uuid references public.expense_categories (id) on delete set null,
  description   text not null constraint accounts_description_len check (char_length(description) between 1 and 200),
  amount        numeric(12,2) not null constraint accounts_amount_positive check (amount > 0),
  paid_amount   numeric(12,2) not null default 0
                constraint accounts_paid_non_negative check (paid_amount >= 0),
  due_date      date not null,
  paid_at       timestamptz,
  /** Parcelamento: 2/6 significa segunda de seis. */
  installment   smallint not null default 1 constraint accounts_installment_positive check (installment >= 1),
  installments  smallint not null default 1 constraint accounts_installments_positive check (installments >= 1),
  /** Agrupa as parcelas de um mesmo título. */
  group_id      uuid,
  notes         text,
  created_by    uuid references auth.users (id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint accounts_installment_within_total check (installment <= installments),
  constraint accounts_paid_within_amount check (paid_amount <= amount)
);

create index financial_accounts_due_idx
  on public.financial_accounts (tenant_id, direction, due_date)
  where status in ('open', 'partially_paid', 'overdue');
create index financial_accounts_supplier_idx on public.financial_accounts (supplier_id)
  where supplier_id is not null;
create index financial_accounts_group_idx on public.financial_accounts (group_id)
  where group_id is not null;

create trigger financial_accounts_set_updated_at
  before update on public.financial_accounts
  for each row execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- sync_account_status()
-- Contrato: trigger BEFORE INSERT/UPDATE em financial_accounts.
--   Deriva o status do valor pago e do vencimento, para não depender de o
--   chamador lembrar de atualizá-lo.
-- -----------------------------------------------------------------------------
create or replace function public.sync_account_status()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.status = 'canceled' then
    return new;
  end if;

  if new.paid_amount >= new.amount then
    new.status := 'paid';
    if new.paid_at is null then new.paid_at := now(); end if;
  elsif new.paid_amount > 0 then
    new.status := 'partially_paid';
    new.paid_at := null;
  elsif new.due_date < current_date then
    new.status := 'overdue';
    new.paid_at := null;
  else
    new.status := 'open';
    new.paid_at := null;
  end if;

  return new;
end;
$$;

create trigger financial_accounts_sync_status
  before insert or update of paid_amount, due_date, status on public.financial_accounts
  for each row execute function public.sync_account_status();

-- -----------------------------------------------------------------------------
-- create_installments(...)
-- Contrato ESTÁVEL: (p_direction public.account_direction, p_description text,
--   p_total numeric, p_installments smallint, p_first_due date,
--   p_supplier_id uuid, p_category_id uuid) -> jsonb
--   { "ok": bool, "error": text|null, "groupId": uuid|null, "created": int }
--
--   Divide o total em parcelas mensais. O resto da divisão vai na PRIMEIRA
--   parcela, para a soma das parcelas bater exatamente com o total.
--   error: 'nao_autorizado' | 'parcelas_invalidas'
-- -----------------------------------------------------------------------------
create or replace function public.create_installments(
  p_direction    public.account_direction,
  p_description  text,
  p_total        numeric,
  p_installments smallint default 1,
  p_first_due    date default current_date,
  p_supplier_id  uuid default null,
  p_category_id  uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant   uuid := public.current_tenant_id();
  v_group    uuid := gen_random_uuid();
  v_base     numeric(12,2);
  v_first    numeric(12,2);
  i          smallint;
begin
  if v_tenant is null then
    return jsonb_build_object('ok', false, 'error', 'nao_autorizado', 'groupId', null, 'created', 0);
  end if;

  if p_installments < 1 or p_total <= 0 then
    return jsonb_build_object('ok', false, 'error', 'parcelas_invalidas', 'groupId', null, 'created', 0);
  end if;

  v_base := trunc(p_total / p_installments, 2);
  v_first := round(p_total - v_base * (p_installments - 1), 2);

  for i in 1..p_installments loop
    insert into public.financial_accounts
      (tenant_id, direction, description, amount, due_date, installment, installments,
       group_id, supplier_id, category_id, created_by)
    values (v_tenant, p_direction,
            p_description || case when p_installments > 1
                                  then ' (' || i || '/' || p_installments || ')' else '' end,
            case when i = 1 then v_first else v_base end,
            (p_first_due + ((i - 1) || ' month')::interval)::date,
            i, p_installments, v_group, p_supplier_id, p_category_id, auth.uid());
  end loop;

  return jsonb_build_object('ok', true, 'error', null, 'groupId', v_group, 'created', p_installments);
end;
$$;

-- -----------------------------------------------------------------------------
-- settle_account(p_account_id uuid, p_amount numeric, p_session_id uuid)
-- Contrato ESTÁVEL: -> jsonb { "ok": bool, "error": text|null,
--   "status": text|null, "paidAmount": numeric|null, "remaining": numeric|null }
--   Baixa (total ou parcial) de um título. Quando informada a sessão de
--   caixa, registra também a movimentação correspondente.
--   error: 'conta_nao_encontrada' | 'nao_autorizado' | 'conta_cancelada'
--        | 'valor_invalido'
-- -----------------------------------------------------------------------------
create or replace function public.settle_account(
  p_account_id uuid,
  p_amount     numeric,
  p_session_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_account public.financial_accounts%rowtype;
  v_paid    numeric(12,2);
begin
  select * into v_account from public.financial_accounts where id = p_account_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'conta_nao_encontrada',
      'status', null, 'paidAmount', null, 'remaining', null);
  end if;

  if coalesce(v_account.tenant_id = public.current_tenant_id(), false) is false then
    return jsonb_build_object('ok', false, 'error', 'nao_autorizado',
      'status', null, 'paidAmount', null, 'remaining', null);
  end if;

  if v_account.status = 'canceled' then
    return jsonb_build_object('ok', false, 'error', 'conta_cancelada',
      'status', 'canceled', 'paidAmount', v_account.paid_amount, 'remaining', null);
  end if;

  if p_amount is null or p_amount <= 0
     or v_account.paid_amount + p_amount > v_account.amount then
    return jsonb_build_object('ok', false, 'error', 'valor_invalido',
      'status', v_account.status::text, 'paidAmount', v_account.paid_amount,
      'remaining', v_account.amount - v_account.paid_amount);
  end if;

  v_paid := v_account.paid_amount + p_amount;

  update public.financial_accounts set paid_amount = v_paid where id = p_account_id;

  if p_session_id is not null then
    insert into public.cash_movements (tenant_id, session_id, type, method, amount, reason, created_by)
    values (v_account.tenant_id, p_session_id,
            (case when v_account.direction = 'payable' then 'withdrawal' else 'supply' end)::public.cash_movement_type,
            'cash', p_amount,
            case when v_account.direction = 'payable' then 'Pagamento: ' else 'Recebimento: ' end
              || v_account.description,
            auth.uid());
  end if;

  select status into v_account.status from public.financial_accounts where id = p_account_id;

  return jsonb_build_object('ok', true, 'error', null, 'status', v_account.status::text,
    'paidAmount', v_paid, 'remaining', round(v_account.amount - v_paid, 2));
end;
$$;

grant execute on function public.create_installments(public.account_direction, text, numeric, smallint, date, uuid, uuid) to authenticated;
grant execute on function public.settle_account(uuid, numeric, uuid) to authenticated;

-- ------------------------------------ RLS ------------------------------------
alter table public.expense_categories  enable row level security;
alter table public.financial_accounts  enable row level security;

create policy expense_categories_staff_all on public.expense_categories
  for all to authenticated
  using (tenant_id = (select public.current_tenant_id()))
  with check (tenant_id = (select public.current_tenant_id()));

create policy financial_accounts_staff_all on public.financial_accounts
  for all to authenticated
  using (tenant_id = (select public.current_tenant_id()))
  with check (tenant_id = (select public.current_tenant_id()));

-- O catálogo precisa vir ANTES: o trigger validate_role_permissions recusa
-- conceder permissão que o sistema ainda não reconhece.
insert into public.permission_catalog (key, module, label, description, sort_order) values
  ('finance.read',  'Financeiro', 'Ver contas',       'Contas a pagar e a receber', 63),
  ('finance.write', 'Financeiro', 'Lançar e baixar contas', null, 64)
on conflict (key) do nothing;

update public.roles
set permissions = permissions || '{"finance.read": true, "finance.write": true}'::jsonb
where tenant_id is null and key in ('owner', 'manager');
