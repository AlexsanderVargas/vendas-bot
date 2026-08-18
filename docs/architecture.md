# Arquitetura do Sistema

## Visão Geral

SaaS multi-tenant para o setor gastronômico, com arquitetura **modular (DDD leve)**: módulos de domínio bem separados compartilhando um núcleo de tenancy, identidade e catálogo.

```mermaid
flowchart LR
    subgraph B2C["Cliente Final (B2C)"]
        WEB["Next.js / Vercel<br/>Cardápio Digital & Delivery"]
    end
    subgraph OPS["Operação Interna"]
        ADM["Next.js / Vercel<br/>PDV · KDS · Salão · Gestão"]
    end
    subgraph API["Backend"]
        FASTIFY["Fastify + TypeScript<br/>Rate limit · CORS · Webhooks"]
    end
    subgraph SUPA["Supabase"]
        AUTH["Auth (OAuth 2.0)"]
        PG["PostgreSQL + PostGIS<br/>RLS multi-tenant"]
        RT["Realtime (WebSockets)"]
    end
    WEB --> FASTIFY
    ADM --> FASTIFY
    WEB -. "subscriptions de status" .-> RT
    ADM -. "mesas/KDS em tempo real" .-> RT
    FASTIFY --> PG
    WEB --> AUTH
    ADM --> AUTH
```

## Módulos de Domínio

| Módulo | Responsabilidade |
|---|---|
| Core / Tenancy | `tenants`, `users` (staff), `roles` (RBAC granular) |
| Catálogo & Insumos | `products`, ficha técnica, estoque/lotes, fornecedores |
| Operação | mesas/setores, comandas, KDS |
| B2C | `customers`, `customer_addresses`, carrinho, fidelidade, NPS |
| Vendas | `orders`, `order_items`, rastreamento de status |
| Financeiro | PDV/caixa, pagamentos online, contas, DRE/CMV |
| Fiscal | integração NFC-e / NF-e |
| Marketplaces | integrações iFood/Uber Eats, mapa de itens, fila de eventos |
| Identidade Visual | `tenant_branding`, biblioteca de mídias, tema servido por estabelecimento |

## Estratégia Multi-tenant

1. **`tenant_id` em toda tabela de domínio** (uuid, FK para `tenants`).
2. **RLS em todas as tabelas.** O isolamento acontece no banco:
   - **Staff**: o JWT do Supabase Auth carrega `app_metadata.tenant_id` (setado pelo backend com `service_role` no onboarding do funcionário). A função `public.current_tenant_id()` lê esse claim e as políticas comparam com a coluna `tenant_id`.
   - **Cliente B2C**: acesso apenas às próprias linhas (`auth_user_id = auth.uid()`), independente de tenant — um mesmo usuário Google pode ser cliente de vários restaurantes (uma linha em `customers` por tenant).
   - **Anônimo**: leitura pública somente de cardápio (`tenants` e `products` ativos) para o cardápio digital funcionar sem login.
3. **`service_role`** (backend Fastify) ignora RLS — usado para rotinas administrativas, webhooks de pagamento e onboarding.

## Decisões Estruturais

- **PostGIS** (`geography(Point, 4326)`): distância cliente→restaurante para taxa de entrega por raio e para o modo retirada (rotas Google Maps/Waze).
- **Snapshots em pedidos**: `orders.delivery_address` (jsonb) e `order_items.product_name`/`unit_price` congelam os dados no momento da venda — alterações posteriores de cadastro não reescrevem histórico.
- **Numeração de pedido por tenant**: contador transacional por tenant (`tenant_counters` + `next_order_number()`), gerando sequência amigável e sem colisão entre estabelecimentos.
- **Realtime**: as subscriptions do Supabase dependem das políticas de `select` — o cliente só recebe eventos dos próprios pedidos; o KDS só recebe eventos do próprio tenant.
- **Contratos estáveis**: funções SQL e endpoints têm contratos de entrada/saída imutáveis (ver [regras de engenharia](engineering-rules.md)).

## White-label

O produto é vendido para o restaurante, mas quem usa o cardápio é o cliente
**dele**. Por isso a marca do SaaS não aparece na vitrine:

- **Identidade no banco** (`tenant_branding`): cores validadas por
  `is_hex_color()` e fonte restrita a uma lista fechada — os dois valores vão
  para o CSS servido ao cliente final, onde texto livre seria injeção.
- **Tema injetado no servidor**: o layout renderiza um `<style>` com as
  variáveis da identidade, então o navegador nunca pinta a cor padrão antes
  de trocar. Toda a paleta (`brand-50`…`brand-700`) deriva de
  `--brand-primary` por `color-mix`, então trocar uma variável recoloriza a
  aplicação inteira sem tocar em componente.
- **Mídias isoladas pelo caminho**: os arquivos ficam em
  `tenants/<tenant_id>/…` no Supabase Storage e as políticas do bucket
  derivam o estabelecimento do próprio caminho — o cliente não escolhe o
  tenant, o caminho escolhe por ele.

## Marketplaces

Pedidos de iFood e Uber Eats entram pelo mesmo caminho dos pedidos próprios
(cozinha, estoque, relatórios), com duas diferenças deliberadas:

- **O preço vem do parceiro**, não do catálogo interno: quem definiu o que o
  cliente pagou foi o marketplace, e recalcular produziria um pedido que não
  bate com o repasse.
- **Item sem mapeamento não perde a venda**: entra no pedido mesmo assim e é
  devolvido em `unmappedItems` para o lojista resolver depois.

Idempotência por `(integration_id, external_event_id)`; evento que falha
**não** é confirmado, para o parceiro reentregar.

## Roadmap (Features)

Todas as oito features foram entregues e mescladas na `main`:

1. **Fundação** — DB core + RLS/PostGIS · Backend Fastify · Frontend Next.js (PR #5)
2. **Cardápio Digital & Delivery B2C** (PR #13)
3. **Produtos & Insumos** — ficha técnica, estoque FIFO/FEFO (PR #19)
4. **Operação Interna** — mesas, comandas, KDS, RBAC (PR #25)
5. **Financeiro & Caixa** — PDV, pagamentos on-line, DRE/CMV (PR #31)
6. **Fiscal & Tributário** — configuração tributária, fila de emissão (PR #35)
7. **Marketplaces** — iFood e Uber Eats (PR #41)
8. **Identidade Visual** — branding, biblioteca de mídias, tema aplicado

O estado de verificação de cada módulo — o que está testado e o que **não** foi
homologado contra ambientes reais — está no [README](../README.md#o-que-está-verificado-e-o-que-não-está).
