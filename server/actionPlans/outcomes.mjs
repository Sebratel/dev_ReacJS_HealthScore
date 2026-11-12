// ─────────────────────────────────────────────────────────────────────────
// Reavaliação de impacto — fecha o ciclo da tarefa.
//
// O cuidado central: o "antes" e o "depois" precisam sair da MESMA RÉGUA. O
// "antes" ficou congelado no dossiê, calculado pela engine financeira com a
// config oficial daquele momento; o "depois" é recalculado agora, com a mesma
// engine e a config oficial de agora. Quando a config muda entre um e outro, a
// variação deixa de significar "efeito da ação" — por isso gravamos
// `config_versao` junto, e a tela avisa quando as duas não batem.
//
// Roda depois do ETL (o score só é novo quando o snapshot é novo) e também sob
// gatilho manual de admin.
// ─────────────────────────────────────────────────────────────────────────
import { scoreEngineAllClients } from '../engines.mjs'
import { getClients, getDataset } from '../dataset.mjs'
import { getOfficialConfig } from '../officialConfig.mjs'
import { withDefaults } from '../engineDefaults.mjs'
import { listTasksDueForOutcome, insertOutcome } from './store.mjs'

export const DEFAULT_PRAZO_DIAS = 30

// Identidade da régua: se mudar entre o antes e o depois, a comparação perde
// sentido. `updatedAt` da config oficial é o carimbo mais barato que temos.
function configVersion() {
  const o = getOfficialConfig()
  return o?.updatedAt ? `oficial@${o.updatedAt}` : 'defaults-do-codigo'
}

// Avalia as tarefas concluídas há >= prazoDias e ainda sem resultado.
// Devolve o que foi feito — o endpoint manual mostra isso ao admin.
export async function runOutcomeEvaluation({ prazoDias = DEFAULT_PRAZO_DIAS } = {}) {
  const pendentes = await listTasksDueForOutcome(prazoDias)
  if (!pendentes.length) return { avaliadas: 0, semDados: 0, total: 0 }

  const clients = getClients()
  if (!clients.length) throw new Error('Base ainda não materializada — sem snapshot não há score "depois".')

  const official = getOfficialConfig()
  // withDefaults, nunca a config crua — e aqui o estrago seria o pior dos
  // tres lugares onde isso aparecia. Sem o merge, uma config publicada antes
  // de um indicador virar faixa pontua zero: todo contrato sai com 100 no
  // "depois", e TODO plano parece ter dado certo. A medicao de efetividade
  // mentiria exatamente na direcao que agrada. Ver server/configOficial.test.mjs.
  const config = withDefaults(official?.configs)?.financial
  if (!config) throw new Error('Config oficial do Financeiro não publicada — sem ela não há régua para o "depois".')

  const scores = scoreEngineAllClients('financial', {
    clients,
    config,
    thresholds: official?.thresholds,
    monthly: getDataset()?.monthly || [],
  })
  const byId = new Map(scores.map((s) => [String(s.customerId), s]))
  const versao = configVersion()

  let avaliadas = 0
  let semDados = 0
  for (const t of pendentes) {
    const atual = byId.get(String(t.clienteId))
    const dias = Math.round((Date.now() - new Date(t.concluidoEm).getTime()) / 86400000)

    if (!atual) {
      // Cliente saiu da população da engine (cancelou, ou perdeu os sinais que
      // o colocavam nela). Registramos o fato em vez de deixar a tarefa
      // pendente para sempre — e sem inventar um score.
      await insertOutcome({
        taskId: t.taskId,
        scoreAntes: t.scoreAntes,
        scoreDepois: null,
        classificacaoAntes: t.classificacaoAntes,
        classificacaoDepois: null,
        diasDecorridos: dias,
        configVersao: versao,
        observacao: 'Cliente não está mais na população da engine financeira (cancelamento ou ausência de sinais).',
      })
      semDados++
      continue
    }

    await insertOutcome({
      taskId: t.taskId,
      scoreAntes: t.scoreAntes,
      scoreDepois: atual.healthScore,
      classificacaoAntes: t.classificacaoAntes,
      classificacaoDepois: atual.classification,
      diasDecorridos: dias,
      configVersao: versao,
    })
    avaliadas++
  }

  return { avaliadas, semDados, total: pendentes.length, configVersao: versao }
}
