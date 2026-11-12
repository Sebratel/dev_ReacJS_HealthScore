// ─────────────────────────────────────────────────────────────────────────
// Orquestração de uma rodada: seleciona → monta dossiê → chama a IA →
// valida → grava. Roda em segundo plano; a tela acompanha pelo status.
//
// A seleção NÃO tem lógica de score própria: chama a mesma runEngine que a
// tela /financeiro usa, com a config oficial. Se um dia os pesos mudarem, a
// rodada muda junto — que é o comportamento certo.
// ─────────────────────────────────────────────────────────────────────────
import { runEngine, scoreEngineAllClients } from '../engines.mjs'
import { getClients, getDataset } from '../dataset.mjs'
import { getOfficialConfig } from '../officialConfig.mjs'
import { withDefaults } from '../engineDefaults.mjs'
import { provedorAtivo } from '../ia/registro.mjs'
import { buildDossier, renderPrompt } from './dossier.mjs'
import { validateRecommendation, contratoEmTexto, ACTION_PLAN_JSON_SCHEMA } from './schema.mjs'
import {
  getActiveTemplate, createRun, updateRun, insertDossier, insertRecommendation,
} from './store.mjs'

// Severidade: menor = pior. "Classificação mínima" quer dizer "pelo menos tão
// grave quanto", então critical sozinho é o mais restritivo.
const CLASS_RANK = { critical: 0, high_risk: 1, attention: 2, healthy: 3, excellent: 4 }

// Teto de chamadas simultâneas ao provedor, para não estourar rate limit.
export const MAX_CONCURRENCY = 10
// Teto de clientes por rodada — 30 é o padrão; acima de 200 a rodada vira um
// custo que ninguém aprovou de propósito.
const MAX_CLIENTES = 200

export const DEFAULT_CRITERIO = {
  quantidade: 30,
  classificacaoMinima: 'critical',
  cidade: null,
  mrrMin: null,
  mrrMax: null,
}

// Executa `worker` sobre `items` com no máximo `limit` em voo. Sem dependência
// externa: são poucas linhas e o comportamento fica explícito.
async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length)
  let next = 0
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = next++
      if (i >= items.length) return
      try { results[i] = await worker(items[i], i) } catch (e) { results[i] = { ok: false, erro: e.message } }
    }
  })
  await Promise.all(runners)
  return results
}

// Aplica o critério sobre a engine e devolve os scores escolhidos.
export function selectClients(criterio = {}) {
  const c = { ...DEFAULT_CRITERIO, ...criterio }
  const clients = getClients()
  if (!clients.length) throw new Error('Base ainda não materializada no backend (snapshot ausente).')

  const official = getOfficialConfig()
  // withDefaults, NUNCA a config crua. A gravada traz as NOTAS; a FORMA dos
  // indicadores (quais faixas existem) vem do codigo. Uma config publicada
  // antes de um indicador virar faixa nao tem `indices`: sem o merge, ela
  // pontua zero, todo mundo fica com 100, e a selecao devolve NINGUEM — em
  // silencio, enquanto a tela de /financeiro (que aplica o merge) continua
  // mostrando os criticos. As duas precisam ler a mesma regua.
  const config = withDefaults(official?.configs)?.financial
  if (!config) {
    throw new Error(
      'Config oficial do Financeiro não publicada. Um power user precisa publicar os pesos ' +
      'em Configurações antes de gerar planos — senão cada rodada usaria uma régua diferente.',
    )
  }

  const rankLimite = CLASS_RANK[c.classificacaoMinima] ?? 0
  // Página única com os piores; a ordenação padrão de runEngine já é
  // healthScore ascendente (pior primeiro).
  const { scores } = runEngine('financial', {
    clients,
    config,
    thresholds: official?.thresholds,
    monthly: getDataset()?.monthly || [],
    city: c.cidade || undefined,
    page: 0,
    pageSize: 2000,
  })

  const qtd = Math.min(MAX_CLIENTES, Math.max(1, Number(c.quantidade) || DEFAULT_CRITERIO.quantidade))
  const filtrados = scores.filter((s) => {
    if ((CLASS_RANK[s.classification] ?? 9) > rankLimite) return false
    const mrr = Number(s.monthlyValue) || 0
    if (c.mrrMin != null && mrr < Number(c.mrrMin)) return false
    if (c.mrrMax != null && mrr > Number(c.mrrMax)) return false
    return true
  })
  return { selecionados: filtrados.slice(0, qtd), criterio: c, disponiveis: filtrados.length }
}

