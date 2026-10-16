/**
 * The vlCVX tab on its own: the same page and components as in Securo, with the data read from static JSON
 * files (written by backend/scripts/vlcvx_export.py) instead of Securo's API. See vite.vlcvx.config.ts.
 */
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import i18n from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import './styles.css'
import { common, nav, vlcvx } from '@/locales/en.json'
import VlcvxPage from '@/pages/vlcvx'

void i18n.use(initReactI18next).init({
  lng: 'en',
  fallbackLng: 'en',
  resources: { en: { translation: { common, nav, vlcvx } } },
  interpolation: { escapeValue: false },
})

const client = new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } } })

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={client}>
        <div className="min-h-screen bg-background text-foreground">
          <main className="max-w-6xl mx-auto px-4 sm:px-6 py-6">
            <VlcvxPage />
          </main>
        </div>
      </QueryClientProvider>
    </I18nextProvider>
  </StrictMode>,
)
