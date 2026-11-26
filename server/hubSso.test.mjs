// ─────────────────────────────────────────────────────────────────────────
// Entrada pelo Hub Apps e o modo "só pelo Hub" (HUB_ONLY).
//
// O token de lançamento é montado aqui do jeito que o hub-api monta
// (jsonwebtoken, HS256, { sub, email, name, appId, iat, exp }, exp = iat + 300),
// só que com node:crypto, para não depender de lib de JWT no teste.
// ─────────────────────────────────────────────────────────────────────────
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createHmac } from 'node:crypto'
import { once } from 'node:events'
import express from 'express'
import {
  verifyHubLaunchToken, issueHubSession, verifyHubSession, hubOnlyActive, hubOnlyIgnored,
  hubSsoConfigured, publicAuthConfig, __resetHubReplayForTest,
} from './hubSso.mjs'
import { createRequireAuth, authRoutes } from './auth.mjs'

const SECRET = 'segredo-de-teste-do-hub-com-tamanho-razoavel'
const APP_ID = '42'
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
const agora = () => Math.floor(Date.now() / 1000)

function assina({ header = { alg: 'HS256', typ: 'JWT' }, payload, secret = SECRET, algo = 'sha256' }) {
  const data = `${b64(header)}.${b64(payload)}`
  return `${data}.${createHmac(algo, secret).update(data).digest('base64url')}`
}

function lancamento(over = {}) {
  const iat = agora()
  // O Hub manda o appId como número (id da tabela apps).
  return { sub: 'uid-1', email: 'Fulano.Silva@Sebratel.com.br', name: 'Fulano Silva', appId: 42, iat, exp: iat + 300, ...over }
}

const ENV_KEYS = ['HUB_SSO_SECRET', 'HUB_APP_ID', 'HUB_ONLY', 'HUB_URL', 'ALLOWED_DOMAIN']
let envAntes
beforeEach(() => {
  envAntes = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
  process.env.HUB_SSO_SECRET = SECRET
  process.env.HUB_APP_ID = APP_ID
  process.env.HUB_ONLY = 'false'
  delete process.env.HUB_URL
  process.env.ALLOWED_DOMAIN = 'sebratel.com.br'
  __resetHubReplayForTest()
})
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (envAntes[k] === undefined) delete process.env[k]
    else process.env[k] = envAntes[k]
  }
  vi.useRealTimers()
})

