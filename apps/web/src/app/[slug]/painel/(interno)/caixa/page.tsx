import { CashRegister } from '@/components/painel/cash-register'

export default function CaixaPage() {
  return (
    <main>
      <h1 className="mb-6 text-2xl font-bold tracking-tight">Caixa (PDV)</h1>
      <CashRegister />
    </main>
  )
}
