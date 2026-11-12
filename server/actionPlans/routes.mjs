// ─────────────────────────────────────────────────────────────────────────
// Rotas do módulo Planos de Ação + cadastro de provedores de IA.
//
// Papéis (reusa o RBAC do sistema): ver é de qualquer conta do domínio;
// gerar, aprovar e rejeitar é de power_user+; mexer em prompt, provedor e
// disparar a reavaliação é de admin.
//
// Nada aqui aceita config vinda do cliente para pontuar: a régua é sempre a
// config oficial do servidor. Um plano gerado com pesos do navegador de quem
// clicou não seria comparável com nenhum outro.
// ─────────────────────────────────────────────────────────────────────────
import { Router } from 'express'
import { isReady } from '../db.mjs'
import { validateEditedActions } from './schema.mjs'
import { startRun, selectClients, retryRecommendation, selecionarPorRegua, DEFAULT_CRITERIO, MAX_CONCURRENCY } from './runner.mjs'
import { atLeast, canEditSector, SECTOR_LABELS } from '../roles.mjs'
import { getPlanState, invalidatePlanState } from './planState.mjs'
import {
  getSettings, listSettings, saveSettings, settingsHistory,
  listRulers, createRuler, archiveRuler,
  abrirPlano, encerrarMembership, encerrarPlano, listMemberships, getMembership,
  creditosDoContrato, revogarCredito, efetividadePorSetor, resumoEmPlano,
} from './membership.mjs'
import { runOutcomeEvaluation, DEFAULT_PRAZO_DIAS } from './outcomes.mjs'
import {
  listRuns, getRun, listRecommendationsByRun, getRecommendation,
  approveRecommendation, rejectRecommendation, listTasks, setTaskStatus, assignTask,
  listTemplates, createTemplateVersion, getActiveTemplate,
} from './store.mjs'
import {
  estado as estadoIA, salvar as salvarIA, remover as removerIA,
  listarModelos, testar as testarIA,
} from '../ia/registro.mjs'

// Erro → resposta. Falha de banco é 503 (o módulo está indisponível, não é
// culpa de quem chamou); o resto é 400 com a mensagem original, que já é
// escrita para ser lida por quem está na tela.
function fail(res, e) {
  const msg = e?.message || 'Erro inesperado.'
  const semBanco = /ECONNREFUSED|ER_BAD_DB_ERROR|ETIMEDOUT|ENOTFOUND|não configurado|doesn't exist/i.test(msg)
  res.status(semBanco ? 503 : 400).json({ error: msg })
}

