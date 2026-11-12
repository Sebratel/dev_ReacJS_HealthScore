import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  ClipboardList, Plus, Loader2, AlertTriangle, RefreshCw, Info, Database,
  ShieldCheck, FlaskConical, ChevronLeft, Target, X,
} from 'lucide-react'
import { Card, CardHeader } from '@/components/ui/Card'
import { KpiCard } from '@/components/ui/KpiCard'
import { cn } from '@/utils/cn'
import { useAuthStore, hasRole } from '@/store/authStore'
import {
  getModuleStatus, listRuns, listRecommendations, ApiError,
  type ModuleStatus, type Run, type Recommendation,
} from './actionPlansApi'
import { NewRunDialog } from './NewRunDialog'
import { NewPlanDialog } from './NewPlanDialog'
import { RecommendationRow } from './RecommendationRow'
import { TasksPanel } from './TasksPanel'

type Aba = 'rodadas' | 'tarefas'

const RUN_STATUS_LABEL: Record<string, string> = {
  pendente: 'Na fila',
  gerando: 'Gerando…',
  concluida: 'Concluída',
  concluida_com_falhas: 'Concluída com falhas',
  falha: 'Falhou',
}

const fmtData = (iso: string | null) =>
  !iso ? '—' : new Date(iso.replace(' ', 'T')).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })

