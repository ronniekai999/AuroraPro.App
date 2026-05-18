# ── V2 frontend build stage (M10) ────────────────────────────────────
# Builds Aurora's V2 React+Vite SPA. Output (static/v2/) is consumed
# by the Go build stage below via `COPY --from=v2builder` so the Go
# binary's `static/` directory always contains a freshly-built V2
# bundle — independent of whether the committed static/v2/ in the
# repo is current. This makes deployments deterministic.
#
# Using node:20-alpine for the smaller image (~150 MB vs ~1.1 GB for
# the full node:20). npm ci uses package-lock.json so installs are
# reproducible. The Vite build writes to /v2-src/../v2 (i.e. /v2),
# which the next stage picks up.
FROM node:20-alpine AS v2builder
WORKDIR /v2-src
COPY static/redesign/app/package.json static/redesign/app/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY static/redesign/app/ ./
# vite.config.ts writes to ../../v2 relative to this dir, so set up
# the parent so the output lands at /v2 (predictable for the next
# stage's COPY).
RUN mkdir -p /v2 && npm run build

# ── Go build stage ───────────────────────────────────────────────────
FROM golang:1.23-alpine AS builder

ARG VERSION=dev

RUN apk add --no-cache git

WORKDIR /build
COPY go.mod go.sum ./
RUN go mod download

COPY . .
# Overlay the freshly-built V2 bundle onto the static dir. This wipes
# whatever was committed to static/v2/ in the repo and replaces it
# with the v2builder's output — so the deployed bundle ALWAYS matches
# the v2 source in this build, never stale committed artifacts.
RUN rm -rf static/v2
COPY --from=v2builder /v2 ./static/v2

RUN CGO_ENABLED=0 GOOS=linux go build \
    -ldflags="-s -w -X main.version=${VERSION}" \
    -o aurora ./cmd/aurora

# ── Runtime stage ────────────────────────────────────────────────────
FROM alpine:3.21

LABEL org.opencontainers.image.title="Aurora Media Server"
LABEL org.opencontainers.image.description="Self-hosted media streaming server with HLS transcoding"
LABEL org.opencontainers.image.url="https://github.com/aurora-media/aurora"
LABEL org.opencontainers.image.source="https://github.com/aurora-media/aurora"
LABEL org.opencontainers.image.vendor="Aurora Media"

RUN apk add --no-cache ffmpeg ca-certificates tzdata wget

WORKDIR /app
COPY --from=builder /build/aurora .
COPY --from=builder /build/migrations ./migrations
COPY --from=builder /build/static ./static
COPY --from=builder /build/docker-entrypoint.sh .
RUN chmod +x docker-entrypoint.sh

# Create cache directories
RUN mkdir -p /app/cache/images /app/cache/subtitles /tmp/aurora-transcode /app/data

# Create non-root user
RUN addgroup -S aurora && adduser -S aurora -G aurora

# Set ownership so the non-root user can write to required paths
RUN chown -R aurora:aurora /app /tmp/aurora-transcode

USER aurora

EXPOSE 8484

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget -qO- http://localhost:8484/api/health || exit 1

ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["./aurora"]
