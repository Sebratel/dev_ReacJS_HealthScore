// ─────────────────────────────────────────────────────────────────────────
// Contrato em plano SOME DA LISTA, NUNCA DA CONTA.
//
// É a regra que sustenta a credibilidade da plataforma inteira. Se o filtro
// de "em plano" entrasse nos KPIs, abrir plano viraria a forma mais barata de
// melhorar o indicador: uma régua "todos os críticos" derrubaria o painel a
// zero na segunda-feira, sem um cliente atendido e sem ninguém mentir.
//
// A segunda regra, igualmente frágil em revisão de código: o crédito de plano
// anda AO LADO do score, nunca dentro. Somá-lo em `overallHealth` faria dois
// contratos com o mesmo comportamento terem notas diferentes conforme quem
// rodou plano — e o ranking passaria a ordenar por esforço declarado.
//
// Os dois erros são invisíveis em teste manual: a tela fica mais bonita nos
// dois casos. Por isso ficam travados aqui.
//
// A base é do FINANCEIRO, com atraso e renegociação de verdade, porque o
// teste precisa de contratos REALMENTE críticos. A primeira versão destes
// testes usava contratos limpos: todos davam 100/excellent, e as asserções de
// KPI comparavam zero com zero — passariam mesmo com o filtro furado.
// ─────────────────────────────────────────────────────────────────────────
import { describe, it, expect } from 'vitest'
import { runDashboard, runEngine } from './engines.mjs'
import { DEFAULT_FINANCIAL_CONFIG } from '../src/features/financial-engine/financialConfig.ts'

const base = {
  personId: '1000', name: 'Contrato',
  clientGender: '(sem gênero)', clientBirth: null,
  seller: '(sem vendedor)', sellerGender: '(sem gênero)', sellerBirth: null, sellerAdmitted: null,
  contractDate: '2024-01-01', cancellationDate: null,
  plan: 'Plano', monthlyValue: 100, paymentForm: 'Boleto',
  city: 'Cidade', neighborhood: 'Bairro',
  // A engine financeira só pontua quem tem histórico de fatura
  // (`totalInvoices > 0 || trustReleases > 0 || renegotiations > 0`). Sem
  // isto a população sai vazia e o teste inteiro vira vácuo — foi o que
  // aconteceu na primeira versão.
  onTimeInvoices: 12, lateInvoices: 0, overdueInvoices: 0, totalInvoices: 12,
  renegotiations: 0, trustReleases: 0, equipment: [], onuStatusCounts: {},
  finWorstLateDays: 0, finWorstLateKey: '', finOnTimeKey: 'antes',
  finRenegKey: 'nunca', finTrustKey: 'nunca',
  protocolCount: 0, scheduleCount: 0, slaLateCount: 0, avgSlaDays: 0, reasons: [], technicians: [],
  installProtocols: 0, installScheduleCount: 0, installSlaLateCount: 0, installAvgSlaDays: 0,
  installSaleToScheduleDays: 0, installTechnicians: [],
  relProtocolCount: 0, relRecurrenceDays: 0, relAvgOverageHours: 0, relCancelThreats: 0,
  relTypes: [], relAttendants: [],
  netSite: '', netConcentrator: '', netAccessPoint: '', netSplitter: '', netSplitterCode: '',
  netSlot: '', netPon: '', netMassiveCount: 0, netAvgOfflineMin: 0, netAvgOverageMin: 0,
}

const c = (id, mrr, extra = {}) => ({
  ...base, ...extra, clientId: id, contractNumber: id, monthlyValue: mrr,
})

// Dois críticos de propósito, e os dois ESTÃO em plano: é o caso perigoso.
// Esconder os críticos não pode derrubar `criticalCount`.
const contratos = [
  c('C-001', 100),
  c('C-002', 200, { finWorstLateKey: 'd45', finWorstLateDays: 45, finRenegKey: 'rc:rc2', renegotiations: 2 }),
  c('C-003', 300, { finWorstLateKey: 'd45', finWorstLateDays: 45 }),
  c('C-004', 400, { finWorstLateKey: 'd30', finWorstLateDays: 30, finRenegKey: 'rc:rc2', renegotiations: 2 }),
  c('C-005', 500, { finWorstLateKey: 'd5', finWorstLateDays: 5 }),
  c('C-006', 600),
]

