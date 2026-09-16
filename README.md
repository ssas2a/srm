# SRM Credit Engine

Plataforma de avaliação e liquidação de recebíveis em BRL e USD. O projeto possui um frontend web estático, um backend em TypeScript/Express e um PostgreSQL executado via Docker Compose.

## Arquitetura

```text
Navegador
   |
   | HTTP GET/POST/PUT
   v
Frontend vanilla ------> Backend Express :3000 ------> PostgreSQL :5432
                         /api/v1
```

O frontend não é iniciado pelo Docker Compose. O Compose sobe somente o backend e o banco.

## Estrutura

```text
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
  .env
  .env.example
run_all.sh
big_bang.sh
destroy_all.sh
update_exchange_rate.sh
.githooks/commit-msg
```

## Pré-requisitos

- Docker Engine
- Docker Compose v2
- Bash
- Node.js e npm, caso o backend seja compilado fora do Docker
- Python 3, caso o frontend seja servido com o servidor HTTP simples

## Configuração do ambiente

As configurações locais do Compose ficam em `services/.env`. O arquivo não deve ser versionado porque contém credenciais.

Exemplo baseado em `services/.env.example`:

```dotenv
DB_HOST=postgres-db
DB_PORT=5432
DB_USER=srm_user
DB_PASSWORD=srm_pass
DB_NAME=srm_credit_db
DB_CONTAINER_NAME=srm-postgres-db
DB_EXPOSED_PORT=5432
SERVICE_EXPOSED_PORT=3000
```

`DB_USER`, `DB_PASSWORD` e `DB_NAME` são obrigatórios no Compose. `DB_HOST` e `DB_PORT` são usados pelo backend e pelo script de atualização cambial. `DB_CONTAINER_NAME` identifica o contêiner acessado por `update_exchange_rate.sh`.

## Backend e banco

### Subida normal

Na raiz do projeto:

```bash
./run_all.sh
```

O script:

1. remove os contêineres do projeto;
2. preserva imagens e volumes;
3. reconstrói a imagem do backend;
4. recria PostgreSQL e backend;
5. exibe o status dos serviços.

Serviços após a subida:

- Backend: `http://127.0.0.1:3000`
- PostgreSQL: `localhost:5432`

O PostgreSQL deve aparecer como `healthy`.

### Execução manual

```bash
cd services
npm install
npm run build
npm start
```

Para execução manual fora do Docker, forneça as variáveis `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD` e `DB_NAME` no ambiente do processo.

### Reconstrução destrutiva

```bash
./big_bang.sh
```

Além de recriar os serviços, remove imagens e volumes do projeto. Isso apaga os dados persistidos do PostgreSQL.

### Destruição sem recriação

```bash
./destroy_all.sh
```

Remove os contêineres, imagens e volumes do projeto, incluindo os recursos do PostgreSQL. O script também tenta remover explicitamente imagens locais do repositório `postgres`.

Não execute `big_bang.sh` ou `destroy_all.sh` se precisar preservar os dados do banco.

## Frontend

O frontend está em `frontend/` e é uma aplicação vanilla HTML, CSS e JavaScript. A URL da API está fixa em `frontend/js/config.js`:

```javascript
API_BASE_URL: 'http://127.0.0.1:3000/api/v1'
```

A página não exibe um campo para alterar essa URL.

Para servir localmente:

```bash
cd frontend
python3 -m http.server 8080
```

Acesse `http://127.0.0.1:8080`.

O frontend:

- cadastra ativos;
- envia `cliente`, `idempotencyKey`, tipo, valor, moeda e vencimento;
- carrega a lista de ativos;
- exibe valor de face, valores presentes, deságio, cotação e status;
- permite selecionar e liquidar ativos;
- consulta o câmbio na primeira carga;
- consulta o câmbio novamente a cada 30 segundos;
- permite atualização manual da cotação exibida usando somente `GET`.

O frontend não altera a cotação no banco.

## API

Todas as rotas estão sob `/api/v1`.

### Consultar câmbio

```http
GET /api/v1/cambio
```

Resposta:

```json
{
  "pair": "USD_BRL",
  "rate": 5.365,
  "updatedAt": "2026-09-16T20:16:47.026Z"
}
```

Não existe `POST /api/v1/cambio`. A alteração da cotação é feita pelo script operacional descrito abaixo.

### Cadastrar ativos

```http
POST /api/v1/ativo
Content-Type: application/json
```

O corpo pode ser um objeto ou uma lista de objetos:

```json
[
  {
    "cliente": "cliente-demo",
    "idempotencyKey": "ativo-001",
    "tipo": "DUPLICATA",
    "valorFace": 25000,
    "moeda": "BRL",
    "vencimento": "2027-12-31"
  }
]
```

Campos obrigatórios:

- `cliente`: identificação do cliente;
- `idempotencyKey`: chave única do ativo para aquele cliente;
- `tipo`: `DUPLICATA`, `CHEQUE` ou `CONTRATO`, entre os aliases suportados;
- `valorFace`: valor positivo com até duas casas decimais;
- `moeda`: `BRL` ou `USD`;
- `vencimento`: data no formato `YYYY-MM-DD`.

Resposta bem-sucedida: `201 Created`.

### Idempotência

A idempotência é por ativo, não por lista. A combinação abaixo é única:

```text
cliente + idempotencyKey
```

