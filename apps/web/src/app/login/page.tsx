import { Suspense } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { SocialLoginButtons } from './social-login-buttons'

export default function LoginPage() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-md items-center px-6">
      <Card className="w-full">
        <CardHeader>
          <CardTitle>Entrar</CardTitle>
          <CardDescription>
            Use sua conta social para acompanhar pedidos, salvar endereços e acumular pontos.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Suspense fallback={<p className="text-sm text-muted-foreground">Carregando…</p>}>
            <SocialLoginButtons />
          </Suspense>
          <p className="mt-6 text-center text-sm text-muted-foreground">
            Equipe de um estabelecimento entra pelo painel da própria loja, em{' '}
            <code>/nome-do-estabelecimento/painel</code>.
          </p>
        </CardContent>
      </Card>
    </main>
  )
}
