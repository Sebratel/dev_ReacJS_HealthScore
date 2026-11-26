// Cliente HTTP central da API. Anexa o Bearer e, em 401, RENOVA o token
// silenciosamente e repete a chamada 1x. Só desloga se a sessão Google morreu
// de verdade (aí o RequireAuth manda pro /login). Todos os helpers de API usam.
//
// Sessão aberta pelo Hub Apps: o Bearer é o da sessão do Hub (sessionStorage do
// quadro) e não há renovação pelo Google — 401 é fim de sessão, e a tela de
// login manda abrir o Hub de novo. 403 { code: 'HUB_ONLY' } (o servidor só
// aceita entrada pelo Hub) também é fim de sessão, para qualquer um.
import { useAuthStore } from '@/store/authStore'
import { refreshGoogleToken } from '@/store/googleAuth'
import { hubSessionToken, isHubOnly, markHubOnlyRefused } from '@/store/hubSession'

export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

/** Bearer da próxima requisição: a sessão do Hub, se houver; senão a do Google. */
export function currentBearer(): string | null {
  const hub = hubSessionToken()
  if (hub) return hub
  const st = useAuthStore.getState()
  return st.via === 'hub' ? null : st.accessToken
}

function withAuth(init: RequestInit | undefined, token: string | null): RequestInit {
  return { ...init, headers: { ...(init?.headers || {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) } }
}

/**
 * 403 HUB_ONLY → encerra a sessão (de qualquer origem) e devolve a mensagem do
 * servidor; senão null. Lê um clone: o corpo original fica para quem chamou.
 */
export async function hubOnlyRefusal(res: Response): Promise<string | null> {
  if (res.status !== 403) return null
  const body = (await res.clone().json().catch(() => null)) as { code?: string; error?: string } | null
  if (body?.code !== 'HUB_ONLY') return null
  markHubOnlyRefused()
  useAuthStore.getState().logout()
  return body.error || 'Acesse o Health Score pelo Hub Apps.'
}

async function send(path: string, init: RequestInit | undefined, token: string | null): Promise<Response> {
  try {
    return await fetch(path, withAuth(init, token))
  } catch {
    throw new ApiError(0, 'Não foi possível falar com o servidor (backend offline?).')
  }
}

export async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  let res = await send(path, init, currentBearer())
  let recusa = await hubOnlyRefusal(res)
  if (recusa) throw new ApiError(403, recusa)
  if (res.status !== 401) return res

  // 401 → tenta renovar o token do Google silenciosamente e repetir uma vez.
  // Nunca na sessão do Hub, nem com "só pelo Hub": lá o Google não vale.
  const viaHub = useAuthStore.getState().via === 'hub' || !!hubSessionToken()
  if (!viaHub && !isHubOnly()) {
    let newToken: string | null = null
    try { newToken = await refreshGoogleToken() } catch { /* sessão Google indisponível */ }
    if (newToken) {
      res = await send(path, init, newToken)
      recusa = await hubOnlyRefusal(res)
      if (recusa) throw new ApiError(403, recusa)
      if (res.status !== 401) return res
    }
  }

  // Continua 401 → sessão realmente expirou; limpa e sinaliza.
  useAuthStore.getState().logout()
  throw new ApiError(401, viaHub ? 'Sessão do Hub Apps encerrada. Abra o Health Score de novo pelo Hub.' : 'Sessão expirada. Entre novamente.')
}
