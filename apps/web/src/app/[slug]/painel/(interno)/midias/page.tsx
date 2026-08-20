import { MediaLibrary } from '@/components/painel/media-library'

export const metadata = { title: 'Mídias' }

export default function MidiasPage() {
  return (
    <main>
      <h1 className="mb-2 text-2xl font-bold tracking-tight">Mídias</h1>
      <p className="mb-6 text-sm text-muted-foreground">
        As imagens do seu estabelecimento: logo, capa, fotos dos pratos. O arquivo vai direto para
        o armazenamento, dentro de uma pasta que é só sua.
      </p>
      <MediaLibrary />
    </main>
  )
}
