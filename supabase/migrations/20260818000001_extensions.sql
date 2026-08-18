-- =============================================================================
-- Migration: Extensões do banco
-- PBI 1 (issue #2) — Database Core & B2C
-- =============================================================================

-- PostGIS: geolocalização (taxa de entrega por distância, rotas de retirada).
-- No Supabase, extensões vivem no schema "extensions".
create extension if not exists postgis with schema extensions;

-- pg_trgm: busca fuzzy de produtos no cardápio (índices GIN trigram).
create extension if not exists pg_trgm with schema extensions;

-- citext: texto case-insensitive (slug do tenant, e-mails).
create extension if not exists citext with schema extensions;
