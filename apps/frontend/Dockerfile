FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
COPY apps/frontend/package.json apps/frontend/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/sfu-core/package.json packages/sfu-core/package.json
COPY packages/nest-sfu/package.json packages/nest-sfu/package.json
RUN npm install

FROM deps AS build
COPY tsconfig.base.json ./
COPY packages/contracts packages/contracts
COPY packages/sfu-core packages/sfu-core
COPY packages/nest-sfu packages/nest-sfu
COPY apps/frontend apps/frontend
RUN npm run build -w @native-sfu/contracts && npm run build -w @native-sfu/frontend -- --configuration production

FROM nginx:1.27-alpine
COPY apps/frontend/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/frontend/dist/frontend/browser /usr/share/nginx/html
EXPOSE 80
