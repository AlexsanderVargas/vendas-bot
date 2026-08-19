-- =============================================================================
-- Movimento de caixa não atravessa mais a fronteira do estabelecimento (#79)
--
-- `settle_account(p_account_id, p_amount, p_session_id)` conferia o título e
-- NÃO conferia nada sobre a sessão recebida:
--
--     insert into public.cash_movements (tenant_id, session_id, ...)
--     values (v_account.tenant_id, p_session_id, ...);
--
-- Como `cash_movements.tenant_id` é derivado da sessão por trigger, o lançamento
-- caía inteiro dentro da outra loja: tenant e sessão dela. Na conferência do
-- fechamento, o vizinho fecha com uma diferença que ninguém explica.
--
-- Por que só aqui: uma escrita direta na tabela, pelo PostgREST, já era barrada
-- pela RLS — o trigger reescreve o tenant_id para o da sessão e o WITH CHECK da
-- policy recusa. `settle_account` é SECURITY DEFINER e não passa por RLS
-- nenhuma; era o único caminho aberto, e agora confere a sessão explicitamente.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- settle_account(p_account_id uuid, p_amount numeric, p_session_id uuid)
-- Contrato ESTÁVEL: -> jsonb { "ok": bool, "error": text|null,
--   "status": text|null, "paidAmount": numeric|null, "remaining": numeric|null }
--   error: 'conta_nao_encontrada' | 'nao_autorizado' | 'conta_cancelada'
--        | 'valor_invalido' | 'sessao_invalida'   <- valor novo
--
-- A autorização passa a ser `can_access_tenant`, que confere o vínculo NO
-- BANCO. `current_tenant_id()` lia só o claim do JWT: funcionário desativado
-- seguia baixando título pela hora que faltava para o token dele expirar.
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

  if not public.can_access_tenant(v_account.tenant_id) then
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

  -- A sessão precisa ser do MESMO estabelecimento do título e estar aberta.
  -- Caixa fechado já teve o valor apurado e conferido: um lançamento posterior
  -- muda um número que alguém assinou.
  if p_session_id is not null
     and not exists (
       select 1 from public.cash_sessions s
       where s.id = p_session_id
         and s.tenant_id = v_account.tenant_id
         and s.status = 'open'
     ) then
    return jsonb_build_object('ok', false, 'error', 'sessao_invalida',
      'status', v_account.status::text, 'paidAmount', v_account.paid_amount,
      'remaining', round(v_account.amount - v_account.paid_amount, 2));
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
