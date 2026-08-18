-- =============================================================================
-- Migration: RBAC granular — catálogo de permissões e gestão de funcionários
-- Fase 4 / PBI (issue #22) — Organização do Estabelecimento
-- =============================================================================

-- -----------------------------------------------------------------------------
-- permission_catalog: lista das permissões que o sistema reconhece.
-- Existe para a tela de papéis renderizar uma matriz em vez de pedir que o
-- gestor digite chaves à mão. Global (sem tenant_id) e somente leitura.
-- -----------------------------------------------------------------------------
create table public.permission_catalog (
  key         text primary key constraint permission_key_format check (key ~ '^[a-z][a-z0-9_]*(\.[a-z0-9_*]+)+$'),
  module      text not null,
  label       text not null,
  description text,
  sort_order  integer not null default 0
);

insert into public.permission_catalog (key, module, label, description, sort_order) values
  ('orders.read',           'Pedidos',     'Ver pedidos',              'Consultar pedidos do estabelecimento', 10),
  ('orders.create',         'Pedidos',     'Lançar pedidos',           'Abrir comandas e lançar itens', 11),
  ('orders.update_status',  'Pedidos',     'Mudar status de pedidos',  'Confirmar, preparar, entregar', 12),
  ('orders.cancel',         'Pedidos',     'Cancelar pedidos',         null, 13),
  ('tables.read',           'Salão',       'Ver o salão',              null, 20),
  ('tables.write',          'Salão',       'Gerenciar mesas',          'Criar mesas e mudar status', 21),
  ('products.read',         'Cardápio',    'Ver o cardápio',           null, 30),
  ('products.write',        'Cardápio',    'Editar o cardápio',        'Produtos, categorias e opcionais', 31),
  ('inventory.read',        'Estoque',     'Ver estoque',              'Insumos, lotes e movimentações', 40),
  ('inventory.write',       'Estoque',     'Movimentar estoque',       'Entradas, baixas e fichas técnicas', 41),
  ('kds.read',              'Cozinha',     'Ver a fila de preparo',    null, 50),
  ('kds.update_status',     'Cozinha',     'Avançar itens no preparo', null, 51),
  ('cash.read',             'Financeiro',  'Ver o caixa',              null, 60),
  ('cash.open',             'Financeiro',  'Abrir e fechar caixa',     null, 61),
  ('cash.movement',         'Financeiro',  'Suprimento e sangria',     null, 62),
  ('reports.read',          'Relatórios',  'Ver relatórios',           'DRE, fluxo de caixa e CMV', 70),
  ('staff.read',            'Equipe',      'Ver funcionários',         null, 80),
  ('staff.write',           'Equipe',      'Gerenciar funcionários',   'Convidar, editar papéis e desativar', 81),
  ('settings.write',        'Configurações','Editar configurações',    'Dados do estabelecimento e entrega', 90);

alter table public.permission_catalog enable row level security;

create policy permission_catalog_read on public.permission_catalog
  for select to authenticated using (true);

-- -----------------------------------------------------------------------------
-- has_permission(p_permission text)
-- Contrato ESTÁVEL: (text) -> boolean
--   Resolve a permissão do usuário autenticado com curingas, na mesma ordem
--   do resolvedor em TypeScript (apps/api/src/plugins/auth.ts):
--   negação explícita vence, depois exata, depois curinga mais específico,
--   por último o curinga global.
-- -----------------------------------------------------------------------------
create or replace function public.has_permission(p_permission text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_permissions jsonb;
  v_parts       text[];
  v_wildcard    text;
  i             integer;
begin
  select r.permissions into v_permissions
  from public.users u
  join public.roles r on r.id = u.role_id
  where u.id = auth.uid() and u.is_active;

  if v_permissions is null then return false; end if;

  if v_permissions ? p_permission then
    return (v_permissions ->> p_permission)::boolean;
  end if;

  v_parts := string_to_array(p_permission, '.');
  for i in reverse array_length(v_parts, 1) - 1 .. 1 loop
    v_wildcard := array_to_string(v_parts[1:i], '.') || '.*';
    if v_permissions ? v_wildcard then
      return (v_permissions ->> v_wildcard)::boolean;
    end if;
  end loop;

  return coalesce((v_permissions ->> '*')::boolean, false);
end;
$$;

grant execute on function public.has_permission(text) to authenticated;

-- -----------------------------------------------------------------------------
-- Papéis customizados só podem conceder permissões conhecidas: uma chave
-- digitada errado viraria permissão que nunca concede nada (falso negativo
-- silencioso) ou, pior, um curinga amplo demais.
-- Contrato: trigger BEFORE INSERT/UPDATE em roles.
-- -----------------------------------------------------------------------------
create or replace function public.validate_role_permissions()
returns trigger language plpgsql set search_path = '' as $$
declare
  v_key text;
begin
  for v_key in select jsonb_object_keys(new.permissions) loop
    if v_key <> '*'
       and not exists (select 1 from public.permission_catalog c where c.key = v_key)
       and not exists (
         -- Curingas de módulo ('orders.*') valem se o módulo existir.
         select 1 from public.permission_catalog c
         where v_key like '%.*'
           and c.key like left(v_key, length(v_key) - 1) || '%'
       ) then
      raise exception 'permissão desconhecida: %', v_key using errcode = 'check_violation';
    end if;
  end loop;
  return new;
end;
$$;

create trigger roles_validate_permissions
  before insert or update of permissions on public.roles
  for each row execute function public.validate_role_permissions();

-- Papéis de sistema ganham as permissões do catálogo que lhes cabem.
update public.roles set permissions = permissions
  || '{"orders.read": true, "orders.update_status": true, "kds.read": true}'::jsonb
where tenant_id is null and key = 'waiter';

update public.roles set permissions = permissions
  || '{"staff.read": true, "staff.write": true, "settings.write": true, "reports.read": true}'::jsonb
where tenant_id is null and key = 'manager';

-- -----------------------------------------------------------------------------
-- Auditoria de mudanças sensíveis de equipe.
-- -----------------------------------------------------------------------------
create table public.staff_audit_log (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.tenants (id) on delete cascade,
  actor_id   uuid references auth.users (id) on delete set null,
  target_id  uuid references auth.users (id) on delete set null,
  action     text not null,
  details    jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index staff_audit_log_tenant_idx on public.staff_audit_log (tenant_id, created_at desc);

alter table public.staff_audit_log enable row level security;

create policy staff_audit_read on public.staff_audit_log
  for select to authenticated
  using (tenant_id = (select public.current_tenant_id()));

create or replace function public.log_staff_change()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    insert into public.staff_audit_log (tenant_id, actor_id, target_id, action, details)
    values (new.tenant_id, auth.uid(), new.id, 'created',
            jsonb_build_object('roleId', new.role_id, 'name', new.name));
  elsif new.role_id is distinct from old.role_id then
    insert into public.staff_audit_log (tenant_id, actor_id, target_id, action, details)
    values (new.tenant_id, auth.uid(), new.id, 'role_changed',
            jsonb_build_object('from', old.role_id, 'to', new.role_id));
  elsif new.is_active is distinct from old.is_active then
    insert into public.staff_audit_log (tenant_id, actor_id, target_id, action, details)
    values (new.tenant_id, auth.uid(), new.id,
            case when new.is_active then 'reactivated' else 'deactivated' end, '{}'::jsonb);
  end if;
  return null;
end;
$$;

create trigger users_log_staff_change
  after insert or update of role_id, is_active on public.users
  for each row execute function public.log_staff_change();
