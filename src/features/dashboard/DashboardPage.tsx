import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Activity, AlertTriangle, DollarSign, Users, Gauge as GaugeIcon, ChevronRight, Brain, Loader2, Lock, RefreshCw, ListFilter, ClipboardCheck, Eye, EyeOff } from 'lucide-react'
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell } from 'recharts'
import { KpiCard } from '@/components/ui/KpiCard'
import { MonthlyCohortCard } from './MonthlyCohortCard'
import { RECEITA_RISCO_DEF } from './revenueAtRisk'
import { Card, CardHeader } from '@/components/ui/Card'
import { HealthGauge, scoreToHealthClass } from '@/components/ui/HealthGauge'
import { HEALTH_LABELS, softenColor, type HealthPalette } from '@/utils/healthColors'
import { useHealthColors } from '@/hooks/useHealthColors'
import { useChartTokens } from '@/hooks/useChartTokens'
import { formatCurrency, cn } from '@/utils/cn'
import { useAppStore } from '@/store/appStore'
import { coverageLabelFromMeta } from '@/features/engines/engineApi'
import { fetchDashboard, ApiError, type DashboardResponse } from './dashboardApi'
import type { HealthClassification } from '@/types'
import ScoreTimeline from '@/features/score-history/ScoreTimeline'
import { ContractFilters, type ContractFilterState } from '@/components/ui/ContractFilters'
import { WorstHealthModal } from './WorstHealthModal'

const DIST_ORDER: HealthClassification[] = ['critical', 'high_risk', 'attention', 'healthy', 'excellent']
// Recebe a paleta por parâmetro: hooks só podem ser chamados dentro de componentes.
const scoreColor = (palette: HealthPalette, v: number) => palette[scoreToHealthClass(v)]

const CompTooltip = ({ active, payload, label }: any) => {
  if (!active || !payload?.length) return null
  return (
    <div className="bg-surface-container-low border border-outline rounded-lg p-2.5 text-xs shadow-xl">
      <p className="text-on-surface/70 mb-1 font-medium">{label}</p>
      <p style={{ color: payload[0].color }}>Health Score: <strong>{payload[0].value}</strong></p>
    </div>
  )
}

function DistBar({ dist, total }: { dist: Record<HealthClassification, number>; total: number }) {
  const palette = useHealthColors()
  if (!total) return <div className="h-1.5 rounded-full bg-outline" />
  return (
    <div className="flex h-1.5 rounded-full overflow-hidden gap-px">
      {DIST_ORDER.map((cls) => {
        const pct = (dist[cls] / total) * 100
        if (pct <= 0) return null
        return <div key={cls} className="h-full" style={{ width: `${pct}%`, background: palette[cls] }} title={`${HEALTH_LABELS[cls]}: ${dist[cls]}`} />
      })}
    </div>
  )
}

type RiskItem = DashboardResponse['ranking']['top'][number]

