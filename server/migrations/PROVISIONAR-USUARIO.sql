-- ─────────────────────────────────────────────────────────────────────────
-- Usuário e base dedicados da aplicação — rodar UMA VEZ, com o usuário
-- master do MariaDB.
--
-- NÃO é uma migration: o runner (`npm run migrate`) não executa este arquivo,
-- e nem poderia — ele se conecta com o usuário que este script cria. Por isso
-- o nome fora do padrão NNN-*.sql.
--
-- POR QUE EXISTE
--
-- `server/db.mjs` deixa DB_APP_USER cair em DB_MARIA_USER quando ausente,
-- porque é o mesmo servidor e só muda a base. A conveniência tem um preço.
--
-- Conferido no servidor em 12/11/2026, `DevSebratel` (a conta do .env) tem
-- ALL PRIVILEGES em 22 bases da casa — DB_DevTasks, DB_Marketing,
-- DB_Cancellation_Plataform, DB_ComercialDashboard, DB_Applicattion e outras.
-- Ela NÃO alcança o ERP (o ELLEVEN é PostgreSQL, por outro pool), mas alcança
-- o banco de praticamente todo sistema interno. Um `delete` sem `where`
-- escrito no Health Score não para em DB_HealthScore.
--
-- Com um usuário próprio, o banco passa a garantir o que hoje é disciplina:
-- `hs_app` não tem como tocar em nada fora desta base.
--
-- ATENÇÃO: este script precisa de uma conta com CREATE USER. `DevSebratel`
-- NÃO tem (`ERROR 1227`), então o DBA precisa rodar — ou conceder o
-- privilégio.
--
-- COMO RODAR
--
-- O caminho mais curto NÃO é este arquivo — é o script, que faz o mesmo
-- usando o driver que o projeto já tem (sem precisar de cliente MariaDB
-- instalado) e ainda CONFERE o isolamento no fim:
--
--   npm run provisionar:usuario -- --senha 'SENHA_NOVA'
--
-- Este .sql fica como referência de exatamente o que é executado, e para
-- quem preferir rodar por um cliente gráfico (DBeaver, HeidiSQL) ou pelo
-- terminal do servidor:
--
--   mysql -h <host> -u <master> -p < server/migrations/PROVISIONAR-USUARIO.sql
--
-- Troque a senha abaixo ANTES de rodar e guarde-a em DB_APP_PASSWORD na
-- stack. Depois disto, `npm run migrate` aplica o esquema com esta conta.
-- ─────────────────────────────────────────────────────────────────────────

create database if not exists DB_HealthScore
  default character set utf8mb4
  collate utf8mb4_unicode_ci;

-- '%' porque a API roda em contêiner: o IP de origem muda a cada recriação
-- da stack. Quem fecha o acesso é a rede do Docker, não o host do GRANT.
create user if not exists 'hs_app'@'%' identified by 'TROQUE-ESTA-SENHA';

-- Só DML, e só nesta base. Sem CREATE/ALTER/DROP: o esquema é mudado pelo
-- runner de migrations, que roda com conta de DBA numa janela controlada —
-- não pela aplicação servindo requisição.
grant select, insert, update, delete on DB_HealthScore.* to 'hs_app'@'%';

-- Para a própria `npm run migrate` rodar com esta conta, descomente:
-- grant create, alter, drop, index, references on DB_HealthScore.* to 'hs_app'@'%';

flush privileges;

-- Conferência: deve listar APENAS DB_HealthScore (e information_schema).
-- show databases;      -- conectado como hs_app
-- show grants for 'hs_app'@'%';
