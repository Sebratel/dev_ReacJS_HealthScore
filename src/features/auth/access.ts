// Papel do usuário no front — só para UX (mostrar/esconder controles). A
// autoridade real é o backend, que revalida o papel em cada request de escrita.
import { useAuthStore, hasRole, type Role } from '@/store/authStore'
import { parseScopes, scopeCanEdit, type SectorKey } from '@/features/auth/sectors'
import { currentBearer, hubOnlyRefusal } from '@/lib/apiClient'

// GET/PUT autenticados "QUIETOS": enviam o token atual e, em falha (ex.: token
// expirado), NÃO disparam o refresh silencioso do Google (prompt=none, que o
// navegador bloqueia) nem deslogam. Usados no boot (papel + config oficial),
// que não devem sequestrar o fluxo de autenticação. As chamadas de dados
// continuam no apiClient normal (com refresh/logout).
// Exceção: 403 HUB_ONLY é definitivo (o servidor só aceita entrada pelo Hub) e
// encerra a sessão aqui também.
export async function quietAuthedGet(path: string): Promise<Response | null> {
  const token = currentBearer()
  if (!token) return null
  try {
    const res = await fetch(path, { headers: { Authorization: `Bearer ${token}` } })
    if (await hubOnlyRefusal(res)) return null
    return res
  } catch {
    return null
  }
}

export async function quietAuthedPut(path: string, body: unknown): Promise<void> {
  const token = currentBearer()
  if (!token) return
  try {
    const res = await fetch(path, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    await hubOnlyRefusal(res)
  } catch { /* silencioso — o backend é a autoridade; retenta no próximo save */ }
}

// Busca papel + setores no servidor (GET /api/me) e grava no store. Silencioso:
// em falha, o papel fica null e a UI trata como viewer (esconde tudo restrito).
export async function fetchMe(): Promise<void> {
  const res = await quietAuthedGet('/api/me')
  if (!res || !res.ok) return
  const data = await res.json().catch(() => null)
  if (!data?.role) return
  useAuthStore.getState().setRole(data.role as Role)
  // Admin manda em tudo; para os demais vale o que o servidor devolveu.
  useAuthStore.getState().setScopes(data.role === 'admin' ? '*' : parseScopes(data.scopes))
}

// Hook de gating: papel atual, atalhos hierárquicos e escopo por setor.
//   canEditSector(key) → mostra/esconde o que edita indicador daquele setor.
// É só UX: o backend revalida o escopo em toda escrita.
export function useRole() {
  const role = useAuthStore((s) => s.role)
  const scopes = useAuthStore((s) => s.scopes)
  const isPowerUser = hasRole(role, 'power_user')
  return {
    role,
    scopes,
    isPowerUser, // power_user OU admin
    isAdmin: hasRole(role, 'admin'),
    canEditSector: (sector: SectorKey | string) => isPowerUser && scopeCanEdit(scopes, sector),
  }
}