// ─── Régua de plano ────────────────────────────────────────────
// Irmã de selectClients, com três diferenças que importam:
//
//   por SETOR, não só Financeiro — cada power user tem o seu;
//   em MASSA — a régua existe para pegar centenas ou milhares de contratos
//     de uma vez; a rodada de IA não pode, porque lá cada cliente custa uma
//     chamada paga ao provedor (por isso MAX_CLIENTES = 200 lá em cima);
//   devolve separado quem JÁ ESTÁ em plano aberto do setor — a régua volta a
//     casar naturalmente com quem está sendo tratado, e misturar os dois na
//     prévia faria o usuário abrir um plano de 400 que entra com 90.
//
// Teto alto de propósito. Ele não é um limite técnico: é um freio contra
// "selecionei a base inteira sem querer". A tela sempre mostra quantos
// casaram ANTES de criar, então passar disso é decisão consciente.
export const MAX_CONTRATOS_POR_PLANO = 20000

export function selecionarPorRegua(setor, definicao = {}, emPlano = null) {
  const clients = getClients()
  if (!clients.length) throw new Error('Base ainda não materializada no backend (snapshot ausente).')

  const official = getOfficialConfig()
  // Idem: a forma vem do codigo, as notas do que foi publicado. Ver o
  // comentario em selectClients.
  const config = withDefaults(official?.configs)?.[setor]
  if (!config) {
    throw new Error(
      `Config oficial de "${setor}" não publicada. Um power user precisa publicar os pesos em ` +
      'Configurações antes de abrir planos — senão cada plano usaria uma régua diferente.',
    )
  }

  // `scoreEngineAllClients`, não `runEngine`: aquele devolve uma PÁGINA, e a
  // paginação dele é travada em 2.000 (`Math.min(2000, …)`, por causa do
  // tamanho do payload HTTP do "Ver dados"). Aqui não há payload — a seleção
  // roda dentro do processo —, e uma régua "todos em atenção" passa de 2.000
  // com folga. Os dois usam o mesmo cache de pontuação.
  const scores = scoreEngineAllClients(setor, {
    clients,
    config,
    thresholds: official?.thresholds,
    monthly: getDataset()?.monthly || [],
  })

  const rankLimite = definicao.classificacaoMinima ? (CLASS_RANK[definicao.classificacaoMinima] ?? 9) : null
  const cidade = definicao.cidade || null
  const casou = scores.filter((s) => {
    if (cidade && s.city !== cidade) return false
    if (rankLimite != null && (CLASS_RANK[s.classification] ?? 9) > rankLimite) return false
    if (definicao.scoreMax != null && s.healthScore > Number(definicao.scoreMax)) return false
    if (definicao.scoreMin != null && s.healthScore < Number(definicao.scoreMin)) return false
    const mrr = Number(s.monthlyValue) || 0
    if (definicao.mrrMin != null && mrr < Number(definicao.mrrMin)) return false
    if (definicao.mrrMax != null && mrr > Number(definicao.mrrMax)) return false
    // Régua por INDICADOR: "quem perde 10 pontos ou mais em atraso de fatura".
    // É o corte que o power user do setor realmente quer — "crítico" mistura
    // sete causas diferentes num rótulo só.
    if (definicao.indicador?.key) {
      const ind = (s.indicators || []).find((i) => i.key === definicao.indicador.key)
      if (!ind) return false
      const pts = Number(ind.points) || 0
      if (definicao.indicador.pontosMax != null && pts > Number(definicao.indicador.pontosMax)) return false
      if (definicao.indicador.pontosMin != null && pts < Number(definicao.indicador.pontosMin)) return false
    }
    return true
  })

  const jaEmPlano = emPlano ? casou.filter((s) => emPlano.has(String(s.customerId))) : []
  const novos = emPlano ? casou.filter((s) => !emPlano.has(String(s.customerId))) : casou
  const limite = Math.min(MAX_CONTRATOS_POR_PLANO, Math.max(1, Number(definicao.quantidade) || MAX_CONTRATOS_POR_PLANO))

  return {
    setor,
    selecionados: novos.slice(0, limite).map((s) => ({
      contratoId: String(s.customerId),
      nome: s.customerName,
      cidade: s.city,
      mrr: Number(s.monthlyValue) || 0,
      score: s.healthScore,
      classificacao: s.classification,
    })),
    casaram: casou.length,
    jaEmPlano: jaEmPlano.length,
    disponiveis: novos.length,
  }
}

