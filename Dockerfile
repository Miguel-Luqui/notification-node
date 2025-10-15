# imagem leve Node.js
FROM node:18-alpine

WORKDIR /usr/src/app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

COPY . .

ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "src/api.js"]