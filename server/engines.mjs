// ─────────────────────────────────────────────────────────────────────────
// Ponte backend → engines do front. Rodando sob `tsx`, o backend importa e
// executa AS MESMAS engines TS que o navegador usa (fonte única, sem
// divergência). Pontua a base materializada com a config que veio na
// requisição e devolve paginado/agregado.
//
// Filtros de população por engine = os mesmos das páginas (engineSummaries.ts).
// Rede entra normalmente aqui (a materialização tem os campos de rede da base
// ativa); o coorte de CANCELADOS de rede é que segue segurado, na outra tela.
// ─────────────────────────────────────────────────────────────────────────
import { buildFinancialEngineData } from '../src/features/financial-engine/financialEngine.ts'
import { buildCommercialEngineData } from '../src/features/commercial-engine/commercialEngine.ts'
import { buildConnectionEngineData } from '../src/features/connection-engine/connectionEngine.ts'
import { buildNetworkEngineData } from '../src/features/network-engine/networkEngine.ts'
import { buildFieldEngineData } from '../src/features/field-engine/fieldEngine.ts'
import { buildInstallationEngineData } from '../src/features/installation-engine/installationEngine.ts'
import { buildRelationshipEngineData } from '../src/features/relationship-engine/relationshipEngine.ts'
import { applyHealthThresholds, DEFAULT_HEALTH_THRESHOLDS, scoreToHealthClass } from '../src/utils/health.ts'
import { getVersion } from './dataset.mjs'

const ENGINES = {
  financial:    { base: (c) => c.totalInvoices > 0 || c.trustReleases > 0 || c.renegotiations > 0, build: buildFinancialEngineData, wantsMonthly: true },
  commercial:   { base: () => true, build: buildCommercialEngineData },
  // Conexão: entra quem tem equipamento, quedas de PPPoE OU leitura de enlace
  // (óptica / porta LAN / CPE). Sem a última condição, o cliente com sinal
  // péssimo mas sem equipamento cadastrado ficava de fora da engine inteira.
  connection:   { base: (c) => c.equipment.length > 0 || Object.values(c.onuStatusCounts || {}).some((n) => n > 0) || c.connRxPower != null || c.connLanMbps != null || !!c.connCpeModel || c.connWifiRssi != null, build: buildConnectionEngineData },
  network:      { base: (c) => c.netMassiveCount > 0 || !!c.netSite, build: buildNetworkEngineData },
  field:        { base: (c) => c.protocolCount > 0, build: buildFieldEngineData },
  installation: { base: (c) => c.installProtocols > 0, build: buildInstallationEngineData },
  relationship: { base: (c) => c.relProtocolCount > 0, build: buildRelationshipEngineData },
}

export const ENGINE_KEYS = Object.keys(ENGINES)

// ─── Cache de score (em memória) ───────────────────────────────
// Pontua a base UMA vez por (engine + config + limiares + versão do snapshot).
// Paginar/filtrar/trocar aba reusa o array pontuado (barato). Invalida sozinho
// quando a config muda (hash) ou entra o snapshot novo da madrugada (mtime).
const scoreCache = new Map()
const SCORE_CACHE_LIMIT = 24
function fnv1a(str) {
  let h = 0x811c9dc5
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) }
  return (h >>> 0).toString(36)
}
// Impressão digital BARATA da coorte. `clients.length` sozinho não identifica
// quem está dentro: duas populações diferentes do mesmo tamanho (a base de dois
// meses distintos na coorte mensal, ativos × cancelados na previsão) caíam na
// mesma entrada de cache e a segunda recebia o score da primeira — silenciosa.
// Amostra ids em passo fixo para não varrer 86 mil registros a cada chamada.
function cohortFingerprint(clients) {
  const n = clients.length
  if (!n) return '0'
  const passo = Math.max(1, Math.floor(n / 32))
  let acc = `${n}`
  for (let i = 0; i < n; i += passo) acc += `|${clients[i]?.clientId ?? ''}`
  acc += `|${clients[n - 1]?.clientId ?? ''}`
  return fnv1a(acc)
}

