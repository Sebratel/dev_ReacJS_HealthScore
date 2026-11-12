// Cliente do módulo de Planos de Ação. Tudo passa pelo apiFetch central —
// um fetch cru esquecido num botão manda requisição sem Bearer, toma 401 em
// silêncio, e a ação simplesmente não acontece parecendo que aconteceu.
import { apiFetch, ApiError } from '@/lib/apiClient'

export { ApiError }

export type Prioridade = 'alta' | 'media' | 'baixa'
export type ResponsavelArea = 'cobranca' | 'atendimento' | 'comercial' | 'juridico'
export type RecStatus = 'valida' | 'falha_schema' | 'falha_provedor'
export type RunStatus = 'pendente' | 'gerando' | 'concluida' | 'concluida_com_falhas' | 'falha'
export type TaskStatus = 'em_execucao' | 'concluido' | 'cancelado'

export interface Acao {
  titulo: string
  descricao: string
  prioridade: Prioridade
  prazo_sugerido_dias: number
  responsavel_sugerido: ResponsavelArea
  impacto_esperado: string
}

export interface DossieIndicador { nome: string; valor: number | string; pontos: number }
export interface Dossie {
  cliente_id: string
  nome: string | null
  contrato: string | null
  cidade: string | null
  setor: string
  health_score_atual: number
  classificacao: string
  receita_mensal: number | null
  plano: string | null
  indicadores: DossieIndicador[]
  historico_health_score: { data: string; score: number }[]
  forma_pagamento: string | null
  planos_anteriores: {
    titulo: string; status: string; criado_em: string
    resultado: { variacao: number; dias_decorridos: number } | null
  }[]
}

export interface Recommendation {
  id: number
  dossierId: number
  runId: number
  clienteId: string
  contratoId: string | null
  setor: string
  healthScoreNoMomento: number | null
  classificacao: string | null
  dossie: Dossie
  versaoPrompt: string
  modelo: string
  status: RecStatus
  resposta: {
    diagnostico: string
    causas_provaveis: string[]
    acoes_recomendadas: Acao[]
    indicadores_considerados: string[]
    confianca_modelo: number
  } | null
  erroValidacao: string | null
  tokens: { entrada: number | null; saida: number | null; total: number | null }
  duracaoMs: number | null
  tentativa: number
  criadoEm: string
  aprovacao: {
    id: number; status: 'em_revisao' | 'aprovado' | 'rejeitado'
    gestorId: string; acoesEditadas: Acao[] | null; comentario: string | null; decididoEm: string | null
  } | null
}

export interface Run {
  id: number
  setor: string
  criterio: Record<string, unknown>
  qtdClientes: number
  iniciadoPor: string
  status: RunStatus
  erro: string | null
  criadoEm: string
  concluidoEm: string | null
  totais: { dossies: number; validas: number; falhas: number; decididas: number }
}

export interface Task {
  id: number
  clienteId: string
  clienteNome: string | null
  contratoId: string | null
  setor: string
  titulo: string
  descricao: string | null
  prioridade: Prioridade | null
  responsavelArea: ResponsavelArea | null
  responsavelId: string | null
  prazo: string | null
  status: TaskStatus
  concluidoEm: string | null
  criadoEm: string
  resultado: {
    antes: number; depois: number; variacao: number
    classificacaoAntes: string; classificacaoDepois: string
    diasDecorridos: number; avaliadoEm: string
  } | null
}

export interface ModuleStatus {
  banco: { ok: boolean; error?: string }
  promptAtivo: { id: number; versao: string; setor: string } | null
  provedor: { tipo: string; modelo: string; origem: 'env' | 'tela' | null; dica: string | null } | null
  simulado: boolean
  criterioPadrao: Criterio
  concorrenciaMaxima: number
  prazoReavaliacaoDias: number
}

export interface Criterio {
  quantidade: number
  classificacaoMinima: string
  cidade: string | null
  mrrMin: number | null
  mrrMax: number | null
}

export interface Preview {
  criterio: Criterio
  disponiveis: number
  selecionados: number
  amostra: { clienteId: string; nome: string; cidade: string; healthScore: number; classificacao: string; mrr: number }[]
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await apiFetch(path, init)
  const body = await res.json().catch(() => ({}))
  if (!res.ok) {
    const msg = (body as { error?: string })?.error
    throw new ApiError(res.status, msg || `Erro ${res.status} no servidor.`)
  }
  return body as T
}

const json = (body: unknown): RequestInit => ({
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
})

export const getModuleStatus = () => call<ModuleStatus>('/api/action-plans/status')

export const previewRun = (criterio: Partial<Criterio>) =>
  call<Preview>('/api/action-plans/runs/preview', json({ criterio }))

export const startRun = (criterio: Partial<Criterio>) =>
  call<{ runId: number; selecionados: number; disponiveis: number }>('/api/action-plans/runs', json({ criterio }))

export const listRuns = () => call<{ runs: Run[] }>('/api/action-plans/runs')
export const getRun = (id: number) => call<{ run: Run }>(`/api/action-plans/runs/${id}`)
export const listRecommendations = (runId: number) =>
  call<{ recommendations: Recommendation[] }>(`/api/action-plans/runs/${runId}/recommendations`)

export const approveRecommendation = (id: number, acoes: Acao[], comentario?: string, responsavelId?: string) =>
  call<{ ok: true; tarefasCriadas: number }>(`/api/action-plans/recommendations/${id}/approve`, json({ acoes, comentario, responsavelId }))

