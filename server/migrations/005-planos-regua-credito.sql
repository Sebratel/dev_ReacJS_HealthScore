-- ─────────────────────────────────────────────────────────────────────────
-- Planos de Ação: régua, permanência e crédito.
--
-- O módulo nasceu como "rodada de IA": um lote de clientes vira dossiê, a IA
-- recomenda, o gestor aprova, viram tarefas. Esta migration acrescenta o que
-- faltava para ele ser um PLANO de verdade:
--
--   régua      — o critério que seleciona os contratos, salvo e reutilizável
--   permanência— enquanto o plano corre, o contrato fica marcado "em plano"
--   crédito    — ao encerrar com êxito, ganha pontos por prazo determinado
--
-- DUAS DECISÕES QUE O ESQUEMA PRECISA SUSTENTAR, e que valem mais que o SQL:
--
-- 1. Contrato em plano SOME DA TELA, NUNCA DA BASE. Não há coluna que o
--    remova de lugar nenhum: o que existe é uma permanência aberta
--    (`saiu_em is null`), e cada tela decide se filtra. Coorte mensal,
--    receita em risco e assertividade NÃO filtram — se filtrassem, abrir
--    plano viraria a forma mais barata de melhorar o indicador.
--
-- 2. Crédito NÃO é score. Fica em tabela própria, com validade e com quem
--    concedeu. O score medido continua vindo das engines, intocado. Quem
--    exibe soma os dois lado a lado; quem rankeia usa só o medido.
--
-- Contrato não é FK: vive no ELLEVEN (PostgreSQL de terceiro, somente
-- leitura). Mesma decisão da 001.
-- ─────────────────────────────────────────────────────────────────────────

-- ─── Teto de crédito por setor ──────────────────────────────────────────
-- Quem define o teto é o power_user DO SETOR, não o admin: decisão do
-- negócio, com a contrapartida de que a conta é cobrada depois. Para que
-- essa cobrança seja possível, `definido_por` e o log abaixo não são
-- opcionais — sem registro de quem afrouxou o teto, não há o que cobrar.
--
-- `validade_dias` fica aqui mas é de ADMIN. É o contrapeso do teto: se o
-- mesmo papel mexesse nos dois, crédito alto e validade longa sairiam
-- juntos, e o crédito deixaria de expirar — que é justamente o mecanismo
-- que distingue plano que resolveu de plano que foi arquivado.
create table if not exists action_plan_sector_settings (
  setor           varchar(40)      not null primary key,
  credito_maximo  smallint unsigned not null default 15,
  validade_dias   smallint unsigned not null default 45,
  definido_por    varchar(160)     not null,
  definido_em     datetime         not null default current_timestamp on update current_timestamp
) engine=InnoDB default charset=utf8mb4 collate=utf8mb4_unicode_ci;

-- Toda alteração de teto/validade, append-only. A tabela acima responde
-- "quanto é hoje"; esta responde "quem mudou, quando, de quanto para quanto".
create table if not exists action_plan_settings_log (
  id              bigint unsigned not null auto_increment primary key,
  setor           varchar(40)  not null,
  campo           varchar(40)  not null,
  valor_anterior  varchar(40)  null,
  valor_novo      varchar(40)  not null,
  alterado_por    varchar(160) not null,
  alterado_em     datetime     not null default current_timestamp,
  key ix_settings_log_setor (setor, alterado_em)
) engine=InnoDB default charset=utf8mb4 collate=utf8mb4_unicode_ci;

