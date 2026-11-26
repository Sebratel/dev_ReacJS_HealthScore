// Entrada pelo Hub Apps. Roda ANTES de o React montar (main.tsx).
//
//   1. Tira o ?sso_token da URL (history.replaceState) antes de qualquer coisa.
//   2. Pergunta ao servidor como entrar (GET /api/auth/config → hubOnly…).
//   3. Se veio token, troca por uma sessão do Health Score (POST /api/auth/hub)
//      e já deixa o usuário logado — sem isso o RequireAuth veria "sem usuário"
//      e mandaria para o login no meio da troca.
//   4. Acerta o que sobrou no store com o modo do servidor: com HUB_ONLY, sessão
//      do Google morre, e fora do quadro do Hub (aba solta) nada vale.
//
// Idempotente: o token é de uso único, e o StrictMode (ou um segundo import)
// não pode disparar uma segunda troca — ela falharia e derrubaria a primeira.
// Falha não lança: vira a mensagem que a tela de login mostra.
import { useAuthStore } from '@/store/authStore'
import {
  HUB_URL_PADRAO, clearHubSession, isFramed, readHubSession, saveHubSession,
  setAuthConfig, setHubLoginError, takeSsoTokenFromUrl,
  type AuthConfig, type HubSession,
} from '@/store/hubSession'

const CONFIG_TIMEOUT_MS = 5000

async function loadAuthConfig(): Promise<AuthConfig | null> {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), CONFIG_TIMEOUT_MS)
  try {
    const r = await fetch('/api/auth/config', { cache: 'no-store', signal: ctrl.signal })
    if (!r.ok) return null
    const c = (await r.json().catch(() => null)) as Partial<AuthConfig> | null
    if (!c) return null
    return {
      hubSso: !!c.hubSso,
      hubOnly: !!c.hubOnly,
      hubUrl: typeof c.hubUrl === 'string' && /^https:\/\//i.test(c.hubUrl) ? c.hubUrl : HUB_URL_PADRAO,
    }
  } catch {
    return null // sem config: o servidor continua sendo a autoridade (403 HUB_ONLY)
  } finally {
    clearTimeout(t)
  }
}

async function exchange(sso: string): Promise<HubSession | null> {
  try {
    const r = await fetch('/api/auth/hub', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: sso }),
    })
    const body = (await r.json().catch(() => ({}))) as {
      token?: string; expiresAt?: string; user?: { email?: string; name?: string }; error?: string
    }
    if (!r.ok || !body.token || !body.expiresAt || !body.user?.email) {
      setHubLoginError(body.error || `Erro ${r.status} ao entrar pelo Hub Apps.`)
      return null
    }
    return {
      token: body.token,
      expiresAt: body.expiresAt,
      user: { email: body.user.email, name: body.user.name || body.user.email },
    }
  } catch {
    setHubLoginError('Não foi possível falar com o servidor do Health Score para entrar pelo Hub Apps.')
    return null
  }
}

function enterAs(s: HubSession): void {
  // Papel e setores vêm depois, do GET /api/me (cadastro do próprio sistema).
  useAuthStore.setState({
    user: { name: s.user.name, email: s.user.email },
    accessToken: null, via: 'hub', role: null, scopes: null,
  })
}

async function run(): Promise<void> {
  const sso = takeSsoTokenFromUrl()
  const framed = isFramed()
  const cfg = await loadAuthConfig()
  setAuthConfig(cfg)
  const store = useAuthStore.getState()

  // Só pelo Hub e fora do quadro (aba solta, link colado): nada vale aqui —
  // nem o token da URL, nem sessão herdada de outra aba.
  if (cfg?.hubOnly && !framed) {
    store.logout()
    return
  }

  if (sso) {
    const s = await exchange(sso)
    if (s) {
      saveHubSession(s)
      enterAs(s)
      setHubLoginError(null)
    } else {
      // Entrada recusada: não deixa sessão anterior de pé por engano.
      store.logout()
    }
    return
  }

  // Recarga dentro do quadro: a sessão do Hub continua no sessionStorage.
  const hub = readHubSession()
  if (hub) { enterAs(hub); return }

  // Sem sessão do Hub, o que sobrou no store é do login direto (Google) — que
  // com HUB_ONLY não vale mais, nem para quem já tinha entrado.
  if (store.via === 'hub' || cfg?.hubOnly) {
    clearHubSession()
    store.logout()
    return
  }
  // Sessão do Google gravada antes de existir o campo `via`.
  if (store.user && !store.via) store.setVia('google')
}

let booting: Promise<void> | null = null

export function bootAuth(): Promise<void> {
  if (!booting) booting = run().catch(() => { /* nunca impede o app de montar */ })
  return booting
}
