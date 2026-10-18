# SAIP Training Gateway
FROM node:22-slim

WORKDIR /app

# Install dependencies
COPY shared/package.json shared/tsconfig.json ./shared/
COPY training/package.json training/tsconfig.json ./training/
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml* ./
RUN npm install -g pnpm && pnpm install --frozen-lockfile || pnpm install

# Copy source
COPY shared/src ./shared/src/
COPY training/src ./training/src/

# Build
RUN pnpm --filter @saip/shared build && pnpm --filter @saip/training build

EXPOSE 8001

CMD ["node", "training/dist/index.js"]
