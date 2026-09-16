# Prompt de Reconstrucao do SRM Credit Engine

Atue como um engenheiro de software senior e recrie, do zero, um projeto chamado **SRM Credit Engine** no workspace atual. O sistema deve ser uma plataforma de cessao e liquidacao de recebiveis multimoedas, com backend em TypeScript/Express/PostgreSQL, frontend vanilla HTML/CSS/JavaScript e execucao do backend via Docker Compose.

Nao use implementacoes temporarias ou prototipos antigos. Organize o projeto com esta estrutura minima:

```text
/
  frontend/
    index.html
    style.css
    js/
      app.js
      config.js
  services/
    src/index.ts
    init.sql
    Dockerfile
    docker-compose.yaml
    package.json
    package-lock.json
    tsconfig.json
    .env.example
    .env
  run_all.sh
  big_bang.sh
  destroy_all.sh
  README_case_dev_srm.md
```

## Backend

Use TypeScript, Express, `pg`, CORS e PostgreSQL 16. O backend deve escutar na porta interna `3000` e expor:

- `GET /api/v1/cambio`: retorna a cotacao USD/BRL mais recente.
- `POST /api/v1/ativo`: cadastra e precifica um ou varios ativos. Cada item deve ser processado individualmente.
- `GET /api/v1/ativo`: lista os ativos com valores financeiros, desagio, cotacao e status.
- `PUT /api/v1/ativo`: atualiza o status dos ativos e recalcula os valores cambiais.

Nao crie endpoint para alterar manualmente a cotacao do dolar. O endpoint `POST /api/v1/cambio` deve estar ausente.

Use transacoes PostgreSQL com `BEGIN`, `COMMIT`, `ROLLBACK` e `FOR UPDATE` nas alteracoes de ativos. Retorne codigos HTTP semanticos e nao exponha detalhes internos de excecoes.

## Precisao financeira

Nunca use `number` para os calculos financeiros do backend. Use `bigint` com escalas inteiras:

- dinheiro em centavos: escala `100`;
- cotacao cambial com quatro casas: escala `10000`.

Implemente arredondamento conforme a ABNT NBR 5891, com desempate para o par:

- abaixo de 5: conserva;
- acima de 5 ou 5 seguido de algarismos diferentes de zero: incrementa;
- exatamente 5 seguido apenas de zeros: conserva o quociente par e incrementa o impar.

Casos obrigatorios:

- `12,345` para duas casas resulta em `12,34`;
- `12,355` para duas casas resulta em `12,36`.

## Strategy de precificacao

Use o padrao Strategy para decidir a regra pelo tipo do ativo. Crie uma interface comum e estrategias concretas:

- `DUPLICATA` e `DUPLICATA_MERCANTIL`: spread de `1,5% ao mes`;
- `CHEQUE` e `CHEQUE_PREDATADO`: spread de `2,5% ao mes`;
- `CONTRATO` e `CONTRATO_SERVICO`: spread de `2,0% ao mes`;
- tipo desconhecido: estrategia padrao de duplicata.

A taxa base e `0,8% ao mes`. Calcule:

```text
Valor Presente = Valor Face / (1 + Taxa Base + Spread)^Prazo
```

O prazo deve ser calculado pela diferenca entre a data atual UTC e o vencimento, usando meses como `ceil(dias / 30)`. Para prazo zero, o valor presente e o valor de face.

Calcule tambem:

```text
Desagio = Valor Face - Valor Presente
```

Converta valores entre BRL e USD usando a cotacao mais recente e o mesmo arredondamento ABNT.

## Idempotencia por ativo

Cada item enviado ao `POST /api/v1/ativo` deve conter:

```json
{
  "cliente": "cliente-demo",
  "idempotencyKey": "ativo-001",
  "tipo": "DUPLICATA",
  "valorFace": 1000,
  "moeda": "BRL",
  "vencimento": "2027-12-31"
}
```

A idempotencia e por ativo, nao por lista. Crie uma tabela `asset_idempotency_keys` com chave primaria composta por `cliente` e `idempotency_key`, hash SHA-256 do payload relevante e referencia ao `asset_id`.

Comportamento:

1. Primeira combinacao `cliente + idempotencyKey`: cria o ativo.
2. Repeticao com a mesma combinacao e mesmos dados: retorna o ativo ja existente, sem duplicar.
3. Mesma combinacao com dados diferentes: retorna `409 Conflict`.
4. A operacao deve permanecer transacional.

O frontend deve solicitar o nome do cliente e gerar uma UUID para `idempotencyKey` de cada ativo criado.

## Banco de dados

Crie `services/init.sql` com as tabelas:

### `exchange_rates`

- `id`
- `pair`
- `rate NUMERIC(10,4)`
- `updated_at`

Insira uma cotacao inicial `USD_BRL` de `5.3650`.

### `assets`

- `id`
- `tipo`
- `valor_face`
- `moeda`
- `vencimento`
- `valor_presente_centavos`
- `desagio_centavos`
- `valor_presente_brl_centavos`
- `valor_presente_usd_centavos`
- `cotacao_dolar_4dp`
- `status`
- `created_at`
- `updated_at`

### `audit_events`

Registre eventos de negocio com:

