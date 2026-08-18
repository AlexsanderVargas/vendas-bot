-- =============================================================================
-- Seed de demonstração — Fase 9 / PBI (issue #50)
--
-- Um Supabase recém-provisionado sobe vazio: o cardápio não tem o que mostrar
-- e o painel não tem o que operar, o que torna impossível julgar se está tudo
-- certo. Este script cria um estabelecimento fictício completo.
--
-- SEGURO DE RODAR DUAS VEZES: todos os identificadores são fixos e todo insert
-- tem `on conflict do nothing`.
--
-- Para remover tudo, nesta ordem — os pedidos primeiro, porque
-- orders.tenant_id é `on delete restrict`: o histórico de vendas é imutável
-- por construção e não some junto com o cadastro.
--   delete from public.orders  where tenant_id = 'dededede-0000-0000-0000-000000000001';
--   delete from public.tenants where id        = 'dededede-0000-0000-0000-000000000001';
--
-- NÃO cria usuários — isso é do Supabase Auth. Para se vincular como dono,
-- veja docs/homologacao.md.
-- =============================================================================

\set tenant 'dededede-0000-0000-0000-000000000001'

-- ------------------------------ estabelecimento -------------------------------
insert into public.tenants (
  id, slug, name, document, phone,
  address_street, address_number, neighborhood, city, state, zip_code,
  location, delivery_fee_mode, is_active
) values (
  :'tenant', 'lancheria-demo', 'Lancheria do Zé', '12345678000199', '+5551999990000',
  'Av. Ipiranga', '1200', 'Azenha', 'Porto Alegre', 'RS', '90160093',
  extensions.st_setsrid(extensions.st_makepoint(-51.2177, -30.0346), 4326)::extensions.geography,
  'distance', true
)
on conflict (id) do nothing;

-- ------------------------------ identidade visual -----------------------------
insert into public.tenant_branding (
  tenant_id, primary_color, primary_contrast, accent_color,
  font_family, theme_mode, corner_radius,
  display_name, tagline, about, social_links, banner_message
) values (
  :'tenant', '#E85D2A', '#FFFFFF', '#FFC24B',
  'poppins', 'system', 16,
  'Lancheria do Zé', 'O melhor X-Salada da cidade desde 1987',
  'Lanches na chapa, batata frita sequinha e o atendimento de sempre.',
  '{"instagram": "@lancheriadoze", "whatsapp": "+55 51 99999-0000"}'::jsonb,
  'Entregamos até 23h de terça a domingo.'
)
on conflict (tenant_id) do nothing;

-- --------------------------------- categorias ---------------------------------
insert into public.categories (id, tenant_id, name, description, sort_order) values
  ('dededede-0000-0000-0000-00000000c001', :'tenant', 'Lanches',      'Na chapa, no pão de verdade', 1),
  ('dededede-0000-0000-0000-00000000c002', :'tenant', 'Porções',      'Para dividir (ou não)',       2),
  ('dededede-0000-0000-0000-00000000c003', :'tenant', 'Bebidas',      'Geladas',                     3),
  ('dededede-0000-0000-0000-00000000c004', :'tenant', 'Sobremesas',   'Para fechar bem',             4)
on conflict (id) do nothing;

-- --------------------------------- produtos -----------------------------------
insert into public.products (id, tenant_id, category_id, sku, name, description, price, sort_order) values
  ('dededede-0000-0000-0000-00000000b001', :'tenant', 'dededede-0000-0000-0000-00000000c001', 'LAN-001',
   'X-Salada',        'Hambúrguer 180g, queijo, alface, tomate e maionese da casa', 26.90, 1),
  ('dededede-0000-0000-0000-00000000b002', :'tenant', 'dededede-0000-0000-0000-00000000c001', 'LAN-002',
   'X-Bacon',         'Hambúrguer 180g, bacon crocante, queijo e cebola caramelizada', 32.90, 2),
  ('dededede-0000-0000-0000-00000000b003', :'tenant', 'dededede-0000-0000-0000-00000000c001', 'LAN-003',
   'X-Tudo',          'Tudo o que cabe entre dois pães', 38.90, 3),
  ('dededede-0000-0000-0000-00000000b004', :'tenant', 'dededede-0000-0000-0000-00000000c002', 'POR-001',
   'Batata Frita',    'Porção de 400g, sequinha', 24.90, 1),
  ('dededede-0000-0000-0000-00000000b005', :'tenant', 'dededede-0000-0000-0000-00000000c002', 'POR-002',
   'Isca de Frango',  'Porção de 400g com molho da casa', 34.90, 2),
  ('dededede-0000-0000-0000-00000000b006', :'tenant', 'dededede-0000-0000-0000-00000000c003', 'BEB-001',
   'Refrigerante Lata', '350ml', 7.00, 1),
  ('dededede-0000-0000-0000-00000000b007', :'tenant', 'dededede-0000-0000-0000-00000000c003', 'BEB-002',
   'Suco Natural',    'Laranja ou maracujá, 500ml', 12.00, 2),
  ('dededede-0000-0000-0000-00000000b008', :'tenant', 'dededede-0000-0000-0000-00000000c004', 'SOB-001',
   'Petit Gateau',    'Com sorvete de creme', 22.00, 1)
on conflict (id) do nothing;

-- --------------------------- opcionais dos lanches ----------------------------
insert into public.product_option_groups (id, tenant_id, product_id, name, selection_type, min_select, max_select, sort_order) values
  ('dededede-0000-0000-0000-00000000e001', :'tenant', 'dededede-0000-0000-0000-00000000b001',
   'Ponto da carne', 'single', 1, 1, 1),
  ('dededede-0000-0000-0000-00000000e002', :'tenant', 'dededede-0000-0000-0000-00000000b001',
   'Adicionais', 'multiple', 0, 4, 2),
  ('dededede-0000-0000-0000-00000000e003', :'tenant', 'dededede-0000-0000-0000-00000000b002',
   'Ponto da carne', 'single', 1, 1, 1)
on conflict (id) do nothing;

insert into public.product_options (id, tenant_id, group_id, name, price_delta, sort_order) values
  ('dededede-0000-0000-0000-00000000f001', :'tenant', 'dededede-0000-0000-0000-00000000e001', 'Ao ponto',      0.00, 1),
  ('dededede-0000-0000-0000-00000000f002', :'tenant', 'dededede-0000-0000-0000-00000000e001', 'Bem passado',   0.00, 2),
  ('dededede-0000-0000-0000-00000000f003', :'tenant', 'dededede-0000-0000-0000-00000000e002', 'Bacon',         6.00, 1),
  ('dededede-0000-0000-0000-00000000f004', :'tenant', 'dededede-0000-0000-0000-00000000e002', 'Queijo extra',  4.00, 2),
  ('dededede-0000-0000-0000-00000000f005', :'tenant', 'dededede-0000-0000-0000-00000000e002', 'Ovo',           3.00, 3),
  ('dededede-0000-0000-0000-00000000f006', :'tenant', 'dededede-0000-0000-0000-00000000e003', 'Ao ponto',      0.00, 1),
  ('dededede-0000-0000-0000-00000000f007', :'tenant', 'dededede-0000-0000-0000-00000000e003', 'Bem passado',   0.00, 2)
on conflict (id) do nothing;

-- -------------------------------- fornecedores --------------------------------
insert into public.suppliers (id, tenant_id, name, document, phone, contact_name) values
  ('dededede-0000-0000-0000-00000000ad01', :'tenant', 'Frigorífico Central', '11222333000144', '+5551988880001', 'Marcos'),
  ('dededede-0000-0000-0000-00000000ad02', :'tenant', 'Hortifruti do Bairro', '55666777000188', '+5551988880002', 'Dona Alice')
on conflict (id) do nothing;

-- ----------------------------------- insumos ----------------------------------
insert into public.ingredients (id, tenant_id, name, sku, base_unit, average_cost, stock_quantity, minimum_stock, is_perishable, shelf_life_days) values
  ('dededede-0000-0000-0000-00000000a001', :'tenant', 'Hambúrguer 180g', 'ING-001', 'un', 4.5000, 200.000, 40.000,  true, 90),
  ('dededede-0000-0000-0000-00000000a002', :'tenant', 'Pão de hambúrguer','ING-002', 'un', 1.2000, 300.000, 60.000,  true,  7),
  ('dededede-0000-0000-0000-00000000a003', :'tenant', 'Queijo mussarela', 'ING-003', 'g',  0.0450, 8000.000, 2000.000, true, 30),
  ('dededede-0000-0000-0000-00000000a004', :'tenant', 'Bacon',            'ING-004', 'g',  0.0620, 4000.000, 1000.000, true, 20),
  ('dededede-0000-0000-0000-00000000a005', :'tenant', 'Alface',           'ING-005', 'g',  0.0120, 2000.000, 500.000,  true,  5),
  ('dededede-0000-0000-0000-00000000a006', :'tenant', 'Tomate',           'ING-006', 'g',  0.0150, 3000.000, 800.000,  true,  7),
  ('dededede-0000-0000-0000-00000000a007', :'tenant', 'Batata congelada', 'ING-007', 'g',  0.0180, 20000.000, 5000.000, false, null)
on conflict (id) do nothing;

-- ------------------------------- fichas técnicas ------------------------------
-- Com elas o CMV aparece nos relatórios e a venda baixa estoque sozinha.
insert into public.product_recipes (tenant_id, product_id, ingredient_id, quantity, waste_percent) values
  (:'tenant', 'dededede-0000-0000-0000-00000000b001', 'dededede-0000-0000-0000-00000000a001',    1.0000, 0),
  (:'tenant', 'dededede-0000-0000-0000-00000000b001', 'dededede-0000-0000-0000-00000000a002',    1.0000, 0),
  (:'tenant', 'dededede-0000-0000-0000-00000000b001', 'dededede-0000-0000-0000-00000000a003',   30.0000, 2),
  (:'tenant', 'dededede-0000-0000-0000-00000000b001', 'dededede-0000-0000-0000-00000000a005',   20.0000, 15),
  (:'tenant', 'dededede-0000-0000-0000-00000000b001', 'dededede-0000-0000-0000-00000000a006',   30.0000, 10),
  (:'tenant', 'dededede-0000-0000-0000-00000000b002', 'dededede-0000-0000-0000-00000000a001',    1.0000, 0),
  (:'tenant', 'dededede-0000-0000-0000-00000000b002', 'dededede-0000-0000-0000-00000000a002',    1.0000, 0),
  (:'tenant', 'dededede-0000-0000-0000-00000000b002', 'dededede-0000-0000-0000-00000000a003',   30.0000, 2),
  (:'tenant', 'dededede-0000-0000-0000-00000000b002', 'dededede-0000-0000-0000-00000000a004',   40.0000, 5),
  (:'tenant', 'dededede-0000-0000-0000-00000000b004', 'dededede-0000-0000-0000-00000000a007',  400.0000, 3)
on conflict (product_id, ingredient_id) do nothing;

-- ----------------------------------- salão ------------------------------------
insert into public.dining_sectors (id, tenant_id, name, sort_order) values
  ('dededede-0000-0000-0000-00000000cd01', :'tenant', 'Salão',    1),
  ('dededede-0000-0000-0000-00000000cd02', :'tenant', 'Calçada',  2)
on conflict (id) do nothing;

insert into public.dining_tables (id, tenant_id, sector_id, label, seats, status, map_x, map_y) values
  ('dededede-0000-0000-0000-00000000da01', :'tenant', 'dededede-0000-0000-0000-00000000cd01', '1', 4, 'free',     10, 10),
  ('dededede-0000-0000-0000-00000000da02', :'tenant', 'dededede-0000-0000-0000-00000000cd01', '2', 4, 'occupied', 30, 10),
  ('dededede-0000-0000-0000-00000000da03', :'tenant', 'dededede-0000-0000-0000-00000000cd01', '3', 2, 'free',     50, 10),
  ('dededede-0000-0000-0000-00000000da04', :'tenant', 'dededede-0000-0000-0000-00000000cd01', '4', 6, 'billing',  70, 10),
  ('dededede-0000-0000-0000-00000000da05', :'tenant', 'dededede-0000-0000-0000-00000000cd02', '5', 4, 'cleaning', 10, 60),
  ('dededede-0000-0000-0000-00000000da06', :'tenant', 'dededede-0000-0000-0000-00000000cd02', '6', 4, 'free',     30, 60)
on conflict (id) do nothing;

-- ---------------------------------- pedidos -----------------------------------
-- Estados variados para o KDS e os relatórios não abrirem vazios.
insert into public.orders (id, tenant_id, order_number, channel, status, payment_status, subtotal, discount, delivery_fee, total, placed_at)
values
  ('dededede-0000-0000-0000-00000000ce01', :'tenant', 9001, 'dine_in',  'preparing', 'pending', 59.80, 0.00, 0.00, 59.80, now() - interval '12 minutes'),
  ('dededede-0000-0000-0000-00000000ce02', :'tenant', 9002, 'takeaway', 'ready',     'paid',    32.90, 0.00, 0.00, 32.90, now() - interval '25 minutes'),
  ('dededede-0000-0000-0000-00000000ce03', :'tenant', 9003, 'dine_in',  'completed', 'paid',    88.70, 8.87, 0.00, 79.83, now() - interval '3 hours'),
  ('dededede-0000-0000-0000-00000000ce04', :'tenant', 9004, 'takeaway', 'completed', 'paid',    46.90, 0.00, 0.00, 46.90, now() - interval '1 day')
on conflict (id) do nothing;

-- order_items não tem chave natural (o mesmo produto pode entrar duas vezes na
-- mesma comanda), então a idempotência vem de ids fixos.
insert into public.order_items (id, order_id, tenant_id, product_id, product_name, unit_price, quantity) values
  ('dededede-0000-0000-0000-0000000e0001', 'dededede-0000-0000-0000-00000000ce01', :'tenant', 'dededede-0000-0000-0000-00000000b001', 'X-Salada',     26.90, 1),
  ('dededede-0000-0000-0000-0000000e0002', 'dededede-0000-0000-0000-00000000ce01', :'tenant', 'dededede-0000-0000-0000-00000000b003', 'X-Tudo',       38.90, 1),
  ('dededede-0000-0000-0000-0000000e0003', 'dededede-0000-0000-0000-00000000ce02', :'tenant', 'dededede-0000-0000-0000-00000000b002', 'X-Bacon',      32.90, 1),
  ('dededede-0000-0000-0000-0000000e0004', 'dededede-0000-0000-0000-00000000ce03', :'tenant', 'dededede-0000-0000-0000-00000000b001', 'X-Salada',     26.90, 2),
  ('dededede-0000-0000-0000-0000000e0005', 'dededede-0000-0000-0000-00000000ce03', :'tenant', 'dededede-0000-0000-0000-00000000b004', 'Batata Frita', 24.90, 1),
  ('dededede-0000-0000-0000-0000000e0006', 'dededede-0000-0000-0000-00000000ce04', :'tenant', 'dededede-0000-0000-0000-00000000b005', 'Isca de Frango', 34.90, 1),
  ('dededede-0000-0000-0000-0000000e0007', 'dededede-0000-0000-0000-00000000ce04', :'tenant', 'dededede-0000-0000-0000-00000000b006', 'Refrigerante Lata', 7.00, 1)
on conflict (id) do nothing;

\echo ''
\echo '  Estabelecimento de demonstração pronto.'
\echo '  Cardápio: /lancheria-demo'
\echo '  Tenant:   dededede-0000-0000-0000-000000000001'
\echo '  Para se vincular como dono, veja docs/homologacao.md'
\echo ''