export default function ActionPlansPage() {
  const role = useAuthStore((s) => s.role)
  const podeDecidir = hasRole(role, 'power_user')

  const [aba, setAba] = useState<Aba>('rodadas')
  const [status, setStatus] = useState<ModuleStatus | null>(null)
  const [statusErro, setStatusErro] = useState<string | null>(null)
  const [runs, setRuns] = useState<Run[] | null>(null)
  const [runsErro, setRunsErro] = useState<string | null>(null)
  const [abrindo, setAbrindo] = useState<number | null>(null)
  const [recs, setRecs] = useState<Recommendation[] | null>(null)
  const [recsErro, setRecsErro] = useState<string | null>(null)
  const [dialogo, setDialogo] = useState(false)
  const [dialogoPlano, setDialogoPlano] = useState(false)
  const [planoCriado, setPlanoCriado] = useState<{ entraram: number } | null>(null)

  const carregarStatus = useCallback(() => {
    setStatusErro(null)
    getModuleStatus()
      .then(setStatus)
      .catch((e) => setStatusErro(e instanceof ApiError ? e.message : 'Erro inesperado.'))
  }, [])

  const carregarRuns = useCallback(() => {
    setRunsErro(null)
    listRuns()
      .then((d) => setRuns(d.runs))
      .catch((e) => { setRuns([]); setRunsErro(e instanceof ApiError ? e.message : 'Erro inesperado.') })
  }, [])

  const carregarRecs = useCallback((runId: number) => {
    setRecsErro(null)
    setRecs(null)
    listRecommendations(runId)
      .then((d) => setRecs(d.recommendations))
      .catch((e) => { setRecs([]); setRecsErro(e instanceof ApiError ? e.message : 'Erro inesperado.') })
  }, [])

  useEffect(() => { carregarStatus(); carregarRuns() }, [carregarStatus, carregarRuns])
  useEffect(() => { if (abrindo != null) carregarRecs(abrindo) }, [abrindo, carregarRecs])

  // Enquanto uma rodada gera, o status muda sozinho no servidor — sem este
  // pulso a tela ficaria em "Gerando…" para sempre e pareceria travada.
  const gerando = useMemo(() => (runs ?? []).some((r) => r.status === 'gerando' || r.status === 'pendente'), [runs])
  useEffect(() => {
    if (!gerando) return
    const id = setInterval(() => { carregarRuns(); if (abrindo != null) carregarRecs(abrindo) }, 4000)
    return () => clearInterval(id)
  }, [gerando, carregarRuns, carregarRecs, abrindo])

  const runAberta = (runs ?? []).find((r) => r.id === abrindo) ?? null
  const kpis = useMemo(() => {
    const rs = runs ?? []
    return {
      rodadas: rs.length,
      planos: rs.reduce((a, r) => a + r.totais.validas, 0),
      pendentes: rs.reduce((a, r) => a + Math.max(0, r.totais.validas - r.totais.decididas), 0),
      falhas: rs.reduce((a, r) => a + r.totais.falhas, 0),
    }
  }, [runs])

  const bancoIndisponivel = status && !status.banco.ok

  return (
    <div className="space-y-5 animate-slide-up">
      {/* Cabeçalho */}
      <div className="rounded-2xl border border-outline bg-surface-container-lowest shadow-card-md px-5 py-4">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-gradient-brand flex items-center justify-center shadow-glow shrink-0">
              <ClipboardList size={16} className="text-on-primary" />
            </div>
            <div>
              <h1 className="text-lg font-bold gradient-text tracking-tight leading-none">Planos de Ação</h1>
              <p className="text-[11px] text-on-surface-variant mt-1">
                Financeiro · a IA propõe o plano, o gestor decide, a tarefa é medida no health score
              </p>
            </div>
          </div>
          {podeDecidir && !bancoIndisponivel && (
            <div className="flex items-center gap-2 shrink-0">
              {/* Dois caminhos, de propósito. "Novo plano" é o de massa: uma
                  régua pega centenas ou milhares de contratos de uma vez.
                  "Rodada de IA" gera recomendação por contrato e custa uma
                  chamada paga em cada um — por isso tem teto de 200. */}
              <button
                onClick={() => setDialogoPlano(true)}
                className="flex items-center gap-1.5 text-[11px] px-3 py-1.5 rounded-lg bg-primary/15 text-primary border border-primary/30 hover:bg-primary/25 transition-all font-medium"
              >
                <Target size={12} /> Novo plano
              </button>
              <button
                onClick={() => setDialogo(true)}
                className="flex items-center gap-1.5 text-[11px] px-3 py-1.5 rounded-lg border border-outline text-on-surface/80 hover:border-outline-strong transition-colors"
              >
                <Plus size={12} /> Rodada de IA
              </button>
            </div>
          )}
        </div>

        {/* Situação do módulo — o que falta configurar, antes do primeiro clique */}
        {bancoIndisponivel ? (
          <div className="mt-3 flex items-start gap-2 rounded-lg bg-risk-critical/5 border border-risk-critical/20 px-3 py-2 text-[11px] text-on-surface-variant leading-relaxed">
            <Database size={13} className="text-risk-critical shrink-0 mt-0.5" />
            <p>
              <strong className="text-on-surface/80">Banco do módulo indisponível.</strong> As tabelas ficam na base
              própria do Health Score (MariaDB). Rode <span className="font-mono">npm run migrate</span> e confira as
              variáveis <span className="font-mono">DB_APP_*</span> na stack. Detalhe: {status?.banco.error}
            </p>
          </div>
        ) : status?.simulado ? (
          <div className="mt-3 flex items-start gap-2 rounded-lg bg-risk-medium/5 border border-risk-medium/20 px-3 py-2 text-[11px] text-on-surface-variant leading-relaxed">
            <FlaskConical size={13} className="text-risk-medium shrink-0 mt-0.5" />
            <p>
              <strong className="text-on-surface/80">Modo simulado.</strong> Nenhum provedor de IA está cadastrado
              (ou o escolhido é o simulado), então os planos são montados por uma resposta determinística — servem
              para ver o fluxo funcionando, não para decidir. Um administrador cadastra o provedor em
              Configurações → Provedor de IA.
            </p>
          </div>
        ) : (
          <div className="mt-3 flex items-start gap-2 rounded-lg bg-primary/5 border border-primary/15 px-3 py-2 text-[11px] text-on-surface-variant leading-relaxed">
            <Info size={13} className="text-primary shrink-0 mt-0.5" />
            <p>
              A seleção usa o <strong className="text-on-surface/70">mesmo ranking da tela Financeiro</strong>, com a
              config oficial. O plano só vira tarefa depois da decisão de um gestor, e o resultado é medido{' '}
              {status?.prazoReavaliacaoDias ?? 30} dias após a conclusão — comparando com a mesma régua.
              {status?.provedor && (
                <> Provedor: <span className="font-mono text-on-surface/70">{status.provedor.modelo}</span>.</>
              )}
            </p>
          </div>
        )}

        {statusErro && (
          <div className="mt-3 flex items-center gap-2 text-[11px] text-risk-critical">
            <AlertTriangle size={12} /> {statusErro}
          </div>
        )}
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <KpiCard label="Rodadas" value={kpis.rodadas.toLocaleString('pt-BR')} subtitle="geradas até aqui" icon={<ClipboardList size={14} />} variant="brand" />
        <KpiCard label="Planos válidos" value={kpis.planos.toLocaleString('pt-BR')} subtitle="passaram na validação" icon={<ShieldCheck size={14} />} variant="success" />
        <KpiCard label="Aguardando decisão" value={kpis.pendentes.toLocaleString('pt-BR')} subtitle="sem aprovação nem rejeição" icon={<ClipboardList size={14} />} variant="warning" />
        <KpiCard label="Gerações com falha" value={kpis.falhas.toLocaleString('pt-BR')} subtitle="fora do contrato ou erro do provedor" icon={<AlertTriangle size={14} />} variant="danger" iconColor="text-risk-critical" />
      </div>

      {/* Abas */}
      <div className="flex items-center gap-1.5">
        {([['rodadas', 'Rodadas e recomendações'], ['tarefas', 'Minhas tarefas']] as [Aba, string][]).map(([k, label]) => (
          <button
            key={k} onClick={() => setAba(k)}
            className={cn(
              'text-[11px] px-3 py-1.5 rounded-lg border transition-colors',
              aba === k ? 'bg-primary/15 text-primary border-primary/30' : 'border-outline text-on-surface-variant hover:border-outline-strong',
            )}
          >
            {label}
          </button>
        ))}
      </div>

      {aba === 'tarefas' ? (
        <Card>
          <CardHeader title="Minhas tarefas" subtitle="Ações aprovadas sob sua responsabilidade" icon={<ClipboardList size={14} />} />
          <TasksPanel podeDecidir={podeDecidir} somenteMinhas />
        </Card>
      ) : abrindo != null ? (
        <Card>
          <CardHeader
            title={`Rodada #${abrindo}`}
            subtitle={runAberta ? `${runAberta.totais.validas} plano(s) válido(s) · ${runAberta.totais.decididas} decidido(s) · iniciada por ${runAberta.iniciadoPor}` : 'Carregando…'}
            icon={<ClipboardList size={14} />}
            action={
              <button onClick={() => { setAbrindo(null); carregarRuns() }} className="flex items-center gap-1 text-[11px] text-on-surface-variant hover:text-on-surface transition-colors">
                <ChevronLeft size={12} /> Voltar
              </button>
            }
          />
          {recs === null ? (
            <div className="flex items-center justify-center gap-2 py-16 text-sm text-on-surface/70">
              <Loader2 size={16} className="animate-spin" /> Carregando recomendações…
            </div>
          ) : recsErro ? (
            <div className="px-5 py-8 space-y-3">
              <div className="flex items-start gap-2.5 text-sm text-risk-critical">
                <AlertTriangle size={16} className="mt-0.5 shrink-0" />
                <div>
                  <p className="font-medium text-on-surface">Não foi possível carregar as recomendações</p>
                  <p className="mt-0.5 text-[12px] text-on-surface/70">{recsErro}</p>
                </div>
              </div>
              <button onClick={() => carregarRecs(abrindo)} className="flex items-center gap-1.5 rounded-md border border-outline px-3 py-1.5 text-[12px] text-on-surface/85 hover:border-outline-strong transition-colors">
                <RefreshCw size={13} /> Tentar novamente
              </button>
            </div>
          ) : recs.length === 0 ? (
            <div className="px-5 py-12 text-center">
              <Loader2 size={20} className={cn('mx-auto text-on-surface-variant/50', runAberta?.status === 'gerando' && 'animate-spin')} />
              <p className="mt-2 text-xs text-on-surface-variant">
                {runAberta?.status === 'gerando' ? 'A rodada ainda está gerando os planos…' : 'Esta rodada não produziu recomendações.'}
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-outline bg-surface-container-low/50">
                    {['#', 'Cliente', 'Diagnóstico', 'Ações', 'Health', 'Classificação', 'Decisão'].map((h, i) => (
                      <th key={h} className={cn('px-3 py-2.5 text-[10px] text-on-surface-variant uppercase tracking-wider font-medium whitespace-nowrap', i >= 3 || i === 0 ? 'text-right' : 'text-left')}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {recs.map((r, i) => (
                    <RecommendationRow
                      key={r.id} rec={r} rank={i + 1} podeDecidir={podeDecidir}
                      onChanged={() => { carregarRecs(abrindo); carregarRuns() }}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      ) : (
        <Card>
          <CardHeader title="Rodadas" subtitle="Cada rodada é um conjunto de contratos analisado de uma vez" icon={<ClipboardList size={14} />} />
          {runs === null ? (
            <div className="flex items-center justify-center gap-2 py-16 text-sm text-on-surface/70">
              <Loader2 size={16} className="animate-spin" /> Carregando rodadas…
            </div>
          ) : runsErro ? (
            <div className="px-5 py-8 space-y-3">
              <div className="flex items-start gap-2.5 text-sm text-risk-critical">
                <AlertTriangle size={16} className="mt-0.5 shrink-0" />
                <div>
                  <p className="font-medium text-on-surface">Não foi possível carregar as rodadas</p>
                  <p className="mt-0.5 text-[12px] text-on-surface/70">{runsErro}</p>
                </div>
              </div>
              <button onClick={carregarRuns} className="flex items-center gap-1.5 rounded-md border border-outline px-3 py-1.5 text-[12px] text-on-surface/85 hover:border-outline-strong transition-colors">
                <RefreshCw size={13} /> Tentar novamente
              </button>
            </div>
          ) : runs.length === 0 ? (
            <div className="px-5 py-12 text-center">
              <ClipboardList size={22} className="mx-auto text-on-surface-variant/50" />
              <p className="mt-2 text-xs text-on-surface-variant">Nenhuma rodada gerada ainda.</p>
              <p className="mt-1 text-[10px] text-on-surface-variant/70">
                {podeDecidir
                  ? 'Comece por "Nova rodada": os piores contratos do Financeiro entram primeiro.'
                  : 'Um power user precisa gerar a primeira rodada.'}
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-outline bg-surface-container-low/50">
                    {['#', 'Criada em', 'Critério', 'Contratos', 'Válidos', 'Falhas', 'Decididos', 'Situação'].map((h, i) => (
                      <th key={h} className={cn('px-3 py-2.5 text-[10px] text-on-surface-variant uppercase tracking-wider font-medium whitespace-nowrap', i >= 3 ? 'text-right' : 'text-left')}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {runs.map((r) => (
                    <tr
                      key={r.id}
                      onClick={() => setAbrindo(r.id)}
                      className="border-b border-outline hover:bg-surface-container-low/60 cursor-pointer transition-colors"
                    >
                      <td className="px-3 py-2.5 text-[11px] font-mono text-on-surface">{r.id}</td>
                      <td className="px-3 py-2.5 text-[11px] text-on-surface-variant">{fmtData(r.criadoEm)}</td>
                      <td className="px-3 py-2.5 text-[10px] text-on-surface-variant">
                        {String(r.criterio?.classificacaoMinima ?? '—')} · top {String(r.criterio?.quantidade ?? '—')}
                        {r.criterio?.cidade ? ` · ${r.criterio.cidade}` : ''}
                      </td>
                      <td className="px-3 py-2.5 text-right text-[11px] font-mono text-on-surface">{r.totais.dossies}</td>
                      <td className="px-3 py-2.5 text-right text-[11px] font-mono text-risk-low">{r.totais.validas}</td>
                      <td className={cn('px-3 py-2.5 text-right text-[11px] font-mono', r.totais.falhas ? 'text-risk-critical' : 'text-on-surface-variant/60')}>{r.totais.falhas}</td>
                      <td className="px-3 py-2.5 text-right text-[11px] font-mono text-on-surface-variant">{r.totais.decididas}</td>
                      <td className="px-3 py-2.5 text-right">
                        <span className={cn(
                          'text-[10px] px-1.5 py-0.5 rounded border',
                          r.status === 'falha' ? 'text-risk-critical border-risk-critical/30 bg-risk-critical/10'
                            : r.status === 'gerando' || r.status === 'pendente' ? 'text-primary border-primary/30 bg-primary/10'
                              : r.status === 'concluida_com_falhas' ? 'text-risk-medium border-risk-medium/30 bg-risk-medium/10'
                                : 'text-on-surface-variant border-outline bg-surface-container-low',
                        )}>
                          {RUN_STATUS_LABEL[r.status] ?? r.status}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}

      {/* Confirmação do plano criado. Diz quantos contratos saíram da lista
          E que os indicadores não se mexeram — é a dúvida que aparece na
          primeira vez que alguém vê centenas de contratos sumirem de uma vez. */}
      {planoCriado && (
        <div className="flex items-start gap-2 rounded-xl border border-primary/25 bg-primary/5 px-4 py-3">
          <Target size={14} className="text-primary-strong mt-0.5 shrink-0" />
          <p className="text-[11px] text-on-surface-variant leading-relaxed flex-1">
            Plano criado com <strong className="text-on-surface font-mono">{planoCriado.entraram.toLocaleString('pt-BR')}</strong> contrato(s).
            Eles saíram das listas operacionais enquanto o plano corre — e <strong>continuam contados</strong> em
            críticos, receita em risco e na coorte mensal.
          </p>
          <button onClick={() => setPlanoCriado(null)} className="text-on-surface-variant hover:text-on-surface transition-colors shrink-0" aria-label="Fechar">
            <X size={13} />
          </button>
        </div>
      )}

      {dialogoPlano && (
        <NewPlanDialog
          onClose={() => setDialogoPlano(false)}
          onCriado={(_runId, entraram) => {
            setDialogoPlano(false)
            setPlanoCriado({ entraram })
            carregarRuns()
          }}
        />
      )}

      {dialogo && status && (
        <NewRunDialog
          padrao={status.criterioPadrao}
          onClose={() => setDialogo(false)}
          onStarted={(runId) => { setDialogo(false); carregarRuns(); setAbrindo(runId) }}
        />
      )}
    </div>
  )
}
