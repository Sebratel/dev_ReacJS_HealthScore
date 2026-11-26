import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { RouterProvider } from 'react-router-dom'
import { createAppRouter } from './router'
import { bootAuth } from './features/auth/hubEntry'
import { applyInitialTheme } from './utils/theme'
import './styles/globals.css'

applyInitialTheme()

// Aberto pelo Hub Apps (?sso_token): entra ANTES de montar, para o RequireAuth
// ja encontrar o usuario. O roteador nasce DEPOIS, com a URL sem o token. A
// troca fica fora do React: o StrictMode nao consegue dispara-la duas vezes.
void bootAuth().finally(() => {
  const router = createAppRouter()
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <RouterProvider router={router} />
    </StrictMode>,
  )
})
