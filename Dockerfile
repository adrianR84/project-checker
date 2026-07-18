FROM node:23-alpine
WORKDIR /app
COPY package*.json ./
COPY pnpm-lock.yaml ./
RUN corepack enable && pnpm install --prod --frozen-lockfile
COPY . .
EXPOSE 3004
CMD ["node", "index.js"]