- primeira requisição: cria o ativo;
- repetição com os mesmos dados: retorna o ativo existente;
- mesma combinação com dados diferentes: retorna `409 Conflict`;
- a chave e o hash do payload ficam em `asset_idempotency_keys`.

Exemplo de conflito:

```json
{
  "error": "idempotencyKey já utilizada com dados diferentes."
}
```

### Listar ativos

```http
GET /api/v1/ativo
```

Os itens retornam, entre outros campos:

```json
{
  "id": "ATV-1234",
  "tipo": "DUPLICATA",
  "valorFace": 25000,
  "moeda": "BRL",
  "valorPresenteBrl": 23351.41,
  "valorPresenteUsd": 4352.55,
  "desagio": 1648.59,
  "cotacaoDolar": 5.365,
  "status": "AVALIADO"
}
```

### Atualizar status

```http
PUT /api/v1/ativo
Content-Type: application/json
```

Exemplo:

```json
[
  {
    "id": "ATV-1234",
    "status": "LIQUIDADO"
  }
]
```

A atualização utiliza transação e bloqueio `FOR UPDATE`. Mudanças reais de status são registradas na auditoria.

## Precificação

O cálculo está no backend, em `calculatePresentValueCents`, e usa o padrão Strategy para selecionar o spread pelo tipo:

- duplicata: `1,5% ao mês`;
- cheque: `2,5% ao mês`;
- contrato: `2,0% ao mês`;
- tipo desconhecido: estratégia padrão de duplicata.

A taxa base é `0,8% ao mês`. A fórmula é:

```text
Valor Presente = Valor Face / (1 + Taxa Base + Spread)^Prazo
```

O prazo é calculado como `ceil(dias até o vencimento / 30)`. Para prazo zero, o valor presente é igual ao valor de face.

O deságio é:

```text
Deságio = Valor Face - Valor Presente
```

## Precisão monetária

O backend trabalha com `bigint`:

- dinheiro: centavos, escala `100`;
- câmbio: quatro casas decimais, escala `10000`.

O arredondamento segue a regra de desempate para o par da ABNT NBR 5891. Exemplos:

- `12,345` para duas casas resulta em `12,34`;
- `12,355` para duas casas resulta em `12,36`.

O frontend recebe valores já calculados pelo backend e não deve decidir arredondamentos financeiros com `toFixed`.

## Banco de dados

O arquivo `services/init.sql` cria ou prepara:

- `exchange_rates`: histórico de cotações;
- `assets`: recebíveis e valores calculados;
- `audit_events`: rastreabilidade das operações;
- `asset_idempotency_keys`: idempotência por cliente e ativo.

O backend também executa verificações de schema na inicialização para bancos já existentes.

### Auditoria

A tabela `audit_events` registra:

- `ASSET_CREATED` para criação de ativo;
- `ASSET_STATUS_CHANGED` para mudança real de status;
- `ASSET_RECALCULATED` para reconciliação de valores existentes;
- `EXCHANGE_RATE_UPDATED` para alteração feita pelo script operacional.

Os dados anterior e atual são armazenados em `JSONB`. A operação e a auditoria são confirmadas na mesma transação quando aplicável.

## Atualização operacional do câmbio

Como não existe endpoint HTTP de escrita para a cotação, use:

```bash
./update_exchange_rate.sh 5.4200 USD_BRL
```

O script:

1. lê conexão e nome do contêiner em `services/.env`;
2. valida cotação positiva com até quatro casas;
3. verifica se o contêiner PostgreSQL está em execução;
4. executa `psql` via `docker exec`;
5. insere uma nova cotação em `exchange_rates`;
6. captura a cotação anterior;
7. registra `EXCHANGE_RATE_UPDATED` em `audit_events`;
8. confirma alteração e auditoria na mesma transação.

Variáveis necessárias:

```dotenv
DB_HOST=postgres-db
DB_PORT=5432
DB_USER=srm_user
DB_PASSWORD=srm_pass
DB_NAME=srm_credit_db
DB_CONTAINER_NAME=srm-postgres-db
```

## Hook de commits

O hook `.githooks/commit-msg` valida o padrão das mensagens. Ative no clone local:

```bash
git config core.hooksPath .githooks
chmod +x .githooks/commit-msg
```

Formato aceito:

```text
tipo: descrição
tipo(escopo): descrição
```

Tipos aceitos incluem `fix`, `feature`, `config`, `feat`, `docs`, `refactor`, `test`, `build`, `ci`, `chore`, `perf` e `revert`.

Exemplos:

```text
fix: corrige arredondamento ABNT
feature: adiciona idempotencia por ativo
config: parametriza conexao do banco
fix(api): corrige consulta de cambio
```

## Validação rápida

Backend:

```bash
cd services
npm run build
```

Frontend:

```bash
node --check frontend/js/app.js
```

Compose:

```bash
cd services
docker compose --env-file .env config --quiet
```

Serviços:

```bash
curl http://127.0.0.1:3000/api/v1/cambio
docker compose --env-file services/.env -f services/docker-compose.yaml ps
```

Teste de endpoint removido:

```bash
curl -i -X POST http://127.0.0.1:3000/api/v1/cambio
```

O resultado esperado é `404 Not Found`.

## Segurança e operação

- Não versione `services/.env`.
- Não registre senhas em logs.
- `big_bang.sh` e `destroy_all.sh` removem volumes e podem apagar dados.
- O frontend deve usar somente o endpoint de leitura do câmbio.
- Não execute scripts destrutivos em ambiente compartilhado sem confirmar o projeto Compose correto.
