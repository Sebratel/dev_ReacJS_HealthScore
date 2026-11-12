// ─────────────────────────────────────────────────────────────────────────
// Permanência em plano, crédito e régua.
//
// As três regras do módulo moram aqui, e cada uma existe por um motivo que
// não é técnico:
//
//   EM PLANO esconde da tela, nunca da base. Este arquivo só sabe dizer
//   QUEM está em plano; quem decide filtrar é cada tela. As telas de
//   medição (coorte mensal, receita em risco, assertividade) não perguntam.
//
//   CRÉDITO não é score. Sai daqui separado, e quem exibe soma os dois lado
//   a lado. O ranking usa o medido.
//
//   CRÉDITO EXPIRA. Se o plano resolveu, o score medido sobe dentro da
//   validade; se não subiu, o ganho era fictício e evapora sozinho.
// ─────────────────────────────────────────────────────────────────────────
import { query, withTransaction } from '../db.mjs'
import { SECTORS } from '../roles.mjs'

export const DESFECHOS = ['com_exito', 'sem_exito', 'cancelado']
export const CREDITO_MAXIMO_ABSOLUTO = 40
export const VALIDADE_PADRAO_DIAS = 45
export const CREDITO_PADRAO = 15

function parseJson(v) {
  if (v == null) return null
  if (typeof v === 'object') return v
  try { return JSON.parse(v) } catch { return null }
}

function exigeSetor(setor) {
  if (!SECTORS.includes(setor)) throw new Error(`Setor desconhecido: ${setor}`)
  return setor
}

// ─── Teto de crédito por setor ─────────────────────────────────
// O teto é do power_user DO SETOR (decisão do negócio); a validade é de
// admin. Quem chama é que confere o papel — aqui só valida os limites.

export async function getSettings(setor) {
  exigeSetor(setor)
  const [row] = await query('select * from action_plan_sector_settings where setor = ?', [setor])
  if (!row) {
    return {
      setor, creditoMaximo: CREDITO_PADRAO, validadeDias: VALIDADE_PADRAO_DIAS,
      definidoPor: null, definidoEm: null, padrao: true,
    }
  }
  return {
    setor: row.setor,
    creditoMaximo: Number(row.credito_maximo),
    validadeDias: Number(row.validade_dias),
    definidoPor: row.definido_por,
    definidoEm: row.definido_em,
    padrao: false,
  }
}

export async function listSettings() {
  return Promise.all(SECTORS.map((s) => getSettings(s)))
}

/**
 * Grava teto e/ou validade de um setor, registrando a mudança.
 *
 * O log não é opcional: o teto é do próprio setor justamente porque a conta
 * é cobrada depois, e sem registro de quem afrouxou não há o que cobrar.
 */
export async function saveSettings({ setor, creditoMaximo, validadeDias }, por) {
  exigeSetor(setor)
  const atual = await getSettings(setor)
  const novoCredito = creditoMaximo == null ? atual.creditoMaximo : Number(creditoMaximo)
  const novaValidade = validadeDias == null ? atual.validadeDias : Number(validadeDias)

  if (!Number.isInteger(novoCredito) || novoCredito < 0 || novoCredito > CREDITO_MAXIMO_ABSOLUTO) {
    throw new Error(`Teto de crédito deve ser um inteiro entre 0 e ${CREDITO_MAXIMO_ABSOLUTO}.`)
  }
  if (!Number.isInteger(novaValidade) || novaValidade < 1 || novaValidade > 365) {
    throw new Error('Validade do crédito deve ser entre 1 e 365 dias.')
  }

  return withTransaction(async (conn) => {
    await conn.execute(
      `insert into action_plan_sector_settings (setor, credito_maximo, validade_dias, definido_por)
       values (?, ?, ?, ?)
       on duplicate key update credito_maximo = values(credito_maximo),
                               validade_dias  = values(validade_dias),
                               definido_por   = values(definido_por)`,
      [setor, novoCredito, novaValidade, por],
    )
    const mudancas = [
      ['credito_maximo', atual.creditoMaximo, novoCredito],
      ['validade_dias', atual.validadeDias, novaValidade],
    ].filter(([, de, para]) => de !== para)
    for (const [campo, de, para] of mudancas) {
      await conn.execute(
        `insert into action_plan_settings_log (setor, campo, valor_anterior, valor_novo, alterado_por)
         values (?, ?, ?, ?, ?)`,
        [setor, campo, String(de), String(para), por],
      )
    }
    return { setor, creditoMaximo: novoCredito, validadeDias: novaValidade, mudancas: mudancas.length }
  })
}

