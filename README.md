# ChurnIQ — Plataforma de Inteligência de Churn para ISPs

Plataforma analítica enterprise para previsão e redução de churn em provedores de internet, com foco em ISPs regionais do RS.

> 📘 **[DIRETRIZES.md](DIRETRIZES.md)** — como usar a plataforma: acessos por
> setor, como ler o Health Score, e as boas práticas de Planos de Ação e das
> sugestões de IA. Leitura para quem opera; este README é para quem instala.

## Stack

| Camada | Tecnologia |
|---|---|
| Framework | React 18 + Vite + TypeScript |
| Estilização | Tailwind CSS (dark theme customizado) |
| Gráficos | Recharts |
| Tabelas | TanStack Table v8 |
| Ícones | Lucide React |
| Estado | Zustand |
| Rotas | React Router v6 |
| Animações | Framer Motion |
| Datas | date-fns |

## Início Rápido

```bash
cd churn_mvp
npm install
npm run dev
```

Acesse `http://localhost:5173`

Para usar o **Catálogo de Queries** (em Configurações) também no dev, suba o backend numa segunda aba:

```bash
npm run api        # sobe a API em http://localhost:8787 (proxy /api do Vite aponta p/ ela)
```

## Catálogo de Queries (editável)

As ~30 queries SQL que alimentam o ETL ficam num **registro central** em
[`scripts/queries/`](scripts/queries/) — a fonte única de verdade, importada
tanto pelo ETL (`fetch-clients.mjs`) quanto pelo backend. Em **Configurações →
Queries do Sistema** dá para visualizar, copiar e **editar** cada query.

- `registry.mjs` — definições default (mesmos fragmentos/SQL do ETL original).
- `guard.mjs` — barra qualquer SQL que não seja somente-leitura (SELECT/WITH).
- `overrides.mjs` — persiste as edições em `data/query-overrides.json`.
- `index.mjs` — resolve o **SQL efetivo = override ?? default**.

Fluxo da edição:

```
Tela (Bearer Google) → PUT /api/queries/:id → grava override no servidor
                                              ↓
              ETL (node fetch-clients.mjs) lê o registro → usa o override
```

> As edições passam a valer na **próxima execução do ETL** — não alteram o
> snapshot já carregado pelo front. O botão **Restaurar padrão** remove o
> override e volta ao SQL original.

**Segurança:** editar SQL roda contra o banco no ETL. O `guard` recusa
escrita/DDL e o backend exige conta Google do domínio permitido
(`ALLOWED_DOMAIN`) — com allowlist opcional de editores (`QUERY_EDITOR_EMAILS`).
Mesmo assim, use um **usuário PostgreSQL somente-leitura** no ETL
(`DB_ELLEVEN_USER`) como garantia final.

Verificação de paridade (o registro novo gera SQL idêntico ao original):

```bash
npm run check:queries
```

## Planos de Ação (IA) — setor Financeiro

Ciclo fechado: a plataforma escolhe os piores clientes do Financeiro, monta um
dossiê por cliente, pede um plano à IA, o gestor decide, a ação vira tarefa e o
efeito é medido no health score.

```
seleção (mesmo ranking de /financeiro)
  → dossiê congelado → IA (schema forçado) → validação
  → decisão do gestor → tarefa com prazo → reavaliação 30 dias depois
```

### O que é diferente do resto do sistema

Este é o **único módulo que escreve num banco**. Todo o resto vive do snapshot
do ETL e de JSON no volume. As tabelas ficam numa base própria no MariaDB
(`DB_HealthScore`), com um pool de escrita separado do pool somente-leitura do
ETL — a fronteira é intencional.

```bash
npm run migrate         # cria a base (se faltar) e aplica as migrations
npm run migrate:status  # lista o que está pendente
```

A API também aplica as migrations pendentes no boot (`RUN_MIGRATIONS_ON_BOOT`),
porque o deploy é pelo Portainer e não há passo intermediário. Falhar aí **não**
derruba a API: o resto do sistema não depende deste banco, e a tela do módulo
mostra o que está faltando.