-- ─── Régua ───────────────────────────────────────────────────────────────
-- O critério que seleciona os contratos do plano, salvo com nome para virar
-- um clique no mês seguinte. `definicao` é o mesmo formato de
-- `action_plan_runs.criterio_selecao` — setor, faixa de score ou indicador,
-- mais filtros (cidade, MRR, tempo de casa).
create table if not exists action_plan_rulers (
  id          bigint unsigned not null auto_increment primary key,
  setor       varchar(40)  not null,
  nome        varchar(120) not null,
  descricao   varchar(255) null,
  definicao   json         not null,
  -- Régua sugerida pela plataforma (ex.: "348 contratos caíram de bom para
  -- ruim no Financeiro") nasce com isto em 1 e some da lista ao ser usada.
  sugerida    tinyint(1)   not null default 0,
  arquivada   tinyint(1)   not null default 0,
  criado_por  varchar(160) not null,
  criado_em   datetime     not null default current_timestamp,
  unique key uk_ruler_setor_nome (setor, nome),
  key ix_ruler_setor (setor, arquivada)
) engine=InnoDB default charset=utf8mb4 collate=utf8mb4_unicode_ci;

-- ─── O plano ─────────────────────────────────────────────────────────────
-- `action_plan_runs` já era o lote; vira o plano. As colunas novas separam
-- duas coisas que estavam confundidas numa só:
--   status   — a GERAÇÃO (pendente/gerando/concluida): é da IA, já existia
--   situacao — o PLANO (rascunho/em_andamento/encerrado): é do negócio
-- Um plano pode estar em_andamento com a geração já concluída há semanas.
alter table action_plan_runs
  add column nome            varchar(160) null after setor,
  add column ruler_id        bigint unsigned null after criterio_selecao,
  -- ia | manual | sugerido
  add column origem          varchar(20)  not null default 'ia' after nome,
  -- rascunho | em_andamento | encerrado
  add column situacao        varchar(20)  not null default 'em_andamento' after status,
  -- Congelados na abertura: o teto vigente naquele dia. Se o power_user
  -- mudar o teto depois, planos já abertos não são reprecificados.
  add column credito_pontos  smallint unsigned not null default 0 after situacao,
  add column validade_dias   smallint unsigned not null default 45 after credito_pontos,
  add column encerrado_em    datetime null after concluido_em,
  add column encerrado_por   varchar(160) null after encerrado_em,
  add key ix_runs_situacao (situacao, setor);

-- ─── Permanência: o contrato dentro do plano ─────────────────────────────
-- É a tabela que responde "quem está em plano agora":
--   select contrato_id from action_plan_memberships where saiu_em is null
--
-- Um contrato pode estar em plano de VÁRIOS setores ao mesmo tempo
-- (Financeiro e Rede são problemas distintos), mas só um por setor. O
-- índice único sobre a coluna gerada faz o banco garantir isso — UNIQUE
-- ignora NULL no MariaDB, então N encerrados convivem com no máximo um
-- aberto. Mesmo padrão do prompt ativo na 001.
create table if not exists action_plan_memberships (
  id                     bigint unsigned not null auto_increment primary key,
  run_id                 bigint unsigned not null,
  contrato_id            varchar(60)  not null,
  setor                  varchar(40)  not null,
  -- Congelado na entrada: é o ponto de partida contra o qual o desfecho é
  -- medido. Sem ele, "o score subiu" não tem referência.
  score_entrada          decimal(6,2) null,
  classificacao_entrada  varchar(30)  null,
  entrou_em              datetime     not null default current_timestamp,
  saiu_em                datetime     null,
  -- com_exito | sem_exito | cancelado — null enquanto aberto.
  -- Encerrar EXIGE desfecho: é a única coisa que este módulo produz e
  -- nenhuma outra tela produz (que tipo de plano, em que perfil, moveu o
  -- score). `sem_exito` não gera crédito.
  desfecho               varchar(20)  null,
  score_saida            decimal(6,2) null,
  observacao             text         null,
  contrato_setor_aberto  varchar(110) generated always as
    (if(saiu_em is null, concat(setor, ':', contrato_id), null)) stored,
  constraint fk_member_run foreign key (run_id) references action_plan_runs (id) on delete cascade,
  unique key uk_member_run_contrato (run_id, contrato_id),
  unique key uk_member_um_aberto_por_setor (contrato_setor_aberto),
  key ix_member_aberto (saiu_em, contrato_id),
  key ix_member_contrato (contrato_id),
  key ix_member_desfecho (setor, desfecho)
) engine=InnoDB default charset=utf8mb4 collate=utf8mb4_unicode_ci;

-- ─── Crédito ─────────────────────────────────────────────────────────────
-- Concedido ao encerrar com êxito. NÃO entra no score medido: quem exibe
-- mostra os dois ("38 medido · +15 crédito"), quem rankeia usa o medido.
--
-- Expira. Se o plano resolveu de verdade, o score medido sobe dentro da
-- validade — a fatura é paga, a ONU para de cair. Se não subiu, o ganho era
-- fictício e evapora. É isso que impede o crédito de virar nota comprada.
--
-- Vários setores podem creditar o mesmo contrato; o crédito NÃO SOMA (vale
-- o maior). A regra vive na leitura, não no esquema, porque depende do
-- instante: `max(pontos) where expira_em > now() and revogado_em is null`.
create table if not exists action_plan_credits (
  id             bigint unsigned not null auto_increment primary key,
  membership_id  bigint unsigned not null,
  contrato_id    varchar(60)  not null,
  setor          varchar(40)  not null,
  pontos         smallint unsigned not null,
  -- O teto vigente quando o crédito foi concedido. Guardado junto para que
  -- um crédito antigo possa ser auditado contra a regra da época.
  teto_na_epoca  smallint unsigned not null,
  concedido_por  varchar(160) not null,
  concedido_em   datetime     not null default current_timestamp,
  expira_em      datetime     not null,
  revogado_em    datetime     null,
  revogado_por   varchar(160) null,
  constraint fk_credit_member foreign key (membership_id) references action_plan_memberships (id) on delete cascade,
  unique key uk_credit_membership (membership_id),
  key ix_credit_vigente (contrato_id, expira_em, revogado_em)
) engine=InnoDB default charset=utf8mb4 collate=utf8mb4_unicode_ci;