export async function settingsHistory(setor, limite = 50) {
  const rows = setor
    ? await query(
        'select * from action_plan_settings_log where setor = ? order by alterado_em desc limit ?',
        [exigeSetor(setor), Number(limite)],
      )
    : await query('select * from action_plan_settings_log order by alterado_em desc limit ?', [Number(limite)])
  return rows.map((r) => ({
    id: r.id, setor: r.setor, campo: r.campo,
    de: r.valor_anterior, para: r.valor_novo,
    por: r.alterado_por, em: r.alterado_em,
  }))
}

// ─── Régua ─────────────────────────────────────────────────────

export async function listRulers({ setor, incluirArquivadas = false } = {}) {
  const where = []
  const args = []
  if (setor) { where.push('setor = ?'); args.push(exigeSetor(setor)) }
  if (!incluirArquivadas) where.push('arquivada = 0')
  const rows = await query(
    `select * from action_plan_rulers ${where.length ? `where ${where.join(' and ')}` : ''}
     order by sugerida desc, criado_em desc`,
    args,
  )
  return rows.map((r) => ({
    id: r.id, setor: r.setor, nome: r.nome, descricao: r.descricao,
    definicao: parseJson(r.definicao), sugerida: !!r.sugerida, arquivada: !!r.arquivada,
    criadoPor: r.criado_por, criadoEm: r.criado_em,
  }))
}

export async function createRuler({ setor, nome, descricao, definicao, sugerida = false }, por) {
  exigeSetor(setor)
  if (!nome?.trim()) throw new Error('A régua precisa de um nome.')
  if (!definicao || typeof definicao !== 'object') throw new Error('A régua precisa de uma definição.')
  const rows = await query(
    `insert into action_plan_rulers (setor, nome, descricao, definicao, sugerida, criado_por)
     values (?, ?, ?, ?, ?, ?)`,
    [setor, nome.trim(), descricao || null, JSON.stringify(definicao), sugerida ? 1 : 0, por],
  )
  return { id: rows.insertId, setor, nome: nome.trim() }
}

export async function archiveRuler(id) {
  await query('update action_plan_rulers set arquivada = 1 where id = ?', [Number(id)])
  return { id: Number(id), arquivada: true }
}

// ─── Quem está em plano ────────────────────────────────────────
// A consulta mais chamada do módulo: entra no payload do dashboard a cada
// carregamento de tela. Por isso devolve só o que a tela precisa — id do
// contrato e setor — e tem índice próprio (ix_member_aberto).

/** Contratos com permanência ABERTA, por setor. */
export async function contratosEmPlano({ setor } = {}) {
  const rows = setor
    ? await query(
        'select contrato_id, setor, run_id, entrou_em from action_plan_memberships where saiu_em is null and setor = ?',
        [exigeSetor(setor)],
      )
    : await query('select contrato_id, setor, run_id, entrou_em from action_plan_memberships where saiu_em is null')
  return rows.map((r) => ({
    contratoId: String(r.contrato_id), setor: r.setor, runId: r.run_id, entrouEm: r.entrou_em,
  }))
}

/**
 * Mapa contrato → crédito vigente.
 *
 * Vários setores podem creditar o mesmo contrato. O crédito NÃO SOMA: vale
 * o maior. Sete setores a 15 pontos seriam 105 — score cheio de graça.
 */
export async function creditosVigentes() {
  const rows = await query(
    `select contrato_id, max(pontos) pontos
       from action_plan_credits
      where revogado_em is null and expira_em > now()
      group by contrato_id`,
  )
  const mapa = new Map()
  for (const r of rows) mapa.set(String(r.contrato_id), Number(r.pontos))
  return mapa
}

