import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import type { Scopes } from '@/features/auth/sectors'
import { clearHubSession } from './hubSession'

export interface AuthUser {
  name: string
  email: string
  picture?: string
}

// Papéis de acesso (hierárquicos): viewer < power_user < admin.
export type Role = 'viewer' | 'power_user' | 'admin'
const RANK: Record<Role, number> = { viewer: 0, power_user: 1, admin: 2 }

// Por onde a sessão entrou. 'hub' = aberta pelo Hub Apps (Bearer no
// sessionStorage do quadro, ver hubSession.ts); 'google' = login direto.
export type AuthVia = 'google' | 'hub'

interface AuthState {
  user: AuthUser | null
  // access_token do Google — usado como Bearer nas chamadas ao backend (/api).
  // Expira em ~1h; em 401 o usuário é orientado a entrar novamente. Na sessão
  // do Hub fica null: o Bearer é o da sessão do Hub.
  accessToken: string | null
  via: AuthVia | null
  // Papel efetivo, resolvido no servidor (GET /api/me). Null = ainda não sabido.
  role: Role | null
  // Setores que este usuário EDITA: '*' (todos) ou a lista. Não limita o que
  // ele vê — só onde pode mexer. Null = ainda não sabido.
  scopes: Scopes | null
  setUser: (u: AuthUser | null) => void
  setAccessToken: (t: string | null) => void
  setVia: (v: AuthVia | null) => void
  setRole: (r: Role | null) => void
  setScopes: (s: Scopes | null) => void
  logout: () => void
}

const VAZIO = { user: null, accessToken: null, via: null, role: null, scopes: null } as const

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      ...VAZIO,
      setUser: (user) => set({ user }),
      setAccessToken: (accessToken) => set({ accessToken }),
      setVia: (via) => set({ via }),
      setRole: (role) => set({ role }),
      setScopes: (scopes) => set({ scopes }),
      logout: () => { clearHubSession(); set({ ...VAZIO }) },
    }),
    {
      name: 'churniq-auth',
      storage: createJSONStorage(() => localStorage),
      // Sessão do Hub NUNCA vai para o localStorage: ele é compartilhado entre
      // abas, e uma aba solta herdaria o usuário de quem entrou pelo quadro.
      // Ela mora só no sessionStorage do quadro (hubSession.ts).
      partialize: (s) => (s.via === 'hub'
        ? { ...VAZIO }
        : { user: s.user, accessToken: s.accessToken, via: s.via, role: s.role, scopes: s.scopes }),
    },
  ),
)

// ─── Helpers de papel (fonte única) ────────────────────────────
// O papel é apenas para UX (mostrar/esconder); a autoridade real é o backend,
// que revalida em cada request de escrita.
export function hasRole(role: Role | null, min: Role): boolean {
  return role != null && RANK[role] >= RANK[min]
}
