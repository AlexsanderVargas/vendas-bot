import type { InputHTMLAttributes } from 'react'
import { cn } from '@/lib/utils'

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn(
        'flex h-10 w-full rounded-lg border border-border bg-transparent px-3 py-2 text-sm',
        'placeholder:text-muted-foreground focus-visible:outline-2 focus-visible:outline-offset-2',
        'focus-visible:outline-brand-600 disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    />
  )
}
