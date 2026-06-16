FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
COPY apps/backend/package.json apps/backend/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/sfu-core/package.json packages/sfu-core/package.json
COPY packages/nest-sfu/package.json packages/nest-sfu/package.json
RUN npm install

FROM deps AS build
COPY tsconfig.base.json ./
COPY packages/contracts packages/contracts
COPY packages/sfu-core packages/sfu-core
COPY packages/nest-sfu packages/nest-sfu
COPY apps/backend apps/backend
RUN npm run build -w @native-sfu/contracts && npm run build -w @native-sfu/sfu-core && npm run build -w @native-sfu/nest-sfu && npx tsc -p apps/backend/tsconfig.build.json

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/packages/contracts/dist ./packages/contracts/dist
COPY --from=build /app/packages/sfu-core/dist ./packages/sfu-core/dist
COPY --from=build /app/packages/nest-sfu/dist ./packages/nest-sfu/dist
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/sfu-core/package.json packages/sfu-core/package.json
COPY packages/nest-sfu/package.json packages/nest-sfu/package.json
COPY --from=build /app/apps/backend/dist ./apps/backend/dist
COPY apps/backend/package.json apps/backend/package.json
EXPOSE 3000 40000-40100/udp
CMD ["node", "apps/backend/dist/main.js"]
