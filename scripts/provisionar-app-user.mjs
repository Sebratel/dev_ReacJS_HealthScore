// ─────────────────────────────────────────────────────────────────────────
// Cria a conta dedicada da aplicação no MariaDB — `hs_app`, com acesso só a
// DB_HealthScore.
//
// Existe porque o caminho normal (abrir o .sql num cliente MariaDB) exige um
// cliente instalado, e o projeto já tem o driver `mysql2`. Aqui é um comando.
//
// Conecta com a conta MASTER (as DB_MARIA_* do .env, que hoje são do
// `DevSebratel`) e cria a conta nova. Não apaga nada, não mexe em dado, não
// altera a conta atual: enquanto DB_APP_USER não for definido na stack, a
// aplicação continua se conectando exatamente como antes.
//
// Uso:
//   node scripts/provisionar-app-user.mjs --senha 'SENHA_NOVA'
//   node scripts/provisionar-app-user.mjs --senha 'SENHA' --com-ddl
//
//   --com-ddl  dá também CREATE/ALTER/DROP na base, para que `npm run migrate`
//              possa rodar com esta conta. Sem isso, as migrations continuam
//              sendo aplicadas pela conta master.
// ─────────────────────────────────────────────────────────────────────────
import 'dotenv/config'
import mysql from 'mysql2/promise'

const USUARIO = 'hs_app'
const BASE = process.env.DB_APP_DATABASE || 'DB_HealthScore'

function arg(nome) {
  const i = process.argv.indexOf(`--${nome}`)
  return i >= 0 ? process.argv[i + 1] : null
}

const senha = arg('senha') || process.env.DB_APP_PASSWORD
const comDdl = process.argv.includes('--com-ddl')

if (!senha) {
  console.error(
    'Falta a senha da conta nova.\n' +
    "  node scripts/provisionar-app-user.mjs --senha 'SENHA_NOVA'\n" +
    'Ela não é inventada aqui de propósito: quem escolhe é quem vai guardá-la na stack.',
  )
  process.exit(1)
}
if (String(senha).length < 16) {
  console.error('Senha curta demais. Use 16 caracteres ou mais — esta conta fica numa env que várias pessoas leem.')
  process.exit(1)
}

const master = {
  host: process.env.DB_MARIA_HOST,
  port: Number(process.env.DB_MARIA_PORT) || 3306,
  user: process.env.DB_MARIA_USER,
  password: process.env.DB_MARIA_PASSWORD,
}
if (!master.host || !master.user) {
  console.error('DB_MARIA_HOST/USER ausentes — este script usa a conta master do .env para criar a conta nova.')
  process.exit(1)
}

console.log(`\nServidor : ${master.host}:${master.port}`)
console.log(`Master   : ${master.user}`)
console.log(`Criando  : ${USUARIO}@'%' com acesso só a ${BASE}\n`)

const conn = await mysql.createConnection({ ...master, multipleStatements: false })

try {
  // Senha e identificadores NÃO vão por placeholder: MariaDB não aceita `?`
  // em DDL de usuário. `conn.escape` monta o literal com as aspas certas.
  const senhaSql = conn.escape(String(senha))

  await conn.query(
    `create database if not exists \`${BASE}\` default character set utf8mb4 collate utf8mb4_unicode_ci`,
  )
  console.log(`  ✓ base ${BASE} existe`)

  try {
    await conn.query(`create user if not exists '${USUARIO}'@'%' identified by ${senhaSql}`)
  } catch (e) {
    // Conferido em 12/11/2026: `DevSebratel` tem ALL PRIVILEGES em 22 bases
    // nomeadas, mas nenhum privilégio global além de PROCESS — então criar
    // usuário é recusado aqui. O erro cru ("Access denied; you need ... the
    // CREATE USER privilege") não diz o que fazer; este diz.
    if (e?.errno === 1227) {
      throw new Error(
        `A conta "${master.user}" não pode criar usuários neste servidor.\n` +
        '  Ela tem ALL PRIVILEGES nas bases de aplicação, mas não CREATE USER (privilégio global).\n' +
        '  Peça ao DBA para rodar, no 10.0.11.171:\n\n' +
        `    create user '${USUARIO}'@'%' identified by '<senha>';\n` +
        `    grant select, insert, update, delete on \`${BASE}\`.* to '${USUARIO}'@'%';\n` +
        '    flush privileges;\n\n' +
        `  Ou conceder: grant create user on *.* to '${master.user}'@'%';`,
      )
    }
    throw e
  }
  // `create user if not exists` NÃO troca a senha de uma conta que já existe.
  // Rodar de novo com senha nova precisa ser explícito, ou o script mentiria
  // dizendo "pronto" e a stack não conectaria.
  await conn.query(`alter user '${USUARIO}'@'%' identified by ${senhaSql}`)
  console.log(`  ✓ usuário ${USUARIO} criado (senha aplicada)`)

  const privs = comDdl
    ? 'select, insert, update, delete, create, alter, drop, index, references'
    : 'select, insert, update, delete'
  await conn.query(`grant ${privs} on \`${BASE}\`.* to '${USUARIO}'@'%'`)
  await conn.query('flush privileges')
  console.log(`  ✓ permissões: ${privs}`)
  console.log(`    (apenas em ${BASE} — nenhuma outra base da empresa)`)
} finally {
  await conn.end()
}

// ─── Conferência ─────────────────────────────────────────────────────────
// A parte que importa: provar que o isolamento é real. Um GRANT que "parece
// certo" e uma conta que enxerga o ERP inteiro são a mesma tela de sucesso.
console.log('\nConferindo com a conta nova…')
const teste = await mysql.createConnection({ ...master, user: USUARIO, password: String(senha) })
try {
  const [bases] = await teste.query('show databases')
  const nomes = bases.map((r) => Object.values(r)[0]).filter((n) => n !== 'information_schema' && n !== 'performance_schema')
  console.log(`  bases visíveis: ${nomes.join(', ') || '(nenhuma)'}`)
  if (nomes.length === 1 && nomes[0] === BASE) {
    console.log('  ✓ a conta nova NÃO alcança nenhuma base do ERP')
  } else {
    console.log(`  ⚠  a conta enxerga ${nomes.length} base(s). Esperado: só ${BASE}.`)
    console.log('     Provável GRANT herdado de uma execução anterior ou de um usuário anônimo.')
  }
  await teste.query(`use \`${BASE}\``)
  const [[{ n }]] = await teste.query('select count(*) n from information_schema.tables where table_schema = ?', [BASE])
  console.log(`  ✓ leitura em ${BASE} funciona (${n} tabela(s))`)
} finally {
  await teste.end()
}

console.log(`
Pronto. Nada mudou ainda no sistema: a API só passa a usar esta conta quando
as variáveis abaixo existirem na stack do Portainer.

  DB_APP_USER=${USUARIO}
  DB_APP_PASSWORD=<a senha que você passou aqui>

Depois disso, redeploy da stack. As migrations aplicam sozinhas no boot${comDdl ? '' : ' (com a conta master, já que esta não tem DDL)'}.
`)
