// ─────────────────────────────────────────────────────────────────────────
// Entrada pelo Hub Apps: o Health Score aberto DENTRO do Hub (iframe).
//
//   1. A pessoa clica no card do Health Score no Hub. O Hub confere se ela tem
//      acesso ao app e emite um token de 5 min (JWT HS256 assinado com o
//      SSO_JWT_SECRET do Hub, com { sub, email, name, appId, iat, exp }).
//   2. O iframe abre https://health-score…/?sso_token=<token>. O front tira o
//      token da URL ANTES de montar e o manda para POST /api/auth/hub.
//   3. Aqui o token é conferido (algoritmo, assinatura, validade, appId,
//      domínio, uso único) e trocado por uma SESSÃO do Health Score, de 8 h,
//      que viaja no Authorization como qualquer outro Bearer.
//
// A sessão é assinada com uma chave DERIVADA do segredo do Hub, nunca com o
// segredo em si, e leva iss/aud/via próprios: um token de lançamento do Hub não
// vale como sessão, e uma sessão não vale como token de lançamento. O papel
// (viewer / power_user / admin) continua vindo de ADMIN_EMAILS + roles.json,
// exatamente como no login pelo Google — o token do Hub só diz QUEM é.
//
// HUB_ONLY=true liga o "só pelo Hub": todo outro meio de entrada é recusado no
// servidor, SEM exceção — nem ADMIN_EMAILS, nem lista de emergência. Só vale
// com HUB_SSO_SECRET e HUB_APP_ID preenchidos: sem eles ninguém entraria por
// lado nenhum, então HUB_ONLY é ignorado (e o boot avisa).
// ─────────────────────────────────────────────────────────────────────────
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'

export const HUB_URL_PADRAO = 'https://hub-apps.sebratel.net.br'
export const HUB_ONLY_MESSAGE =
  'O Health Score é acessado pelo Hub Apps. Abra o Hub e clique no Health Score.'

const SESSION_TTL_S = 8 * 60 * 60
const SESSION_ISS = 'healthscore'
const SESSION_AUD = 'healthscore-hub-session'
// Folga para relógio adiantado do Hub e teto da validade de um lançamento.
const IAT_SKEW_S = 60
const MAX_LAUNCH_TTL_S = 600