const EM_PLANO = new Set(['C-002', 'C-004'])
const CREDITOS = new Map([['C-002', 15], ['C-004', 8]])

const opts = (extra) => ({
  configs: { financial: DEFAULT_FINANCIAL_CONFIG },
  topN: 50,
  ...extra,
})

describe('a base do teste é mesmo severa', () => {
  // Guarda contra o teste virar vácuo de novo: sem crítico e sem receita em
  // risco, tudo abaixo passaria comparando zero com zero.
  const r = runDashboard(contratos, opts({}))
  it('tem crítico e receita em risco de verdade', () => {
    expect(r.ranking.criticalCount).toBeGreaterThan(0)
    expect(r.ranking.revenueAtRiskMonthly).toBeGreaterThan(0)
  })
  it('os contratos que entram em plano são críticos', () => {
    // Não "são TODOS os críticos" — o que importa é que esconder os que vão
    // para o plano significa esconder crítico de verdade. É o caso perigoso.
    const criticos = new Set(
      r.ranking.top.filter((x) => x.classification === 'critical').map((x) => x.customerId),
    )
    for (const id of EM_PLANO) expect(criticos, `${id} não é crítico`).toContain(id)
  })
})

describe('contrato em plano de ação', () => {
  const semFiltro = runDashboard(contratos, opts({ emPlano: EM_PLANO, ocultarEmPlano: false }))
  const comFiltro = runDashboard(contratos, opts({ emPlano: EM_PLANO, ocultarEmPlano: true }))

  it('some da LISTA quando o filtro está ligado', () => {
    const idsVisiveis = comFiltro.ranking.top.map((r) => r.customerId)
    expect(idsVisiveis).not.toContain('C-002')
    expect(idsVisiveis).not.toContain('C-004')
    expect(idsVisiveis).toHaveLength(4)
  })

  // A linha de base verdadeira: uma rodada que NÃO SABE que planos existem.
  // Comparar só "com filtro × sem filtro" não basta — as duas conhecem os
  // mesmos planos, então um KPI escrito contra a PARTICIPAÇÃO (e não contra
  // o filtro) sairia errado nas duas e a igualdade passaria. Verificado por
  // mutação: trocar criticalCount por `!r.emPlano` não quebrava aquele par.
  const semSaberDePlano = runDashboard(contratos, opts({}))
  const KPIS = ['total', 'criticalCount', 'highRiskCount', 'atRiskCount',
    'revenueAtRiskMonthly', 'annualRevenueRisk']

  it('NÃO some dos KPIs — nenhum número de risco se mexe', () => {
    for (const campo of KPIS) {
      expect(comFiltro.ranking[campo], `KPI "${campo}" mudou ao esconder quem está em plano`)
        .toBe(semFiltro.ranking[campo])
    }
  })

  it('saber que o contrato está em plano não move KPI nenhum', () => {
    for (const campo of KPIS) {
      expect(comFiltro.ranking[campo], `KPI "${campo}" reagiu à participação em plano`)
        .toBe(semSaberDePlano.ranking[campo])
      expect(semFiltro.ranking[campo]).toBe(semSaberDePlano.ranking[campo])
    }
  })

  it('o painel continua acusando os críticos que escondeu', () => {
    // O contador segue marcando os 2 críticos em plano, embora a lista já
    // não os mostre: é exatamente essa discrepância que a tela precisa
    // exibir ("N críticos · 2 em plano").
    expect(comFiltro.ranking.criticalEmPlanoCount).toBe(EM_PLANO.size)
    const criticosVisiveis = comFiltro.ranking.top.filter((r) => r.classification === 'critical')
    expect(criticosVisiveis.map((r) => r.customerId)).not.toContain('C-002')
    expect(comFiltro.ranking.criticalCount).toBeGreaterThan(criticosVisiveis.length)
  })

  it('a tela consegue dizer quantos escondeu', () => {
    expect(comFiltro.ranking.emPlanoCount).toBe(2)
    expect(comFiltro.ranking.hiddenByPlan).toBe(2)
    expect(semFiltro.ranking.hiddenByPlan).toBe(0)
    expect(comFiltro.ranking.visibleTotal).toBe(4)
  })

  it('a receita em risco continua contando quem está em plano', () => {
    // O contrato em plano continua expondo MRR: ele ainda pode cancelar.
    const semNenhumPlano = runDashboard(contratos, opts({}))
    expect(comFiltro.ranking.revenueAtRiskMonthly).toBe(semNenhumPlano.ranking.revenueAtRiskMonthly)
  })
})

