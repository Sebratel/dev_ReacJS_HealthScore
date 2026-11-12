import { useEffect, useMemo, useState } from 'react'
import { X, Loader2, AlertTriangle, Users, Target, Save } from 'lucide-react'
import { HEALTH_LABELS } from '@/components/ui/HealthGauge'
import { formatCurrency } from '@/utils/cn'
import { realByCity } from '@/data/realClients'
import { useAuthStore } from '@/store/authStore'
import { SECTOR_ORDER, SECTOR_LABELS, scopeCanEdit, type SectorKey } from '@/features/auth/sectors'
import { INDICATOR_CATALOG, useIndicatorLabelMap } from '@/features/settings/indicatorCatalog'
import {
  previewRegua, criarPlano, criarRegua, listarSettings, ApiError,
  type ReguaDefinicao, type ReguaPreview, type SetorSettings,
} from './actionPlansApi'

// ─────────────────────────────────────────────────────────────────────────
// Montar um plano a partir de uma RÉGUA.
//
// Este diálogo é o mecanismo de MASSA do módulo: uma régua larga pega
// centenas ou milhares de contratos de uma vez. Não confundir com "Nova
// rodada" (NewRunDialog), que gera recomendações de IA e tem teto de 200
// porque lá cada contrato custa uma chamada paga ao provedor.
//
// A prévia é o centro da tela, não um detalhe: antes de criar, o usuário
// precisa ver TRÊS números — quantos casaram, quantos já estão em plano, e
// quantos de fato entram. Sem o do meio, abrir um plano de 400 que entra com
// 90 parece defeito.
// ─────────────────────────────────────────────────────────────────────────

const MODO_CLASSE = 'classe'
const MODO_SCORE = 'score'

const CLASS_OPTS = [
  { key: 'critical', label: `Somente ${HEALTH_LABELS.critical}` },
  { key: 'high_risk', label: `${HEALTH_LABELS.critical} + ${HEALTH_LABELS.high_risk}` },
  { key: 'attention', label: `${HEALTH_LABELS.critical} + ${HEALTH_LABELS.high_risk} + ${HEALTH_LABELS.attention}` },
]

const campo = 'h-8 px-2 text-xs bg-surface-container-low border border-outline rounded-lg text-on-surface placeholder-on-surface-variant/70 focus:outline-none focus:border-primary/50'
const rotulo = 'text-[10px] uppercase tracking-wider text-on-surface-variant'

interface Props {
  onClose: () => void
  onCriado: (runId: number, entraram: number) => void
}