/** Detalhe dos créditos de um contrato — para o painel do cliente. */
export async function creditosDoContrato(contratoId) {
  const rows = await query(
    `select c.*, r.nome plano_nome
       from action_plan_credits c
       join action_plan_memberships m on m.id = c.membership_id
       join action_plan_runs r on r.id = m.run_id
      where c.contrato_id = ?
      order by c.concedido_em desc`,
    [String(contratoId)],
  )
  const agora = Date.now()
  return rows.map((r) => ({
    id: r.id, setor: r.setor, pontos: Number(r.pontos), plano: r.plano_nome,
    concedidoPor: r.concedido_por, concedidoEm: r.concedido_em, expiraEm: r.expira_em,
    revogadoEm: r.revogado_em,
    vigente: !r.revogado_em && new Date(r.expira_em).getTime() > agora,
  }))
}

/** Contagem por setor para o contador das telas ("1.319 críticos · 214 em plano"). */
export async function resumoEmPlano() {
  const rows = await query(
    `select setor, count(*) total from action_plan_memberships where saiu_em is null group by setor`,
  )
  const porSetor = {}
  let total = 0
  for (const r of rows) { porSetor[r.setor] = Number(r.total); total += Number(r.total) }
  return { total, porSetor }
}

// ─── Abrir plano ───────────────────────────────────────────────

// Quantas permanências por INSERT. Medido contra o banco real (186.219.134.247,
// ~70 ms de ida e volta): linha a linha, 1.000 contratos levam 70 SEGUNDOS;
// em lotes de 500, 567 ms. São 123x, e é a diferença entre "abre um plano de
// 5.000" e "a requisição morre no caminho".
//
// 500 e não 5.000 porque o pacote do MariaDB tem teto (`max_allowed_packet`)
// e o erro dele é obscuro; com 5 colunas curtas, 500 linhas ficam na casa das
// dezenas de KB, bem longe do limite padrão de 16 MB.
const LOTE = 500

/**
 * Insere as permanências em lote, caindo para linha a linha só no lote que
 * bater em duplicata.
 *
 * A duplicata é esperada e NÃO é erro: `uk_member_um_aberto_por_setor` recusa
 * quem já tem plano aberto no setor. A régua já exclui esses na seleção, mas
 * entre a prévia e o clique alguém pode ter aberto outro plano — e aí o lote
 * inteiro falharia por causa de uma linha. O fallback isola a culpada sem
 * perder as outras 499.
 */
async function inserirPermanencias(conn, linhas) {
  const SQL = `insert into action_plan_memberships
     (run_id, contrato_id, setor, score_entrada, classificacao_entrada) values `
  let entraram = 0
  let jaEmPlano = 0

  for (let i = 0; i < linhas.length; i += LOTE) {
    const lote = linhas.slice(i, i + LOTE)
    try {
      await conn.query(SQL + lote.map(() => '(?, ?, ?, ?, ?)').join(','), lote.flat())
      entraram += lote.length
    } catch (e) {
      if (e?.code !== 'ER_DUP_ENTRY') throw e
      // Statement abortado não desfaz a transação no InnoDB: dá para reinserir
      // linha a linha e descobrir exatamente quem já estava em plano.
      for (const linha of lote) {
        try {
          await conn.execute(SQL + '(?, ?, ?, ?, ?)', linha)
          entraram++
        } catch (e2) {
          if (e2?.code === 'ER_DUP_ENTRY') { jaEmPlano++; continue }
          throw e2
        }
      }
    }
  }
  return { entraram, jaEmPlano }
}

/**
 * Cria o plano e coloca os contratos dentro dele.
 *
 * O teto do setor é CONGELADO no plano: se o power_user mudar o teto depois,
 * planos já abertos não são reprecificados — senão o crédito combinado na
 * abertura mudaria no meio do caminho.
 *
 * Contrato que já está em plano DO MESMO SETOR é pulado, não é erro: a régua
 * naturalmente volta a casar com quem já está sendo tratado, e falhar o lote
 * inteiro por isso só obrigaria o usuário a caçar quem sobrou.
 */
