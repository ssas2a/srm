# Estágio 1: Build da aplicação TypeScript
FROM node:20-alpine AS builder
WORKDIR /app

# Copia os manifestos de dependências
COPY package*.json tsconfig.json ./

# Instala todas as dependências (incluindo devDependencies necessárias para o tsc)
RUN npm install

# Copia o código fonte e compila
COPY src ./src
RUN npm run build

# Estágio 2: Execução em produção
FROM node:20-alpine AS runner
WORKDIR /app

COPY package*.json ./

# Instala apenas dependências de produção
RUN npm install --only=production

# Copia o resultado compilado da etapa de build
COPY --from=builder /app/dist ./dist

EXPOSE 3000
CMD ["node", "dist/index.js"]
