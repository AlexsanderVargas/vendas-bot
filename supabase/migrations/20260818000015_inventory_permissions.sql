-- =============================================================================
-- Migration: Permissões de estoque nos papéis de sistema
-- Fase 3 / PBI (issue #15) — Gestão de Produtos e Insumos
--
-- Os papéis semeados em 20260818000003 não conheciam o módulo de estoque.
-- Atualiza apenas os papéis de sistema (tenant_id nulo); papéis customizados
-- de cada estabelecimento continuam sob controle do próprio tenant.
-- =============================================================================

update public.roles
set permissions = permissions || '{"inventory.read": true, "inventory.write": true}'::jsonb
where tenant_id is null and key in ('owner', 'manager');

update public.roles
set permissions = permissions || '{"inventory.read": true}'::jsonb
where tenant_id is null and key in ('cashier', 'kitchen');
