# Vendas Bot — SaaS Gastronômico Multi-tenant

Sistema SaaS multi-tenant para o setor gastronômico (lancherias, restaurantes, bares e afins), com módulo B2C completo de Cardápio Digital e Delivery para os clientes finais.

## Stack

| Camada | Tecnologia |
|---|---|
| Backend | Node.js + Fastify 5 + TypeScript strict |
| Frontend | Next.js 16 (App Router) + Tailwind CSS v4 + shadcn/ui, alvo Vercel |
| Banco / BaaS | Supabase (PostgreSQL + PostGIS) com RLS para isolamento multi-tenant |
| Autenticação | OAuth 2.0 via Supabase Auth (Google, Facebook, Outlook, GitHub) |
| Segurança | `@fastify/rate-limit`, `@fastify/helmet`, CORS por lista de origens |

## Estrutura

```
apps/api/               Backend Fastify
apps/web/               Frontend Next.js (B2C + painel interno)
packages/shared/        Contratos e regras compartilhadas entre API e web
supabase/migrations/    Fonte da verdade do schema (append-only)
scripts/                db-test.sh e as suítes de asserção SQL
docs/                   Arquitetura, regras de engenharia e notas de banco
```

## Como rodar

```bash
npm install
npm run build:shared          # o pacote compartilhado emite dist/ consumido pelos apps

cp apps/api/.env.example apps/api/.env      # preencha as chaves do Supabase
cp apps/web/.env.example apps/web/.env.local

npm run dev -w @vendas-bot/api    # http://localhost:3333
npm run dev -w @vendas-bot/web    # http://localhost:3000
```

Aplicar o schema: `supabase db push`, ou executar os arquivos de `supabase/migrations/` em ordem numérica no SQL Editor.

Para provisionar de verdade — contas, chaves e o que é gratuito em cada
integração — siga [docs/homologacao.md](docs/homologacao.md).

## Verificação

```bash
npm run typecheck     # api + web + shared
npm run test          # suíte de API (vitest)
npm run db:test       # migrations + asserções de RLS e regras de negócio
```

`scripts/db-test.sh` sobe um PostgreSQL descartável (ou usa o serviço do CI), aplica o stub do schema `auth` do Supabase, roda **todas** as migrations e executa as suítes de asserção. Qualquer asserção falsa aborta o script.

## Módulos entregues

| Feature | Escopo | PR |
|---|---|---|
| 1 — Fundação | Schema core multi-tenant, backend Fastify, frontend Next.js | #5 |
| 2 — Cardápio Digital e Delivery B2C | Cardápio público, entrega e taxas, carrinho, checkout, rastreamento, fidelidade e NPS | #13 |
| 3 — Produtos e Insumos | Insumos, fornecedores, ficha técnica, CMV, estoque FIFO/FEFO, baixa automática | #19 |
| 4 — Operação Interna | Salão e mesas, RBAC granular, comandas, KDS | #25 |
| 5 — Financeiro e Caixa | PDV, pagamento on-line, contas a pagar/receber, DRE e fluxo de caixa | #31 |
| 6 — Fiscal e Tributário | Configuração tributária, documentos fiscais, fila de emissão e contingência | #35 |
| 7 — Marketplaces | Integração com iFood e Uber Eats: importação de pedidos, mapa de itens, fila de eventos idempotente | #41 |
| 8 — Identidade Visual | Marca do cliente no cardápio e no painel: cores, fonte, logo, capa, biblioteca de mídias | — |

## O que está verificado e o que não está

Esta seção existe para não confundir "implementado" com "homologado".

### Verificado automaticamente

- **Banco**: 33 migrations aplicam limpas do zero, com **464 asserções** cobrindo isolamento por RLS entre estabelecimentos e entre clientes, regras de negócio (preço recalculado no servidor, FIFO/FEFO, CMV histórico, conciliação de caixa, numeração fiscal sem buraco, pedido de marketplace com o preço do parceiro) e integridade (constraints, triggers de derivação de `tenant_id`, arquivo preso à pasta do próprio estabelecimento).
- **API**: **383 testes** com `fastify.inject`, cobrindo contratos de entrada e saída, autenticação, autorização por permissão, e o mapeamento de erros de negócio para status HTTP.
- **Frontend**: `tsc --noEmit` e `next build` sem erros.
- **CI**: `.github/workflows/ci.yml` roda banco (PostGIS), typecheck, testes e build a cada push e pull request.

### NÃO verificado contra ambientes reais

- **Gateways de pagamento** (Mercado Pago, Stripe, Asaas): os clientes seguem a documentação oficial de cada provedor e são exercitados com transporte HTTP mockado — formato das requisições, mapeamento de status e verificação de assinatura, incluindo recusa de assinatura adulterada e de notificação antiga. **Nenhuma credencial real foi usada.** Homologar em sandbox antes de produção.
- **Emissão fiscal (NFC-e/NF-e)**: depende de certificado digital A1/A3, credenciamento na SEFAZ do estado e homologação. O que existe é a arquitetura de banco, a fila com contingência e retentativa, e a porta `FiscalEmitter` com um cliente HTTP genérico. **Nada foi transmitido a SEFAZ ou a integrador real.**
- **Supabase**: nenhuma migration foi aplicada em projeto real — a validação toda ocorreu em PostgreSQL local com stub do schema `auth`.
- **Fluxo OAuth de ponta a ponta**: o código de login social está implementado, mas exige provedores configurados no painel do Supabase para ser exercitado.
- **iFood e Uber Eats**: os clientes seguem a documentação pública de cada marketplace e são exercitados com transporte HTTP mockado — normalização de pedido, verificação de assinatura do webhook e idempotência de evento. **Nenhuma credencial de parceiro foi usada, e nenhum pedido real foi importado.** Ambos exigem homologação e aprovação do marketplace antes de produção.
- **Supabase Storage**: o bucket `tenant-media` e suas políticas estão na migration, mas não foram criados em projeto real. O envio de imagem depende do bucket existir — e o schema `storage` não existe no PostgreSQL local, então essa parte da migration é pulada nas asserções (o que é testado ali é o registro, o prefixo por estabelecimento e os limites de arquivo).

### Pontos a endurecer antes de produção

- Segredos de gateway e fiscais estão em tabelas com RLS negando tudo fora do `service_role`. É seguro contra acesso pelo navegador, mas um gerenciador de segredos dedicado é o passo seguinte.
- O webhook de pagamento identifica o estabelecimento tentando validar a assinatura contra cada configuração do provedor. Com muitos estabelecimentos, vale uma URL de webhook por tenant.
- Não há testes de ponta a ponta de navegador (Playwright) — a verificação do frontend é typecheck e build.
- As imagens dos estabelecimentos são servidas com `unoptimized` no `next/image`: o host vem do projeto Supabase de cada instalação, então não há lista de domínios que possa ser fixada em build. Com um domínio de CDN definido, vale configurar `images.remotePatterns` e ligar a otimização.
- O webhook do Uber Eats e o polling do iFood identificam o estabelecimento pela integração cadastrada. Vale medir o custo do polling antes de escalar o número de lojas.

## Documentação

- [Homologação e Provisionamento](docs/homologacao.md) — o que criar fora do repositório, em que ordem, e o que custa dinheiro.
- [Regras de Engenharia](docs/engineering-rules.md) — fluxo de branches, contratos de I/O e gestão de issues.
- [Arquitetura](docs/architecture.md) — visão modular e estratégia multi-tenant.
- [PBI 1 — Database Core](docs/database/pbi-1-database-core.md) — diagrama ER e decisões do núcleo.
