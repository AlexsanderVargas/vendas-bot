# Vendas Bot — SaaS Gastronômico Multi-tenant

Sistema SaaS multi-tenant para o setor gastronômico (lancherias, restaurantes, bares e afins), com módulo B2C completo de Cardápio Digital e Delivery para os clientes finais.

## Stack Tecnológica

| Camada | Tecnologia |
|---|---|
| Backend | Node.js + Fastify + TypeScript (strict mode) |
| Frontend | Next.js (React) + Tailwind CSS + shadcn/ui, hospedado na Vercel |
| Banco de Dados / BaaS | Supabase (PostgreSQL + PostGIS) com RLS para isolamento multi-tenant |
| Autenticação | OAuth 2.0 via Supabase Auth (Google, GitHub, Facebook, Outlook) |
| Segurança | Rate limiting (`@fastify/rate-limit`), CORS rigoroso |

## Módulos

1. **Gestão de Produtos e Insumos** — cadastro, ficha técnica, estoque/lotes (FIFO/FEFO), fornecedores.
2. **Organização do Estabelecimento** — salão/mesas em tempo real, gestão de pessoas (RBAC).
3. **Cardápio Digital e Delivery (B2C)** — social login, cadastro progressivo, endereços + taxa por distância (PostGIS), carrinho persistente, rastreamento real-time, fidelidade e NPS.
4. **Atendimento e Vendas** — comandas/mesas, KDS (Kitchen Display System).
5. **Financeiro e Caixa** — PDV, pagamentos online (Mercado Pago, Stripe, Asaas, PIX), contas a pagar/receber, DRE, CMV.
6. **Fiscal e Tributário** — preparação para NFC-e e NF-e.

## Estrutura do Repositório

```
docs/                  Documentação de arquitetura e regras de engenharia
supabase/migrations/   Migrations SQL versionadas (fonte da verdade do schema)
apps/api/              Backend Fastify (PBI 2)
apps/web/              Frontend Next.js (PBI 3)
```

## Documentação

- [Regras de Engenharia](docs/engineering-rules.md) — fluxo de branches, regras de commit e de banco.
- [Arquitetura](docs/architecture.md) — visão modular, estratégia multi-tenant e decisões estruturais.
