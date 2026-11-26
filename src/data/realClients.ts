import type { RealClient } from '@/types'
import { apiFetch } from '@/lib/apiClient'

export interface RealClientsMeta {
  generatedAt: string
  source: string
  fromDate: string
  sampleSize: number
  coverage?: 'full' | 'sample'
}
export interface RealTotals { clients: number; contracts: number; mrr: number }
export interface RealCityAgg { city: string; contracts: number; mrr: number }
export interface RealMonthly { month: string; onTime: number; late: number; overdue: number }
export interface RealDistinctEntry { value: string; count: number }
export interface RealValueEntry { value: number; count: number }
export interface RealCommercial {
  sellers: RealDistinctEntry[]
  plans: RealDistinctEntry[]
  values: RealValueEntry[]
  cities: RealDistinctEntry[]
  neighborhoods: RealDistinctEntry[]
  clientGenders: RealDistinctEntry[]
  sellerGenders: RealDistinctEntry[]
}
export interface RealConnection {
  models: RealDistinctEntry[]
}
export interface RealField {
  reasons: RealDistinctEntry[]
  technicians: RealDistinctEntry[]
}
export interface RealInstallation {
  technicians: RealDistinctEntry[]
}
export interface RealRelationship {
  types: RealDistinctEntry[]
  attendants: RealDistinctEntry[]
}
export interface RealNetwork {
  totalMassives: number
  splittersAffected: number
  // Listas distintas de infra (site/concentrador/…) para os índices dinâmicos.
  sites: RealDistinctEntry[]
  concentrators: RealDistinctEntry[]
  accessPoints: RealDistinctEntry[]
  splitters: RealDistinctEntry[]
  slots: RealDistinctEntry[]
  pons: RealDistinctEntry[]
}
// Retiradas de equipamento — agregados protocolo-a-protocolo (base-wide).
export interface RealWithdrawalStatus { total: number; retrieved: number }
export interface RealWithdrawalTech {
  value: string
  protocols: number
  retrieved: number
  successRate: number
  avgVisits: number
}
export interface RealWithdrawalPerson {
  name: string
  contractNumber: string
  cancellationDate: string | null
  cancellationMotive: string | null
  plan: string
  city: string
  monthlyValue: number
  protocols: number
  visits: number
  recovered: boolean
  technicians: string[]
  lastDate: string | null
}
export interface RealWithdrawalCancellation {
  cancelledTotal: number
  withWithdrawal: number
  recovered: number
  notRecovered: number
  recoveryRate: number
  avgVisits: number
  mrrAtRisk: number
  window: { from: string; to: string; months: number }
}
export interface RealWithdrawals {
  total: number
  retrieved: number
  notRetrieved: number
  successRate: number
  avgVisits: number
  contractsWithWithdrawal: number
  byStatus: { cancelled: RealWithdrawalStatus; active: RealWithdrawalStatus }
  technicians: RealWithdrawalTech[]
  visitsHistogram: { visits: string; count: number }[]
  cancellation: RealWithdrawalCancellation | null
  people: RealWithdrawalPerson[]
  peopleTotal: number
}

interface RealClientsFile {
  meta: RealClientsMeta
  totals: RealTotals
  paymentForms: string[]
  byCity: RealCityAgg[]
  monthly: RealMonthly[]
  commercial: RealCommercial
  connection: RealConnection
  field: RealField
  installation: RealInstallation
  relationship: RealRelationship
  network: RealNetwork
  withdrawals: RealWithdrawals
  clients: RealClient[]
}

const EMPTY_WITHDRAWALS: RealWithdrawals = {
  total: 0, retrieved: 0, notRetrieved: 0, successRate: 0, avgVisits: 0,
  contractsWithWithdrawal: 0,
  byStatus: { cancelled: { total: 0, retrieved: 0 }, active: { total: 0, retrieved: 0 } },
  technicians: [], visitsHistogram: [],
  cancellation: null, people: [], peopleTotal: 0,
}

// Caminho do snapshot gerado pelo job diário (scripts/fetch-clients.mjs).
// Extensão neutra (.data) para nenhum host aplicar Content-Encoding automático —
// o conteúdo é gzip e descomprimimos manualmente aqui. (~9 MB transferidos.)
const DATA_URL = '/realClients.data'

