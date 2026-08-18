# Regras de Engenharia (Críticas e Inegociáveis)

Estas regras valem para todos os contribuidores — humanos e agentes de IA.

## 1. Fluxo de Branches

- Toda nova **feature** nasce em uma branch baseada em `main`, no formato:
  `feat/base/idfeature{N}/descricao` — onde `{N}` é o número da issue de Feature no GitHub.
- Todo **PBI** dessa feature nasce em uma branch baseada na branch de feature, no formato:
  `feat/pbi/idpbi{N}/descricao` — onde `{N}` é o número da issue de PBI no GitHub.
- Fluxo de merge: branch de PBI → branch de feature → `main` (sempre via Pull Request).

## 2. Branches Protegidas

**Nunca** fazer commits diretos em `development`, `staging`, `main` ou `master`.

> Exceção única e já consumida: o commit de bootstrap que criou a `main` neste repositório vazio (aprovado explicitamente pelo mantenedor).

## 3. Scripts de Banco de Dados

- Todo script entregue deve ser **otimizado**: índices adequados (compostos com `tenant_id` na frente), tipos corretos, constraints, políticas RLS eficientes (funções de auth envolvidas em subselect para cache de initplan).
- Migrations versionadas em `supabase/migrations/` com naming timestamped (`YYYYMMDDHHMMSS_descricao.sql`). Nunca editar uma migration já mesclada em `main`; criar uma nova.

## 4. Contratos de Funções (I/O)

- **Sempre respeitar o contrato de saída** das funções existentes (SQL e TypeScript), salvo extrema necessidade justificada e comunicada. O mesmo vale para os **parâmetros de entrada**.
- Mudanças de contrato exigem nova função/versão ou aprovação explícita do mantenedor.

## 5. Gestão de Trabalho (GitHub Issues no lugar de PBIs do Azure)

- **Feature** = issue com label `feature` (épico). **PBI** = issue com label `pbi`, vinculada à Feature como sub-issue.
- Issues de Feature e PBI **não podem ser fechadas por agentes** — apenas pelo mantenedor.
- **Tasks** podem ser criadas por agentes (checklist na issue do PBI ou issues próprias). Ao concluir uma task, informar o **tempo gasto** naquela execução (comentário na issue).

## 6. Multi-tenancy

- Toda tabela de domínio carrega `tenant_id` e tem RLS habilitada.
- O isolamento é garantido no banco (RLS via claim JWT `app_metadata.tenant_id`), nunca apenas na aplicação.
