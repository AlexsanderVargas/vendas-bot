-- =============================================================================
-- Asserções do seed de demonstração: aplica DUAS vezes e confere que nada
-- duplica. Um seed que duplica ao ser reaplicado é pior que nenhum seed —
-- deixa o banco num estado que ninguém sabe desfazer.
-- =============================================================================
\set ON_ERROR_STOP on
\set demo 'dededede-0000-0000-0000-000000000001'

\ir seed_demo.sql

create temporary table t_seed1 as
select
  (select count(*) from public.products      where tenant_id = :'demo') as produtos,
  (select count(*) from public.categories    where tenant_id = :'demo') as categorias,
  (select count(*) from public.product_recipes where tenant_id = :'demo') as fichas,
  (select count(*) from public.orders        where tenant_id = :'demo') as pedidos,
  (select count(*) from public.order_items   where tenant_id = :'demo') as itens,
  (select count(*) from public.dining_tables where tenant_id = :'demo') as mesas,
  (select count(*) from public.product_options where tenant_id = :'demo') as opcionais;

select test.assert((select produtos from t_seed1) = 8, 'o seed cria os produtos do cardápio');
select test.assert((select categorias from t_seed1) = 4, 'o seed cria as categorias');
select test.assert((select fichas from t_seed1) = 10, 'o seed cria as fichas técnicas');
select test.assert((select pedidos from t_seed1) = 4, 'o seed cria pedidos em estados variados');
select test.assert((select mesas from t_seed1) = 6, 'o seed cria as mesas do salão');

-- ------------------------------ segunda aplicação -----------------------------
\ir seed_demo.sql

select test.assert(
  (select count(*) from public.products where tenant_id = :'demo') = (select produtos from t_seed1)
  and (select count(*) from public.categories where tenant_id = :'demo') = (select categorias from t_seed1)
  and (select count(*) from public.product_recipes where tenant_id = :'demo') = (select fichas from t_seed1)
  and (select count(*) from public.orders where tenant_id = :'demo') = (select pedidos from t_seed1)
  and (select count(*) from public.order_items where tenant_id = :'demo') = (select itens from t_seed1)
  and (select count(*) from public.dining_tables where tenant_id = :'demo') = (select mesas from t_seed1)
  and (select count(*) from public.product_options where tenant_id = :'demo') = (select opcionais from t_seed1),
  'aplicar o seed duas vezes não duplica nada');

-- ---------------------------- o cardápio abre de fato -------------------------
-- É o que o seed existe para provar: a vitrine não abre vazia.
select test.assert(
  (public.resolve_branding('lancheria-demo')->>'isCustomized')::boolean,
  'o estabelecimento de demonstração já vem com identidade visual');

select test.assert(
  (public.resolve_branding('lancheria-demo')->>'displayName') = 'Lancheria do Zé',
  'a identidade traz o nome de exibição');

select test.assert(
  exists (
    select 1 from public.products p
    join public.categories c on c.id = p.category_id
    where p.tenant_id = :'demo' and p.is_active and c.is_active),
  'há produto ativo em categoria ativa — o cardápio tem o que mostrar');

-- A ficha técnica precisa produzir CMV, senão os relatórios abrem zerados.
select test.assert(
  public.product_cmv('dededede-0000-0000-0000-00000000b001') > 0,
  'a ficha técnica do X-Salada produz CMV');

select test.assert(
  exists (select 1 from public.orders where tenant_id = :'demo' and status = 'preparing'),
  'há pedido em preparo — o KDS abre com fila');

-- ------------------------------ remoção limpa ---------------------------------
-- O cabeçalho do seed promete que dois deletes removem tudo. A ordem importa:
-- orders.tenant_id é `on delete restrict`, então o histórico de vendas sai
-- antes do cadastro — apagar o tenant direto é BLOQUEADO pelo banco, e é isso
-- que se verifica primeiro.
select test.assert_denied(
  $$delete from public.tenants where id = 'dededede-0000-0000-0000-000000000001'$$,
  'apagar o estabelecimento com pedidos é bloqueado (histórico é imutável)');

delete from public.orders  where tenant_id = :'demo';
delete from public.tenants where id        = :'demo';

select test.assert(
  not exists (select 1 from public.products where tenant_id = :'demo')
  and not exists (select 1 from public.orders where tenant_id = :'demo'),
  'apagar o estabelecimento remove todo o dado de demonstração');
