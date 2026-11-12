// Cliente do endpoint /api/dashboard — roda as 7 engines + ranking combinado no
// backend (config/limiares do usuário viajam na requisição). Substitui o cálculo
// client-side (useEngineSummaries + buildClientRiskRanking).
import type { HealthClassification } from '@/types'
import { apiFetch } from '@/lib/apiClient'
import { pruneEngineConfigs } from '@/lib/pruneConfig'
import { ApiError, type EngineMeta } from '@/features/engines/engineApi'

export { ApiError }

export interface DashboardSummary {
  key: string
  label: string
  route: string
  analyzed: number
  avgHealthScore: number
  avgChurnRisk: number
  totalRevenueRisk: number
  criticalCount: number
  highRiskCount: number
  distribution: Record<HealthClassification, number>
}

export interface RankedClient {
  customerId: string
  customerName: string
  contractNumber: string
  city: string
  plan: string
  monthlyValue: number
  overallHealth: number
  overallChurnRisk: number
  classification: HealthClassification
  revenueRisk: number
  enginesPresent: number
  /** Tem permanência aberta em algum plano de ação. */
  emPlano: boolean
  /**
   * Crédito de plano vigente, em pontos. Anda AO LADO de `overallHealth`,
   * nunca somado dentro dele: a tela exibe os dois, o ranking usa o medido.
   */
  creditoPlano: number
  byEngine: { key: string; label: string; healthScore: number; classification: HealthClassification }[]
  signals: { overdue: number; relCancelThreats: number; renegotiations: number; netMassiveCount: number; slaLateCount: number; trustReleases: number } | null
}

export interface DashboardResponse {
  summaries: DashboardSummary[]
  globalHealth: number
  ranking: {
    total: number
    criticalCount: number
    highRiskCount: number
    atRiskCount: number
    revenueAtRiskMonthly: number
    annualRevenueRisk: number
    visibleTotal: number
    /**
     * Contados sobre a base INTEIRA, mesmo quando a lista os esconde. São
     * eles que permitem a tela dizer "1.319 críticos · 214 em plano" em vez
     * de mostrar 1.105 e ninguém notar a diferença.
     */
    emPlanoCount: number
    criticalEmPlanoCount: number
    /** Quantos o filtro tirou da lista nesta requisição. */
    hiddenByPlan: number
    top: RankedClient[]
    radar: { metric: string; value: number }[]
  }
  baseCounts: { cancelThreats: number; overdueClients: number; slaLateClients: number; massiveClients: number }
  cities: string[]
  /** Estado do módulo de Planos. `disponivel: false` = banco fora; nada quebra. */
  planos: { disponivel: boolean; total: number; porSetor: Record<string, number> }
  meta: EngineMeta
  monthly: { month: string; onTime: number; late: number; overdue: number }[]
}

export interface DashboardParams {
  configs: Record<string, unknown>
  thresholds: unknown
  name?: string
  contract?: string
  city?: string
  classification?: string
  topN?: number
  /**
   * Esconde da LISTA quem está em plano de ação. Ligado por padrão no
   * servidor (`!== false`): a tela operacional não repete quem já está sendo
   * tratado. Os KPIs nunca mudam com isto.
   */
  ocultarEmPlano?: boolean
}

export async function fetchDashboard(params: DashboardParams): Promise<DashboardResponse> {
  // Poda índices zerados dos configs — corpo cai de MBs para KB (base completa).
  const payload = { ...params, configs: pruneEngineConfigs(params.configs) }
  const res = await apiFetch('/api/dashboard', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
  })
  let body: unknown = null
  try { body = await res.json() } catch { /* sem corpo */ }
  if (!res.ok) {
    const msg = (body as { error?: string })?.error
    if (res.status === 503) throw new ApiError(503, msg || 'Base ainda não materializada no backend.')
    throw new ApiError(res.status, msg || `Erro ${res.status} no servidor.`)
  }
  return body as DashboardResponse
}
