# Base leve com Node.js LTS
FROM node:18-alpine

# Diretório de trabalho dentro do container
WORKDIR /usr/src/app

# Copia apenas manifestos de dependências primeiro para aproveitar cache do Docker
# Se existir package-lock.json, npm ci será usado (instalações reprodutíveis).
COPY package.json package-lock.json* ./

# Instala dependências de produção.
# - Usa `npm ci` quando houver lockfile (reprodutível e mais rápido em CI)
# - Caso contrário, cai para `npm install` para evitar falha em builds locais sem lockfile
RUN if [ -f package-lock.json ]; then \
      npm ci --omit=dev; \
    else \
      npm install --omit=dev; \
    fi

# Copia o resto da aplicação
COPY . .

# Ajuste de permissões: executa como usuário não-root para segurança
# A imagem oficial já tem usuário `node`, vamos usar ele.
RUN chown -R node:node /usr/src/app

# Executar como usuário não-root (melhor prática)
USER node

# Ambiente de produção por padrão; permite override via docker-compose/.env
ENV NODE_ENV=production

# Porta exposta pelo app (consistente com src/api.js)
EXPOSE 3000

# Comando padrão (pode ser sobrescrito no docker-compose)
CMD ["node", "src/api.js"]