-- =============================================================================
-- CPF/CNPJ do cliente — opcional.
--
-- Necessário para dois fluxos distintos que pedem o mesmo dado:
--   1. Asaas: só cobra em nome de um `customer`, e o cadastro exige cpfCnpj;
--   2. NFC-e com CPF na nota, quando o cliente pede.
--
-- Fica OPCIONAL de propósito: exigir documento de todo mundo no checkout
-- adiciona fricção a quem paga por Mercado Pago, Stripe ou na entrega, e
-- custa conversão numa tela em que cada campo pesa.
--
-- Guardado só com dígitos (sem pontuação) para que a comparação seja exata e
-- a busca no provedor não dependa de formatação.
-- =============================================================================

alter table public.customers
  add column if not exists cpf_cnpj text
    constraint customers_document_digits
      check (cpf_cnpj is null or cpf_cnpj ~ '^[0-9]{11}$' or cpf_cnpj ~ '^[0-9]{14}$');

comment on column public.customers.cpf_cnpj is
  'CPF (11) ou CNPJ (14), somente dígitos. Opcional: exigido apenas por Asaas e por nota fiscal com documento.';

-- O cliente edita o próprio cadastro pelo PostgREST; o grant é por coluna, e
-- sem incluir a nova o update viria negado mesmo com a policy permitindo.
grant update (name, whatsapp, cpf_cnpj) on table public.customers to authenticated;

-- Sem índice: o documento é lido a partir do cliente já identificado
-- (customers.id), nunca como critério de busca. Índice aqui seria custo de
-- escrita sem leitura que o justifique.
