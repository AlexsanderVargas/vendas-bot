import { createClient } from '@/lib/supabase/server'
import { RecipeManager } from '@/components/painel/recipe-manager'

export default async function FichasPage() {
  const supabase = await createClient()

  // A RLS já limita ao tenant do funcionário.
  const [{ data: products }, { data: ingredients }] = await Promise.all([
    supabase.from('products').select('id, name').eq('is_active', true).order('name'),
    supabase.from('ingredients').select('id, name, base_unit').eq('is_active', true).order('name'),
  ])

  return (
    <main>
      <h1 className="mb-6 text-2xl font-bold tracking-tight">Ficha técnica e CMV</h1>
      {!products || products.length === 0 ? (
        <p className="text-sm text-muted-foreground">Cadastre produtos antes de montar fichas técnicas.</p>
      ) : (
        <RecipeManager
          products={products.map((product) => ({ id: product.id, name: product.name }))}
          ingredients={(ingredients ?? []).map((ingredient) => ({
            id: ingredient.id,
            name: ingredient.name,
            baseUnit: ingredient.base_unit,
          }))}
        />
      )}
    </main>
  )
}