export async function abrirPlano({
  setor, nome, rulerId = null, criterio = {}, origem = 'manual',
  creditoPontos = null, contratos = [],
}, por) {
  exigeSetor(setor)
  if (!nome?.trim()) throw new Error('O plano precisa de um nome.')
  if (!Array.isArray(contratos) || !contratos.length) {
    throw new Error('Nenhum contrato casou com a régua — o plano não foi criado.')
  }

  const cfg = await getSettings(setor)
  const pontos = creditoPontos == null ? cfg.creditoMaximo : Number(creditoPontos)
  if (!Number.isInteger(pontos) || pontos < 0) throw new Error('Crédito do plano inválido.')
  if (pontos > cfg.creditoMaximo) {
    throw new Error(
      `Crédito de ${pontos} pontos passa do teto de ${cfg.creditoMaximo} do setor. ` +
      'Ajuste o teto do setor antes, para que a mudança fique registrada.',
    )
  }

  return withTransaction(async (conn) => {
    const [run] = await conn.execute(
      `insert into action_plan_runs
         (setor, nome, origem, criterio_selecao, ruler_id, qtd_clientes, iniciado_por,
          status, situacao, credito_pontos, validade_dias)
       values (?, ?, ?, ?, ?, ?, ?, 'concluida', 'em_andamento', ?, ?)`,
      [setor, nome.trim(), origem, JSON.stringify(criterio), rulerId, contratos.length, por,
       pontos, cfg.validadeDias],
    )
    const runId = run.insertId

    const linhas = contratos
      .map((c) => {
        const contratoId = String(c.contratoId ?? c.clientId ?? c)
        return contratoId ? [runId, contratoId, setor, c.score ?? null, c.classificacao ?? null] : null
      })
      .filter(Boolean)

    const { entraram, jaEmPlano } = await inserirPermanencias(conn, linhas)
    if (!entraram) {
      throw new Error('Todos os contratos da régua já estão em plano deste setor.')
    }
    await conn.execute('update action_plan_runs set qtd_clientes = ? where id = ?', [entraram, runId])
    if (rulerId) await conn.execute('update action_plan_rulers set sugerida = 0 where id = ?', [rulerId])

    return { runId, nome: nome.trim(), setor, entraram, jaEmPlano, creditoPontos: pontos, validadeDias: cfg.validadeDias }
  })
}

// ─── Encerrar ──────────────────────────────────────────────────

/**
 * Encerra a permanência de UM contrato, com desfecho obrigatório.
 *
 * Só `com_exito` gera crédito. É a trava que faz o desfecho valer alguma
 * coisa: sem ela, encerrar seria sempre "deu certo" e o módulo não produziria
 * nenhum aprendizado sobre que plano funciona.
 */
export async function encerrarMembership({ membershipId, desfecho, scoreSaida = null, observacao = null }, por) {
  if (!DESFECHOS.includes(desfecho)) {
    throw new Error(`Desfecho deve ser um de: ${DESFECHOS.join(', ')}.`)
  }
  return withTransaction(async (conn) => {
    const [[m]] = await conn.execute(
      `select m.*, r.credito_pontos, r.validade_dias
         from action_plan_memberships m
         join action_plan_runs r on r.id = m.run_id
        where m.id = ?`,
      [Number(membershipId)],
    )
    if (!m) throw new Error('Permanência não encontrada.')
    if (m.saiu_em) throw new Error('Esta permanência já foi encerrada.')

    await conn.execute(
      `update action_plan_memberships
          set saiu_em = now(), desfecho = ?, score_saida = ?, observacao = ?
        where id = ?`,
      [desfecho, scoreSaida, observacao, m.id],
    )

    let credito = null
    const pontos = Number(m.credito_pontos) || 0
    if (desfecho === 'com_exito' && pontos > 0) {
      const cfg = await getSettings(m.setor)
      // O teto de HOJE também vale: um plano aberto com teto alto não pode
      // creditar acima do teto atual se o setor apertou a régua no caminho.
      const efetivo = Math.min(pontos, cfg.creditoMaximo)
      if (efetivo > 0) {
        await conn.execute(
          `insert into action_plan_credits
             (membership_id, contrato_id, setor, pontos, teto_na_epoca, concedido_por, expira_em)
           values (?, ?, ?, ?, ?, ?, date_add(now(), interval ? day))`,
          [m.id, m.contrato_id, m.setor, efetivo, cfg.creditoMaximo, por, Number(m.validade_dias) || VALIDADE_PADRAO_DIAS],
        )
        credito = { pontos: efetivo, validadeDias: Number(m.validade_dias) || VALIDADE_PADRAO_DIAS }
      }
    }

    // Plano cujo último contrato saiu está encerrado.
    const [[resto]] = await conn.execute(
      'select count(*) abertos from action_plan_memberships where run_id = ? and saiu_em is null',
      [m.run_id],
    )
    if (Number(resto.abertos) === 0) {
      await conn.execute(
        `update action_plan_runs set situacao = 'encerrado', encerrado_em = now(), encerrado_por = ?
          where id = ? and situacao <> 'encerrado'`,
        [por, m.run_id],
      )
    }

    return { membershipId: m.id, contratoId: String(m.contrato_id), desfecho, credito }
  })
}