function scoredEngineData(key, clients, config, thresholds, monthly) {
  const eng = ENGINES[key]
  const cacheK = `${key}:${fnv1a(JSON.stringify(config))}:${fnv1a(JSON.stringify(thresholds || {}))}:${getVersion()}:${cohortFingerprint(clients)}`
  const hit = scoreCache.get(cacheK)
  if (hit) return hit
  // Miss: pontua a população inteira da engine (parte cara) e guarda.
  applyHealthThresholds(thresholds && typeof thresholds === 'object' ? thresholds : DEFAULT_HEALTH_THRESHOLDS)
  const population = clients.filter(eng.base)
  const cities = Array.from(new Set(population.map((c) => c.city).filter(Boolean))).sort((a, b) => a.localeCompare(b, 'pt-BR'))
  const data = eng.wantsMonthly ? eng.build(population, config, monthly) : eng.build(population, config)
  const entry = { population, data, cities }
  if (scoreCache.size >= SCORE_CACHE_LIMIT) scoreCache.delete(scoreCache.keys().next().value)
  scoreCache.set(cacheK, entry)
  return entry
}

// Rótulo + rota de cada engine (para o Dashboard/IA).
const ENGINE_META = {
  financial: { label: 'Financeiro', route: '/financeiro' },
  commercial: { label: 'Comercial', route: '/engine-comercial' },
  connection: { label: 'Conexão', route: '/engine-conexao' },
  network: { label: 'Rede', route: '/engine-rede' },
  field: { label: 'Campo', route: '/manutencao' },
  installation: { label: 'Instalação', route: '/engine-instalacao' },
  relationship: { label: 'Relacionamento', route: '/engine-relacionamento' },
}

// Pontua uma engine sobre a base materializada e devolve a página + agregados.
//   clients      base completa (materializada)
//   config       config de pontuação (vem da requisição, por-usuário)
//   thresholds   limiares de health (vêm da requisição; default se ausente)
//   monthly      série mensal (só usada pelo financeiro)
//   filtros:     search (nome/id/contrato), city, classification
//   paginação:   page (0-based), pageSize
export function runEngine(key, opts = {}) {
  const eng = ENGINES[key]
  if (!eng) throw new Error(`Engine desconhecida: ${key}`)
  if (!opts.config || typeof opts.config !== 'object') throw new Error('Campo "config" (objeto) é obrigatório.')

  // Pontua a população inteira (do cache) — filtros/paginação vêm depois.
  const { population, data, cities } = scoredEngineData(key, opts.clients || [], opts.config, opts.thresholds, opts.monthly || [])

  // Filtros da requisição (mesmo shape do ContractFilters) sobre a POPULAÇÃO →
  // conjunto de ids permitidos; aplicado nos scores já pontuados (barato).
  const name = String(opts.name || '').trim().toLowerCase()
  const contract = String(opts.contract || '').trim().toLowerCase()
  const city = opts.city
  let allowIds = null
  if (name || contract || city) {
    allowIds = new Set()
    for (const c of population) {
      if (name && !(c.name && c.name.toLowerCase().includes(name))) continue
      if (contract && !(String(c.contractNumber).toLowerCase().includes(contract) || String(c.clientId).toLowerCase().includes(contract))) continue
      if (city && c.city !== city) continue
      allowIds.add(c.clientId)
    }
  }
  let scores = allowIds ? data.scores.filter((s) => allowIds.has(s.customerId)) : data.scores

  // Distribuição sobre o conjunto filtrado (pré-filtro de classificação).
  const analyzed = scores.length
  const distribution = { excellent: 0, healthy: 0, attention: 0, high_risk: 0, critical: 0 }
  for (const s of scores) distribution[s.classification]++

  // Filtro por classificação + ordenação + página. Padrão: risco (pior 1º).
  // sortKey aceita qualquer campo do score, inclusive caminho aninhado
  // ("signals.lateInvoices"); arrays ordenam pelo tamanho, classification pela
  // severidade, números numericamente e o resto por localeCompare pt-BR.
  if (opts.classification) scores = scores.filter((s) => s.classification === opts.classification)

  // ─── Planos de ação ───
  // Marca quem está em plano e anexa o crédito vigente. `.map` com spread de
  // propósito: `data.scores` é o array CACHEADO da população — mutar aqui
  // contaminaria a próxima requisição de todo mundo.
  //
  // O que vem acima (`aggregates`, `distribution`, `analyzed`) já está
  // fechado: esconder é filtro de LISTA, nunca de contagem.
  const emPlano = opts.emPlano || null
  const creditos = opts.creditos || null
  if (emPlano || creditos) {
    scores = scores.map((s) => ({
      ...s,
      emPlano: emPlano ? emPlano.has(String(s.customerId)) : false,
      creditoPlano: creditos ? (creditos.get(String(s.customerId)) ?? 0) : 0,
    }))
  }
  const emPlanoCount = emPlano ? scores.filter((s) => s.emPlano).length : 0
  const hiddenByPlan = opts.ocultarEmPlano && emPlano ? emPlanoCount : 0
  if (hiddenByPlan) scores = scores.filter((s) => !s.emPlano)

  const CLASS_RANK = { critical: 0, high_risk: 1, attention: 2, healthy: 3, excellent: 4 }
  const sortKey = typeof opts.sortKey === 'string' && opts.sortKey ? opts.sortKey : null
  const dir = opts.sortDir === 'desc' ? -1 : 1
  const sortVal = (s) => {
    if (sortKey === 'classification') return CLASS_RANK[s.classification] ?? null
    let v = s
    for (const part of sortKey.split('.')) {
      if (v == null || typeof v !== 'object') return null
      v = v[part]
    }
    if (Array.isArray(v)) return v.length
    return v ?? null
  }
  scores = scores.slice().sort((a, b) => {
    if (!sortKey) return a.healthScore - b.healthScore
    const va = sortVal(a)
    const vb = sortVal(b)
    if (va == null && vb == null) return 0
    if (va == null) return 1
    if (vb == null) return -1
    if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * dir
    return String(va).localeCompare(String(vb), 'pt-BR') * dir
  })

  const total = scores.length
  // Teto 2000 — a paginação normal usa 10; o "Ver dados" pede lotes maiores
  // (seletor de quantidade). 2000 cobre o export sem estourar o payload.
  const pageSize = Math.min(2000, Math.max(1, Number(opts.pageSize) || 25))
  const page = Math.max(0, Number(opts.page) || 0)
  const pageScores = scores.slice(page * pageSize, page * pageSize + pageSize)

  const { scores: _omit, ...aggregates } = data
  return {
    aggregates, distribution, cities, scores: pageScores, total, analyzed,
    populationTotal: population.length, page, pageSize, emPlanoCount, hiddenByPlan,
  }
}