describe('conferência do token de lançamento do Hub', () => {
  it('aceita o token válido e normaliza o e-mail em minúsculas', () => {
    const r = verifyHubLaunchToken(assina({ payload: lancamento() }))
    expect(r).toEqual({ ok: true, email: 'fulano.silva@sebratel.com.br', name: 'Fulano Silva' })
  })

  it('recusa segredo errado', () => {
    const r = verifyHubLaunchToken(assina({ payload: lancamento(), secret: 'outro-segredo' }))
    expect(r).toMatchObject({ ok: false, status: 401 })
  })

  it('recusa alg: none (sem assinatura)', () => {
    const t = `${b64({ alg: 'none', typ: 'JWT' })}.${b64(lancamento())}.`
    expect(verifyHubLaunchToken(t)).toMatchObject({ ok: false, status: 401 })
  })

  it('recusa alg: none mesmo com a assinatura HS256 correta (o cabeçalho não escolhe o algoritmo)', () => {
    const header = { alg: 'none', typ: 'JWT' }
    const data = `${b64(header)}.${b64(lancamento())}`
    const sig = createHmac('sha256', SECRET).update(data).digest('base64url')
    expect(verifyHubLaunchToken(`${data}.${sig}`)).toMatchObject({ ok: false, status: 401 })
  })

  it('recusa outro algoritmo (HS512)', () => {
    const t = assina({ header: { alg: 'HS512', typ: 'JWT' }, payload: lancamento(), algo: 'sha512' })
    expect(verifyHubLaunchToken(t)).toMatchObject({ ok: false, status: 401 })
  })

  it('recusa token vencido', () => {
    const iat = agora() - 400
    const r = verifyHubLaunchToken(assina({ payload: lancamento({ iat, exp: iat + 300 }) }))
    expect(r).toMatchObject({ ok: false, status: 401 })
    expect(r.error).toMatch(/venceu/)
  })

  it('recusa iat no futuro (além da folga de 60 s)', () => {
    const iat = agora() + 120
    expect(verifyHubLaunchToken(assina({ payload: lancamento({ iat, exp: iat + 300 }) })))
      .toMatchObject({ ok: false, status: 401 })
  })

  it('aceita iat até 60 s no futuro (relógio do Hub adiantado)', () => {
    const iat = agora() + 30
    expect(verifyHubLaunchToken(assina({ payload: lancamento({ iat, exp: iat + 300 }) })).ok).toBe(true)
  })

  it('recusa validade longa demais (exp - iat > 600)', () => {
    const iat = agora()
    expect(verifyHubLaunchToken(assina({ payload: lancamento({ iat, exp: iat + 3600 }) })))
      .toMatchObject({ ok: false, status: 401 })
  })

  it('recusa token sem iat', () => {
    const p = lancamento(); delete p.iat
    expect(verifyHubLaunchToken(assina({ payload: p }))).toMatchObject({ ok: false, status: 401 })
  })

  it('recusa appId de outro aplicativo', () => {
    const r = verifyHubLaunchToken(assina({ payload: lancamento({ appId: 7 }) }))
    expect(r).toMatchObject({ ok: false, status: 403 })
  })

  it('recusa e-mail de fora do domínio (inclusive sufixo parecido)', () => {
    for (const email of ['alguem@gmail.com', 'alguem@sebratel.com.br.evil.com', 'alguem@xsebratel.com.br', '']) {
      __resetHubReplayForTest()
      const r = verifyHubLaunchToken(assina({ payload: lancamento({ email }) }))
      expect(r, email).toMatchObject({ ok: false, status: 403 })
    }
  })

  it('é de uso único: o segundo uso do mesmo token é recusado', () => {
    const t = assina({ payload: lancamento() })
    expect(verifyHubLaunchToken(t).ok).toBe(true)
    const r = verifyHubLaunchToken(t)
    expect(r).toMatchObject({ ok: false, status: 401 })
    expect(r.error).toMatch(/já foi usado/)
  })

  it('recusa payload adulterado (troca o e-mail e mantém a assinatura)', () => {
    const [h, , s] = assina({ payload: lancamento() }).split('.')
    const adulterado = `${h}.${b64(lancamento({ email: 'chefe@sebratel.com.br' }))}.${s}`
    expect(verifyHubLaunchToken(adulterado)).toMatchObject({ ok: false, status: 401 })
  })

  it('recusa lixo e formatos quebrados', () => {
    for (const t of ['', 'abc', 'a.b', 'a.b.c', '...', `${b64({ alg: 'HS256' })}.@@@.xyz`]) {
      expect(verifyHubLaunchToken(t).ok, t).toBe(false)
    }
  })

  it('sem HUB_APP_ID a entrada pelo Hub fica desligada (503)', () => {
    process.env.HUB_APP_ID = ''
    expect(verifyHubLaunchToken(assina({ payload: lancamento() }))).toMatchObject({ ok: false, status: 503 })
  })
})

