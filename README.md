# Aurora Media Server

A personal media server built in Go — Phase 1 + Phase 2.

## Features

### Phase 1 — Core
- **Auth**: Register/login with JWT + refresh tokens, invite codes, rate limiting
- **Libraries**: Multi-path library management with filesystem watching
- **Scanner**: Automatic media discovery with ffprobe metadata extraction
- **Media API**: List, filter, paginate, full-text search (pg_trgm)
- **WebSocket**: Real-time scan progress notifications
- **Security**: Argon2 password hashing, symlink-safe path validation, request size limits

### Phase 2 — Discovery & Playback
- **TMDB Integration**: Auto-match scanned media with TheMovieDB for rich metadata
  - Posters, backdrops, cast & crew, genres, ratings, overviews, taglines
  - Confidence-based matching with manual search override
  - Background refresh of stale metadata
- **Image Proxy**: TMDB images served through Aurora with local caching (no CORS issues)
- **TV Show Detail**: Season/episode browsing with TMDB-enriched episode data
- **Next Episode**: Smart "next unwatched" logic per user
- **Video Streaming**: Direct play via HTTP range requests, HLS transcode fallback via FFmpeg
- **Subtitle Support**: Embedded subtitle extraction (VTT conversion), external SRT/VTT discovery
- **Watch Progress**: Per-user playback position tracking, auto-complete at 90%, continue watching row

## Quick Start

```bash
# 1. Copy env and configure
cp .env.example .env
# Edit .env: set POSTGRES_PASSWORD, TMDB_API_KEY

# 2. Start with Docker Compose
docker compose up -d

# 3. First user becomes admin
curl -X POST http://localhost:8484/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","email":"admin@example.com","password":"yourpassword"}'
```

## API Endpoints

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/api/health` | GET | No | Health check |
| `/api/auth/register` | POST | No | Register (first user = admin) |
| `/api/auth/login` | POST | No | Login → JWT tokens |
| `/api/auth/refresh` | POST | No | Refresh access token |
| `/api/auth/me` | GET | Yes | Current user info |
| `/api/libraries` | GET | Yes | List libraries |
| `/api/libraries` | POST | Admin | Create library |
| `/api/libraries/{id}/scan` | POST | Admin | Trigger scan |
| `/api/media` | GET | Yes | List/filter/paginate media |
| `/api/media/recent` | GET | Yes | Recently added |
| `/api/media/search?q=` | GET | Yes | Full-text search |
| `/api/media/{id}` | GET | Yes | Enriched detail (TMDB) |
| `/api/media/{id}/seasons` | GET | Yes | TV seasons |
| `/api/media/{id}/seasons/{n}/episodes` | GET | Yes | Episodes with files |
| `/api/media/{id}/next-episode` | GET | Yes | Next unwatched episode |
| `/api/media/{id}/artwork` | GET | Yes | All artwork |
| `/api/media/{id}/cast` | GET | Yes | Cast & crew |
| `/api/media/{id}/refresh-metadata` | POST | Admin | Force TMDB refresh |
| `/api/tmdb/search?q=&type=` | GET | Yes | Manual TMDB search |
| `/api/images/{size}/{path}` | GET | No | Image proxy |
| `/api/stream/media/{fileID}` | GET | Yes | Stream media file |
| `/api/stream/episode/{fileID}` | GET | Yes | Stream episode file |
| `/api/stream/{fileID}/subtitles` | GET | Yes | List subtitle tracks |
| `/api/stream/{fileID}/subtitles/{idx}` | GET | Yes | Get subtitle (WebVTT) |
| `/api/progress/continue` | GET | Yes | Continue watching row |
| `/api/progress/{id}` | PUT | Yes | Report playback position |
| `/api/progress/{id}` | GET | Yes | Get watch progress |
| `/api/progress/{id}/watched` | POST | Yes | Mark as watched |
| `/ws` | WS | Token | WebSocket (scan progress) |

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DATABASE_URL` | Yes | — | PostgreSQL connection string |
| `JWT_SECRET` | Yes | auto-gen | Min 32 chars |
| `TMDB_API_KEY` | Yes | — | TMDB v3 API key |
| `AURORA_PORT` | No | 8484 | HTTP port |
| `AURORA_ALLOWED_ORIGINS` | No | localhost | CORS origins |
| `SCANNER_WORKERS` | No | 8 | Parallel scan workers |
| `CACHE_IMAGE_DIR` | No | /var/cache/aurora/images | Image cache |
| `CACHE_TRANSCODE_DIR` | No | /tmp/aurora-transcode | HLS segments |
| `METADATA_REFRESH_HOURS` | No | 168 | Stale metadata re-check (7 days) |

## Requirements

- PostgreSQL 14+ (with pg_trgm extension)
- FFmpeg + FFprobe (for scanning, transcoding, subtitles)
- TMDB API key (free at themoviedb.org)