export function NewPlanDialog({ onClose, onCriado }: Props) {
  const scopes = useAuthStore((s) => s.scopes)
  const labelsPorSetor = useIndicatorLabelMap()

  // Só os setores que a conta edita. Um power user do Financeiro não monta
  // plano de Rede — a mesma regra que governa os pesos dos indicadores.
  const setoresDisponiveis = useMemo(
    () => SECTOR_ORDER.filter((s) => scopeCanEdit(scopes, s)),
    [scopes],
  )

  const [setor, setSetor] = useState<SectorKey>(setoresDisponiveis[0] ?? 'financial')
  const [nome, setNome] = useState('')
  const [modo, setModo] = useState(MODO_CLASSE)
  const [classificacaoMinima, setClassificacaoMinima] = useState('critical')
  const [scoreMax, setScoreMax] = useState('40')
  const [cidade, setCidade] = useState('')
  const [mrrMin, setMrrMin] = useState('')
  const [mrrMax, setMrrMax] = useState('')
  const [indicador, setIndicador] = useState('')
  const [indicadorPontos, setIndicadorPontos] = useState('')
  const [credito, setCredito] = useState<string>('')
  const [salvarComoRegua, setSalvarComoRegua] = useState(false)

  const [settings, setSettings] = useState<SetorSettings | null>(null)
  const [preview, setPreview] = useState<ReguaPreview | null>(null)
  const [previewErro, setPreviewErro] = useState<string | null>(null)
  const [carregando, setCarregando] = useState(false)
  const [criando, setCriando] = useState(false)
  const [erro, setErro] = useState<string | null>(null)

  // Teto do setor: o crédito do plano não pode passar dele, e quem mexe no
  // teto é o power user do próprio setor (fica registrado quem mexeu).
  useEffect(() => {
    let alive = true
    listarSettings()
      .then(({ setores }) => {
        if (!alive) return
        const s = setores.find((x) => x.setor === setor) ?? null
        setSettings(s)
        setCredito((atual) => (atual === '' && s ? String(s.creditoMaximo) : atual))
      })
      .catch(() => { if (alive) setSettings(null) })
    return () => { alive = false }
  }, [setor])

  const definicao = (): ReguaDefinicao => ({
    classificacaoMinima: modo === MODO_CLASSE ? classificacaoMinima : null,
    scoreMax: modo === MODO_SCORE && scoreMax ? Number(scoreMax) : null,
    cidade: cidade || null,
    mrrMin: mrrMin ? Number(mrrMin) : null,
    mrrMax: mrrMax ? Number(mrrMax) : null,
    indicador: indicador
      ? { key: indicador, pontosMax: indicadorPontos ? -Math.abs(Number(indicadorPontos)) : null }
      : null,
  })

  // Prévia a cada mudança da régua, com atraso — cada cálculo varre a base
  // inteira no servidor.
  useEffect(() => {
    let alive = true
    setCarregando(true)
    setPreviewErro(null)
    const id = setTimeout(() => {
      previewRegua(setor, definicao())
        .then((p) => { if (alive) { setPreview(p); setCarregando(false) } })
        .catch((e) => {
          if (!alive) return
          setPreview(null)
          setPreviewErro(e instanceof ApiError ? e.message : 'Não foi possível calcular a prévia.')
          setCarregando(false)
        })
    }, 400)
    return () => { alive = false; clearTimeout(id) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setor, modo, classificacaoMinima, scoreMax, cidade, mrrMin, mrrMax, indicador, indicadorPontos])

  const criar = async () => {
    setCriando(true)
    setErro(null)
    try {
      if (salvarComoRegua) {
        // Falhar ao salvar a régua não pode impedir o plano: a régua é
        // conveniência para o mês que vem, o plano é o que foi pedido agora.
        await criarRegua({ setor, nome: nome.trim(), definicao: definicao() }).catch(() => null)
      }
      const r = await criarPlano({
        setor, nome: nome.trim(), definicao: definicao(),
        creditoPontos: credito === '' ? null : Number(credito),
      })
      onCriado(r.runId, r.entraram)
    } catch (e) {
      setErro(e instanceof ApiError ? e.message : 'Não foi possível criar o plano.')
      setCriando(false)
    }
  }

  const cidades = realByCity.map((c) => c.city).sort((a, b) => a.localeCompare(b, 'pt-BR'))
  const indicadores = INDICATOR_CATALOG[setor]?.order ?? []
  const rotuloIndicador = (k: string) => labelsPorSetor[setor]?.[k] ?? k
  const entram = preview ? preview.disponiveis : 0
  const podeCriar = !!nome.trim() && entram > 0 && !criando

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div
        className="w-full max-w-xl rounded-2xl border border-outline bg-surface-container-lowest shadow-card-md max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-outline">
          <div>
            <h2 className="text-sm font-bold text-on-surface">Novo plano de ação</h2>
            <p className="text-[11px] text-on-surface-variant mt-0.5">
              A régua seleciona os contratos de uma vez — eles saem da lista operacional enquanto o plano corre
            </p>
          </div>
          <button onClick={onClose} className="text-on-surface-variant hover:text-on-surface transition-colors" aria-label="Fechar">
            <X size={16} />
          </button>
        </div>

        <div className="px-5 py-4 space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <label className="flex flex-col gap-1">
              <span className={rotulo}>Setor</span>
              <select value={setor} onChange={(e) => setSetor(e.target.value as SectorKey)} className={campo}>
                {setoresDisponiveis.map((s) => <option key={s} value={s}>{SECTOR_LABELS[s]}</option>)}
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className={rotulo}>Nome do plano</span>
              <input
                value={nome} onChange={(e) => setNome(e.target.value)} maxLength={160}
                placeholder="Ex.: Recuperação de atraso — Curitiba" className={campo}
              />
            </label>
          </div>

          {/* ─── Régua ─── */}
          <div className="rounded-lg border border-outline bg-surface-container-low/40 px-3 py-3 space-y-3">
            <div className="flex items-center gap-1.5">
              <Target size={12} className="text-primary-strong" />
              <span className="text-[11px] font-bold text-on-surface">Régua de seleção</span>
            </div>

            <div className="flex gap-2">
              {[[MODO_CLASSE, 'Por classificação'], [MODO_SCORE, 'Por faixa de score']].map(([k, l]) => (
                <button
                  key={k} type="button" onClick={() => setModo(k)}
                  className={`text-[10px] px-2.5 py-1 rounded-lg border transition-colors ${
                    modo === k
                      ? 'bg-primary/15 text-primary border-primary/30 font-medium'
                      : 'border-outline text-on-surface-variant hover:border-outline-strong'
                  }`}
                >
                  {l}
                </button>
              ))}
            </div>

            {modo === MODO_CLASSE ? (
              <label className="flex flex-col gap-1">
                <span className={rotulo}>Classificação mínima</span>
                <select value={classificacaoMinima} onChange={(e) => setClassificacaoMinima(e.target.value)} className={campo}>
                  {CLASS_OPTS.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
                </select>
              </label>
            ) : (
              <label className="flex flex-col gap-1">
                <span className={rotulo}>Health score até</span>
                <input
                  type="number" min={0} max={100} value={scoreMax}
                  onChange={(e) => setScoreMax(e.target.value)} className={campo}
                />
              </label>
            )}

            <div className="grid grid-cols-3 gap-3">
              <label className="flex flex-col gap-1">
                <span className={rotulo}>Cidade</span>
                <select value={cidade} onChange={(e) => setCidade(e.target.value)} className={campo}>
                  <option value="">Todas</option>
                  {cidades.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              </label>
              <label className="flex flex-col gap-1">
                <span className={rotulo}>Mensalidade mín.</span>
                <input type="number" min={0} value={mrrMin} onChange={(e) => setMrrMin(e.target.value)} placeholder="sem limite" className={campo} />
              </label>
              <label className="flex flex-col gap-1">
                <span className={rotulo}>Mensalidade máx.</span>
                <input type="number" min={0} value={mrrMax} onChange={(e) => setMrrMax(e.target.value)} placeholder="sem limite" className={campo} />
              </label>
            </div>

            {/* "Crítico" mistura sete causas num rótulo só; o corte por
                indicador é o que o responsável pelo setor realmente quer. */}
            <div className="grid grid-cols-2 gap-3">
              <label className="flex flex-col gap-1">
                <span className={rotulo}>Indicador (opcional)</span>
                <select value={indicador} onChange={(e) => setIndicador(e.target.value)} className={campo}>
                  <option value="">Qualquer causa</option>
                  {indicadores.map((k) => <option key={k} value={k}>{rotuloIndicador(k)}</option>)}
                </select>
              </label>
              <label className="flex flex-col gap-1">
                <span className={rotulo}>Perdendo ao menos</span>
                <input
                  type="number" min={0} value={indicadorPontos} disabled={!indicador}
                  onChange={(e) => setIndicadorPontos(e.target.value)}
                  placeholder="pontos" className={`${campo} disabled:opacity-40`}
                />
              </label>
            </div>
          </div>

          {/* ─── Crédito ─── */}
          <div className="grid grid-cols-2 gap-3 items-end">
            <label className="flex flex-col gap-1">
              <span className={rotulo}>Crédito ao concluir com êxito</span>
              <input
                type="number" min={0} max={settings?.creditoMaximo ?? 40} value={credito}
                onChange={(e) => setCredito(e.target.value)} className={campo}
              />
            </label>
            <p className="text-[10px] text-on-surface-variant pb-1.5">
              Teto do setor: <strong className="text-on-surface">{settings?.creditoMaximo ?? '—'}</strong> pontos ·
              vence em {settings?.validadeDias ?? '—'} dias.
              <br />
              Não entra no score medido — fica ao lado dele.
            </p>
          </div>

          {/* ─── Prévia ─── */}
          <div className="rounded-lg border border-outline bg-surface-container-low/50 px-3 py-2.5">
            {carregando ? (
              <div className="flex items-center gap-2 text-[11px] text-on-surface-variant">
                <Loader2 size={12} className="animate-spin" /> Calculando quantos contratos a régua pega…
              </div>
            ) : previewErro ? (
              <div className="flex items-start gap-2 text-[11px] text-risk-critical">
                <AlertTriangle size={12} className="mt-0.5 shrink-0" /> <span>{previewErro}</span>
              </div>
            ) : preview ? (
              <div className="space-y-2">
                <div className="flex items-center gap-2 text-[11px] text-on-surface">
                  <Users size={12} className="text-primary shrink-0" />
                  <span>
                    <strong className="font-mono">{preview.casaram.toLocaleString('pt-BR')}</strong> casaram com a régua
                    {preview.jaEmPlano > 0 && (
                      <span className="text-on-surface-variant">
                        {' '}· <span className="font-mono">{preview.jaEmPlano.toLocaleString('pt-BR')}</span> já em plano deste setor
                      </span>
                    )}
                    {' '}→ <strong className="font-mono text-primary">{entram.toLocaleString('pt-BR')}</strong> entram
                  </span>
                </div>
                {preview.selecionados.length > 0 && (
                  <ul className="space-y-0.5 max-h-28 overflow-y-auto">
                    {preview.selecionados.map((a) => (
                      <li key={a.contratoId} className="text-[10px] text-on-surface-variant font-mono truncate">
                        #{a.contratoId} · {a.nome} · score {a.score} · {formatCurrency(a.mrr)}
                      </li>
                    ))}
                    {preview.truncado && (
                      <li className="text-[10px] text-on-surface-variant/70">
                        amostra de {preview.selecionados.length} — o plano leva os {entram.toLocaleString('pt-BR')}
                      </li>
                    )}
                  </ul>
                )}
              </div>
            ) : null}
          </div>

          <label className="flex items-center gap-2 text-[11px] text-on-surface-variant cursor-pointer">
            <input
              type="checkbox" checked={salvarComoRegua} onChange={(e) => setSalvarComoRegua(e.target.checked)}
              className="accent-primary"
            />
            <Save size={11} /> Salvar esta régua para reusar no mês que vem
          </label>

          {erro && (
            <div className="flex items-start gap-2 text-[11px] text-risk-critical">
              <AlertTriangle size={12} className="mt-0.5 shrink-0" /> <span>{erro}</span>
            </div>
          )}
        </div>

        <div className="flex items-center justify-between gap-2 px-5 py-3 border-t border-outline">
          <p className="text-[10px] text-on-surface-variant">
            Os contratos somem da lista operacional, <strong>não dos indicadores</strong>.
          </p>
          <div className="flex items-center gap-2 shrink-0">
            <button onClick={onClose} className="text-[11px] px-3 py-1.5 rounded-lg border border-outline text-on-surface/80 hover:border-outline-strong transition-colors">
              Cancelar
            </button>
            <button
              onClick={criar}
              disabled={!podeCriar}
              className="flex items-center gap-1.5 text-[11px] px-3 py-1.5 rounded-lg bg-primary/15 text-primary border border-primary/30 hover:bg-primary/25 transition-all font-medium disabled:opacity-30"
            >
              {criando ? <Loader2 size={12} className="animate-spin" /> : <Target size={12} />}
              {criando ? 'Criando…' : `Criar plano com ${entram.toLocaleString('pt-BR')}`}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