describe('sessão do Health Score aberta pelo Hub', () => {
  it('emite e confere a sessão', () => {
    const s = issueHubSession({ email: 'fulano@sebratel.com.br', name: 'Fulano' })
    expect(verifyHubSession(s.token)).toEqual({ email: 'fulano@sebratel.com.br', name: 'Fulano' })
    expect(Date.parse(s.expiresAt) - Date.now()).toBeGreaterThan(7.9 * 3600 * 1000)
  })

  it('o token de lançamento não vale como sessão, e a sessão não vale como lançamento', () => {
    const t = assina({ payload: lancamento() })
    expect(verifyHubSession(t)).toBeNull()
    const s = issueHubSession({ email: 'fulano@sebratel.com.br', name: 'Fulano' })
    expect(verifyHubLaunchToken(s.token).ok).toBe(false)
  })

  it('sessão vencida não vale', () => {
    const s = issueHubSession({ email: 'fulano@sebratel.com.br', name: 'Fulano' })
    vi.useFakeTimers()
    vi.setSystemTime(Date.now() + 8 * 3600 * 1000 + 1000)
    expect(verifyHubSession(s.token)).toBeNull()
  })

  it('trocar o HUB_SSO_SECRET derruba as sessões emitidas', () => {
    const s = issueHubSession({ email: 'fulano@sebratel.com.br', name: 'Fulano' })
    process.env.HUB_SSO_SECRET = 'segredo-novo'
    expect(verifyHubSession(s.token)).toBeNull()
  })

  it('sessão forjada com o segredo cru (sem a derivação) não vale', () => {
    const iat = agora()
    const t = assina({ payload: { iss: 'healthscore', aud: 'healthscore-hub-session', via: 'hub', email: 'x@sebratel.com.br', iat, exp: iat + 3600 } })
    expect(verifyHubSession(t)).toBeNull()
  })
})

describe('HUB_ONLY só vale com a entrada pelo Hub configurada', () => {
  it('ligado com segredo e appId → ativo', () => {
    process.env.HUB_ONLY = 'true'
    expect(hubOnlyActive()).toBe(true)
    expect(hubOnlyIgnored()).toBe(false)
  })

  it('ligado sem segredo → ignorado', () => {
    process.env.HUB_ONLY = 'true'
    process.env.HUB_SSO_SECRET = ''
    expect(hubSsoConfigured()).toBe(false)
    expect(hubOnlyActive()).toBe(false)
    expect(hubOnlyIgnored()).toBe(true)
  })

  it('ligado sem HUB_APP_ID → ignorado (não existe card no Hub ainda)', () => {
    process.env.HUB_ONLY = 'true'
    process.env.HUB_APP_ID = ''
    expect(hubOnlyActive()).toBe(false)
  })

  it('HUB_URL que não é https cai no padrão', () => {
    process.env.HUB_URL = 'javascript:alert(1)'
    expect(publicAuthConfig().hubUrl).toBe('https://hub-apps.sebratel.net.br')
    process.env.HUB_URL = 'https://hub-apps-staging.sebratel.net.br'
    expect(publicAuthConfig().hubUrl).toBe('https://hub-apps-staging.sebratel.net.br')
  })
})

