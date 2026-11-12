// ─────────────────────────────────────────────────────────────────────────
// Estado de planos para as telas de pontuação (dashboard e engines).
//
// Duas coisas que esta camada existe para garantir:
//
// 1. O dashboard NÃO consulta o MariaDB a cada carregamento. São duas
//    consultas agregadas por janela, compartilhadas por todo mundo que abrir
//    a tela. Sem isso, cada filtro digitado viraria ida ao banco.
//
// 2. Banco fora do ar NÃO derruba o Health Score. Planos de Ação é um módulo
//    acessório; dashboard, engines e coorte existiam antes dele. Em erro, o
//    estado degrada para "ninguém em plano, crédito zero" e a tela carrega
//    igual — com um aviso, não com um 503.
// ─────────────────────────────────────────────────────────────────────────
import { contratosEmPlano, creditosVigentes, resumoEmPlano } from './membership.mjs'

const TTL_MS = 30_000

const VAZIO = {
  emPlano: new Set(),
  creditos: new Map(),
  porSetor: {},
  total: 0,
  disponivel: false,
  erro: null,
}

let cache = null
let carregadoEm = 0
let emVoo = null

/**
 * Estado atual, com janela de 30s.
 *
 * Chamadas concorrentes compartilham a mesma promessa (`emVoo`): abrir a tela
 * dispara /api/dashboard e vários /api/engine quase juntos, e sem isso cada
 * um abriria sua própria consulta ao banco.
 */
export async function getPlanState() {
  const agora = Date.now()
  if (cache && agora - carregadoEm < TTL_MS) return cache
  if (emVoo) return emVoo

  emVoo = (async () => {
    try {
      const [emPlano, creditos, resumo] = await Promise.all([
        contratosEmPlano(),
        creditosVigentes(),
        resumoEmPlano(),
      ])
      cache = {
        emPlano: new Set(emPlano.map((m) => m.contratoId)),
        creditos,
        porSetor: resumo.porSetor,
        total: resumo.total,
        disponivel: true,
        erro: null,
      }
    } catch (e) {
      // Tabela ainda não migrada, banco fora, credencial errada: tudo cai
      // aqui e vira "módulo indisponível", nunca erro na tela de score.
      cache = { ...VAZIO, erro: e.message }
    } finally {
      carregadoEm = Date.now()
      emVoo = null
    }
    return cache
  })()

  return emVoo
}

/**
 * Força a próxima leitura a ir ao banco.
 *
 * Chamado por toda escrita do módulo (abrir plano, encerrar, revogar
 * crédito): sem isso, quem acabou de criar um plano ainda veria os contratos
 * na lista por até 30 segundos e acharia que o botão não funcionou.
 */
export function invalidatePlanState() {
  cache = null
  carregadoEm = 0
}

/** Só o resumo, para o rodapé/contador das telas. */
export async function resumoPlanos() {
  const s = await getPlanState()
  return { total: s.total, porSetor: s.porSetor, disponivel: s.disponivel, erro: s.erro }
}