// Linha do ranking de risco — clicável, abre a timeline de health do cliente.
function RiskRow({ c, rank }: { c: RiskItem; rank: number }) {
  const [open, setOpen] = useState(false)
  const palette = useHealthColors()
  const color = palette[c.classification]
  return (
    <div>
      <div className="flex items-center gap-3 px-5 py-2.5 cursor-pointer hover:bg-surface-container-low/60 transition-colors" onClick={() => setOpen((v) => !v)}>
        <span className="text-[10px] font-mono text-on-surface-variant/90 w-4">{rank}</span>
        <div className="w-8 h-8 rounded-full border flex items-center justify-center text-[11px] font-bold shrink-0" style={{ backgroundColor: softenColor(color, 0.08), borderColor: softenColor(color, 0.19), color }}>{c.customerName[0]}</div>
        <div className="flex-1 min-w-0">
          <p className="text-xs font-semibold text-on-surface truncate">{c.customerName}</p>
          <p className="text-[10px] text-on-surface-variant">
            {c.contractNumber && <><span className="font-mono text-on-surface/70" title="Nº do contrato">#{c.contractNumber}</span> · </>}{c.city} · {c.plan}
          </p>
        </div>
        <div className="hidden sm:flex flex-col items-center"><span className="text-[9px] text-on-surface-variant/90">{c.enginesPresent} módulos</span></div>
        {c.emPlano && (
          <span className="hidden md:inline text-[9px] font-semibold px-1.5 py-0.5 rounded bg-primary/10 text-primary-strong shrink-0" title="Tem plano de ação em andamento">
            em plano
          </span>
        )}
        {/* O crédito aparece AO LADO do score medido, nunca somado dentro
            dele. Quem lê a tela vê de onde veio cada ponto — e vê o crédito
            sumir sozinho quando vence, se o score medido não tiver subido. */}
        <div className="flex flex-col items-end">
          <span className="flex items-baseline gap-1 leading-none">
            <span style={{ color }} className="text-sm font-bold tabular-nums">{c.overallHealth}</span>
            {c.creditoPlano > 0 && (
              <span className="text-[10px] font-semibold text-primary tabular-nums" title={`+${c.creditoPlano} de crédito de plano, por prazo determinado — não entra no score medido`}>
                +{c.creditoPlano}
              </span>
            )}
          </span>
          <span className="text-[9px] text-on-surface-variant/90">{c.creditoPlano > 0 ? 'health medido' : 'health'}</span>
        </div>
        <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded" style={{ color, background: `${color}15` }}>{HEALTH_LABELS[c.classification]}</span>
      </div>
      {open && (
        <div className="px-5 pb-3 pt-1 bg-surface-container-low/40">
          <ScoreTimeline clientId={c.customerId} />
        </div>
      )}
    </div>
  )
}

export default function DashboardPage() {
  const navigate = useNavigate()
  const tokens = useChartTokens()
  const palette = useHealthColors()
  const financialConfig = useAppStore((s) => s.financialConfig)
  const commercialConfig = useAppStore((s) => s.commercialConfig)
  const connectionConfig = useAppStore((s) => s.connectionConfig)
  const networkConfig = useAppStore((s) => s.networkConfig)
  const fieldConfig = useAppStore((s) => s.fieldConfig)
  const installationConfig = useAppStore((s) => s.installationConfig)
  const relationshipConfig = useAppStore((s) => s.relationshipConfig)
  const thresholds = useAppStore((s) => s.healthThresholds)

  const [data, setData] = useState<DashboardResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<ApiError | null>(null)
  const [reloadKey, setReloadKey] = useState(0)
  const [worstOpen, setWorstOpen] = useState(false)

  // Filtro de cliente/contrato/cidade — mesmo componente das demais telas.
  // Escopa a lista de "Maior Risco" (KPIs/resumos seguem globais). Nome/contrato
  // com debounce (350ms); cidade é seleção, aplica na hora.
  const [filters, setFilters] = useState<ContractFilterState>({ contract: '', name: '', city: '' })
  const [debounced, setDebounced] = useState({ contract: '', name: '' })
  useEffect(() => {
    const t = setTimeout(() => setDebounced({ contract: filters.contract, name: filters.name }), 350)
    return () => clearTimeout(t)
  }, [filters.contract, filters.name])
  const hasFilter = !!(debounced.contract || debounced.name || filters.city)

  // Esconde da LISTA quem já está em plano de ação — ligado por padrão, para
  // a operação não repetir quem está sendo tratado. Não mexe em KPI nenhum:
  // os contadores acima seguem sobre a base inteira, e o rodapé da lista diz
  // quantos ficaram de fora. Ver server/planoFiltro.test.mjs.
  const [ocultarEmPlano, setOcultarEmPlano] = useState(true)

  useEffect(() => {
    let alive = true
    setLoading(true)
    const configs = { financial: financialConfig, commercial: commercialConfig, connection: connectionConfig, network: networkConfig, field: fieldConfig, installation: installationConfig, relationship: relationshipConfig }
    // Ao filtrar, sobe o topN para trazer todos os resultados do filtro (não só o top 8).
    fetchDashboard({ configs, thresholds, name: debounced.name, contract: debounced.contract, city: filters.city, topN: hasFilter ? 50 : 8, ocultarEmPlano })
      .then((d) => { if (alive) { setData(d); setError(null) } })
      .catch((e) => { if (alive) setError(e instanceof ApiError ? e : new ApiError(0, 'Erro inesperado.')) })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [financialConfig, commercialConfig, connectionConfig, networkConfig, fieldConfig, installationConfig, relationshipConfig, thresholds, reloadKey, debounced, filters.city, hasFilter, ocultarEmPlano])

  const compData = useMemo(
    () => (data ? data.summaries.map((e) => ({ name: e.label, score: e.avgHealthScore })).sort((a, b) => a.score - b.score) : []),
    [data],
  )

  if (loading && !data) {
    return <div className="flex items-center gap-2 rounded-xl border border-outline bg-surface-container-lowest px-5 py-16 text-sm text-on-surface/70 animate-slide-up"><Loader2 size={16} className="animate-spin" /> Calculando os scores no servidor…</div>
  }
  if (error && !data) {
    return (
      <div className="rounded-xl border border-outline bg-surface-container-lowest px-5 py-6 space-y-3 animate-slide-up">
        <div className="flex items-start gap-2.5 text-sm text-risk-critical">
          {error.status === 401 ? <Lock size={16} className="mt-0.5 shrink-0" /> : <AlertTriangle size={16} className="mt-0.5 shrink-0" />}
          <div>
            <p className="font-medium text-on-surface">{error.status === 0 ? 'Servidor indisponível' : error.status === 401 ? 'Sessão expirada' : 'Não foi possível carregar o dashboard'}</p>
            <p className="mt-0.5 text-[12px] text-on-surface/70">{error.message}</p>
            {error.status === 0 && <p className="mt-1.5 text-[11px] text-on-surface-variant">Depende do backend (<span className="font-mono">/api</span>). Suba com <span className="font-mono">npm run api</span>.</p>}
          </div>
        </div>
        <button onClick={() => setReloadKey((k) => k + 1)} className="flex items-center gap-1.5 rounded-md border border-outline px-3 py-1.5 text-[12px] text-on-surface/85 hover:border-outline-strong hover:text-on-surface transition-colors"><RefreshCw size={13} /> Tentar novamente</button>
      </div>
    )
  }
  if (!data) return null

  const totals = data.meta.totals
  const globalHealth = data.globalHealth
  const enginesAtRisk = data.summaries.filter((e) => e.avgHealthScore < 60).length
  const rk = data.ranking

  return (
    <div className="space-y-6 animate-slide-up">
      {/* Filtro de cliente/contrato — escopa a lista de Maior Risco (panorama do cliente) */}
      <ContractFilters
        filters={filters}
        onChange={setFilters}
        cities={data?.cities ?? []}
        resultCount={data?.ranking.visibleTotal}
        totalCount={data?.ranking.total}
      />
      {/* Quem está em plano de ação.
          A barra aparece SEMPRE que existe alguém em plano, inclusive com o
          filtro desligado: o número precisa estar à vista para que esconder
          nunca vire maquiar. Os KPIs abaixo seguem sobre a base inteira. */}
      {data && data.planos?.disponivel && data.ranking.emPlanoCount > 0 && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-xl border border-outline bg-surface-container-lowest px-3 py-2 -mb-2">
          <ClipboardCheck size={13} className="text-primary-strong shrink-0" />
          <p className="text-[11px] text-on-surface-variant flex-1 min-w-[16rem]">
            <span className="font-mono font-semibold text-on-surface">
              {data.ranking.emPlanoCount.toLocaleString('pt-BR')}
            </span>{' '}
            contrato(s) em plano de ação
            {data.ranking.criticalEmPlanoCount > 0 && (
              <> · <span className="font-mono text-risk-critical">{data.ranking.criticalEmPlanoCount}</span> deles críticos</>
            )}
            {ocultarEmPlano
              ? <> — ocultos da lista abaixo, <span className="font-semibold">mas contados nos indicadores</span>.</>
              : <> — aparecendo na lista abaixo.</>}
          </p>
          <button
            type="button"
            onClick={() => setOcultarEmPlano((v) => !v)}
            className="flex items-center gap-1.5 text-[11px] font-semibold text-primary hover:text-primary-strong transition-colors shrink-0"
          >
            {ocultarEmPlano ? <Eye size={12} /> : <EyeOff size={12} />}
            {ocultarEmPlano ? 'Mostrar na lista' : 'Ocultar da lista'}
          </button>
        </div>
      )}
      {loading && <div className="flex items-center justify-end gap-1.5 text-[11px] text-on-surface-variant -mb-3"><Loader2 size={11} className="animate-spin" /> atualizando…</div>}
      {/* KPIs */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {/* A unidade do sistema é o CONTRATO: é ele que cancela, que tem plano,
            endereço e nota. A pessoa vira subtítulo — quem tem 3 contratos e
            cancela 1 precisa aparecer como 1 saída, não como nada. */}
        <KpiCard label="Contratos Ativos" value={(totals?.contracts ?? 0).toLocaleString('pt-BR')} subtitle={`Ticket médio ${formatCurrency((totals?.mrr ?? 0) / Math.max(1, totals?.contracts ?? 0))}`} icon={<Users size={14} />} variant="brand" />
        <KpiCard label="MRR (Base Ativa)" value={formatCurrency(totals?.mrr ?? 0)} subtitle="Receita recorrente mensal" icon={<DollarSign size={14} />} variant="success" iconColor="text-risk-low" />
        <KpiCard label="Health Score Global" value={`${globalHealth}/100`} subtitle="Média dos 7 módulos" icon={<Activity size={14} />} variant={globalHealth < 50 ? 'danger' : globalHealth < 70 ? 'warning' : 'success'} iconColor={globalHealth < 50 ? 'text-risk-critical' : 'text-risk-low'} />
        <KpiCard label="Contratos em Risco" value={rk.atRiskCount.toLocaleString('pt-BR')} subtitle={`Receita em risco: ${formatCurrency(rk.revenueAtRiskMonthly)}/mês`} hint={RECEITA_RISCO_DEF} icon={<AlertTriangle size={14} />} variant="danger" iconColor="text-risk-critical" />
      </div>

      {/* Assertividade — a plataforma acerta? Fica na primeira dobra de
          propósito: é o número que a operação abre para ver. */}
      <MonthlyCohortCard />

      {/* Resumo por engine */}
      <div>
        <div className="flex items-center gap-2 mb-3">
          <GaugeIcon size={14} className="text-primary-strong" />
          <h2 className="text-sm font-bold text-on-surface">Resumo dos Health Scores por Módulo</h2>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {data.summaries.map((e) => {
            const cls = scoreToHealthClass(e.avgHealthScore)
            return (
              <button key={e.key} onClick={() => navigate(e.route)} className="text-left bg-surface-container-lowest border border-outline rounded-2xl p-4 shadow-card hover:shadow-card-md hover:border-outline-strong hover:-translate-y-0.5 transition-all duration-200 group">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs font-bold text-on-surface">{e.label}</span>
                  <ChevronRight size={13} className="text-on-surface-variant/90 group-hover:text-primary transition-colors" />
                </div>
                <div className="flex items-center gap-3">
                  <HealthGauge score={Math.round(e.avgHealthScore)} size={72} showLabel={false} />
                  <div className="flex-1 min-w-0">
                    <p className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: palette[cls] }}>{HEALTH_LABELS[cls]}</p>
                    <p className="text-[10px] text-on-surface-variant mt-0.5">{e.analyzed.toLocaleString('pt-BR')} analisados</p>
                    <p className="text-[10px] text-on-surface-variant">
                      <span className="text-risk-critical font-mono">{e.criticalCount}</span> crít. ·{' '}
                      <span className="text-risk-high font-mono">{e.highRiskCount}</span> alto
                    </p>
                  </div>
                </div>
                <div className="mt-3"><DistBar dist={e.distribution} total={e.analyzed} /></div>
              </button>
            )
          })}

          <div className="bg-gradient-to-br from-primary/10 to-secondary/10 border border-primary/25 rounded-2xl p-4 flex flex-col items-center justify-center">
            <p className="text-[10px] text-on-surface/70 uppercase tracking-widest mb-1">Health Global</p>
            <HealthGauge score={globalHealth} size={96} />
            <p className="text-[10px] text-on-surface-variant mt-1">{enginesAtRisk} de {data.summaries.length} módulos abaixo de 60</p>
          </div>
        </div>
      </div>

      {/* Comparação + maiores riscos */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card>
          <CardHeader title="Comparação de Health Score por Módulo" subtitle="Média do score de cada módulo" icon={<GaugeIcon size={14} />} />
          <div className="p-4 h-64">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={compData} layout="vertical" margin={{ top: 4, right: 16, left: 24, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke={tokens.grid} horizontal={false} />
                <XAxis type="number" domain={[0, 100]} tick={{ fill: tokens.axis, fontSize: 10 }} axisLine={false} tickLine={false} />
                <YAxis type="category" dataKey="name" tick={{ fill: tokens.axisStrong, fontSize: 11 }} axisLine={false} tickLine={false} width={92} />
                <Tooltip content={<CompTooltip />} cursor={{ fill: softenColor(tokens.onSurface, 0.05) }} />
                <Bar dataKey="score" name="Health Score" radius={[0, 4, 4, 0]} barSize={18}>
                  {compData.map((d, i) => <Cell key={i} fill={scoreColor(palette, d.score)} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Card>

        <Card>
          <CardHeader
            title={hasFilter ? 'Clientes no filtro' : 'Clientes com Maior Risco'}
            subtitle={hasFilter ? `${rk.visibleTotal.toLocaleString('pt-BR')} cliente(s) · clique para ver o panorama` : 'Score combinado por cliente · clique para ver o panorama'}
            icon={<AlertTriangle size={14} />}
            action={
              <div className="flex items-center gap-3">
                <button onClick={() => setWorstOpen(true)} className="text-[11px] text-primary hover:text-primary-container flex items-center gap-1"><ListFilter size={11} /> Ver todos / Exportar</button>
                <button onClick={() => navigate('/ia')} className="text-[11px] text-primary hover:text-primary-container flex items-center gap-1"><Brain size={11} /> Análise de IA →</button>
              </div>
            }
          />
          <div className="divide-y divide-outline">
            {rk.top.map((c, i) => <RiskRow key={c.customerId} c={c} rank={i + 1} />)}
            {rk.top.length === 0 && (
              <div className="px-5 py-10 text-center text-xs text-on-surface-variant">
                {hasFilter ? 'Nenhum cliente encontrado com esse filtro.' : 'Sem clientes para exibir.'}
              </div>
            )}
          </div>
        </Card>
      </div>

      <p className="text-[10px] text-on-surface-variant text-center">
        {coverageLabelFromMeta(data.meta)} · pontuado no servidor · atualizado em {data.meta.generatedAt ? new Date(data.meta.generatedAt).toLocaleString('pt-BR') : '—'}
      </p>

      <WorstHealthModal open={worstOpen} onClose={() => setWorstOpen(false)} cities={data.cities} />
    </div>
  )
}
