FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
COPY pnpm-lock.yaml ./
RUN npm install -g pnpm@8 && pnpm install --prod --frozen-lockfile
COPY . .
EXPOSE 3004
CMD ["node", "index.js"]