export function actionPlanRoutes(requireAuth) {
  const r = Router()

  // ─── Situação do módulo ──────────────────────────────────────
  // A tela pergunta isto antes de tudo: sem banco, sem prompt ou sem provedor
  // ela mostra o que falta, em vez de um erro cru no primeiro clique.
  r.get('/action-plans/status', requireAuth(), async (_req, res) => {
    const db = await isReady()
    let prompt = null
    if (db.ok) {
      try { prompt = await getActiveTemplate('financeiro') } catch { /* tabela ainda não migrada */ }
    }
    const ia = estadoIA()
    res.json({
      banco: db,
      promptAtivo: prompt ? { id: prompt.id, versao: prompt.versao, setor: prompt.setor } : null,
      provedor: ia.configurado
        ? { tipo: ia.tipo, modelo: ia.modelo, origem: ia.origem, dica: ia.dica }
        : null,
      // Sem provedor cadastrado o módulo roda simulado: é útil para ver a
      // tela funcionando, e a UI precisa dizer isso em letras claras.
      simulado: !ia.configurado || ia.tipo === 'simulado',
      criterioPadrao: DEFAULT_CRITERIO,
      concorrenciaMaxima: MAX_CONCURRENCY,
      prazoReavaliacaoDias: DEFAULT_PRAZO_DIAS,
    })
  })

  // ─── Rodadas ─────────────────────────────────────────────────
  // Prévia do critério: quantos clientes entram, sem gastar uma chamada de IA.
  r.post('/action-plans/runs/preview', requireAuth({ minRole: 'power_user' }), (req, res) => {
    try {
      const { selecionados, criterio, disponiveis } = selectClients(req.body?.criterio)
      res.json({
        criterio,
        disponiveis,
        selecionados: selecionados.length,
        amostra: selecionados.slice(0, 5).map((s) => ({
          clienteId: s.customerId, nome: s.customerName, cidade: s.city,
          healthScore: s.healthScore, classificacao: s.classification, mrr: s.monthlyValue,
        })),
      })
    } catch (e) { fail(res, e) }
  })

  r.post('/action-plans/runs', requireAuth({ minRole: 'power_user' }), async (req, res) => {
    try {
      const out = await startRun({
        setor: req.body?.setor || 'financeiro',
        criterio: req.body?.criterio,
        iniciadoPor: req.user.email,
      })
      res.status(202).json(out)
    } catch (e) { fail(res, e) }
  })

  r.get('/action-plans/runs', requireAuth(), async (req, res) => {
    try {
      res.json({ runs: await listRuns({ setor: req.query.setor, limit: req.query.limit }) })
    } catch (e) { fail(res, e) }
  })

  r.get('/action-plans/runs/:id', requireAuth(), async (req, res) => {
    try {
      const run = await getRun(req.params.id)
      if (!run) return res.status(404).json({ error: 'Rodada não encontrada.' })
      res.json({ run })
    } catch (e) { fail(res, e) }
  })

  r.get('/action-plans/runs/:id/recommendations', requireAuth(), async (req, res) => {
    try {
      res.json({ recommendations: await listRecommendationsByRun(req.params.id) })
    } catch (e) { fail(res, e) }
  })

  r.get('/action-plans/recommendations/:id', requireAuth(), async (req, res) => {
    try {
      const rec = await getRecommendation(req.params.id)
      if (!rec) return res.status(404).json({ error: 'Recomendação não encontrada.' })
      res.json({ recommendation: rec })
    } catch (e) { fail(res, e) }
  })

  // ─── Decisão do gestor ───────────────────────────────────────
  r.post('/action-plans/recommendations/:id/approve', requireAuth({ minRole: 'power_user' }), async (req, res) => {
    try {
      const rec = await getRecommendation(req.params.id)
      if (!rec) return res.status(404).json({ error: 'Recomendação não encontrada.' })
      if (rec.status !== 'valida') {
        return res.status(400).json({ error: 'Só uma recomendação válida pode ser aprovada. Gere uma nova tentativa.' })
      }
      // O gestor pode ter editado; sem edição, aprova o que a IA propôs.
      const acoes = req.body?.acoes ?? rec.resposta?.acoes_recomendadas
      const v = validateEditedActions(acoes)
      if (!v.ok) return res.status(400).json({ error: v.errors.join(' · ') })

      const out = await approveRecommendation({
        recommendationId: rec.id,
        gestorId: req.user.email,
        acoes: v.value,
        comentario: req.body?.comentario,
        responsavelId: req.body?.responsavelId ?? req.user.email,
      })
      res.json({ ok: true, ...out })
    } catch (e) { fail(res, e) }
  })

  r.post('/action-plans/recommendations/:id/reject', requireAuth({ minRole: 'power_user' }), async (req, res) => {
    try {
      await rejectRecommendation({
        recommendationId: req.params.id,
        gestorId: req.user.email,
        comentario: req.body?.comentario,
      })
      res.json({ ok: true })
    } catch (e) { fail(res, e) }
  })

  r.post('/action-plans/recommendations/:id/retry', requireAuth({ minRole: 'power_user' }), async (req, res) => {
    try {
      const rec = await getRecommendation(req.params.id)
      if (!rec) return res.status(404).json({ error: 'Recomendação não encontrada.' })
      const out = await retryRecommendation({
        dossierId: rec.dossierId,
        setor: rec.setor,
        dossie: rec.dossie,
        tentativa: rec.tentativa,
      })
      res.json(out)
    } catch (e) { fail(res, e) }
  })

  // ─── Tarefas ─────────────────────────────────────────────────
  r.get('/action-plans/tasks', requireAuth(), async (req, res) => {
    try {
      const responsavelId = req.query.responsavel === 'me' ? req.user.email : (req.query.responsavel || undefined)
      res.json({
        tasks: await listTasks({
          responsavelId,
          status: req.query.status || undefined,
          setor: req.query.setor || undefined,
          clienteId: req.query.cliente || undefined,
        }),
      })
    } catch (e) { fail(res, e) }
  })

  r.patch('/action-plans/tasks/:id', requireAuth({ minRole: 'power_user' }), async (req, res) => {
    try {
      if (req.body?.responsavelId !== undefined) await assignTask(req.params.id, req.body.responsavelId)
      if (req.body?.status) await setTaskStatus(req.params.id, req.body.status, req.user.email)
      res.json({ ok: true })
    } catch (e) { fail(res, e) }
  })

  // ─── Reavaliação de impacto (gatilho manual; o job roda após o ETL) ──
  r.post('/action-plans/outcomes/run', requireAuth({ minRole: 'admin' }), async (req, res) => {
    try {
      res.json(await runOutcomeEvaluation({ prazoDias: req.body?.prazoDias }))
    } catch (e) { fail(res, e) }
  })

  // ─── Prompts ─────────────────────────────────────────────────
  r.get('/action-plans/templates', requireAuth({ minRole: 'power_user' }), async (req, res) => {
    try { res.json({ templates: await listTemplates(req.query.setor) }) } catch (e) { fail(res, e) }
  })

  r.post('/action-plans/templates', requireAuth({ minRole: 'admin' }), async (req, res) => {
    try {
      res.json(await createTemplateVersion({
        setor: req.body?.setor, versao: req.body?.versao,
        conteudo: req.body?.conteudo, ativar: req.body?.ativar !== false,
      }, req.user.email))
    } catch (e) { fail(res, e) }
  })

  // ─── Provedor de IA ──────────────────────────────────────────
  // Mesmo contrato do comercial_pbi: um provedor ativo, chave cifrada, e a
  // listagem dos modelos que aquela chave alcança.
  r.get('/ia', requireAuth({ minRole: 'admin' }), (_req, res) => {
    try { res.json(estadoIA()) } catch (e) { fail(res, e) }
  })

  r.put('/ia', requireAuth({ minRole: 'admin' }), (req, res) => {
    try { res.json(salvarIA(req.body || {}, req.user.email)) } catch (e) { fail(res, e) }
  })

  r.delete('/ia', requireAuth({ minRole: 'admin' }), (_req, res) => {
    try { res.json(removerIA()) } catch (e) { fail(res, e) }
  })

  r.post('/ia/modelos', requireAuth({ minRole: 'admin' }), async (req, res) => {
    try { res.json({ modelos: await listarModelos(req.body || {}) }) } catch (e) { fail(res, e) }
  })

  r.post('/ia/testar', requireAuth({ minRole: 'admin' }), async (_req, res) => {
    try { res.json(await testarIA()) } catch (e) { fail(res, e) }
  })

  // ─────────────────────────────────────────────────────────────
  // Régua, permanência e crédito
  // ─────────────────────────────────────────────────────────────

  // Um power user só mexe no SEU setor. Vale para régua, plano e encerramento:
  // o escopo que já governa os pesos dos indicadores governa os planos também,
  // sem papel novo.
  function exigeSetor(req, setor) {
    if (!setor) throw new Error('Informe o setor.')
    if (!canEditSector(req.user.scopes, setor)) {
      const label = SECTOR_LABELS[setor] || setor
      throw new Error(`Sua conta não edita o setor "${label}".`)
    }
    return setor
  }

  // ─── Teto de crédito por setor ───────────────────────────────
  r.get('/action-plans/settings', requireAuth(), async (_req, res) => {
    try { res.json({ setores: await listSettings() }) } catch (e) { fail(res, e) }
  })

  // O TETO é do power user do setor — decisão de negócio, cobrada depois.
  // A VALIDADE é de admin: se o mesmo papel mexesse nos dois, crédito alto e
  // validade longa sairiam juntos e o crédito deixaria de expirar, que é
  // justamente o que separa plano que resolveu de plano que foi arquivado.
  r.put('/action-plans/settings/:setor', requireAuth({ minRole: 'power_user' }), async (req, res) => {
    try {
      const setor = exigeSetor(req, req.params.setor)
      const { creditoMaximo, validadeDias } = req.body || {}
      if (validadeDias != null && !atLeast(req.user.role, 'admin')) {
        throw new Error('Mudar a validade do crédito é de administrador. O teto de pontos é seu.')
      }
      res.json(await saveSettings({ setor, creditoMaximo, validadeDias }, req.user.email))
    } catch (e) { fail(res, e) }
  })

  r.get('/action-plans/settings/:setor/historico', requireAuth(), async (req, res) => {
    try { res.json({ historico: await settingsHistory(req.params.setor, req.query.limite) }) } catch (e) { fail(res, e) }
  })

  // ─── Régua ───────────────────────────────────────────────────
  r.get('/action-plans/rulers', requireAuth(), async (req, res) => {
    try {
      res.json({ reguas: await listRulers({ setor: req.query.setor || undefined }) })
    } catch (e) { fail(res, e) }
  })

  r.post('/action-plans/rulers', requireAuth({ minRole: 'power_user' }), async (req, res) => {
    try {
      const b = req.body || {}
      exigeSetor(req, b.setor)
      res.json(await createRuler(b, req.user.email))
    } catch (e) { fail(res, e) }
  })

  r.delete('/action-plans/rulers/:id', requireAuth({ minRole: 'power_user' }), async (req, res) => {
    try { res.json(await archiveRuler(req.params.id)) } catch (e) { fail(res, e) }
  })

  // Prévia: quantos contratos a régua pega, e quantos desses já estão em
  // plano. Os dois números juntos, sempre — abrir um plano de 400 que entra
  // com 90 é a frustração que isto evita.
  r.post('/action-plans/rulers/preview', requireAuth({ minRole: 'power_user' }), async (req, res) => {
    try {
      const b = req.body || {}
      const setor = exigeSetor(req, b.setor)
      const estado = await getPlanState()
      const sel = selecionarPorRegua(setor, b.definicao || {}, estado.emPlano)
      // Só uma AMOSTRA volta. Uma régua larga pega milhares de contratos, e
      // mandar todos para a tela seria um JSON de megabytes que ninguém lê —
      // quem decide é a contagem. A criação reexecuta a régua no servidor.
      const AMOSTRA = 50
      res.json({
        ...sel,
        selecionados: sel.selecionados.slice(0, AMOSTRA),
        amostraDe: sel.selecionados.length,
        truncado: sel.selecionados.length > AMOSTRA,
      })
    } catch (e) { fail(res, e) }
  })

  // ─── Planos ──────────────────────────────────────────────────
  r.post('/action-plans/plans', requireAuth({ minRole: 'power_user' }), async (req, res) => {
    try {
      const b = req.body || {}
      const setor = exigeSetor(req, b.setor)
      const estado = await getPlanState()
      const sel = selecionarPorRegua(setor, b.definicao || {}, estado.emPlano)
      const out = await abrirPlano({
        setor, nome: b.nome, rulerId: b.rulerId ?? null,
        criterio: b.definicao || {}, origem: b.origem || 'manual',
        creditoPontos: b.creditoPontos ?? null,
        contratos: sel.selecionados,
      }, req.user.email)
      invalidatePlanState()
      res.json({ ...out, casaram: sel.casaram, jaEmPlano: sel.jaEmPlano })
    } catch (e) { fail(res, e) }
  })

  r.get('/action-plans/memberships', requireAuth(), async (req, res) => {
    try {
      res.json({
        permanencias: await listMemberships({
          runId: req.query.runId || undefined,
          contratoId: req.query.contrato || undefined,
          apenasAbertas: req.query.abertas === '1',
        }),
      })
    } catch (e) { fail(res, e) }
  })

  // Encerrar EXIGE desfecho. `sem_exito` não credita — é essa assimetria que
  // faz o campo valer alguma coisa; sem ela todo encerramento seria "deu
  // certo" e o módulo não produziria nenhum aprendizado.
  r.post('/action-plans/memberships/:id/encerrar', requireAuth({ minRole: 'power_user' }), async (req, res) => {
    try {
      const perm = await getMembership(req.params.id)
      if (!perm) throw new Error('Permanência não encontrada.')
      exigeSetor(req, perm.setor)
      const b = req.body || {}
      const out = await encerrarMembership({
        membershipId: req.params.id, desfecho: b.desfecho,
        scoreSaida: b.scoreSaida ?? null, observacao: b.observacao ?? null,
      }, req.user.email)
      invalidatePlanState()
      res.json(out)
    } catch (e) { fail(res, e) }
  })

  r.post('/action-plans/plans/:runId/encerrar', requireAuth({ minRole: 'power_user' }), async (req, res) => {
    try {
      const run = await getRun(req.params.runId)
      if (!run) throw new Error('Plano não encontrado.')
      exigeSetor(req, run.setor)
      const out = await encerrarPlano({
        runId: req.params.runId, desfecho: req.body?.desfecho, observacao: req.body?.observacao ?? null,
      }, req.user.email)
      invalidatePlanState()
      res.json(out)
    } catch (e) { fail(res, e) }
  })

  // ─── Crédito ─────────────────────────────────────────────────
  r.get('/action-plans/contratos/:id/creditos', requireAuth(), async (req, res) => {
    try { res.json({ creditos: await creditosDoContrato(req.params.id) }) } catch (e) { fail(res, e) }
  })

  r.delete('/action-plans/creditos/:id', requireAuth({ minRole: 'admin' }), async (req, res) => {
    try {
      const out = await revogarCredito(req.params.id, req.user.email)
      invalidatePlanState()
      res.json(out)
    } catch (e) { fail(res, e) }
  })

  // ─── O que o módulo existe para responder ────────────────────
  // Medido pelo score das engines (entrada x saída), nunca pelo creditado:
  // somar o próprio crédito ao resultado provaria que todo plano funciona.
  r.get('/action-plans/efetividade', requireAuth(), async (_req, res) => {
    try {
      res.json({ porSetor: await efetividadePorSetor(), emPlano: await resumoEmPlano() })
    } catch (e) { fail(res, e) }
  })

  return r
}
