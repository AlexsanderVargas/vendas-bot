# Homologação e Provisionamento

Este documento responde a duas perguntas: **o que precisa ser criado fora do
repositório** para o sistema funcionar, e **o que custa dinheiro**.

As fases estão em ordem de **dependência**, não de importância: cada uma
destrava a seguinte. A Fase 1 é a que destrava todo o resto.

> **Nada neste repositório foi aplicado em um projeto Supabase real.** As
> migrations e o seed são scripts; quem os aplica é você. Ver
> [README — o que está verificado](../README.md#o-que-está-verificado-e-o-que-não-está).

---

## Resumo de custos

| Item | Gratuito? | O que exige |
|---|---|---|
| PostgreSQL local (`npm run db:test`) | sim | nada |
| Supabase | sim | 2 projetos ativos, 500 MB de banco, 1 GB de Storage. **Pausa após 7 dias sem requisição** |
| Vercel (frontend) | sim | plano Hobby |
| OAuth Google / Meta / Azure / GitHub | sim | apps de desenvolvimento |
| Mercado Pago | sim | credenciais de teste + usuários de teste |
| Stripe | sim | modo teste, sem ativar a conta |
| Asaas | sim | conta Sandbox, aprovada automaticamente |
| iFood | sim | cadastro no portal já entrega loja e app de teste. **Homologação final exige CNPJ com CNAE de tecnologia** |
| Uber Eats | **não** | NDA, contrato de licenciamento e aprovação de um *partner manager*. Não é self-serve |
| Integrador fiscal (sandbox) | sim | conta no PlugNotas, Focus NFe ou NFe.io |
| Emissão fiscal real | **não** | certificado A1 (e-CNPJ, ICP-Brasil), CSC e credenciamento na SEFAZ do seu estado |

**Em resumo:** dá para exercitar o sistema inteiro de ponta a ponta sem gastar
nada, exceto **Uber Eats** e **emissão fiscal real**.

---

## Onde cada credencial mora

Isto costuma surpreender, então vem antes das fases.

**Só existem 10 variáveis de ambiente, e apenas 3 são obrigatórias**
(`apps/api/src/config.ts`). Credenciais de pagamento, marketplace e fiscal
**não são variáveis de ambiente** — elas são **por estabelecimento** e ficam em
tabelas do banco:

| O que | Onde | Quem lê |
|---|---|---|
| Supabase (URL e chaves) | variáveis de ambiente | a aplicação |
| Gateways de pagamento | tabela `payment_settings` | só `service_role` |
| iFood / Uber Eats | tabela `integration_credentials` | só `service_role` |
| Fiscal (CSC, certificado, integrador) | tabela `fiscal_settings` | só `service_role` |

As três tabelas têm RLS habilitada e **nenhuma policy**, de propósito: nem o
navegador nem um funcionário autenticado conseguem lê-las. Só o backend, com a
chave `service_role`, alcança esses valores.

---

## Fase 0 — Rodar sem conta nenhuma

Valida schema, RLS e regras de negócio sem criar conta em lugar algum.

```bash
npm install
npm run build:shared
npm run db:test     # sobe um PostgreSQL descartável, aplica as 34 migrations e roda as asserções
npm run test        # testes da API
```

Se isso passa, o banco e as regras estão íntegros. O que **não** é validado
aqui: qualquer coisa que dependa de rede — Storage, OAuth, gateways, SEFAZ.

---

## Fase 1 — Supabase

**Destrava:** todo o resto. Sem isto, nada mais é testável.

1. Crie um projeto em [supabase.com](https://supabase.com) (plano gratuito).
2. Aplique as migrations, em ordem numérica:

   ```bash
   supabase link --project-ref <seu-ref>
   supabase db push
   ```

   Sem a CLI: cole o conteúdo de cada arquivo de `supabase/migrations/` no SQL
   Editor, **na ordem do nome do arquivo**. A ordem importa — as migrations são
   append-only e dependem umas das outras.

3. Copie as chaves de *Settings → API* para os arquivos de ambiente:

   ```bash
   cp apps/api/.env.example apps/api/.env
   cp apps/web/.env.example apps/web/.env.local
   ```

   | Variável | Onde achar |
   |---|---|
   | `SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_URL` | Project URL |
   | `SUPABASE_ANON_KEY` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` | chave `anon` / publishable |
   | `SUPABASE_SERVICE_ROLE_KEY` | chave `service_role` — **nunca** no frontend |

### Storage

O bucket `tenant-media` **é criado pela própria migration** `20260818000033_media.sql`
quando ela roda em um ambiente Supabase — não é passo manual. Confira em
*Storage* que ele existe, é público, tem limite de 5 MB e aceita apenas
`image/png`, `image/jpeg`, `image/webp`, `image/avif` e `image/gif`.

Se o bucket não apareceu, a migration rodou num PostgreSQL sem o schema
`storage` e pulou esse bloco — é o comportamento esperado localmente.

### Verificação

```sql
select count(*) from public.tenants;              -- deve responder sem erro
select public.resolve_branding('qualquer-slug');  -- deve devolver null, não erro
```

---

## Fase 2 — Login social (OAuth)

**Destrava:** entrar no painel e no cardápio.

O frontend oferece quatro provedores (`apps/web/src/app/login/social-login-buttons.tsx`):
Google, Facebook, Outlook (Azure) e GitHub. **Você não precisa dos quatro** —
comece pelo Google.

Para cada um:

1. Crie um app OAuth no console do provedor (Google Cloud Console, Meta for
   Developers, Azure AD → App Registrations, GitHub → Developer Settings).
2. Registre lá o *redirect URI* do Supabase: `{SUPABASE_URL}/auth/v1/callback`.
3. No painel do Supabase, *Authentication → Providers*, habilite o provedor e
   cole Client ID e Secret.
4. Em *Authentication → URL Configuration*, adicione `{sua-origem}/auth/callback`
   às **Redirect URLs** — uma entrada para desenvolvimento
   (`http://localhost:3000/auth/callback`) e outra para produção.

Essas chaves vivem **só no painel do Supabase** — não há variável de ambiente
para elas.

---

## Fase 3 — Publicar

**Destrava:** webhooks. Mercado Pago, Stripe, Asaas e Uber Eats precisam
alcançar sua API pela internet — `localhost` não serve.

- **Frontend:** Vercel (Hobby, gratuito). Configure `NEXT_PUBLIC_SUPABASE_URL`,
  `NEXT_PUBLIC_SUPABASE_ANON_KEY` e `NEXT_PUBLIC_API_URL`.
- **API:** qualquer host Node (Railway, Render, Fly). Precisa das três variáveis
  obrigatórias e de `CORS_ORIGINS` apontando para o domínio do frontend.

Para testar webhooks sem publicar, um túnel (`ngrok http 3333`, `cloudflared`)
resolve — a URL do túnel é o que você cadastra no painel do parceiro.

---

## Fase 4 — Pagamentos

**Destrava:** pagamento on-line e PIX. Os três têm sandbox gratuito.

As credenciais vão na tabela `payment_settings`, **uma linha por
estabelecimento**:

```sql
insert into public.payment_settings (
  tenant_id, default_provider, allow_on_delivery,
  mercadopago_access_token, mercadopago_webhook_secret,
  stripe_secret_key, stripe_webhook_secret,
  asaas_api_key, asaas_webhook_token
) values (
  '<id-do-estabelecimento>', 'mercadopago', true,
  'TEST-...', '<segredo do webhook>',
  'sk_test_...', 'whsec_...',
  '<api key sandbox>', '<token que você inventar>'
)
on conflict (tenant_id) do update set
  mercadopago_access_token = excluded.mercadopago_access_token;
```

Preencha só os provedores que for usar — `tenant_payment_options` mostra ao
checkout quais estão configurados, sem vazar segredo.

### URL de webhook

Cadastre no painel de cada gateway:

```
https://<sua-api>/api/v1/webhooks/mercadopago
https://<sua-api>/api/v1/webhooks/stripe
https://<sua-api>/api/v1/webhooks/asaas
```

### Diferenças que importam na hora de homologar

| Provedor | Como o webhook é autenticado |
|---|---|
| **Mercado Pago** | HMAC-SHA256 no header `x-signature` (`ts=...,v1=...`), com janela de 300s |
| **Stripe** | HMAC-SHA256 no header `stripe-signature` (`t=...,v1=...`), com janela de 300s |
| **Asaas** | **não assina** — token fixo no header `asaas-access-token` |

O Asaas ser diferente não é descuido: [a API dele não oferece assinatura de
webhook](https://docs.asaas.com/docs/testando-no-sandbox). Trate o token como
segredo e prefira uma URL difícil de adivinhar.

Onde criar as contas de teste:
- [Mercado Pago — credenciais de teste](https://www.mercadopago.com.br/developers/pt/docs/checkout-api/additional-content/your-integrations/test/accounts)
- [Stripe — modo teste](https://docs.stripe.com/test-mode)
- [Asaas — Sandbox](https://docs.asaas.com/docs/testando-no-sandbox) (o Banco
  Central publica chaves PIX fictícias para testar transferências)

---

## Fase 5 — Marketplaces

### iFood — gratuito, com loja de teste imediata

Ao se cadastrar no [portal do desenvolvedor](https://developer.ifood.com.br/pt-BR/docs/getting-started/first-steps/request-access),
você **já recebe automaticamente uma loja de teste e um app de teste**. As
credenciais ficam em *Meus apps*. A API é gratuita.

A homologação final — necessária para operar com lojas reais — exige **CNPJ com
CNAE de tecnologia**, aplicativo completo e uma reunião com o time de integração
do iFood.

Cadastre a integração e as credenciais:

```sql
insert into public.integrations (tenant_id, channel, status, external_store_id, store_name, is_receiving)
values ('<tenant>', 'ifood', 'connected', '<merchantId da loja de teste>', 'Loja de teste', true)
returning id;

insert into public.integration_credentials (integration_id, client_id, client_secret)
values ('<id acima>', '<clientId>', '<clientSecret>');
```

> **O iFood é polling, não webhook.** Ele não chama sua API — é a sua aplicação
> que precisa perguntar por eventos novos a cada ~30 segundos. Isso é feito pelo
> **worker** (Fase 7). Sem o worker rodando, nenhum pedido entra.

### Uber Eats — exige aprovação comercial

Não é self-serve. Segundo a [documentação oficial](https://developer.uber.com/docs/eats/guides/sandbox),
antes de desenvolver você precisa de conta de desenvolvedor com aplicação de
sandbox, **NDA e contrato de licenciamento assinados**, e **aprovação do seu
partner manager do Uber Eats**.

Com o acesso liberado, o sandbox usa domínios próprios
(`sandbox-login.uber.com` para token, `test-api.uber.com` para as chamadas), e o
cadastro é o mesmo do iFood, trocando `channel` para `'ubereats'` e preenchendo
também `webhook_secret`.

URL de webhook a cadastrar no painel do Uber:

```
https://<sua-api>/api/v1/webhooks/marketplace/ubereats
```

---

## Fase 6 — Fiscal

Dois níveis, com custos bem diferentes.

### Nível 1 — sandbox do integrador (gratuito)

[PlugNotas](https://atendimento.tecnospeed.com.br/hc/pt-br/articles/23715383551767-Primeiros-Passos-com-o-Plugnotas),
Focus NFe e NFe.io oferecem sandbox sem cartão de crédito, com respostas
simuladas e **sem exigir certificado digital**. Serve para validar o fluxo:
enfileirar, transmitir, tratar rejeição, aplicar backoff, cancelar dentro do
prazo.

### Nível 2 — homologação na SEFAZ (pago)

Aqui não há atalho. Exige:

- **Certificado digital A1** (e-CNPJ, emitido por AC credenciada na ICP-Brasil) —
  arquivo `.pfx`, pago, renovação anual;
- **CSC** (Código de Segurança do Contribuinte), obtido na SEFAZ do seu estado;
- **Credenciamento** do CNPJ para emitir NFC-e naquele estado.

Configuração:

```sql
insert into public.fiscal_settings (
  tenant_id, regime, environment, state_registration, cnae,
  nfce_series, csc_id, csc_token,
  provider, provider_api_key, is_enabled
) values (
  '<tenant>', 'simples_nacional', 'homologation', '<IE>', '<CNAE>',
  1, '<id do CSC>', '<token do CSC>',
  'plugnotas', '<api key do sandbox>', true
);
```

Mantenha `environment = 'homologation'` até a SEFAZ liberar. **Documento emitido
em homologação não tem valor fiscal** — é exatamente o que você quer enquanto
testa.

> O cliente HTTP do emissor (`apps/api/src/modules/fiscal/emitters/http.ts`) é
> genérico e presume o formato REST comum desses integradores. Ao escolher um,
> confira `emitPath`, `cancelPath` e o mapeamento de status contra a
> documentação dele.

---

## Fase 7 — Worker

**Destrava:** pedidos do iFood e emissão fiscal. Sem ele, os dois módulos ficam
parados mesmo com credenciais corretas.

```bash
npm run worker -w @vendas-bot/api
```

Dois laços independentes:

- **Marketplaces** — a cada `MARKETPLACE_POLL_SECONDS` (padrão 30), consulta
  eventos novos de cada integração iFood ativa.
- **Fila fiscal** — a cada `FISCAL_POLL_SECONDS` (padrão 60), pega documentos
  pendentes e transmite ao integrador.

É um **processo separado da API**, de propósito: se o polling vivesse dentro do
servidor HTTP, escalar a API para duas instâncias dobraria as consultas ao
iFood. Em produção, rode **uma única instância** do worker.

---

## Dados de demonstração

Um Supabase recém-provisionado sobe vazio — o cardápio não tem o que mostrar e o
painel não tem o que operar. O seed cria um estabelecimento fictício completo:

```bash
bash scripts/seed.sh                              # PostgreSQL local
# ou cole scripts/sql/seed_demo.sql no SQL Editor do Supabase
```

Rodar duas vezes não duplica nada.

### Vincular sua conta ao estabelecimento de demonstração

O seed **não cria usuários** — isso é do Supabase Auth. Entre uma vez pelo login
social para que sua conta exista e então:

```sql
-- 1. Grave o tenant no claim que a RLS lê:
update auth.users
set raw_app_meta_data = raw_app_meta_data
    || jsonb_build_object('tenant_id', '<id-do-tenant-demo>')
where email = '<seu-email>';

-- 2. Crie o vínculo de funcionário com o papel de dono.
--    public.users guarda só o perfil operacional — o e-mail continua
--    em auth.users, sem cópia.
insert into public.users (id, tenant_id, role_id, name)
select u.id, '<id-do-tenant-demo>', r.id, 'Meu Nome'
from auth.users u, public.roles r
where u.email = '<seu-email>'
  and r.key = 'owner' and r.tenant_id is null;
```

**Saia e entre de novo** depois do passo 1 — o `tenant_id` viaja no JWT, e o
token antigo não o tem.

---

## Entrega contínua

`.github/workflows/deploy.yml` roda a cada push na `main`, nesta ordem:

```
verificar  →  migrar  →  publicar
(CI: banco,    (supabase    (vercel
 testes,        db push)     deploy --prod)
 build)
```

Três decisões embutidas no pipeline:

- **Nada é publicado sem passar na verificação.** O job `verificar` reutiliza o
  `ci.yml` inteiro via `workflow_call` — reutilizar em vez de copiar impede que
  as duas definições divirjam com o tempo.
- **Migration antes do deploy.** O frontend novo pode depender de coluna nova;
  publicar primeiro deixaria a aplicação quebrada na janela entre as etapas.
- **`cancel-in-progress: false`.** Abortar um `supabase db push` pela metade
  deixa o schema num estado que ninguém escreveu. Esperar a entrega anterior
  terminar é sempre melhor.

Reexecutar um commit já entregue é inócuo: as migrations são append-only e o
`db push` aplica só o que ainda não está registrado.

### Segredos a cadastrar

Em *Settings → Secrets and variables → Actions*:

| Segredo | Onde obter |
|---|---|
| `SUPABASE_ACCESS_TOKEN` | Supabase → Account → Access Tokens |
| `SUPABASE_PROJECT_REF` | o ref do projeto (aparece na URL do painel) |
| `SUPABASE_DB_PASSWORD` | senha do banco, definida na criação do projeto |
| `VERCEL_TOKEN` | Vercel → Settings → Tokens |
| `VERCEL_ORG_ID` | `.vercel/project.json`, após rodar `vercel link` |
| `VERCEL_PROJECT_ID` | idem |

Faltando qualquer um, o job para com a mensagem dizendo **qual** falta — não
com um erro críptico da CLI.

### Configuração do projeto na Vercel

O repositório é um monorepo com npm workspaces, e `apps/web` depende de
`packages/shared`. Se a *Root Directory* apontar para `apps/web`, o build não
resolve `@vendas-bot/shared`. Configure assim:

| Campo | Valor |
|---|---|
| Root Directory | **raiz do repositório** (deixe vazio) |
| Build Command | `npm run build -w @vendas-bot/web` |
| Output Directory | `apps/web/.next` |
| Install Command | `npm ci` |

O `build` de cada app já constrói o `packages/shared` antes, via `prebuild` —
não é preciso encadear os dois comandos à mão, e o build funciona igual se a
plataforma resolver usar o comando que ela mesma detectou.

E as variáveis de ambiente do projeto na Vercel: `NEXT_PUBLIC_SUPABASE_URL`,
`NEXT_PUBLIC_SUPABASE_ANON_KEY` e `NEXT_PUBLIC_API_URL`.

### Host da API e do worker

A API e o worker precisam de um host Node — nem a Vercel nem o Supabase servem:
a Vercel é serverless (o laço do worker não sobrevive entre requisições, e o
rate limit em memória vira decorativo) e as Edge Functions do Supabase são
Deno, não Node.

No Railway, são **dois serviços apontando para o mesmo repositório**, ambos
escolhendo o pacote `api` na detecção:

| | `api` | `worker` |
|---|---|---|
| Start | `npm run start -w @vendas-bot/api` | `npm run start:worker -w @vendas-bot/api` |
| Domínio público | sim | **não** |

O worker não aparece na detecção automática porque não é um pacote npm
separado — é um segundo entrypoint dentro do `@vendas-bot/api`. Crie o serviço
à mão e troque só o comando de start.

**Watch Paths** nos dois, para um push no frontend não redeployar o backend:

```
apps/api/**
packages/shared/**
package.json
package-lock.json
tsconfig.base.json
```

Rode **uma única instância** do worker: duas consultariam o iFood em dobro.

**Node 22 é obrigatório, não preferência.** O `@supabase/supabase-js` monta um
cliente de realtime no `createClient`, e esse cliente exige `WebSocket` global —
que só existe nativamente a partir do Node 22. No Node 20 a API nem sobe: morre
no boot com `Error: Node.js detected but native WebSocket not found`. O
`engines.node` da raiz e o `.nvmrc` fixam a versão para os hosts que leem um ou
outro; se o seu host ignorar ambos, defina a versão no painel dele.

### O que o pipeline NÃO faz

- **Não publica a API.** Só o frontend vai para a Vercel; o backend Fastify e o
  worker precisam de um host Node (Railway, Render, Fly) com deploy próprio.
- **Não roda o seed.** Dados de demonstração são uma decisão manual, não algo
  que se reaplica a cada push.
- **Não faz rollback.** Se uma migration falhar no meio, o deploy não acontece
  (o job `publicar` depende do `migrar`), mas o schema fica no estado parcial em
  que a migration parou. Migrations pequenas e reversíveis continuam sendo
  responsabilidade de quem as escreve.

---

## Checklist

| Módulo | Verificado quando |
|---|---|
| Cardápio | `/[slug]` abre com produtos, cores e logo do estabelecimento |
| Carrinho e checkout | pedido criado com o total recalculado pelo servidor |
| Entrega | taxa muda conforme o endereço (distância, bairro ou fixa) |
| Rastreamento | status muda na tela do cliente sem recarregar |
| Salão e comandas | mesa muda de estado e a comanda soma corretamente |
| KDS | pedido novo aparece na fila de preparo |
| Estoque | venda de um produto com ficha técnica baixa os insumos |
| Caixa | abertura, sangria e fechamento conferem |
| Pagamento | webhook do sandbox marca o pedido como pago |
| Mídias | upload aparece na biblioteca e no cardápio |
| Identidade visual | cor salva no painel aparece no cardápio **sem piscar** a cor padrão |
| iFood | com o worker rodando, pedido da loja de teste entra e aparece no KDS |
| Fiscal | documento sai de `queued` e chega a `authorized` no sandbox |

---

## Endurecer antes de produção

Além dos pontos já listados no [README](../README.md#pontos-a-endurecer-antes-de-produção):

- **O plano gratuito do Supabase pausa após 7 dias sem requisição.** Serve para
  homologar, não para atender clientes.
- **Uma única instância do worker.** Duas instâncias consultam o iFood em
  dobro. A fila fiscal é segura (usa `skip locked`), mas o polling não tem essa
  proteção.
- **Rotacione as chaves** usadas em teste antes de ir a produção — especialmente
  a `service_role`, que ignora RLS.
