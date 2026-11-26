# syntax=docker/dockerfile:1

# ─────────────────────────────────────────────────────────────
# Stage 1 — build do front (Vite/React)
# ─────────────────────────────────────────────────────────────
FROM node:20-alpine AS build
WORKDIR /app

# Instala dependências com lockfile (build reprodutível)
COPY package.json package-lock.json ./
RUN npm ci

# Código-fonte (inclui public/realClients.data, copiado para o dist no build)
COPY . .

# VITE_GOOGLE_CLIENT_ID é variável de BUILD do Vite (fica embutida no bundle).
# Passada via build arg pelo docker-compose (env da stack no Portainer).
ARG VITE_GOOGLE_CLIENT_ID=""
ENV VITE_GOOGLE_CLIENT_ID=$VITE_GOOGLE_CLIENT_ID

RUN npm run build

# ─────────────────────────────────────────────────────────────
# Stage 2 — serve estático com nginx (SPA)
# ─────────────────────────────────────────────────────────────
FROM nginx:alpine AS serve

# Config com fallback de SPA + tratamento do snapshot de dados
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf

# Artefato buildado
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 80

# Healthcheck simples (busybox wget já vem no nginx:alpine)
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1/ >/dev/null 2>&1 || exit 1

CMD ["nginx", "-g", "daemon off;"]
