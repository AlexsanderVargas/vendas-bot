'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { apiFetch, ApiError } from '@/lib/api'

/**
 * Avaliação pós-entrega. Só aparece quando o pedido já foi concluído e ainda
 * não tem avaliação — o servidor revalida as duas condições.
 */
export function ReviewPrompt({ orderId }: { orderId: string }) {
  const [rating, setRating] = useState(0)
  const [comment, setComment] = useState('')
  const [done, setDone] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sending, setSending] = useState(false)

  if (done) {
    return (
      <p className="rounded-xl border border-border p-4 text-sm">
        Obrigado pela avaliação!
      </p>
    )
  }

  async function submit() {
    if (rating === 0) return
    setSending(true)
    setError(null)
    try {
      await apiFetch(`/orders/${orderId}/review`, {
        method: 'POST',
        body: JSON.stringify({ rating, comment: comment.trim() || null }),
      })
      setDone(true)
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Não foi possível enviar a avaliação.')
      setSending(false)
    }
  }

  return (
    <section className="rounded-xl border border-border p-4">
      <h3 className="mb-3 font-semibold">Como foi seu pedido?</h3>
      <div className="mb-3 flex gap-1" role="radiogroup" aria-label="Nota de 1 a 5 estrelas">
        {[1, 2, 3, 4, 5].map((value) => (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={rating === value}
            aria-label={`${value} ${value === 1 ? 'estrela' : 'estrelas'}`}
            onClick={() => setRating(value)}
            className={`text-2xl leading-none transition-opacity ${
              value <= rating ? 'opacity-100' : 'opacity-30'
            }`}
          >
            ★
          </button>
        ))}
      </div>
      <Input
        value={comment}
        onChange={(event) => setComment(event.target.value)}
        placeholder="Conte o que achou (opcional)"
        maxLength={1000}
        className="mb-3"
      />
      {error ? (
        <p role="alert" className="mb-3 text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <Button onClick={() => void submit()} disabled={rating === 0 || sending}>
        {sending ? 'Enviando…' : 'Enviar avaliação'}
      </Button>
    </section>
  )
}