// ─── Bindings preenchidos por loadRealData() no boot (antes de renderizar o app) ───
// São live bindings ESM: os consumidores leem o valor atual em tempo de execução
// (dentro de render/useMemo/useEffect), nunca no escopo de módulo.
export let realMeta: RealClientsMeta = { generatedAt: '', source: '', fromDate: '', sampleSize: 0 }
export let realTotals: RealTotals = { clients: 0, contracts: 0, mrr: 0 }
export let realPaymentForms: string[] = []
export let realByCity: RealCityAgg[] = []
export let realMonthly: RealMonthly[] = []
export let realCommercial: RealCommercial = { sellers: [], plans: [], values: [], cities: [], neighborhoods: [], clientGenders: [], sellerGenders: [] }
export let realConnection: RealConnection = { models: [] }
export let realField: RealField = { reasons: [], technicians: [] }
export let realInstallation: RealInstallation = { technicians: [] }
export let realRelationship: RealRelationship = { types: [], attendants: [] }
export let realNetwork: RealNetwork = { totalMassives: 0, splittersAffected: 0, sites: [], concentrators: [], accessPoints: [], splitters: [], slots: [], pons: [] }
export let realWithdrawals: RealWithdrawals = EMPTY_WITHDRAWALS
export let realClients: RealClient[] = []

let loaded = false
let loadingPromise: Promise<void> | null = null

export function isRealDataLoaded() {
  return loaded
}

// Rótulo de cobertura para os rodapés das telas:
//   base completa → "base completa · 86.713 contratos"
//   amostra       → "amostra de 2.000 contratos"
export function coverageLabel(): string {
  if (realMeta.coverage === 'full') return `base completa · ${realTotals.contracts.toLocaleString('pt-BR')} contratos`
  return `amostra de ${realMeta.sampleSize.toLocaleString('pt-BR')} contratos`
}

async function decompressGzip(res: Response): Promise<string> {
  if (typeof DecompressionStream === 'undefined' || !res.body) {
    // Navegador sem DecompressionStream — tenta interpretar como texto puro
    // (caso o snapshot tenha sido servido já descomprimido).
    return res.text()
  }
  const stream = res.body.pipeThrough(new DecompressionStream('gzip'))
  return new Response(stream).text()
}

// Baixa e descomprime o snapshot completo uma única vez. Idempotente e seguro
// contra chamadas concorrentes (compartilha a mesma Promise).
export function loadRealData(): Promise<void> {
  if (loaded) return Promise.resolve()
  if (loadingPromise) return loadingPromise

  loadingPromise = (async () => {
    // Carrega apenas os METADADOS/listas (sem o array pesado de clientes) do
    // backend. As telas de ranking/dashboard/IA buscam os clientes pontuados
    // sob demanda em /api/engine/* e /api/dashboard. Boot leve e ágil.
    // Autenticado (Bearer do Google ou da sessão do Hub): a rota deixou de ser
    // pública. 401/HUB_ONLY encerram a sessão e o RequireAuth leva ao login.
    const res = await apiFetch('/api/dataset/lists', { cache: 'no-cache' })
    if (!res.ok) throw new Error(`Não foi possível carregar os metadados da base (HTTP ${res.status}). O backend (/api) está no ar?`)
    const data = JSON.parse(await res.text()) as Partial<RealClientsFile>

    realMeta = data.meta ?? realMeta
    realTotals = data.totals ?? realTotals
    realPaymentForms = data.paymentForms ?? []
    realByCity = data.byCity ?? []
    realMonthly = data.monthly ?? []
    realCommercial = data.commercial ?? realCommercial
    realConnection = data.connection ?? realConnection
    realField = data.field ?? realField
    realInstallation = data.installation ?? realInstallation
    realRelationship = data.relationship ?? realRelationship
    // Merge com defaults: snapshot antigo (pré-infra) não traz as listas
    // (sites/concentrators/…); mantê-las como [] evita `.map` de undefined.
    realNetwork = { ...realNetwork, ...(data.network ?? {}) }
    // Merge com defaults: snapshot antigo (pré-retiradas) não traz o bloco.
    realWithdrawals = { ...EMPTY_WITHDRAWALS, ...(data.withdrawals ?? {}) }
    realClients = [] // não baixamos mais a base inteira no navegador
    loaded = true
  })()

  // Em caso de erro, libera a Promise para permitir retry.
  loadingPromise.catch(() => { loadingPromise = null })
  return loadingPromise
}