- `id`
- `event_type`
- `entity_type`
- `entity_id`
- `action`
- `previous_data JSONB`
- `current_data JSONB`
- `metadata JSONB`
- `created_at`

Registre, no minimo:

- criacao de ativo: `ASSET_CREATED`;
- mudanca real de status: `ASSET_STATUS_CHANGED`;
- reconciliacao de ativo existente: `ASSET_RECALCULATED`.

Como nao existe endpoint de alteracao manual do cambio, nao crie fluxo de atualizacao de cotacao pelo backend. O historico de cotacoes deve permanecer somente para leitura e para dados inseridos por carga/migracao externa.

## Frontend

Crie uma interface vanilla em `frontend/` com:

- formulario para tipo do ativo, valor de face, moeda, vencimento e cliente;
- tabela de ativos com ID, tipo, moeda, valor de face, vencimento, valor presente BRL, valor presente USD, desagio, cotacao do dolar e status;
- botoes para carregar ativos, enviar avaliacao e liquidar selecionados/individualmente;
- consulta inicial de cambio ao carregar a pagina;
- nova consulta de cambio a cada 30 segundos;
- consulta manual de cambio, se mantida, deve ser somente GET;
- nenhum campo visivel para configurar a URL base da API;
- URL fixa em `frontend/js/config.js`, por exemplo `http://127.0.0.1:3000/api/v1`;
- tratamento de erros sem quebrar a pagina.

O desagio exibido deve ser fornecido pelo backend e formatado na moeda original do ativo. Nao use `toFixed` para decidir arredondamentos financeiros.

## Docker e ambiente

Crie `services/docker-compose.yaml` com dois servicos:

- `postgres-db`, usando `postgres:16-alpine`;
- `currency-service`, construido a partir de `services/Dockerfile`.

Use volume `pgdata`, rede compartilhada e healthcheck do PostgreSQL. As credenciais e dados de conexao devem ser recebidos por variaveis de ambiente:

- `DB_HOST`
- `DB_PORT`
- `DB_USER`
- `DB_PASSWORD`
- `DB_NAME`
- `DB_EXPOSED_PORT`
- `SERVICE_EXPOSED_PORT`

`DB_USER`, `DB_PASSWORD` e `DB_NAME` devem ser obrigatorios no Compose. Crie `.env.example` sem segredo real. O `.env` local nao deve ser versionado.

## Scripts operacionais

Crie scripts Bash executaveis na raiz:

### `run_all.sh`

- localiza `services/docker-compose.yaml` independentemente do diretorio atual;
- usa `services/.env` se existir;
- executa `docker compose down --remove-orphans`;
- executa `docker compose up -d --build --force-recreate`;
- mostra o status final.

### `big_bang.sh`

Faz o mesmo que `run_all.sh`, mas remove imagens e volumes do projeto antes de reconstruir:

```bash
docker compose down --remove-orphans --rmi all --volumes
```

### `destroy_all.sh`

Remove os recursos do projeto sem recriar:

- contêineres;
- imagens;
- volumes;
- recursos do banco, incluindo `srm-postgres-db`, imagens locais do repositorio `postgres` e o volume `pgdata`.

Nao remova recursos Docker de outros projetos sem relacao.

### `update_exchange_rate.sh`

Crie um script executavel na raiz para atualizar a cotacao diretamente no banco, ja que o endpoint `POST /api/v1/cambio` nao existe.

O script deve:

- receber a cotacao como primeiro argumento e o par como segundo argumento opcional;
- aceitar cotacoes positivas com no maximo quatro casas decimais;
- carregar todos os dados de conexao exclusivamente de `services/.env`:
  - `DB_HOST`;
  - `DB_PORT`;
  - `DB_USER`;
  - `DB_PASSWORD`;
  - `DB_NAME`;
  - `DB_CONTAINER_NAME`;
- verificar se o container do banco esta em execucao;
- executar `psql` por meio de `docker exec` no contêiner configurado;
- inserir a nova cotacao em `exchange_rates`;
- registrar `EXCHANGE_RATE_UPDATED` em `audit_events`, incluindo valor anterior e atual;
- realizar a alteracao e a auditoria na mesma transacao;
- retornar erro sem alterar o banco para argumentos invalidos ou container indisponivel.

Exemplo:

```bash
./update_exchange_rate.sh 5.4200 USD_BRL
```

O arquivo `services/.env` deve ser local, nao deve conter valores de exemplo no versionamento e nao deve ser exposto em logs. Use `services/.env.example` como modelo, sem credenciais reais.

## Validacao obrigatoria

Depois de criar tudo:

1. rode `npm run build` no backend;
2. rode `node --check frontend/js/app.js`;
3. valide `docker compose config` com um `.env` de teste;
4. suba o Compose;
5. confirme que o PostgreSQL esta healthy;
6. confirme `GET /api/v1/cambio` com HTTP 200;
7. confirme que `POST /api/v1/cambio` retorna HTTP 404;
8. envie o mesmo ativo duas vezes e confirme o mesmo ID;
9. envie a mesma chave com payload diferente e confirme HTTP 409;
10. confirme que a tabela de auditoria e a tabela de idempotencia existem;
11. nao remova alteracoes preexistentes do usuario sem autorizacao.

Ao final, informe os arquivos criados, os testes executados e qualquer limitacao encontrada. Nao faca commit automaticamente.
