FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/backend/package.json apps/backend/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/media-ingest/package.json packages/media-ingest/package.json
COPY packages/sfu-core/package.json packages/sfu-core/package.json
COPY packages/nest-sfu/package.json packages/nest-sfu/package.json
COPY apps/frontend/package.json apps/frontend/package.json
COPY apps/admin-portal/package.json apps/admin-portal/package.json
RUN npm ci

FROM node:22-bookworm-slim AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/backend/package.json apps/backend/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/media-ingest/package.json packages/media-ingest/package.json
COPY packages/sfu-core/package.json packages/sfu-core/package.json
COPY packages/nest-sfu/package.json packages/nest-sfu/package.json
COPY apps/frontend/package.json apps/frontend/package.json
COPY apps/admin-portal/package.json apps/admin-portal/package.json
RUN npm ci --omit=dev --workspace @native-sfu/backend --include-workspace-root

FROM deps AS build
COPY tsconfig.base.json ./
COPY packages/contracts packages/contracts
COPY packages/media-ingest packages/media-ingest
COPY packages/sfu-core packages/sfu-core
COPY packages/nest-sfu packages/nest-sfu
COPY apps/backend apps/backend
RUN npm run build -w @native-sfu/contracts \
  && npm run build -w @native-sfu/media-ingest \
  && npm run build -w @native-sfu/sfu-core \
  && npm run build -w @native-sfu/nest-sfu \
  && npx tsc -p apps/backend/tsconfig.build.json

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates ffmpeg tini \
  && rm -rf /var/lib/apt/lists/*
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/packages/contracts/dist ./packages/contracts/dist
COPY --from=build /app/packages/media-ingest/dist ./packages/media-ingest/dist
COPY --from=build /app/packages/sfu-core/dist ./packages/sfu-core/dist
COPY --from=build /app/packages/nest-sfu/dist ./packages/nest-sfu/dist
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/media-ingest/package.json packages/media-ingest/package.json
COPY packages/sfu-core/package.json packages/sfu-core/package.json
COPY packages/nest-sfu/package.json packages/nest-sfu/package.json
COPY --from=build /app/apps/backend/dist ./apps/backend/dist
COPY apps/backend/package.json apps/backend/package.json
RUN mkdir -p /app/recordings /app/chat-attachments /app/class-materials /app/profile-media /app/tutor-intro-videos \
  && chown -R node:node /app
USER node
EXPOSE 3000 40000-40999/udp
ENTRYPOINT ["tini", "--"]
CMD ["node", "apps/backend/dist/main.js"]