// ─── Score de TODOS os clientes (para o histórico/timeline) ────
// Igual à primeira metade do runDashboard, porém devolve o overall + os scores
// por engine de CADA cliente (não só o topN). Usado pelo job score-history.mjs
// com a config oficial. Reaproveita o cache de scoredEngineData.
export function scoreAllClients(clients, opts = {}) {
  const { configs = {}, thresholds, monthly = [] } = opts
  applyHealthThresholds(thresholds && typeof thresholds === 'object' ? thresholds : DEFAULT_HEALTH_THRESHOLDS)

  const byClient = new Map()
  for (const key of ENGINE_KEYS) {
    const cfg = configs[key]
    if (!cfg) continue
    const { data } = scoredEngineData(key, clients, cfg, thresholds, monthly)
    for (const s of data.scores) {
      let e = byClient.get(s.customerId)
      if (!e) { e = { customerId: s.customerId, sum: 0, count: 0, byEngine: {} }; byClient.set(s.customerId, e) }
      e.sum += s.healthScore; e.count++
      e.byEngine[key] = Math.round(s.healthScore)
    }
  }

  const clientById = new Map(clients.map((c) => [c.clientId, c]))
  const out = []
  for (const e of byClient.values()) {
    const overall = Math.round(e.sum / Math.max(1, e.count))
    const c = clientById.get(e.customerId)
    out.push({
      clientId: e.customerId,
      contractNumber: c?.contractNumber || '',
      overall,
      classification: scoreToHealthClass(overall),
      enginesPresent: e.count,
      byEngine: e.byEngine,
    })
  }
  return out
}

