// Ambiente determinístico para os testes: segredo simétrico evita chamadas
// de rede ao JWKS do Supabase durante a verificação de JWT.
process.env.NODE_ENV = 'test'
process.env.LOG_LEVEL = 'silent'
process.env.SUPABASE_URL = 'https://test.supabase.co'
process.env.SUPABASE_ANON_KEY = 'test-anon-key'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key'
process.env.SUPABASE_JWT_SECRET = 'segredo-de-teste-com-pelo-menos-32-bytes!!'
process.env.CORS_ORIGINS = 'http://localhost:3000,https://app.exemplo.com'
