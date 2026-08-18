import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // packages/shared é consumido direto do fonte TypeScript (workspace).
  transpilePackages: ['@vendas-bot/shared'],
}

export default nextConfig
