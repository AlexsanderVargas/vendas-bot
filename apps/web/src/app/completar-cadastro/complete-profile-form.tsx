'use client'

import { useActionState } from 'react'
import { useFormStatus } from 'react-dom'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { completeProfile, type CompleteProfileState } from './actions'

function SubmitButton() {
  const { pending } = useFormStatus()
  return (
    <Button type="submit" disabled={pending} className="w-full">
      {pending ? 'Salvando…' : 'Concluir cadastro'}
    </Button>
  )
}

export function CompleteProfileForm({
  tenant,
  next,
  defaultName,
}: {
  tenant: string
  next: string
  defaultName: string
}) {
  const [state, formAction] = useActionState<CompleteProfileState, FormData>(completeProfile, {
    error: null,
  })

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <input type="hidden" name="tenant" value={tenant} />
      <input type="hidden" name="next" value={next} />

      <label className="flex flex-col gap-1.5 text-sm font-medium">
        Nome
        <Input name="name" defaultValue={defaultName} placeholder="Como devemos te chamar" />
      </label>

      <label className="flex flex-col gap-1.5 text-sm font-medium">
        WhatsApp
        <Input
          name="whatsapp"
          type="tel"
          inputMode="tel"
          required
          placeholder="(51) 99999-0001"
          aria-describedby={state.error ? 'whatsapp-erro' : undefined}
        />
      </label>

      {state.error ? (
        <p id="whatsapp-erro" role="alert" className="text-sm text-destructive">
          {state.error}
        </p>
      ) : null}

      <SubmitButton />
    </form>
  )
}