### Provedor de IA

Cadastrado em **Configurações → Provedor de IA** (admin), não no `.env` — mesmo
contrato do `comercial_pbi`. **Um** provedor ativo, não uma lista: o módulo
precisa saber sem ambiguidade com que modelo cada plano foi gerado, e "qual é o
padrão hoje?" é pergunta que não deveria existir.

| | |
|---|---|
| Tipos | `anthropic`, `openai` e compatíveis (Groq, OpenRouter, Azure, local — muda só a URL base), `gemini`, e `simulado` |
| Onde fica | `data/ia.json`, no volume — ao lado de `roles.json` e `official-config.json` |
| Chave | cifrada em AES-256-GCM; **nunca** volta numa resposta, só os 4 últimos caracteres |
| Chave de cifra | `APP_SECRET`; sem ela, uma é gerada em `data/.secret` — funciona sem configuração, mas aí perder o volume é perder o que foi cifrado |
| Modelos | a tela lista os modelos **que aquela chave alcança**, consultando o provedor |

Fica em arquivo, e não no MariaDB, por dois motivos: é do mesmo naipe das outras
configs de runtime, e assim a tela do provedor continua funcionando quando o
banco do módulo está fora — que é justamente quando alguém vai querer configurar.

Sem provedor cadastrado o módulo roda em **modo simulado**, com uma resposta
determinística: o fluxo inteiro funciona e a tela diz, em letras claras, que
nenhuma IA foi consultada.

HTTP cru em vez do SDK oficial: são três dialetos atrás de uma interface só, e
misturar SDK num deles com `fetch` nos outros dobraria tratamento de erro e
timeout.

### Duas barreiras para a saída da IA

Cada dialeto pede JSON do jeito que sabe — Anthropic aceita o **JSON Schema
inteiro** (`output_config.format`); OpenAI e Gemini entram em **modo JSON**, que
garante a forma mas não o schema. Nenhum deles é a garantia: quem cobra o
contrato é o validador do servidor, que roda depois em qualquer caminho.

Não é redundância — a segunda barreira pega prompt trocado, modelo trocado e
provedor que ignora o campo. Uma resposta reprovada é gravada com
`status = 'falha_schema'` para auditoria e **nunca** aparece ao gestor como
válida: um plano malformado com cara de bom é o modo de falha perigoso deste
módulo.

### Medir o efeito exige a mesma régua

O "antes" fica congelado no dossiê; o "depois" é recalculado pela **mesma
engine com a config oficial vigente**, e o outcome grava qual régua foi usada.
Sem isso, uma troca de pesos entre um momento e outro apareceria como efeito da
ação. O job roda depois do ETL (o score só é novo quando o snapshot é novo) e
tem gatilho manual para admin.

```bash
npm run outcomes        # reavaliação sob demanda
npm test                # 77 testes de contrato, provedor e registro
ACTION_PLAN_E2E=1 npm test   # + fluxo ponta a ponta (cria e derruba uma base)
```

## Entrada pelo Hub Apps (iframe com login automático)

O Health Score pode abrir **dentro do Hub Apps**. O Hub abre o sistema num iframe com `?sso_token=<JWT HS256 de 5 min>`; antes de o React montar, o front tira o token da URL e o troca na API (`POST /api/auth/hub`) por uma sessão de 8 h, guardada no `sessionStorage` do quadro. O papel (viewer / power_user / admin) continua vindo de `ADMIN_EMAILS` + `data/roles.json`.

| Variável (serviço `api`) | Para quê |
| --- | --- |
| `HUB_SSO_SECRET` | Mesmo valor do `SSO_JWT_SECRET` do hub-api. Segredo: nunca em variável `VITE_`. |
| `HUB_APP_ID` | Id do card do Health Score no Hub. Vazio = entrada pelo Hub desligada e `HUB_ONLY` ignorado. |
| `HUB_ONLY` | `true` = só pelo Hub, **sem exceção** (nem admin): o Google é recusado no servidor com `403 { code: "HUB_ONLY" }`, sessões já abertas param de valer e a aba solta mostra "Acesse pelo Hub Apps". Só vale com as duas acima. |
| `HUB_URL` | Link do botão "Abrir o Hub Apps" (só https). Padrão: `https://hub-apps.sebratel.net.br`. |

