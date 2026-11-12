// ─────────────────────────────────────────────────────────────────────────
// Toda leitura da config oficial passa por `withDefaults`.
//
// Existe por causa de um erro real, achado rodando a régua: `runner.mjs` lia
// `official.configs[setor]` CRU. A config gravada traz as NOTAS; a FORMA dos
// indicadores (quais faixas existem) vem do código. Uma config publicada
// antes de um indicador virar faixa não tem `indices` — e sem o merge ela
// pontua zero.
//
// O estrago era silencioso e assimétrico: `/api/dashboard` e `/api/engine`
// aplicam o merge, então a TELA mostrava 294 críticos no Financeiro; a régua,
// lendo cru, via todo mundo com 100 e selecionava NINGUÉM. Nenhum erro,
// nenhum log — só um plano vazio e a impressão de que o botão não funciona.
//
// Teste de TEXTO de propósito: o defeito é "alguém escreveu a leitura crua
// num arquivo novo", não um comportamento em runtime. Importar os módulos
// aqui sobe Express e conecta em banco; ler a fonte não.
// ─────────────────────────────────────────────────────────────────────────
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))

// Todo arquivo do servidor que PONTUA a partir da config publicada.
const ARQUIVOS = [
  'index.mjs',
  'actionPlans/runner.mjs',
  'actionPlans/outcomes.mjs',
  'scoreHistory.mjs',
  'churnForecast.mjs',
]

// Qualquer `X.configs.algo` ou `X?.configs?.[algo]` — a linha que tiver
// `withDefaults` é pulada antes, então sobra só o acesso cru.
//
// A primeira versão exigia que o objeto se chamasse algo com "config"
// (`\w*[Cc]onfig\w*`). A variável real é `official`, então o guard passava com
// o defeito restaurado — descoberto testando por mutação. O nome do objeto
// não é pista de nada; o que importa é `.configs` sendo indexado.
const ACESSO_CRU = /\w+\s*\??\s*\.configs\s*\??\s*[.[]/g

describe('config oficial nunca é lida crua', () => {
  for (const rel of ARQUIVOS) {
    const caminho = join(__dirname, rel)
    let fonte
    try { fonte = readFileSync(caminho, 'utf8') } catch { continue }

    it(`${rel} passa a config publicada por withDefaults`, () => {
      const linhas = fonte.split('\n')
      const crus = []
      linhas.forEach((linha, i) => {
        const limpa = linha.replace(/\/\/.*$/, '')
        if (limpa.includes('withDefaults')) return
        ACESSO_CRU.lastIndex = 0
        if (ACESSO_CRU.test(limpa)) crus.push(`${rel}:${i + 1}  ${linha.trim()}`)
      })
      expect(
        crus,
        `Leitura crua de .configs — envolva em withDefaults(...), senão uma config ` +
        `gravada antes de um indicador virar faixa pontua zero em silêncio:\n  ${crus.join('\n  ')}`,
      ).toEqual([])
    })
  }

  it('runner.mjs importa withDefaults', () => {
    // A régua e a seleção da rodada de IA dependem disso: sem o import, o
    // guard acima não tem como passar, mas o erro de verdade é este.
    const fonte = readFileSync(join(__dirname, 'actionPlans/runner.mjs'), 'utf8')
    expect(fonte).toMatch(/import \{ withDefaults \} from '\.\.\/engineDefaults\.mjs'/)
  })
})