// Lido a cada chamada (não no import): os testes trocam o ambiente entre casos
// e o custo é desprezível perto de um HMAC.
function cfg() {
  const url = String(process.env.HUB_URL || '').trim()
  return {
    secret: String(process.env.HUB_SSO_SECRET || ''),
    appId: String(process.env.HUB_APP_ID || '').trim(),
    only: /^(1|true|yes|on|sim)$/i.test(String(process.env.HUB_ONLY || '').trim()),
    // Só https: o valor vira href de um link na tela de login.
    url: /^https:\/\/[^\s"'<>]+$/i.test(url) ? url : HUB_URL_PADRAO,
    domain: String(process.env.ALLOWED_DOMAIN || 'sebratel.com.br').trim().toLowerCase(),
  }
}

/** Segredo e id do card preenchidos: a entrada pelo Hub está ligada. */
export function hubSsoConfigured() {
  const c = cfg()
  return !!(c.secret && c.appId)
}

/** "Só pelo Hub" valendo de fato (HUB_ONLY ligado E a entrada pelo Hub pronta). */
export function hubOnlyActive() {
  return cfg().only && hubSsoConfigured()
}

/** HUB_ONLY pedido, mas ignorado por falta de HUB_SSO_SECRET/HUB_APP_ID. */
export function hubOnlyIgnored() {
  return cfg().only && !hubSsoConfigured()
}

export function hubUrl() {
  return cfg().url
}

/** O que a tela de login pode saber. Nada de segredo aqui. */
export function publicAuthConfig() {
  return { hubSso: hubSsoConfigured(), hubOnly: hubOnlyActive(), hubUrl: hubUrl() }
}

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
const agora = () => Math.floor(Date.now() / 1000)

function sessionKey(secret) {
  return createHmac('sha256', secret).update('healthscore-hub-session-v1').digest()
}

/**
 * Confere forma, algoritmo e assinatura de um JWT HS256. Devolve o payload ou
 * null. O algoritmo é FIXO: o `alg` do cabeçalho só é comparado, nunca escolhe
 * nada — aceitar o que vem nele abriria o "alg: none" e a troca de algoritmo.
 */
export function verifyHs256(token, key) {
  if (typeof token !== 'string' || !key || (typeof key === 'string' && !key.length)) return null
  const parts = token.split('.')
  if (parts.length !== 3) return null
  const [rawHeader, rawPayload, rawSig] = parts
  if (!rawHeader || !rawPayload || !rawSig) return null
  let header
  let payload
  try {
    header = JSON.parse(Buffer.from(rawHeader, 'base64url').toString('utf8'))
    payload = JSON.parse(Buffer.from(rawPayload, 'base64url').toString('utf8'))
  } catch { return null }
  if (!header || header.alg !== 'HS256') return null
  const esperado = createHmac('sha256', key).update(`${rawHeader}.${rawPayload}`).digest()
  const recebido = Buffer.from(rawSig, 'base64url')
  // timingSafeEqual exige o mesmo tamanho; a checagem de tamanho não vaza nada
  // útil (o tamanho de um HMAC-SHA256 é público).
  if (recebido.length !== esperado.length || !timingSafeEqual(recebido, esperado)) return null
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null
  return payload
}

// Uso único: o token viaja na URL do iframe e pode parar em histórico ou log de
// proxy. Guarda o hash até o exp. Em memória basta: a `api` roda num contêiner
// só (container_name fixo no compose, sem réplicas). Com réplicas, isto teria
// de ir para um armazenamento compartilhado (Redis).
const usados = new Map() // sha256(token) -> exp em ms

function marcarUso(token, expS) {
  const ms = Date.now()
  for (const [k, exp] of usados) if (exp <= ms) usados.delete(k)
  const id = createHash('sha256').update(token).digest('hex')
  if (usados.has(id)) return false
  usados.set(id, expS * 1000)
  return true
}

const recusa = (error, status = 401) => ({ ok: false, status, error })
const ABRA_DE_NOVO = 'Abra o Health Score de novo pelo Hub Apps.'

/**
 * Confere o token de lançamento emitido pelo Hub Apps.
 * → { ok: true, email, name } | { ok: false, status, error }
 */
export function verifyHubLaunchToken(token) {
  const c = cfg()
  if (!c.secret || !c.appId) {
    return recusa('A entrada pelo Hub Apps não está configurada neste servidor (HUB_SSO_SECRET e HUB_APP_ID).', 503)
  }
  const p = verifyHs256(token, c.secret)
  if (!p) return recusa(`Token do Hub inválido. ${ABRA_DE_NOVO}`)

  const now = agora()
  const exp = Number(p.exp)
  const iat = Number(p.iat)
  if (!Number.isFinite(exp) || !Number.isFinite(iat)) return recusa(`Token do Hub inválido. ${ABRA_DE_NOVO}`)
  if (exp <= now) return recusa(`O link de acesso venceu. ${ABRA_DE_NOVO}`)
  if (iat > now + IAT_SKEW_S) return recusa(`Token do Hub inválido. ${ABRA_DE_NOVO}`)
  if (exp <= iat || exp - iat > MAX_LAUNCH_TTL_S) return recusa(`Token do Hub inválido. ${ABRA_DE_NOVO}`)

  if (String(p.appId ?? '') !== c.appId) {
    return recusa('Este token do Hub foi emitido para outro aplicativo.', 403)
  }
  const email = typeof p.email === 'string' ? p.email.trim().toLowerCase() : ''
  if (!email || !email.endsWith('@' + c.domain)) {
    return recusa(`Somente contas @${c.domain} acessam o Health Score.`, 403)
  }
  // Por último: um token recusado por outro motivo não "gasta" o uso.
  if (!marcarUso(token, exp)) return recusa(`Este link de acesso já foi usado. ${ABRA_DE_NOVO}`)

  const name = typeof p.name === 'string' && p.name.trim() ? p.name.trim() : email
  return { ok: true, email, name }
}

/** Emite a sessão do Health Score para quem entrou pelo Hub. */
export function issueHubSession({ email, name }) {
  const { secret } = cfg()
  if (!secret) throw new Error('HUB_SSO_SECRET ausente.')
  const iat = agora()
  const exp = iat + SESSION_TTL_S
  const data = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({
    iss: SESSION_ISS, aud: SESSION_AUD, via: 'hub', sub: email, email, name, iat, exp,
  })}`
  const sig = createHmac('sha256', sessionKey(secret)).update(data).digest('base64url')
  return { token: `${data}.${sig}`, expiresAt: new Date(exp * 1000).toISOString() }
}

/** Sessão aberta pelo Hub → { email, name }, ou null se o token não é uma (ou venceu). */
export function verifyHubSession(token) {
  const c = cfg()
  if (!c.secret || !c.appId) return null
  const p = verifyHs256(token, sessionKey(c.secret))
  if (!p) return null
  if (p.iss !== SESSION_ISS || p.aud !== SESSION_AUD || p.via !== 'hub') return null
  const exp = Number(p.exp)
  if (!Number.isFinite(exp) || exp <= agora()) return null
  const email = typeof p.email === 'string' ? p.email.trim().toLowerCase() : ''
  if (!email || !email.endsWith('@' + c.domain)) return null
  return { email, name: typeof p.name === 'string' && p.name ? p.name : email }
}

/** Só para teste: esquece os tokens já usados. */
export function __resetHubReplayForTest() {
  usados.clear()
}
