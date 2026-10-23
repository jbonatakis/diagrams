# syntax=docker/dockerfile:1
FROM --platform=$BUILDPLATFORM node:24-bookworm-slim AS web
WORKDIR /build
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --no-fund
COPY index.html tsconfig.json vite.config.ts playwright.config.ts ./
COPY scripts/assets.mjs ./scripts/assets.mjs
COPY src ./src
COPY shared ./shared
COPY tests ./tests
RUN npm run build

FROM --platform=$BUILDPLATFORM golang:1.26-bookworm AS backend
WORKDIR /build
COPY go.mod go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod go mod download
COPY cmd ./cmd
COPY internal ./internal
COPY shared ./shared
ARG TARGETOS
ARG TARGETARCH
RUN --mount=type=cache,target=/go/pkg/mod --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH go build -trimpath -ldflags='-s -w' -o /out/diagrams ./cmd/diagrams
RUN mkdir -p /out/data && chmod 700 /out/data

FROM scratch
WORKDIR /app
COPY --from=backend /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --from=backend /out/diagrams /app/diagrams
COPY --from=backend --chown=10001:10001 /out/data /data
COPY --from=web /build/dist /app/dist
ENV DIAGRAMS_ADDR=0.0.0.0:8080 \
    DIAGRAMS_STATIC_DIR=/app/dist \
    DIAGRAMS_DB=/data/pairings.db
USER 10001:10001
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD ["/app/diagrams", "healthcheck"]
ENTRYPOINT ["/app/diagrams"]
