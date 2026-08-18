'use client'

import { useMemo, useState } from 'react'
import type { MenuCategory, MenuProduct } from '@vendas-bot/shared'
import { formatBRL } from '@vendas-bot/shared'
import { cn } from '@/lib/utils'
import { ProductDialog } from './product-dialog'
import { CartDrawer } from '@/components/cart/cart-drawer'

export function MenuBrowser({
  sections,
  tenantSlug,
}: {
  sections: MenuCategory[]
  tenantSlug: string
}) {
  const [selected, setSelected] = useState<MenuProduct | null>(null)

  // Mapa produto -> categoria: alimenta as regras de upsell por categoria.
  const categoryIdsByProduct = useMemo(() => {
    const map: Record<string, string> = {}
    for (const section of sections) {
      for (const product of section.products) map[product.id] = section.id
    }
    return map
  }, [sections])

  return (
    <>
      <nav aria-label="Categorias" className="sticky top-0 z-10 -mx-4 overflow-x-auto bg-background/95 px-4 py-3 backdrop-blur">
        <ul className="flex gap-2">
          {sections.map((section) => (
            <li key={section.id}>
              <a
                href={`#secao-${section.id}`}
                className="inline-block whitespace-nowrap rounded-full border border-border px-4 py-1.5 text-sm hover:bg-muted"
              >
                {section.name}
              </a>
            </li>
          ))}
        </ul>
      </nav>

      {sections.map((section) => (
        <section key={section.id} id={`secao-${section.id}`} className="scroll-mt-16 py-6">
          <h2 className="mb-4 text-xl font-semibold">{section.name}</h2>
          {section.description ? (
            <p className="mb-4 text-sm text-muted-foreground">{section.description}</p>
          ) : null}
          <ul className="flex flex-col gap-3">
            {section.products.map((product) => (
              <li key={product.id}>
                <button
                  type="button"
                  onClick={() => setSelected(product)}
                  disabled={!product.isAvailable}
                  className={cn(
                    'flex w-full items-start justify-between gap-4 rounded-xl border border-border p-4 text-left transition-colors',
                    product.isAvailable ? 'hover:bg-muted' : 'cursor-not-allowed opacity-60',
                  )}
                >
                  <span className="flex flex-col gap-1">
                    <span className="font-medium">{product.name}</span>
                    {product.description ? (
                      <span className="text-sm text-muted-foreground">{product.description}</span>
                    ) : null}
                    {!product.isAvailable ? (
                      <span className="text-xs font-medium text-destructive">Esgotado</span>
                    ) : null}
                  </span>
                  <span className="shrink-0 font-semibold">{formatBRL(product.price)}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}

      <CartDrawer tenantSlug={tenantSlug} categoryIdsByProduct={categoryIdsByProduct} />

      {selected ? (
        <ProductDialog
          product={selected}
          tenantSlug={tenantSlug}
          onClose={() => setSelected(null)}
        />
      ) : null}
    </>
  )
}