// Uma geração: chama o provedor, valida e devolve o que gravar. Concentrada
// aqui para a rodada e a "nova tentativa" percorrerem exatamente o caminho.
async function gerarEValidar({ provedor, cfg, template, dossie }) {
  const t0 = Date.now()
  // O contrato vai ANEXADO pelo código, não escrito no template: o prompt é
  // editável pela tela, e um contrato que alguém pode apagar sem perceber não
  // é contrato. Também garante que o texto acompanhe o validador sozinho.
  const sistema = `${renderPrompt(template.conteudo, dossie)}

${contratoEmTexto()}`
  const base = { modelo: cfg.modelo || cfg.tipo, tokensEntrada: null, tokensSaida: null }

  let r
  try {
    r = await provedor.gerar({
      sistema,
      pergunta: JSON.stringify(dossie),
      schema: ACTION_PLAN_JSON_SCHEMA,
      dossie, // só o simulado usa
    })
  } catch (e) {
    return { ...base, duracaoMs: Date.now() - t0, status: 'falha_provedor', erroValidacao: e.message }
  }

  const comum = {
    modelo: r.modelo || base.modelo,
    tokensEntrada: r.tokensEntrada ?? null,
    tokensSaida: r.tokensSaida ?? null,
    duracaoMs: Date.now() - t0,
  }

  // Segunda barreira: o schema já foi pedido na origem, mas revalidamos. É o
  // que pega prompt trocado, modelo trocado e provedor que ignora o campo.
  let parsed = null
  try { parsed = JSON.parse(r.texto) } catch { parsed = null }
  if (!parsed) {
    return { ...comum, status: 'falha_schema', respostaBruta: r.texto, erroValidacao: 'A resposta não é um JSON analisável.' }
  }
  const v = validateRecommendation(parsed)
  if (!v.ok) {
    return { ...comum, status: 'falha_schema', respostaBruta: r.texto, erroValidacao: v.errors.join(' · ') }
  }
  return { ...comum, status: 'valida', resposta: v.value }
}

// Cria a rodada e dispara a geração em segundo plano. Devolve o id na hora —
// gerar 30 planos leva minutos, e segurar a requisição só produziria timeout.
export async function startRun({ setor = 'financeiro', criterio, iniciadoPor }) {
  const template = await getActiveTemplate(setor)
  if (!template) throw new Error(`Nenhum prompt ativo para o setor "${setor}". Cadastre um em Configurações.`)

  const { selecionados, criterio: usado, disponiveis } = selectClients(criterio)
  if (!selecionados.length) {
    throw new Error(`Nenhum cliente atende ao critério (classificação mínima "${usado.classificacaoMinima}").`)
  }

  const runId = await createRun({ setor, criterio: { ...usado, disponiveis } }, iniciadoPor)
  await updateRun(runId, { qtd_clientes: selecionados.length, status: 'gerando' })

  // Não aguardamos: a rodada segue e a tela acompanha por /runs/:id.
  processRun({ runId, setor, template, selecionados }).catch(async (e) => {
    await updateRun(runId, { status: 'falha', erro: e.message, concluido_em: new Date() })
  })

  return { runId, selecionados: selecionados.length, disponiveis, criterio: usado }
}

async function processRun({ runId, setor, template, selecionados }) {
  const { provedor, cfg, simulado } = provedorAtivo()

  const resultados = await mapWithConcurrency(selecionados, MAX_CONCURRENCY, async (score) => {
    const dossie = await buildDossier(score, { setor, versaoPrompt: template.versao })
    const dossierId = await insertDossier({
      runId,
      clienteId: score.customerId,
      contratoId: score.contractNumber,
      dados: dossie,
      healthScore: score.healthScore,
      classificacao: score.classification,
    })

    const out = await gerarEValidar({ provedor, cfg, template, dossie })
    await insertRecommendation({ ...out, dossierId, promptTemplateId: template.id })
    return { ok: out.status === 'valida' }
  })

  const falhas = resultados.filter((x) => !x || !x.ok).length
  await updateRun(runId, {
    status: falhas === 0 ? 'concluida' : (falhas === resultados.length ? 'falha' : 'concluida_com_falhas'),
    erro: falhas ? `${falhas} de ${resultados.length} geração(ões) falharam.` : null,
    concluido_em: new Date(),
  })
  return { total: resultados.length, falhas, simulado }
}

// Nova tentativa para UM dossiê que falhou. A geração anterior continua
// gravada (é o registro de que o prompt ou o provedor regrediu); esta entra
// como tentativa seguinte, e a tela passa a mostrar a mais recente.
export async function retryRecommendation({ dossierId, setor, dossie, tentativa }) {
  const template = await getActiveTemplate(setor)
  if (!template) throw new Error(`Nenhum prompt ativo para o setor "${setor}".`)

  const { provedor, cfg } = provedorAtivo()
  const out = await gerarEValidar({ provedor, cfg, template, dossie })
  const id = await insertRecommendation({
    ...out, dossierId, promptTemplateId: template.id, tentativa: (Number(tentativa) || 1) + 1,
  })
  return { id, status: out.status, erro: out.erroValidacao }
}

export { processRun, gerarEValidar }
