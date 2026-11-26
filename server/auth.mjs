// ─────────────────────────────────────────────────────────────────────────
// Autenticação da API. Dois jeitos de chegar com um Bearer:
//
//   • Google (login direto): access_token do Google, conferido no userinfo.
//   • Hub Apps: sessão emitida por POST /api/auth/hub (ver hubSso.mjs).
//
// Com HUB_ONLY ativo, só o segundo vale. A recusa é 403 { code: 'HUB_ONLY' } e
// acontece ANTES de qualquer consulta de papel: não existe e-mail (admin,
// semente de ADMIN_EMAILS ou qualquer outro) que passe por fora do Hub.
//
// O papel efetivo sai sempre de roles.mjs (env + data/roles.json), venha a
// pessoa por onde vier.
// ─────────────────────────────────────────────────────────────────────────
import { Router } from 'express'
import { resolveAccess as resolveAccessPadrao, atLeast } from './roles.mjs'
import {
  HUB_ONLY_MESSAGE, hubOnlyActive, publicAuthConfig,
  verifyHubLaunchToken, issueHubSession, verifyHubSession,
} from './hubSso.mjs'

const ALLOWED_DOMAIN = () => String(process.env.ALLOWED_DOMAIN || 'sebratel.com.br').trim().toLowerCase()

// ─── Google ────────────────────────────────────────────────────
// Cache curto de token→usuário para não consultar o Google a cada request.
const tokenCache = new Map() // token -> { user, exp }
const TOKEN_TTL_MS = 5 * 60 * 1000

export async function getUserFromGoogleToken(token) {
  const cached = tokenCache.get(token)
  if (cached && cached.exp > Date.now()) return cached.user
  let r
  try {
    r = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: `Bearer ${token}` },
    })
  } catch (e) {
    // Falha de REDE: o container não alcançou o googleapis.com (egress/DNS).
    console.warn('[auth] falha de rede ao validar token no Google userinfo:', e.message)
    return null
  }
  if (!r.ok) { console.warn(`[auth] Google userinfo respondeu ${r.status} (token inválido/expirado?)`); return null }
  const p = await r.json().catch(() => ({}))
  if (!p.email || p.email_verified === false) { console.warn('[auth] token sem e-mail verificado'); return null }
  const user = { email: String(p.email).toLowerCase(), name: p.name || p.email }
  tokenCache.set(token, { user, exp: Date.now() + TOKEN_TTL_MS })
  return user
}

// ─── requireAuth ───────────────────────────────────────────────
// Auth + RBAC. minRole: 'viewer' (default) | 'power_user' | 'admin'.
// req.user recebe { email, name, via, role, scopes } — papel efetivo e setores
// que o usuário edita ('*' = todos), resolvidos em roles.mjs. O escopo não barra
// leitura: quem entra vê todas as telas; ele só limita a ESCRITA por setor.
//
// As dependências são injetáveis só para os testes (sem Google, sem arquivo).
export function createRequireAuth({
  resolveGoogleUser = getUserFromGoogleToken,
  resolveAccess = resolveAccessPadrao,
} = {}) {
  return function requireAuth({ minRole = 'viewer' } = {}) {
    return async (req, res, next) => {
      const m = /^Bearer (.+)$/.exec(req.headers.authorization || '')
      if (!m) return res.status(401).json({ error: 'Token de autenticação ausente.' })
      const token = m[1].trim()

      let user = null
      const hub = verifyHubSession(token)
      if (hub) {
        user = { ...hub, via: 'hub' }
      } else if (hubOnlyActive()) {
        // Só pelo Hub: qualquer outro Bearer (Google, sessão antiga, token de
        // lançamento usado como sessão) para aqui — inclusive de admin.
        return res.status(403).json({ error: HUB_ONLY_MESSAGE, code: 'HUB_ONLY' })
      } else {
        try { user = await resolveGoogleUser(token) } catch { user = null }
        if (user) user = { ...user, via: 'google' }
      }
      if (!user) return res.status(401).json({ error: 'Sessão inválida ou expirada. Entre novamente.' })

      const domain = ALLOWED_DOMAIN()
      if (!String(user.email || '').endsWith('@' + domain)) {
        return res.status(403).json({ error: `Acesso restrito a contas @${domain}.` })
      }
      const { role, scopes } = resolveAccess(user.email)
      req.user = { ...user, role, scopes }
      if (!atLeast(role, minRole)) {
        const label = minRole === 'admin' ? 'administrador' : 'power user'
        return res.status(403).json({ error: `Ação restrita a ${label}. Sua conta é "${role}".` })
      }
      next()
    }
  }
}

// ─── Rotas públicas de entrada ─────────────────────────────────
// Montadas em /api: GET /api/auth/config e POST /api/auth/hub.
export function authRoutes() {
  const r = Router()

  // Como a tela de login deve se apresentar. Não revela nada além do que a
  // própria tela mostra: se a entrada pelo Hub existe, se é a única, e o link.
  r.get('/auth/config', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    res.json(publicAuthConfig())
  })

  // Troca o token de 5 min do Hub por uma sessão de 8 h do Health Score.
  r.post('/auth/hub', (req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    const token = typeof req.body?.token === 'string' ? req.body.token.trim() : ''
    if (!token) return res.status(400).json({ error: 'Token do Hub ausente.' })

    const v = verifyHubLaunchToken(token)
    if (!v.ok) {
      if (v.status !== 503) console.warn(`[auth] entrada pelo Hub recusada: ${v.error}`)
      return res.status(v.status).json({ error: v.error })
    }
    const session = issueHubSession({ email: v.email, name: v.name })
    console.log(`[auth] entrada pelo Hub: ${v.email}`)
    res.json({ ...session, user: { email: v.email, name: v.name } })
  })

  return r
}