/** Encerra todas as permanências abertas de um plano com o mesmo desfecho. */
export async function encerrarPlano({ runId, desfecho, observacao = null }, por) {
  const abertas = await query(
    'select id from action_plan_memberships where run_id = ? and saiu_em is null',
    [Number(runId)],
  )
  const resultados = []
  for (const { id } of abertas) {
    resultados.push(await encerrarMembership({ membershipId: id, desfecho, observacao }, por))
  }
  return { runId: Number(runId), encerradas: resultados.length, comCredito: resultados.filter((r) => r.credito).length }
}

export async function revogarCredito(id, por) {
  await query('update action_plan_credits set revogado_em = now(), revogado_por = ? where id = ? and revogado_em is null', [por, Number(id)])
  return { id: Number(id), revogado: true }
}

// ─── Permanências de um plano / de um contrato ─────────────────

export async function getMembership(id) {
  const [row] = await query(
    `select m.*, r.nome plano_nome, r.setor plano_setor
       from action_plan_memberships m
       join action_plan_runs r on r.id = m.run_id
      where m.id = ?`,
    [Number(id)],
  )
  if (!row) return null
  return {
    id: row.id, runId: row.run_id, plano: row.plano_nome, setor: row.setor,
    contratoId: String(row.contrato_id), aberta: !row.saiu_em, desfecho: row.desfecho,
  }
}

export async function listMemberships({ runId, contratoId, apenasAbertas = false } = {}) {
  const where = []
  const args = []
  if (runId) { where.push('m.run_id = ?'); args.push(Number(runId)) }
  if (contratoId) { where.push('m.contrato_id = ?'); args.push(String(contratoId)) }
  if (apenasAbertas) where.push('m.saiu_em is null')
  const rows = await query(
    `select m.*, r.nome plano_nome, r.credito_pontos
       from action_plan_memberships m
       join action_plan_runs r on r.id = m.run_id
      ${where.length ? `where ${where.join(' and ')}` : ''}
      order by m.entrou_em desc`,
    args,
  )
  return rows.map((r) => ({
    id: r.id, runId: r.run_id, plano: r.plano_nome, contratoId: String(r.contrato_id), setor: r.setor,
    scoreEntrada: r.score_entrada == null ? null : Number(r.score_entrada),
    classificacaoEntrada: r.classificacao_entrada,
    scoreSaida: r.score_saida == null ? null : Number(r.score_saida),
    entrouEm: r.entrou_em, saiuEm: r.saiu_em, desfecho: r.desfecho,
    observacao: r.observacao, creditoPrevisto: Number(r.credito_pontos) || 0,
    aberta: !r.saiu_em,
  }))
}

/**
 * O que o módulo existe para responder: que plano moveu o score.
 *
 * Mede pelo score MEDIDO (entrada x saída), nunca pelo creditado — somar o
 * próprio crédito ao resultado provaria que todo plano funciona.
 */
export async function efetividadePorSetor() {
  const rows = await query(
    `select setor, desfecho, count(*) total,
            avg(score_saida - score_entrada) delta_medio
       from action_plan_memberships
      where saiu_em is not null and score_entrada is not null and score_saida is not null
      group by setor, desfecho`,
  )
  return rows.map((r) => ({
    setor: r.setor, desfecho: r.desfecho, total: Number(r.total),
    deltaMedio: r.delta_medio == null ? null : Number(Number(r.delta_medio).toFixed(2)),
  }))
}
