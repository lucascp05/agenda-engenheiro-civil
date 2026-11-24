FROM node:22-bookworm-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
COPY prisma ./prisma
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY test ./test
RUN npm run build
USER node
EXPOSE 3000
CMD ["sh", "-c", "./node_modules/.bin/prisma migrate deploy && exec node dist/main.js"]
