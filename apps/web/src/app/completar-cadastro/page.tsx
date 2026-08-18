import { redirect } from 'next/navigation'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { createClient } from '@/lib/supabase/server'
import { CompleteProfileForm } from './complete-profile-form'

export default async function CompletarCadastroPage({
  searchParams,
}: {
  searchParams: Promise<{ tenant?: string; next?: string }>
}) {
  const { tenant = '', next = '/' } = await searchParams

  const supabase = await createClient()
  const { data } = await supabase.auth.getUser()
  if (!data.user) {
    redirect(`/login?next=${encodeURIComponent(next)}${tenant ? `&tenant=${tenant}` : ''}`)
  }

  return (
    <main className="mx-auto flex min-h-dvh max-w-md items-center px-6">
      <Card className="w-full">
        <CardHeader>
          <CardTitle>Falta só o WhatsApp</CardTitle>
          <CardDescription>
            Usamos seu número para avisar sobre o andamento do pedido. É o único dado que pedimos.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <CompleteProfileForm
            tenant={tenant}
            next={next}
            defaultName={(data.user.user_metadata.full_name as string | undefined) ?? ''}
          />
        </CardContent>
      </Card>
    </main>
  )
}