Rotas públicas de entrada: `GET /api/auth/config` → `{ hubSso, hubOnly, hubUrl }` e `POST /api/auth/hub`. Todas as demais rotas `/api` (inclusive `/api/dataset/lists`, que era pública) exigem Bearer; só `/api/health` fica aberta.

O nginx do `web` manda `Content-Security-Policy: frame-ancestors 'self' https://hub-apps.sebratel.net.br https://hub-apps-staging.sebratel.net.br` (ver `docker/nginx.conf`). Não configure isso no "Advanced" do Nginx Proxy Manager, e não adicione `X-Frame-Options`.

**Deploy, nesta ordem:** criar o card no Hub (SSO "passar token" + "Abrir dentro do Hub" + URL https do Health Score) → pôr `HUB_SSO_SECRET` e `HUB_APP_ID` na stack → redeploy → testar a entrada pelo Hub → só então `HUB_ONLY=true` e redeploy.

## Estrutura

```
src/
├── components/
│   ├── layout/       # Sidebar, TopBar, MainLayout
│   └── ui/           # Card, KpiCard, RiskBadge, Skeleton
├── features/
│   ├── dashboard/    # Dashboard Executivo
│   ├── customers/    # Clientes em Risco (TanStack Table)
│   ├── timeline/     # Timeline do Cliente
│   ├── financial/    # Financeiro / Inadimplência
│   ├── network/      # Rede & Massivas
│   ├── maintenance/  # Manutenção & SLA
│   ├── commercial/   # Comercial & Vendedores
│   └── ai/           # IA Preditiva
├── mocks/            # 500 clientes + dados gerados proceduralmente
├── router/           # React Router (lazy loading por rota)
├── store/            # Zustand store global
├── types/            # TypeScript types
└── utils/            # cn(), formatCurrency, formatPercent
```

## Dados Mock

- **500 clientes** gerados via seeded RNG (reproduzível)
- Cidades reais do RS com coordenadas geográficas
- Contratos, pagamentos, protocolos, falhas de rede
- Score de churn calculado por fórmula multiváriavel:
  `score = atraso × 0.4 + falhas × 3 + protocolos × 2.5 + suporte × 1.5 + ...`

## Rotas

| Rota | Módulo |
|---|---|
| `/` | Dashboard Executivo |
| `/clientes` | Tabela avançada com filtros e ordenação |
| `/timeline?id=C0001` | Timeline visual do cliente |
| `/financeiro` | Aging, inadimplência, receita em risco |
| `/rede` | Massivas, uptime, eventos de rede |
| `/manutencao` | Protocolos, SLA, técnicos |
| `/comercial` | Vendedores, campanhas, churn precoce |
| `/ia` | IA preditiva, alertas, projeções |

## Evolução Futura

```
Backend:     FastAPI + PostgreSQL + Redis
ML:          scikit-learn / LightGBM para churn score real
Auth:        JWT + multiempresa (tenant isolation)
Maps:        Leaflet com pins de clientes por risco
Realtime:    WebSocket para alertas ao vivo
Reports:     PDF export por cliente / executivo
```

## Design System

Inspirado em Datadog, Grafana, Linear e Vercel Dashboard.

- Fundo: `#060910` (deep navy)
- Cards: `#0d1117` com borda `#1a2236`
- Primary: `#4f8ef7` (blue)
- Danger: `#ef4444` (red)
- Success: `#10b981` (green)
- Warning: `#f59e0b` (amber)
#   d e v _ R e a c t J S _ C h u r n 
 
 #   N e x u s C h u r n _ R e a c t J S 
 
 #   N e x u s C h u r n _ R e a c t J S 
 
 