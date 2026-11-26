// Sessão aberta pelo Hub Apps (Health Score embutido no Hub).
//
// Fica no sessionStorage, não no localStorage: vale para ESTE quadro do Hub e
// some quando a aba fecha. Abrir o Health Score direto numa aba nova não herda
// a sessão — que é o que o modo "só pelo Hub" precisa. O "Recarregar" do Hub
// emite um token novo, então perder a sessão aqui nunca custa nada.
//
// Este módulo não importa o authStore (o authStore é que importa este).

const KEY = 'healthscore-hub-session'

export interface HubUser { email: string; name: string }
export interface HubSession { token: string; expiresAt: string; user: HubUser }

function storage(): Storage | null {
  try { return window.sessionStorage } catch { return null }
}

/** Sessão do Hub ainda válida, ou null (ausente ou vencida). */
export function readHubSession(): HubSession | null {
  const s = storage()
  if (!s) return null
  try {
    const raw = s.getItem(KEY)
    if (!raw) return null
    const v = JSON.parse(raw) as HubSession
    if (!v?.token || !v.user?.email || !(Date.parse(v.expiresAt) > Date.now())) { s.removeItem(KEY); return null }
    return v
  } catch { return null }
}

/** Bearer da sessão do Hub, ou null. */
export function hubSessionToken(): string | null {
  return readHubSession()?.token ?? null
}

export function saveHubSession(v: HubSession): void {
  try { storage()?.setItem(KEY, JSON.stringify(v)) } catch { /* modo privado: sem sessão persistida */ }
}

export function clearHubSession(): void {
  try { storage()?.removeItem(KEY) } catch { /* nada a limpar */ }
}

/**
 * Tira o ?sso_token da barra de endereço e o devolve. Sai da URL antes de
 * qualquer outra coisa: assim ele não fica no histórico nem vai junto quando
 * alguém copia o link.
 */
export function takeSsoTokenFromUrl(): string | null {
  const url = new URL(window.location.href)
  const t = url.searchParams.get('sso_token')
  if (!url.searchParams.has('sso_token')) return null
  url.searchParams.delete('sso_token')
  window.history.replaceState(window.history.state, '', url.pathname + url.search + url.hash)
  return t || null
}

/** Está dentro de um quadro (o Hub)? Na dúvida (acesso negado ao topo), sim. */
export function isFramed(): boolean {
  try { return window.self !== window.top } catch { return true }
}

// ─── Estado da entrada (lido pela tela de login) ───────────────
export const HUB_URL_PADRAO = 'https://hub-apps.sebratel.net.br'
export interface AuthConfig { hubSso: boolean; hubOnly: boolean; hubUrl: string }

let authConfig: AuthConfig | null = null
let hubOnlyRefused = false
let hubLoginError: string | null = null

export const getAuthConfig = () => authConfig
export function setAuthConfig(c: AuthConfig | null): void { authConfig = c }

/** O servidor respondeu 403 HUB_ONLY: só pelo Hub, mesmo que a config não tenha chegado. */
export function markHubOnlyRefused(): void { hubOnlyRefused = true }
export function isHubOnly(): boolean { return hubOnlyRefused || !!authConfig?.hubOnly }

/** Motivo da última entrada pelo Hub que falhou (token vencido, já usado…). */
export const getHubLoginError = () => hubLoginError
export function setHubLoginError(msg: string | null): void { hubLoginError = msg }