// ─── Score de UMA engine para TODOS os clientes ────────────────
// runEngine devolve uma página; isto devolve o array inteiro, reusando o mesmo
// cache. Usado pela reavaliação de impacto dos Planos de Ação, que precisa
// comparar o score de hoje com o congelado no dossiê — e comparar exige a
// MESMA régua (mesma engine, mesma config), não um score aproximado.
export function scoreEngineAllClients(key, opts = {}) {
  const eng = ENGINES[key]
  if (!eng) throw new Error(`Engine desconhecida: ${key}`)
  if (!opts.config || typeof opts.config !== 'object') throw new Error('Campo "config" (objeto) é obrigatório.')
  const { data } = scoredEngineData(key, opts.clients || [], opts.config, opts.thresholds, opts.monthly || [])
  return data.scores
}

// ─── Dashboard / IA — roda as 7 engines e combina o risco por cliente ──
// Substitui o cálculo client-side (useEngineSummaries + buildClientRiskRanking)
// que hoje roda no navegador sobre a base inteira.
export function runDashboard(clients, opts = {}) {
  const {
    configs = {}, thresholds, monthly = [], name, contract, city, classification, topN = 12,
    // Planos de ação. Vêm do MariaDB da aplicação e são OPCIONAIS: sem banco,
    // o dashboard roda igual, com ninguém em plano e crédito zero.
    //   emPlano  Set<contratoId> com permanência aberta
    //   creditos Map<contratoId, pontos> de crédito vigente
    emPlano = null, creditos = null, ocultarEmPlano = false,
  } = opts
  applyHealthThresholds(thresholds && typeof thresholds === 'object' ? thresholds : DEFAULT_HEALTH_THRESHOLDS)

  const summaries = []
  const byClient = new Map()

  for (const key of ENGINE_KEYS) {
    const cfg = configs[key]
    if (!cfg) continue // sem config para a engine → pula
    const { data } = scoredEngineData(key, clients, cfg, thresholds, monthly) // reusa o cache

    const distribution = { excellent: 0, healthy: 0, attention: 0, high_risk: 0, critical: 0 }
    for (const s of data.scores) distribution[s.classification]++
    summaries.push({
      key, label: ENGINE_META[key].label, route: ENGINE_META[key].route,
      analyzed: data.scores.length,
      avgHealthScore: data.avgHealthScore, avgChurnRisk: data.avgChurnRisk,
      totalRevenueRisk: data.totalRevenueRisk, criticalCount: data.criticalCount, highRiskCount: data.highRiskCount,
      distribution,
    })

    for (const s of data.scores) {
      let e = byClient.get(s.customerId)
      if (!e) { e = { customerId: s.customerId, customerName: s.customerName, city: s.city, plan: s.plan, monthlyValue: s.monthlyValue, sum: 0, count: 0, byEngine: [] }; byClient.set(s.customerId, e) }
      e.sum += s.healthScore; e.count++
      e.byEngine.push({ key, label: ENGINE_META[key].label, healthScore: s.healthScore, classification: s.classification })
    }
  }

  // Contrato por cliente (base deduplicada por client_id → 1 contrato/cliente)
  // — anexado ao ranking p/ o filtro por nº de contrato funcionar.
  const clientById = new Map(clients.map((c) => [c.clientId, c]))

  // Ranking combinado (health médio dos módulos em que o cliente aparece).
  const ranking = []
  for (const e of byClient.values()) {
    const overallHealth = Math.round(e.sum / Math.max(1, e.count))
    const overallChurnRisk = 100 - overallHealth
    ranking.push({
      customerId: e.customerId, customerName: e.customerName, city: e.city, plan: e.plan, monthlyValue: e.monthlyValue,
      contractNumber: clientById.get(e.customerId)?.contractNumber || '',
      overallHealth, overallChurnRisk, classification: scoreToHealthClass(overallHealth),
      revenueRisk: (overallChurnRisk / 100) * e.monthlyValue, enginesPresent: e.count, byEngine: e.byEngine,
      // O crédito de plano anda AO LADO do score medido, nunca somado dentro
      // dele: `overallHealth` e `classification` continuam vindo só das
      // engines. Quem exibe mostra os dois; quem rankeia usa o medido.
      emPlano: emPlano ? emPlano.has(String(e.customerId)) : false,
      creditoPlano: creditos ? (creditos.get(String(e.customerId)) ?? 0) : 0,
    })
  }
  ranking.sort((a, b) => a.overallHealth - b.overallHealth)

  const isAtRisk = (r) => r.classification === 'critical' || r.classification === 'high_risk'
  const revenueAtRiskMonthly = ranking.filter(isAtRisk).reduce((a, r) => a + r.revenueRisk, 0)
  const stats = {
    total: ranking.length,
    criticalCount: ranking.filter((r) => r.classification === 'critical').length,
    highRiskCount: ranking.filter((r) => r.classification === 'high_risk').length,
    atRiskCount: ranking.filter(isAtRisk).length,
    revenueAtRiskMonthly,
    annualRevenueRisk: revenueAtRiskMonthly * 12,
    // Contados sobre o ranking INTEIRO, mesmo quando a lista os esconde: é o
    // que permite a tela dizer "1.319 críticos · 214 em plano" em vez de
    // simplesmente mostrar 1.105 e ninguém notar a diferença.
    emPlanoCount: ranking.filter((r) => r.emPlano).length,
    criticalEmPlanoCount: ranking.filter((r) => r.emPlano && r.classification === 'critical').length,
  }

  const baseCounts = {
    cancelThreats: clients.filter((c) => c.relCancelThreats > 0).length,
    overdueClients: clients.filter((c) => c.lateInvoices + c.overdueInvoices > 0).length,
    slaLateClients: clients.filter((c) => c.slaLateCount > 0).length,
    massiveClients: clients.filter((c) => c.netMassiveCount > 0).length,
  }

  // Filtros (nome/contrato/cidade/classificação) escopam a lista visível — não os KPIs.
  const nm = String(name || '').trim().toLowerCase()
  const ct = String(contract || '').trim().toLowerCase()
  let visible = ranking
  if (nm) visible = visible.filter((r) => r.customerName && r.customerName.toLowerCase().includes(nm))
  if (ct) visible = visible.filter((r) => String(r.customerId).toLowerCase().includes(ct) || String(r.contractNumber).toLowerCase().includes(ct))
  if (city) visible = visible.filter((r) => r.city === city)
  if (classification) visible = visible.filter((r) => r.classification === classification)
  // Contrato em plano sai da LISTA, nunca dos KPIs: `stats` já foi fechado
  // sobre o ranking inteiro, algumas linhas acima. Se o filtro valesse lá,
  // abrir plano seria a forma mais barata de melhorar o indicador.
  const hiddenByPlan = ocultarEmPlano ? visible.filter((r) => r.emPlano).length : 0
  if (ocultarEmPlano) visible = visible.filter((r) => !r.emPlano)
  const top = visible.slice(0, topN)

  // Sinais brutos por cliente do topo (para a explicação de IA).
  const topWithSignals = top.map((r) => {
    const c = clientById.get(r.customerId)
    return {
      ...r,
      signals: c ? {
        overdue: c.lateInvoices + c.overdueInvoices, relCancelThreats: c.relCancelThreats,
        renegotiations: c.renegotiations, netMassiveCount: c.netMassiveCount,
        slaLateCount: c.slaLateCount, trustReleases: c.trustReleases,
      } : null,
    }
  })

  // Radar: média do score de cada engine no grupo do topo.
  const radar = summaries.map((sm) => {
    const vals = top.flatMap((r) => r.byEngine.filter((b) => b.key === sm.key).map((b) => b.healthScore))
    return { metric: sm.label, value: vals.length ? Math.round(vals.reduce((a, v) => a + v, 0) / vals.length) : 0 }
  })

  const globalHealth = summaries.length ? Math.round(summaries.reduce((a, s) => a + s.avgHealthScore, 0) / summaries.length) : 0
  const cities = Array.from(new Set(clients.map((c) => c.city).filter(Boolean))).sort((a, b) => a.localeCompare(b, 'pt-BR'))

  return {
    summaries, globalHealth,
    ranking: { ...stats, visibleTotal: visible.length, hiddenByPlan, top: topWithSignals, radar },
    baseCounts, cities,
  }
}