export const rejectRecommendation = (id: number, comentario?: string) =>
  call<{ ok: true }>(`/api/action-plans/recommendations/${id}/reject`, json({ comentario }))

export const retryRecommendation = (id: number) =>
  call<{ id: number; status: RecStatus; erro?: string }>(`/api/action-plans/recommendations/${id}/retry`, json({}))

export const listTasks = (params: { responsavel?: string; status?: TaskStatus } = {}) => {
  const q = new URLSearchParams()
  if (params.responsavel) q.set('responsavel', params.responsavel)
  if (params.status) q.set('status', params.status)
  return call<{ tasks: Task[] }>(`/api/action-plans/tasks${q.toString() ? `?${q}` : ''}`)
}

export const updateTask = (id: number, patch: { status?: TaskStatus; responsavelId?: string }) =>
  call<{ ok: true }>(`/api/action-plans/tasks/${id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
  })

export const runOutcomeEvaluation = () =>
  call<{ avaliadas: number; semDados: number; total: number }>('/api/action-plans/outcomes/run', json({}))

// ─── Régua, permanência e crédito ──────────────────────────────
// Separado das rodadas de IA de propósito: ali cada contrato custa uma
// chamada paga ao provedor (teto de 200); aqui a régua é o mecanismo de
// MASSA — centenas ou milhares de contratos num plano só.

export type Desfecho = 'com_exito' | 'sem_exito' | 'cancelado'

export interface ReguaDefinicao {
  classificacaoMinima?: string | null
  scoreMin?: number | null
  scoreMax?: number | null
  cidade?: string | null
  mrrMin?: number | null
  mrrMax?: number | null
  indicador?: { key: string; pontosMin?: number | null; pontosMax?: number | null } | null
  quantidade?: number | null
}

export interface ReguaPreview {
  setor: string
  /** AMOSTRA (até 50). A contagem real está em `amostraDe`. */
  selecionados: { contratoId: string; nome: string; cidade: string; mrr: number; score: number; classificacao: string }[]
  amostraDe: number
  truncado: boolean
  /** Quantos casaram com a régua, incluindo os que já estão em plano. */
  casaram: number
  /** Desses, quantos já têm plano aberto no setor — não entram de novo. */
  jaEmPlano: number
  disponiveis: number
}

export interface Regua {
  id: number
  setor: string
  nome: string
  descricao: string | null
  definicao: ReguaDefinicao
  sugerida: boolean
  criadoPor: string
  criadoEm: string
}

export interface SetorSettings {
  setor: string
  creditoMaximo: number
  validadeDias: number
  definidoPor: string | null
  definidoEm: string | null
  padrao: boolean
}

export interface Permanencia {
  id: number
  runId: number
  plano: string
  contratoId: string
  setor: string
  scoreEntrada: number | null
  classificacaoEntrada: string | null
  scoreSaida: number | null
  entrouEm: string
  saiuEm: string | null
  desfecho: Desfecho | null
  observacao: string | null
  creditoPrevisto: number
  aberta: boolean
}

export const previewRegua = (setor: string, definicao: ReguaDefinicao) =>
  call<ReguaPreview>('/api/action-plans/rulers/preview', json({ setor, definicao }))

export const criarPlano = (body: {
  setor: string; nome: string; definicao: ReguaDefinicao
  creditoPontos?: number | null; rulerId?: number | null
}) =>
  call<{ runId: number; nome: string; entraram: number; jaEmPlano: number; casaram: number; creditoPontos: number; validadeDias: number }>(
    '/api/action-plans/plans', json(body))

export const listarReguas = (setor?: string) =>
  call<{ reguas: Regua[] }>(`/api/action-plans/rulers${setor ? `?setor=${encodeURIComponent(setor)}` : ''}`)

export const criarRegua = (body: { setor: string; nome: string; descricao?: string; definicao: ReguaDefinicao }) =>
  call<{ id: number }>('/api/action-plans/rulers', json(body))

export const arquivarRegua = (id: number) =>
  call<{ id: number }>(`/api/action-plans/rulers/${id}`, { method: 'DELETE' })

export const listarSettings = () =>
  call<{ setores: SetorSettings[] }>('/api/action-plans/settings')

export const salvarSettings = (setor: string, body: { creditoMaximo?: number; validadeDias?: number }) =>
  call<{ setor: string; creditoMaximo: number; validadeDias: number }>(
    `/api/action-plans/settings/${setor}`,
    { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

export const listarPermanencias = (params: { runId?: number; contrato?: string; abertas?: boolean } = {}) => {
  const q = new URLSearchParams()
  if (params.runId) q.set('runId', String(params.runId))
  if (params.contrato) q.set('contrato', params.contrato)
  if (params.abertas) q.set('abertas', '1')
  const s = q.toString()
  return call<{ permanencias: Permanencia[] }>(`/api/action-plans/memberships${s ? `?${s}` : ''}`)
}

export const encerrarPermanencia = (id: number, body: { desfecho: Desfecho; scoreSaida?: number | null; observacao?: string }) =>
  call<{ membershipId: number; desfecho: Desfecho; credito: { pontos: number; validadeDias: number } | null }>(
    `/api/action-plans/memberships/${id}/encerrar`, json(body))

export const encerrarPlano = (runId: number, body: { desfecho: Desfecho; observacao?: string }) =>
  call<{ runId: number; encerradas: number; comCredito: number }>(
    `/api/action-plans/plans/${runId}/encerrar`, json(body))
