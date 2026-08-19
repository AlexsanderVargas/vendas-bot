-- =============================================================================
-- Credencial própria da equipe (issue #72)
--
-- Garçom, cozinheiro e caixa normalmente não têm e-mail corporativo — e às
-- vezes não têm e-mail nenhum. Exigir um por funcionário inviabiliza o
-- cadastro no mundo real, então o vínculo passa a aceitar um NOME DE USUÁRIO,
-- único dentro do estabelecimento.
--
-- O endereço técnico que o Supabase Auth exige é derivado do usuário e do slug
-- (`caixa1` + `lancheria-demo`), de forma determinística: o navegador monta o
-- mesmo endereço na hora de entrar, então não existe endpoint de "resolver
-- usuário" para alguém enumerar a equipe do estabelecimento.
--
-- `must_change_password` existe porque a senha inicial é gerada pelo sistema e
-- passa pela mão do gerente: enquanto não for trocada, o painel só abre a tela
-- de troca. A coluna NÃO entra nos grants de `authenticated` (migration 38) —
-- quem baixa a própria bandeira não pode ser quem a levanta.
-- =============================================================================

alter table public.users
  add column if not exists login text
    constraint users_login_format
      check (login is null or login ~ '^[a-z][a-z0-9._-]{2,29}$'),
  add column if not exists must_change_password boolean not null default false;

-- Único por estabelecimento, não global: 'caixa1' pode existir em cada loja.
create unique index if not exists users_login_tenant_idx
  on public.users (tenant_id, login)
  where login is not null;

comment on column public.users.login is
  'Nome de usuário da equipe, único no estabelecimento. Nulo para quem entra por e-mail.';
comment on column public.users.must_change_password is
  'Senha ainda é a temporária gerada pelo sistema; o painel só abre a troca.';
