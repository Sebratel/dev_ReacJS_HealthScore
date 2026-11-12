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
-- porque é o mesmo servidor e só muda a base. A conveniência tem um preço: a
-- conta do ETL é de LEITURA sobre bases de terceiros, e se ela também for a
-- conta de escrita da aplicação, a fronteira entre "o que o sistema lê" e "o
-- que o sistema escreve" existe só no comentário do código.
--
-- Com um usuário próprio, o banco passa a garantir o que hoje é promessa:
-- `hs_app` NÃO ALCANÇA nenhuma base do ERP, e a conta do ETL não escreve em
-- lugar nenhum. Um bug de SQL na aplicação não tem como tocar o ELLEVEN.
--
-- COMO RODAR
--
--   mysql -h <host> -u root -p < server/migrations/PROVISIONAR-USUARIO.sql
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
