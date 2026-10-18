# SAIP Inference Gateway
FROM node:22-slim

WORKDIR /app

# Install dependencies
COPY shared/package.json shared/tsconfig.json ./shared/
COPY inference/package.json inference/tsconfig.json ./inference/
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml* ./
RUN npm install -g pnpm && pnpm install --frozen-lockfile || pnpm install

# Copy source
COPY shared/src ./shared/src/
COPY inference/src ./inference/src/

# Build
RUN pnpm --filter @saip/shared build && pnpm --filter @saip/inference build

EXPOSE 8000

CMD ["node", "inference/dist/index.js"]
