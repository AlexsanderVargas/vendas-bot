import { AccountsManager } from '@/components/painel/accounts-manager'

export default function FinanceiroPage() {
  return (
    <main>
      <h1 className="mb-6 text-2xl font-bold tracking-tight">Contas a pagar e receber</h1>
      <AccountsManager />
    </main>
  )
}
