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
//   DB_APP_HOST/PORT   caem nas DB_MARIA_* quando ausentes (mesmo servidor)
//   DB_APP_USER/PASSWORD  OBRIGATÓRIAS — ver abaixo
//   DB_APP_DATABASE    default: DB_HealthScore
// ─────────────────────────────────────────────────────────────────────────
import 'dotenv/config'
import mysql from 'mysql2/promise'

export const APP_DATABASE = process.env.DB_APP_DATABASE || 'DB_HealthScore'

export function appDbConfig() {
  // Host e porta ainda caem nas DB_MARIA_*: é o mesmo servidor, só muda a base.
  const host = process.env.DB_APP_HOST || process.env.DB_MARIA_HOST
  const port = Number(process.env.DB_APP_PORT || process.env.DB_MARIA_PORT) || 3306
  const user = process.env.DB_APP_USER
  const password = process.env.DB_APP_PASSWORD

  if (!host) {
    throw new Error(
      'Banco da aplicação sem host. Defina DB_APP_HOST (ou DB_MARIA_HOST) na stack.',
    )
  }
  // Usuário e senha NÃO caem mais nas DB_MARIA_*. Até 12/11/2026 caíam, e a
  // aplicação escrevia com a conta do ETL. Nessa data `DB_HealthScore` foi
  // restrita a `hs_app` + admin: a conta do ETL perdeu o acesso, então o
  // fallback não só é indesejado como não funciona mais — produziria um
  // "Access denied for user 'DevSebratel'" que não diz o que fazer.
  //
  // Esta mensagem diz. A API continua subindo (o pool é preguiçoso e só o
  // módulo de Planos depende dele); quem abrir a tela vê o que falta.
  if (!user || !password) {
    throw new Error(
      `Banco da aplicação sem credencial própria. Defina DB_APP_USER e DB_APP_PASSWORD na stack — ` +
      `${APP_DATABASE} só aceita a conta da aplicação (hs_app) e a de administração. ` +
      'A conta do ETL (DB_MARIA_USER) não serve mais aqui, de propósito. ' +
      "Para criar a conta: npm run provisionar:usuario -- --senha '…'",
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
