import Link from 'next/link'
import { buttonVariants } from '@/components/ui/button'

export default function HomePage() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-2xl flex-col items-center justify-center gap-6 px-6 text-center">
      <h1 className="text-4xl font-bold tracking-tight">GastroSync</h1>
      <p className="text-muted-foreground">
        Plataforma de cardápio digital e delivery para o setor gastronômico.
        O cardápio de cada estabelecimento fica em <code>/nome-do-restaurante</code>, e o
        painel da equipe em <code>/nome-do-restaurante/painel</code>.
      </p>
      <Link href="/login" className={buttonVariants({ size: 'lg' })}>
        Entrar
      </Link>
    </main>
  )
}