// ─── API de verdade (Express numa porta efêmera) ──────────────
describe('API: requireAuth e rotas de entrada', () => {
  let server
  let base
  let googleChamado
  const ADMIN = 'chefe@sebratel.com.br'

  beforeEach(async () => {
    googleChamado = 0
    const requireAuth = createRequireAuth({
      // "Google" falso: só reconhece este token, e é de um ADMIN.
      resolveGoogleUser: async (t) => {
        googleChamado++
        return t === 'google-token-ok' ? { email: ADMIN, name: 'Chefe' } : null
      },
      resolveAccess: (email) => (email === ADMIN ? { role: 'admin', scopes: '*' } : { role: 'viewer', scopes: '*' }),
    })
    const app = express()
    app.use(express.json())
    app.use('/api', authRoutes())
    app.get('/api/me', requireAuth(), (req, res) => res.json(req.user))
    app.get('/api/admin', requireAuth({ minRole: 'admin' }), (_req, res) => res.json({ ok: true }))
    server = app.listen(0, '127.0.0.1')
    await once(server, 'listening')
    base = `http://127.0.0.1:${server.address().port}`
  })
  afterEach(async () => {
    server.close()
    await once(server, 'close')
  })

  const get = (path, token) => fetch(base + path, { headers: token ? { Authorization: `Bearer ${token}` } : {} })
  const entrar = (token) => fetch(base + '/api/auth/hub', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }),
  })

  it('GET /api/auth/config diz como entrar e não vaza o segredo', async () => {
    process.env.HUB_ONLY = 'true'
    const r = await get('/api/auth/config')
    const txt = await r.text()
    expect(r.status).toBe(200)
    expect(JSON.parse(txt)).toEqual({ hubSso: true, hubOnly: true, hubUrl: 'https://hub-apps.sebratel.net.br' })
    expect(txt).not.toContain(SECRET)
  })

  it('POST /api/auth/hub troca o token por sessão; o segundo uso é recusado', async () => {
    const t = assina({ payload: lancamento() })
    const r1 = await entrar(t)
    expect(r1.status).toBe(200)
    const b1 = await r1.json()
    expect(b1.user).toEqual({ email: 'fulano.silva@sebratel.com.br', name: 'Fulano Silva' })
    expect(typeof b1.token).toBe('string')

    const me = await get('/api/me', b1.token)
    expect(me.status).toBe(200)
    expect(await me.json()).toMatchObject({ email: 'fulano.silva@sebratel.com.br', via: 'hub', role: 'viewer' })

    const r2 = await entrar(t)
    expect(r2.status).toBe(401)
  })

  it('POST /api/auth/hub sem token → 400; sem HUB_APP_ID → 503', async () => {
    expect((await entrar('')).status).toBe(400)
    process.env.HUB_APP_ID = ''
    expect((await entrar(assina({ payload: lancamento() }))).status).toBe(503)
  })

  describe('com HUB_ONLY=true', () => {
    beforeEach(() => { process.env.HUB_ONLY = 'true' })

    it('login pelo Google é recusado com 403 HUB_ONLY — mesmo de admin, e sem consultar o Google', async () => {
      const r = await get('/api/me', 'google-token-ok')
      expect(r.status).toBe(403)
      expect(await r.json()).toMatchObject({ code: 'HUB_ONLY' })
      expect(googleChamado).toBe(0)
      expect((await get('/api/admin', 'google-token-ok')).status).toBe(403)
    })

    it('sessão que não veio do Hub (token qualquer, já emitido antes) é recusada', async () => {
      const r = await get('/api/me', 'ya29.token-google-antigo-do-localStorage')
      expect(r.status).toBe(403)
      expect((await r.json()).code).toBe('HUB_ONLY')
    })

    it('o token de lançamento usado direto como Bearer é recusado', async () => {
      const r = await get('/api/me', assina({ payload: lancamento() }))
      expect(r.status).toBe(403)
    })

    it('sem Bearer → 401', async () => {
      expect((await get('/api/me')).status).toBe(401)
    })

    it('a sessão do Hub entra, e o papel vem do cadastro (admin continua admin)', async () => {
      const t = assina({ payload: lancamento({ email: ADMIN, name: 'Chefe' }) })
      const { token } = await (await entrar(t)).json()
      const me = await (await get('/api/me', token)).json()
      expect(me).toMatchObject({ email: ADMIN, via: 'hub', role: 'admin' })
      expect((await get('/api/admin', token)).status).toBe(200)
    })

    it('o papel continua barrando: viewer vindo do Hub não abre rota de admin', async () => {
      const { token } = await (await entrar(assina({ payload: lancamento() }))).json()
      const r = await get('/api/admin', token)
      expect(r.status).toBe(403)
      expect((await r.json()).code).toBeUndefined()
    })
  })

  describe('sem HUB_ONLY', () => {
    it('Google continua valendo', async () => {
      const r = await get('/api/me', 'google-token-ok')
      expect(r.status).toBe(200)
      expect(await r.json()).toMatchObject({ email: ADMIN, via: 'google', role: 'admin' })
    })

    it('HUB_ONLY=true sem segredo é ignorado: Google continua valendo', async () => {
      process.env.HUB_ONLY = 'true'
      process.env.HUB_SSO_SECRET = ''
      expect((await get('/api/me', 'google-token-ok')).status).toBe(200)
    })
  })
})