describe('crédito de plano', () => {
  const semCredito = runDashboard(contratos, opts({}))
  const comCredito = runDashboard(contratos, opts({ creditos: CREDITOS }))

  it('NÃO entra no score medido', () => {
    const porId = new Map(semCredito.ranking.top.map((r) => [r.customerId, r.overallHealth]))
    for (const r of comCredito.ranking.top) {
      expect(r.overallHealth, `o crédito vazou para o score de ${r.customerId}`)
        .toBe(porId.get(r.customerId))
    }
  })

  it('NÃO tira ninguém de crítico', () => {
    // C-002 tem 15 pontos de crédito. Se somassem, ele sairia de crítico —
    // e o painel melhoraria por decreto.
    expect(comCredito.ranking.criticalCount).toBe(semCredito.ranking.criticalCount)
    expect(comCredito.ranking.top.map((r) => r.customerId))
      .toEqual(semCredito.ranking.top.map((r) => r.customerId))
  })

  it('viaja ao lado, para a tela exibir os dois', () => {
    const c2 = comCredito.ranking.top.find((r) => r.customerId === 'C-002')
    expect(c2.creditoPlano).toBe(15)
    expect(comCredito.ranking.top.find((r) => r.customerId === 'C-001').creditoPlano).toBe(0)
  })
})

describe('tela de engine', () => {
  const comum = { clients: contratos, config: DEFAULT_FINANCIAL_CONFIG, pageSize: 100 }
  const semFiltro = runEngine('financial', { ...comum, emPlano: EM_PLANO, ocultarEmPlano: false })
  const comFiltro = runEngine('financial', { ...comum, emPlano: EM_PLANO, ocultarEmPlano: true })

  it('esconde da página mas não da distribuição', () => {
    expect(comFiltro.scores.map((s) => s.customerId)).not.toContain('C-002')
    expect(comFiltro.analyzed).toBe(semFiltro.analyzed)
    expect(comFiltro.distribution).toEqual(semFiltro.distribution)
    expect(comFiltro.distribution.critical).toBeGreaterThanOrEqual(EM_PLANO.size)
    expect(comFiltro.hiddenByPlan).toBe(EM_PLANO.size)
  })

  it('os agregados da engine ignoram o filtro', () => {
    expect(comFiltro.aggregates.criticalCount).toBe(semFiltro.aggregates.criticalCount)
    expect(comFiltro.aggregates.totalRevenueRisk).toBe(semFiltro.aggregates.totalRevenueRisk)
  })

  it('não contamina o cache da população entre requisições', () => {
    // `data.scores` é compartilhado por todo mundo que abre a tela. Marcar
    // "em plano" mutando aquele array faria a próxima requisição — de outro
    // usuário, com outro filtro — enxergar as marcas desta.
    const limpo = runEngine('financial', { ...comum })
    for (const s of limpo.scores) {
      expect(s.emPlano, 'marca de plano vazou para uma requisição sem plano').toBeFalsy()
    }
  })
})
