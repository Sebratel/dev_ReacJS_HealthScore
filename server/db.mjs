// ─────────────────────────────────────────────────────────────────────────
// Pool de ESCRITA do Health Score (MariaDB, base própria da aplicação).
//
// Até aqui o backend não tinha banco: tudo vinha do snapshot do ETL e de
// arquivos JSON no volume. O módulo de Planos de Ação precisa de estado
// relacional de verdade (rodada → dossiê → recomendação → aprovação → tarefa →
// resultado), e é para isso que esta base existe.
//
// ATENÇÃO — este pool é SEPARADO do pool do ETL (scripts/db-maria.mjs) de
// propósito. O ETL é somente-leitura sobre bases de terceiros; este escreve, e
// só na base da aplicação. Misturar os dois apagaria essa fronteira.
//
//   DB_APP_HOST/PORT/USER/PASSWORD  caem nas DB_MARIA_* quando ausentes
//   DB_APP_DATABASE                 default: DB_HealthScore
// ─────────────────────────────────────────────────────────────────────────
import 'dotenv/config'
import mysql from 'mysql2/promise'

export const APP_DATABASE = process.env.DB_APP_DATABASE || 'DB_HealthScore'

// Credenciais do servidor MariaDB. As DB_MARIA_* são o fallback porque é o
// mesmo servidor — só muda a base.
let avisouFallback = false

export function appDbConfig() {
  const host = process.env.DB_APP_HOST || process.env.DB_MARIA_HOST
  const user = process.env.DB_APP_USER || process.env.DB_MARIA_USER
  const password = process.env.DB_APP_PASSWORD || process.env.DB_MARIA_PASSWORD
  const port = Number(process.env.DB_APP_PORT || process.env.DB_MARIA_PORT) || 3306

  // Sem DB_APP_USER, a aplicação ESCREVE com a conta de LEITURA do ETL — que
  // alcança as bases do ERP. A fronteira entre ler e escrever passa a existir
  // só no comentário do código, e um bug de SQL aqui chega no ELLEVEN.
  // server/migrations/PROVISIONAR-USUARIO.sql cria a conta certa.
  if (!process.env.DB_APP_USER && user && !avisouFallback) {
    avisouFallback = true
    console.warn(
      `[banco] DB_APP_USER não definido — escrevendo em ${APP_DATABASE} com a conta do ETL ` +
      `("${user}"), que tem acesso às bases do ERP. Provisione a conta dedicada ` +
      '(server/migrations/PROVISIONAR-USUARIO.sql) e defina DB_APP_USER/DB_APP_PASSWORD na stack.',
    )
  }
  if (!host || !user) {
    throw new Error(
      'Banco da aplicação não configurado. Defina DB_APP_HOST/USER/PASSWORD ' +
      '(ou reaproveite DB_MARIA_HOST/USER/PASSWORD) na stack.',
    )
  }
  return { host, port, user, password }
}

let pool = null

// Pool preguiçoso: a API sobe mesmo sem banco configurado (as telas antigas —
// dashboard, engines, assertividade — não dependem dele). Quem precisar do
// banco recebe o erro no momento da chamada, com mensagem acionável.
export function getPool() {
  if (pool) return pool
  pool = mysql.createPool({
    ...appDbConfig(),
    database: APP_DATABASE,
    connectionLimit: 8,
    connectTimeout: 15000,
    // Datas como string 'YYYY-MM-DD HH:mm:ss' — o resto do sistema trabalha
    // com ISO em texto, e Date do mysql2 vem no fuso do servidor.
    dateStrings: true,
    // Sem múltiplos statements: reduz a superfície de injeção mesmo com
    // parâmetros por toda parte.
    multipleStatements: false,
  })
  return pool
}

export async function query(sql, params = []) {
  const [rows] = await getPool().execute(sql, params)
  return rows
}

// Executa uma função dentro de uma transação, com rollback em qualquer erro.
export async function withTransaction(fn) {
  const conn = await getPool().getConnection()
  try {
    await conn.beginTransaction()
    const out = await fn(conn)
    await conn.commit()
    return out
  } catch (e) {
    try { await conn.rollback() } catch { /* conexão já perdida */ }
    throw e
  } finally {
    conn.release()
  }
}

// O banco está acessível? Usado pelo /api/health e pelas telas, para dizer
// "módulo indisponível" em vez de estourar erro cru.
export async function isReady() {
  try {
    await query('select 1')
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e.message }
  }
}

export async function closePool() {
  if (!pool) return
  await pool.end()
  pool = null
}
