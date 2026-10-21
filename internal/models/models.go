package models

import (
	"time"
)

// --- Users & Auth ---

type UserRole string

const (
	RoleAdmin UserRole = "admin"
	RoleUser  UserRole = "user"
)

type User struct {
	ID           int64     `json:"id"`
	Username     string    `json:"username"`
	Email        string    `json:"email"`
	PasswordHash string    `json:"-"`
	Role         UserRole  `json:"role"`
	AvatarURL    string    `json:"avatar_url,omitempty"`
	CreatedAt    time.Time `json:"created_at"`
	UpdatedAt    time.Time `json:"updated_at"`
	// LastLoginAt is the user's most recent authentication — password login,
	// OAuth callback, or registration's immediate sign-in. Nil for users who
	// haven't signed in since migration 036 added the column (rendered as
	// "Never" in the admin UI). Deliberately NOT bumped on token refresh: that's
	// a silent session continuation, not a re-login. Only GetAllUsers (the admin
	// list) selects it; other user lookups leave it nil, so json omitempty drops
	// the field from those responses.
	LastLoginAt *time.Time `json:"last_login_at,omitempty"`
	// TokenVersion is stamped into the JWT at issue time so a password change
	// (which bumps this column) immediately invalidates all outstanding
	// access tokens via the auth middleware's TokenVersionStore.
	TokenVersion int `json:"-"`
	// OAuth identity (migration 020). Non-nil pair when the user has linked
	// (or signed up via) an OAuth provider — e.g. ("google", "118123456").
	// Nil for password-only users. Used by GetUserByOAuth for return visits
	// and by the login flow to gate password attempts against OAuth-only
	// users (those with empty password_hash).
	OAuthProvider *string `json:"oauth_provider,omitempty"`
	OAuthSubject  *string `json:"-"`
	// Referral attribution (migration 046). Only set for users created through
	// an invite-bypassing OAuth provider without redeeming an invite code —
	// the one signup path that otherwise records nothing about where the user
	// came from.
	//
	// ReferralStatus: nil = never eligible; "pending" = asked-but-unresolved;
	// "answered" | "skipped" = resolved. ReferralSource holds the option KEY
	// (not its admin-editable label, which would rewrite history on rename),
	// and ReferralDetail is free text present only when the source is "other".
	//
	// Selected ONLY by GetAllUsers (the admin list); every other user lookup
	// leaves them nil, so omitempty drops them from those responses. In
	// particular CreateOAuthUserWithIdentity writes referral_status but does
	// not return it, so the OAuth success page can't stash a stale copy —
	// GET /api/me/referral-prompt is the single authority on whether to ask.
	//
	// ReferralDetail is attacker-controlled free text: length-capped and
	// stripped of control/format characters at the API, and rendered as data,
	// never markup, in the admin UI.
	ReferralStatus     *string    `json:"referral_status,omitempty"`
	ReferralSource     *string    `json:"referral_source,omitempty"`
	ReferralDetail     *string    `json:"referral_detail,omitempty"`
	ReferralAnsweredAt *time.Time `json:"referral_answered_at,omitempty"`
}

// MemberProfile is the member-visible identity card for one account
// (migration 049) — the "profile page" surface. Distinct from UserProfile
// (the Netflix-style sub-profiles within an account): a MemberProfile is
// account-level and is what OTHER signed-in members may see, so it must
// never grow email, role, or any auth field.
type MemberProfile struct {
	UserID      int64  `json:"user_id"`
	Username    string `json:"username"`
	DisplayName string `json:"display_name,omitempty"`
	Bio         string `json:"bio,omitempty"`
	// Social handles are stored bare (no "@", no URL) — per-network shape is
	// enforced at the API (social_handlers.go), and the frontend composes the
	// links against fixed well-known domains, so a profile can never link to
	// an arbitrary site.
	SocialX         string `json:"social_x,omitempty"`
	SocialInstagram string `json:"social_instagram,omitempty"`
	SocialFacebook  string `json:"social_facebook,omitempty"`
	SocialSnapchat  string `json:"social_snapchat,omitempty"`
	// AvatarURL mirrors the account's DEFAULT sub-profile avatar (falling
	// back to users.avatar_url, which OAuth signup may have set), so the face
	// other members see is the one the user picked for their main profile.
	AvatarURL string `json:"avatar_url,omitempty"`
	// MemberSince is truncated to YEAR precision at the query (the UI shows
	// "Member since 2025"; other members get no use of the exact second).
	MemberSince time.Time `json:"member_since"`
	// ShareWatchHistory gates the profile page's "Recently Watched" strip
	// (and the follow feed once that lands). Opt-in, default false.
	ShareWatchHistory bool `json:"share_watch_history"`
}

// MemberRecentWatch is one completed title on a member's profile page: a
// media-card summary plus when it was finished. Only rows with a non-NULL
// completed_at qualify (migration 033 deliberately did not backfill), so the
// strip reflects activity from that migration forward — and rewatches update
// in place rather than appearing twice, because watch_progress is per-item
// state, not an event log.
type MemberRecentWatch struct {
	ID           int64     `json:"id"` // media_items.id — the card's click target
	Title        string    `json:"title"`
	Type         string    `json:"type"`
	PosterPath   string    `json:"poster_path,omitempty"`
	BackdropPath string    `json:"backdrop_path,omitempty"`
	Year         int       `json:"year,omitempty"`
	Rating       float64   `json:"rating,omitempty"`
	WatchedAt    time.Time `json:"watched_at"`
}

// UpdateMemberProfileRequest is the PUT /api/me/profile patch body.
// nil = leave unchanged; empty string = clear the field (same convention as
// UpdateProfileRequest).
type UpdateMemberProfileRequest struct {
	DisplayName       *string `json:"display_name,omitempty"`
	Bio               *string `json:"bio,omitempty"`
	SocialX           *string `json:"social_x,omitempty"`
	SocialInstagram   *string `json:"social_instagram,omitempty"`
	SocialFacebook    *string `json:"social_facebook,omitempty"`
	SocialSnapchat    *string `json:"social_snapchat,omitempty"`
	ShareWatchHistory *bool   `json:"share_watch_history,omitempty"`
}

// MemberSummary is the row shape for member lists (directory, followers,
// following): just enough to render a member card + link. Same exposure
// rules as MemberProfile — never grow auth fields here.
type MemberSummary struct {
	UserID      int64  `json:"user_id"`
	Username    string `json:"username"`
	DisplayName string `json:"display_name,omitempty"`
	AvatarURL   string `json:"avatar_url,omitempty"`
	// IsFollowing is viewer-relative (does the CALLER follow this member);
	// only the directory query populates it.
	IsFollowing bool `json:"is_following"`
}

// FollowedRecentWatch is one feed row for the "From People You Follow" home
// rail: a completed title plus WHO (display name falling back to username)
// and WHEN. Only followees with share_watch_history = TRUE ever contribute
// — the 049 opt-in is the single privacy gate and the feed query re-checks
// it on every read, so flipping sharing off empties a member out of every
// feed immediately.
type FollowedRecentWatch struct {
	MemberRecentWatch
	WatchedBy         string `json:"watched_by"`
	WatchedByUsername string `json:"watched_by_username"`
}

// OAuthIdentity is one row of the oauth_identities table (migration 031) — a
// single (provider, subject) link belonging to a user. Multiple rows per user
// (one per provider) is the whole point: it's what lets an account link both
// Google and Discord. This table is the authoritative source for OAuth-login
// resolution; the legacy users.oauth_provider/oauth_subject columns are a
// best-effort mirror of the primary identity only. Subject is omitted from
// JSON (the provider's opaque user ID is not useful to the SPA and leaking it
// serves no purpose).
type OAuthIdentity struct {
	ID        int64     `json:"id"`
	UserID    int64     `json:"user_id"`
	Provider  string    `json:"provider"`
	Subject   string    `json:"-"`
	CreatedAt time.Time `json:"created_at"`
}

type RefreshToken struct {
	ID         int64     `json:"id"`
	UserID     int64     `json:"user_id"`
	Token      string    `json:"token"`
	ExpiresAt  time.Time `json:"expires_at"`
	CreatedAt  time.Time `json:"created_at"`
	Revoked    bool      `json:"revoked"`
	DeviceInfo string    `json:"device_info,omitempty"`
	// ActiveProfileID is the sub-profile currently bound to this session
	// (issue #462) — set via ProfileHandler.ActivateProfile, consulted by
	// db.ResolveActingProfile. nil = no explicit switch yet, falls back to
	// the account default profile.
	ActiveProfileID *int64 `json:"active_profile_id,omitempty"`
	// BoundPINHash is the PIN state ActiveProfileID was judged under when a
	// new session is created (CreateRefreshTokenAtVersion): nil for a profile
	// that must still have no PIN, else the hash it must still have. Not
	// stored.
	BoundPINHash *string `json:"-"`
}

type InviteCode struct {
	ID        int64      `json:"id"`
	Code      string     `json:"code"`
	CreatedBy int64      `json:"created_by"`
	UsedBy    *int64     `json:"used_by,omitempty"`
	UsedAt    *time.Time `json:"used_at,omitempty"`
	ExpiresAt time.Time  `json:"expires_at"`
	CreatedAt time.Time  `json:"created_at"`
}

// --- Libraries ---

type LibraryType string

const (
	LibraryMovies LibraryType = "movie"
	LibraryShows  LibraryType = "show"
)

type Library struct {
	ID           int64       `json:"id"`
	Name         string      `json:"name"`
	Type         LibraryType `json:"type"`
	Paths        []string    `json:"paths"`
	ScanInterval int         `json:"scan_interval_minutes"`
	OwnerID      int64       `json:"owner_id"`
	CreatedAt    time.Time   `json:"created_at"`
	UpdatedAt    time.Time   `json:"updated_at"`
}

// --- Media Items ---

type MediaType string

const (
	MediaMovie MediaType = "movie"
	MediaShow  MediaType = "show"
)

type MediaItem struct {
	ID            int64     `json:"id"`
	LibraryID     int64     `json:"library_id"`
	Type          MediaType `json:"type"`
	Title         string    `json:"title"`
	SortTitle     string    `json:"sort_title"`
	Year          int       `json:"year,omitempty"`
	Overview      string    `json:"overview,omitempty"`
	Rating        float64   `json:"rating,omitempty"`
	RuntimeMin    int       `json:"runtime_minutes,omitempty"`
	ContentRating string    `json:"content_rating,omitempty"`
	PosterPath    string    `json:"poster_path,omitempty"`
	BackdropPath  string    `json:"backdrop_path,omitempty"`
	Studio        string    `json:"studio,omitempty"`
	Network       string    `json:"network,omitempty"`
	ReleaseDate   string    `json:"release_date,omitempty"`
	MatchStatus   string    `json:"match_status,omitempty"`
	AddedAt       time.Time `json:"added_at"`
	UpdatedAt     time.Time `json:"updated_at"`

	// Eager-loaded relations (populated by API layer)
	Genres   []string     `json:"genres,omitempty"`
	Files    []*MediaFile `json:"files,omitempty"`
	Has4K    bool         `json:"has_4k,omitempty"`
	HasHDR   bool         `json:"has_hdr,omitempty"`
	FilePath string       `json:"file_path"` // representative file path (flagged items only)
	// Reason is a transient one-line LLM-generated explanation ("Because you finished
	// Severance"). Populated at the API layer by semantic search / hero rerank and
	// emitted to the frontend as italic caption text. Never stored in the database.
	Reason string `json:"reason,omitempty"`
	// NearestAnchor is a transient pointer to the user's recently-watched item
	// whose embedding sits closest to this item. Populated by the rail
	// recommender via cosine-similarity match against the profile's recent
	// watch history. Used by the frontend to render a "Because you watched X"
	// caption when no LLM-generated Reason is available. Never persisted.
	NearestAnchor *AnchorRef `json:"nearest_anchor,omitempty"`
	// MatchScore is a transient cosine-similarity-to-taste-vector score in
	// [0,1], derived as max(0, 1 - cosine_distance) where the distance comes
	// from the recommender's pgvector ORDER BY. Populated by NearestUnwatched /
	// NearestUnwatchedRich for personalized (taste-vector) pools only; stays 0
	// for the cold-start popular pool which has no centroid to compare against.
	// Under multi-centroid recall this is the similarity to the profile's
	// CLOSEST taste mode (interleaveMerge stamps the max). The hero recommender
	// maps it to the integer personal percent (HeroPick.Match — NOT .Score,
	// which is the global Aurora Score). Never persisted.
	MatchScore float64 `json:"match_score,omitempty"`

	// AI-match suggestion (migration 026). Populated by the AI matcher
	// (internal/matching) for items in match_status='needs_review'. The
	// matcher always sets AIMatchRanAt after it evaluates an item so the
	// backfill worker doesn't re-process it; the other fields are populated
	// only when the LLM returned a real suggestion. When confidence ≥
	// AI_MATCH_AUTO_THRESHOLD the matcher promotes the item via
	// EnrichByTMDBID (sets match_status='matched') and the suggestion fields
	// stay as an audit trail.
	//
	// Surfaced to the admin UI via the FlaggedItems endpoint so the operator
	// can one-click-approve sub-threshold suggestions via the existing
	// ManualMatch handler. Pointer types where the absence of a value
	// matters: AISuggestedTMDBID==nil means "evaluated, no candidate fit"
	// vs the integer-zero case "TMDB id literally 0" (unreachable in TMDB
	// but defended against in the parser).
	AISuggestedTMDBID *int       `json:"ai_suggested_tmdb_id,omitempty"`
	AISuggestedTitle  string     `json:"ai_suggested_title,omitempty"`
	AISuggestedYear   int        `json:"ai_suggested_year,omitempty"`
	AIMatchConfidence *int       `json:"ai_match_confidence,omitempty"`
	AIMatchReasoning  string     `json:"ai_match_reasoning,omitempty"`
	AIMatchRanAt      *time.Time `json:"ai_match_ran_at,omitempty"`
}

// AnchorRef is a lightweight reference to a watched anchor item — just
// enough to render "Because you watched <title> (<year>)" in the UI. Kept
// minimal so the rail JSON payload doesn't balloon when every item carries
// an anchor reference.
type AnchorRef struct {
	Title string `json:"title"`
	Year  int    `json:"year,omitempty"`
	Type  string `json:"type"`
}

type MediaFile struct {
	ID           int64  `json:"id"`
	MediaItemID  int64  `json:"media_item_id"`
	Path         string `json:"-"`
	SizeBytes    int64  `json:"size_bytes"`
	Container    string `json:"container"`
	VideoCodec   string `json:"video_codec,omitempty"`
	AudioCodec   string `json:"audio_codec,omitempty"`
	Resolution   string `json:"resolution,omitempty"`
	VersionTag   string `json:"version_tag,omitempty"`
	Bitrate      int64  `json:"bitrate,omitempty"`
	DurationMs   int64  `json:"duration_ms,omitempty"`
	VideoProfile string `json:"video_profile,omitempty"`
	VideoPixFmt  string `json:"video_pix_fmt,omitempty"`
	// Color metadata — distinguishes HDR (smpte2084 PQ / arib-std-b67
	// HLG / bt2020 primaries) from SDR 10-bit so the transcode
	// pipeline doesn't mis-apply the HDR-to-SDR tonemap to SDR sources.
	// Empty = unknown (treat as non-HDR, safer default).
	ColorTransfer  string `json:"color_transfer,omitempty"`
	ColorPrimaries string `json:"color_primaries,omitempty"`
	// VideoFPS is the probed average frame rate (0 = unknown — files
	// scanned before migration 053). Used to stamp a truthful H.264
	// level for >30fps content (1080p60 → 4.2, 2160p60 → 5.2).
	VideoFPS       float64         `json:"video_fps,omitempty"`
	FileHash       string          `json:"file_hash"`
	ScannedAt      time.Time       `json:"scanned_at"`
	AudioTracks    []AudioTrack    `json:"audio_tracks,omitempty"`
	SubtitleTracks []SubtitleTrack `json:"subtitle_tracks,omitempty"`
	// LibraryName is populated at the API layer for cross-library version display.
	// Not stored in the database.
	LibraryName string `json:"library_name,omitempty"`
}

// --- TV ---

type Season struct {
	ID           int64  `json:"id"`
	MediaItemID  int64  `json:"media_item_id"`
	Number       int    `json:"season_number"`
	Title        string `json:"title,omitempty"`
	Overview     string `json:"overview,omitempty"`
	EpisodeCount int    `json:"episode_count,omitempty"`
}

type Episode struct {
	ID          int64      `json:"id"`
	SeasonID    int64      `json:"season_id"`
	MediaItemID int64      `json:"media_item_id"`
	Number      int        `json:"episode_number"`
	Title       string     `json:"title,omitempty"`
	Overview    string     `json:"overview,omitempty"`
	RuntimeMin  int        `json:"runtime_minutes,omitempty"`
	AirDate     *time.Time `json:"air_date,omitempty"`
}

type EpisodeFile struct {
	ID           int64  `json:"id"`
	EpisodeID    int64  `json:"episode_id"`
	Path         string `json:"-"`
	SizeBytes    int64  `json:"size_bytes"`
	Container    string `json:"container"`
	VideoCodec   string `json:"video_codec,omitempty"`
	AudioCodec   string `json:"audio_codec,omitempty"`
	Resolution   string `json:"resolution,omitempty"`
	VersionTag   string `json:"version_tag,omitempty"`
	Bitrate      int64  `json:"bitrate,omitempty"`
	DurationMs   int64  `json:"duration_ms,omitempty"`
	VideoProfile string `json:"video_profile,omitempty"`
	VideoPixFmt  string `json:"video_pix_fmt,omitempty"`
	// Color metadata — distinguishes HDR (smpte2084 PQ / arib-std-b67
	// HLG / bt2020 primaries) from SDR 10-bit so the transcode
	// pipeline doesn't mis-apply the HDR-to-SDR tonemap to SDR sources.
	// Empty = unknown (treat as non-HDR, safer default).
	ColorTransfer  string `json:"color_transfer,omitempty"`
	ColorPrimaries string `json:"color_primaries,omitempty"`
	// VideoFPS is the probed average frame rate (0 = unknown — files
	// scanned before migration 053). Used to stamp a truthful H.264
	// level for >30fps content (1080p60 → 4.2, 2160p60 → 5.2).
	VideoFPS       float64         `json:"video_fps,omitempty"`
	FileHash       string          `json:"file_hash"`
	ScannedAt      time.Time       `json:"scanned_at"`
	AudioTracks    []AudioTrack    `json:"audio_tracks,omitempty"`
	SubtitleTracks []SubtitleTrack `json:"subtitle_tracks,omitempty"`
	// LibraryName is populated at the API layer for cross-library version display.
	LibraryName string `json:"library_name,omitempty"`
}

// --- FFprobe Multi-Track ---

// AudioTrack represents a single audio stream discovered by ffprobe.
type AudioTrack struct {
	Index     int    `json:"index"`
	Codec     string `json:"codec"`
	Channels  int    `json:"channels"`
	Language  string `json:"language,omitempty"`
	Title     string `json:"title,omitempty"`
	IsDefault bool   `json:"is_default"`
}

// --- Metadata ---

type ExternalID struct {
	MediaItemID int64  `json:"media_item_id"`
	Provider    string `json:"provider"` // tmdb, tvdb, imdb
	ExternalID  string `json:"external_id"`
}

// --- Scanner ---

type ScanStatus string

const (
	ScanIdle     ScanStatus = "idle"
	ScanRunning  ScanStatus = "running"
	ScanComplete ScanStatus = "complete"
	ScanFailed   ScanStatus = "failed"
)

type ScanProgress struct {
	LibraryID    int64      `json:"library_id"`
	Status       ScanStatus `json:"status"`
	TotalFiles   int        `json:"total_files"`
	ScannedFiles int        `json:"scanned_files"`
	NewFiles     int        `json:"new_files"`
	CurrentFile  string     `json:"current_file,omitempty"`
	StartedAt    *time.Time `json:"started_at,omitempty"`
	Error        string     `json:"error,omitempty"`
	// WalkErrors counts directory entries the walk could not read.
	// When non-zero the discovered file list was incomplete, so the
	// deleted-file prune was skipped (PruneSkipped) — surfaced here so
	// the status API shows WHY stale rows linger instead of reporting a
	// clean "complete" while cleanup is silently disabled.
	WalkErrors   int  `json:"walk_errors,omitempty"`
	PruneSkipped bool `json:"prune_skipped,omitempty"`
	// UnreadablePaths names the entries that failed to read, bounded to a
	// handful for display. A single unreadable directory used to disable the
	// prune for an ENTIRE library with only a log line as evidence — one
	// permission-denied folder went unnoticed for three days that way. The
	// prune is now scoped around these paths rather than skipped wholesale,
	// but the operator still needs to see what is unreadable to fix it.
	UnreadablePaths []string `json:"unreadable_paths,omitempty"`
}

// --- API Request/Response ---

type LoginRequest struct {
	Username string `json:"username"`
	Password string `json:"password"`
}

type RegisterRequest struct {
	Username   string `json:"username"`
	Email      string `json:"email"`
	Password   string `json:"password"`
	InviteCode string `json:"invite_code"`
}

type TokenResponse struct {
	// AccessToken/RefreshToken are omitempty: the cookie-auth flow (deep-debug
	// H10) sets httpOnly cookies and returns NO tokens in the body, so ALL
	// current auth endpoints (password login/register/refresh + OAuth) leave
	// them empty. The fields remain (omitempty) for any future non-browser
	// endpoint that opts back into body tokens; today none do — non-browser /
	// API / CLI clients must use the cookies. (BREAKING for clients that read
	// body tokens.)
	AccessToken  string `json:"access_token,omitempty"`
	RefreshToken string `json:"refresh_token,omitempty"`
	ExpiresIn    int64  `json:"expires_in"`
	User         *User  `json:"user"`
}

type RefreshRequest struct {
	RefreshToken string `json:"refresh_token"`
}

type ChangePasswordRequest struct {
	CurrentPassword string `json:"current_password"`
	NewPassword     string `json:"new_password"`
}

type CreateLibraryRequest struct {
	Name  string      `json:"name"`
	Type  LibraryType `json:"type"`
	Paths []string    `json:"paths"`
}

type UpdateLibraryRequest struct {
	Name *string `json:"name,omitempty"`
}

type InviteRequest struct {
	ExpiresInHours int `json:"expires_in_hours"`
}

type PaginationParams struct {
	Page    int `json:"page"`
	PerPage int `json:"per_page"`
}

type PaginatedResponse struct {
	Data       interface{} `json:"data"`
	Page       int         `json:"page"`
	PerPage    int         `json:"per_page"`
	TotalItems int64       `json:"total_items"`
	TotalPages int         `json:"total_pages"`
}

type MediaFilter struct {
	Type           MediaType `json:"type,omitempty"`
	Genre          string    `json:"genre,omitempty"`
	Year           int       `json:"year,omitempty"`
	SortBy         string    `json:"sort_by,omitempty"` // title, rating, year, added
	Query          string    `json:"query,omitempty"`
	MaxRating      string    `json:"max_rating,omitempty"`      // e.g. "PG-13", "TV-14"
	AllowedRatings []string  `json:"allowed_ratings,omitempty"` // computed from MaxRating
}

// --- Phase 2: TMDB Metadata ---

// MetadataUpdate carries fields to patch on a media_item after TMDB lookup.
// nil pointer = don't update this field.
type MetadataUpdate struct {
	MediaItemID   int64
	TMDBID        *int
	IMDbID        *string
	Title         *string
	Overview      *string
	Tagline       *string
	Status        *string
	OriginalLang  *string
	ContentRating *string
	PosterPath    *string
	BackdropPath  *string
	Popularity    *float64
	VoteAverage   *float64
	VoteCount     *int
	RuntimeMin    *int
	Year          *int
	SortTitle     *string
	MetadataSrc   *string
	Studio        *string
	Network       *string
	ReleaseDate   *string
	TrailerKey    *string
}

type EpisodeMetadataUpdate struct {
	MediaItemID   int64
	SeasonNumber  int
	EpisodeNumber int
	TMDBID        *int
	Title         *string
	Overview      *string
	StillPath     *string
	VoteAverage   *float64
	VoteCount     *int
	RuntimeMin    *int
	AirDate       *string // "2024-01-15" format
}

// Artwork represents a poster, backdrop, still, or logo image.
type Artwork struct {
	ID          int64      `json:"id"`
	MediaItemID int64      `json:"media_item_id"`
	ArtType     string     `json:"art_type"`
	Source      string     `json:"source"`
	RemotePath  string     `json:"remote_path"`
	LocalPath   string     `json:"local_path,omitempty"`
	Width       int        `json:"width,omitempty"`
	Height      int        `json:"height,omitempty"`
	Lang        string     `json:"lang,omitempty"`
	VoteAverage float64    `json:"vote_average,omitempty"`
	IsPrimary   bool       `json:"is_primary"`
	Blurhash    string     `json:"blurhash,omitempty"`
	CachedAt    *time.Time `json:"cached_at,omitempty"`
	CreatedAt   time.Time  `json:"created_at"`
}

// CastEntry is used to upsert cast/crew to the DB.
type CastEntry struct {
	MediaItemID  int64
	TMDBPersonID int
	Name         string
	ProfilePath  *string
	RoleType     string // cast, director, writer, producer, creator
	Character    string
	DisplayOrder int
	KnownFor     string
}

// CastMember is the API response format for a cast/crew member.
type CastMember struct {
	ID           int64  `json:"id"`
	Name         string `json:"name"`
	ProfilePath  string `json:"profile_path,omitempty"`
	RoleType     string `json:"role_type"`
	Character    string `json:"character,omitempty"`
	DisplayOrder int    `json:"display_order"`
}

// --- Phase 2: Watch Progress ---

// StaleMediaItem extends MediaItem with fields needed for smart metadata refresh.
type StaleMediaItem struct {
	MediaItem
	TMDBID       *int       `json:"tmdb_id,omitempty"`
	LastMetadata *time.Time `json:"last_metadata,omitempty"`
}

type WatchProgress struct {
	ID          int64     `json:"id"`
	UserID      int64     `json:"user_id"`
	ProfileID   int64     `json:"profile_id"`
	MediaItemID int64     `json:"media_item_id"`
	EpisodeID   *int64    `json:"episode_id,omitempty"`
	PositionMs  int64     `json:"position_ms"`
	DurationMs  int64     `json:"duration_ms"`
	Completed   bool      `json:"completed"`
	UpdatedAt   time.Time `json:"updated_at"`
}

type UpdateProgressRequest struct {
	EpisodeID  *int64 `json:"episode_id,omitempty"`
	ProfileID  *int64 `json:"profile_id,omitempty"`
	PositionMs int64  `json:"position_ms"`
	DurationMs int64  `json:"duration_ms"`
}

// ContinueWatchingItem is an enriched progress entry for the "Continue Watching" row.
// QA BUG-007 — Rating + Genre were previously absent, leaving cards
// in this rail visually leaner than the rest (no star, no genre tag).
// Rating is selected in the SQL; Genre is attached post-fetch via
// GetMediaGenresBatch in the handler.
type ContinueWatchingItem struct {
	WatchProgress
	Title        string  `json:"title"`
	PosterPath   string  `json:"poster_path,omitempty"`
	BackdropPath string  `json:"backdrop_path,omitempty"`
	Type         string  `json:"type"`
	Year         int     `json:"year,omitempty"`
	Rating       float64 `json:"rating,omitempty"`
	Genre        string  `json:"genre,omitempty"`
	EpisodeTitle string  `json:"episode_title,omitempty"`
	SeasonNum    *int    `json:"season_number,omitempty"`
	EpisodeNum   *int    `json:"episode_number,omitempty"`
	Percent      float64 `json:"percent_complete"`
}

// --- Phase 2: Streaming ---

// StreamInfo describes how to stream a particular file.
type StreamInfo struct {
	FileID       int64  `json:"file_id"`
	DirectPlay   bool   `json:"direct_play"`
	DirectStream bool   `json:"direct_stream"` // Remux needed (copy codecs, repackage container)
	Decision     string `json:"decision"`      // "direct_play", "direct_stream", "transcode"
	StreamURL    string `json:"stream_url"`
	Container    string `json:"container"`
	VideoCodec   string `json:"video_codec"`
	AudioCodec   string `json:"audio_codec"`
	Resolution   string `json:"resolution"`
	DurationMs   int64  `json:"duration_ms"`
	// Client-aware decision fields (populated when client sends capabilities)
	TranscodeReason  string `json:"transcode_reason,omitempty"`  // Why not direct_play
	// ReasonCode is TranscodeReason collapsed into one of the fixed buckets
	// the QoE schema records (migration 056). The prose above is for a human
	// reading a log line; this is what aggregates. Bucketed server-side so the
	// vocabulary lives in exactly one place rather than being re-derived by
	// every client that reports telemetry.
	ReasonCode       string `json:"reason_code,omitempty"`
	AudioTrackIndex  int    `json:"audio_track_index"`           // Recommended audio track (0-based, -1=default)
	Remux            bool   `json:"remux,omitempty"`             // Frontend should send remux:true to session
	AudioPassthrough bool   `json:"audio_passthrough,omitempty"` // Frontend should send audio_passthrough:true
	AudioChannels    int    `json:"audio_channels,omitempty"`    // Source audio channel count for bitrate scaling
	AudioCodecOut    string `json:"audio_codec_out,omitempty"`   // Re-encode target: "aac" (stereo) or "ac3" (5.1 surround); frontend echoes it to the session
	VideoCodecOut    string `json:"video_codec_out,omitempty"`   // Transcode output: "h264" (default) or "hevc" (2026-08, when server+client both support it); frontend echoes it to the session
	HDRTonemap       bool   `json:"hdr_tonemap,omitempty"`       // Frontend should send hdr_tonemap:true to session
}

type TranscodeSession struct {
	ID         string    `json:"id"`
	UserID     int64     `json:"user_id"`
	FileID     int64     `json:"file_id"`
	FileType   string    `json:"file_type"`
	PID        int       `json:"pid,omitempty"`
	Status     string    `json:"status"`
	Preset     string    `json:"preset"`
	Resolution string    `json:"resolution,omitempty"`
	StartedAt  time.Time `json:"started_at"`
	LastActive time.Time `json:"last_active"`
}

// SkipMarker is a Smart Skip time window on a media/episode file:
// 'recap' | 'intro' | 'credits', in SOURCE-FILE milliseconds. The player
// maps source time onto the active timeline the same way it maps watch
// progress (real-file seconds = hls time + session start_sec).
//
// Detector records provenance: 'xcorr-v1' (audio cross-correlation),
// heuristic credits detection, or 'manual' (admin correction — never
// overwritten by the analyzer). A zero-length window (start==end==0)
// is an admin suppression: stored so the analyzer won't re-add the
// marker, filtered out of player-facing responses.
type SkipMarker struct {
	Kind       string  `json:"kind"` // "recap" | "intro" | "credits"
	StartMs    int64   `json:"start_ms"`
	EndMs      int64   `json:"end_ms"`
	Confidence float64 `json:"confidence,omitempty"`
	Detector   string  `json:"detector,omitempty"`
}

// SubtitleTrack represents an available subtitle for a media file.
type SubtitleTrack struct {
	Index    int    `json:"index"`
	Language string `json:"language"`
	Title    string `json:"title,omitempty"`
	Codec    string `json:"codec"`
	Forced   bool   `json:"forced"`
	Default  bool   `json:"default"`
	Bitmap   bool   `json:"bitmap,omitempty"` // true for PGS/VOBSUB/DVB — cannot be extracted as text
}

// Expanded MediaItem fields for API response (Phase 2 additions)
// These are populated by the API layer, not stored directly.
type MediaItemEnriched struct {
	*MediaItem
	TMDBID       *int           `json:"tmdb_id,omitempty"`
	IMDbID       string         `json:"imdb_id,omitempty"`
	Tagline      string         `json:"tagline,omitempty"`
	PosterURL    string         `json:"poster_url,omitempty"`
	BackdropURL  string         `json:"backdrop_url,omitempty"`
	Cast         []CastMember   `json:"cast,omitempty"`
	Artwork      []Artwork      `json:"artwork,omitempty"`
	SeasonCount  int            `json:"season_count,omitempty"`
	EpisodeCount int            `json:"episode_count,omitempty"`
	UserProgress *WatchProgress `json:"user_progress,omitempty"`
	// TrailerKey is the YouTube id for the "Watch Trailer" button; "" = none.
	TrailerKey string `json:"trailer_key,omitempty"`
	// TrailerChecked reports whether trailer_key has been resolved yet (the DB
	// value is NOT NULL). When false, GetEnriched lazily backfills it from
	// TMDB. Not serialized — an internal signal for the handler.
	TrailerChecked bool `json:"-"`
}

// SeasonDetail is the API response for a single season.
type SeasonDetail struct {
	Season
	Episodes   []EpisodeDetail `json:"episodes"`
	PosterPath string          `json:"poster_path,omitempty"`
}

// EpisodeDetail is the API response for a single episode with file info.
type EpisodeDetail struct {
	Episode
	StillPath string         `json:"still_path,omitempty"`
	StillURL  string         `json:"still_url,omitempty"`
	Files     []*EpisodeFile `json:"files,omitempty"`
	Progress  *WatchProgress `json:"progress,omitempty"`
}

// ============================================================
// Phase 4: User Profiles
// ============================================================

type UserProfile struct {
	ID           int64     `json:"id"`
	UserID       int64     `json:"user_id"`
	Name         string    `json:"name"`
	AvatarURL    string    `json:"avatar_url,omitempty"`
	IsDefault    bool      `json:"is_default"`
	MaxAgeRating string    `json:"max_age_rating,omitempty"`
	Language     string    `json:"language"`
	SubtitleLang string    `json:"subtitle_lang,omitempty"`
	SubtitleMode string    `json:"subtitle_mode"`
	CreatedAt    time.Time `json:"created_at"`
	UpdatedAt    time.Time `json:"updated_at"`
	// HasPIN reports that switching into this profile needs its PIN (or the
	// account password). The hash itself never leaves the db package.
	HasPIN bool `json:"has_pin"`
	// TasteOnboardingCompleted flips true once the profile finishes the
	// "Pick What You Love" flow; gates the one-time first-run redirect.
	TasteOnboardingCompleted bool `json:"taste_onboarding_completed"`
	// MaturityPref is the Phase E2c content-tone recall lean: -1 Auto
	// (default — the recommender derives the lean from the dominant tier of
	// the profile's watched/seeded titles; see maturityPenaltyExpr), 0
	// family, 1 teen, 2 mature (explicit picks always override Auto). A SOFT
	// bias (distinct from MaxAgeRating's HARD ceiling) that nudges recall
	// toward the resolved tier.
	MaturityPref int `json:"maturity_pref"`
}

type CreateProfileRequest struct {
	Name         string `json:"name"`
	AvatarURL    string `json:"avatar_url,omitempty"`
	MaxAgeRating string `json:"max_age_rating,omitempty"`
	Language     string `json:"language,omitempty"`
	SubtitleLang string `json:"subtitle_lang,omitempty"`
	SubtitleMode string `json:"subtitle_mode,omitempty"`
}

type UpdateProfileRequest struct {
	Name         *string `json:"name,omitempty"`
	AvatarURL    *string `json:"avatar_url,omitempty"`
	MaxAgeRating *string `json:"max_age_rating,omitempty"`
	Language     *string `json:"language,omitempty"`
	SubtitleLang *string `json:"subtitle_lang,omitempty"`
	SubtitleMode *string `json:"subtitle_mode,omitempty"`
	// MaturityPref: -1 Auto (derived from watch/seed history), 0 family,
	// 1 teen, 2 mature. Out-of-range clamps to -1 (Auto). nil = leave
	// unchanged.
	MaturityPref *int `json:"maturity_pref,omitempty"`
}

// ============================================================
// Phase 4: Watchlists
// ============================================================

type Watchlist struct {
	ID        int64     `json:"id"`
	ProfileID int64     `json:"profile_id"`
	Name      string    `json:"name"`
	ListType  string    `json:"list_type"`
	ItemCount int       `json:"item_count,omitempty"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

type WatchlistItem struct {
	ID          int64     `json:"id"`
	WatchlistID int64     `json:"watchlist_id"`
	MediaItemID int64     `json:"media_item_id"`
	AddedAt     time.Time `json:"added_at"`
	SortOrder   int       `json:"sort_order"`
	Title       string    `json:"title,omitempty"`
	PosterPath  string    `json:"poster_path,omitempty"`
	Year        int       `json:"year,omitempty"`
	Type        string    `json:"type,omitempty"`
}

type CreateWatchlistRequest struct {
	Name     string `json:"name"`
	ListType string `json:"list_type,omitempty"`
}

type AddToWatchlistRequest struct {
	MediaItemID int64 `json:"media_item_id"`
}

// ============================================================
// Phase 6: Collections
// ============================================================
//
// Collections are admin/user-curated groupings of media items —
// "Marvel Cinematic Universe", "A24 Slow-burn Horror", etc. Two
// flavors: manually-curated (admin builds the list one item at a
// time) and AI-generated (LLM picks items from a natural-language
// prompt). is_public exposes a collection on other users' home
// rails — typically set by admin for franchise-level groupings.

type Collection struct {
	ID          int64  `json:"id"`
	OwnerUserID int64  `json:"owner_user_id"`
	Name        string `json:"name"`
	Description string `json:"description,omitempty"`
	Kind        string `json:"kind"` // 'manual' | 'ai'
	Prompt      string `json:"prompt,omitempty"`
	IsPublic    bool   `json:"is_public"`
	CoverPath   string `json:"cover_path,omitempty"`
	ItemCount   int    `json:"item_count,omitempty"`
	// PosterPaths is up to four member posters in collection order, for the
	// stacked-poster card the collections grid draws. CoverPath is a single
	// image (auto-populated from the first item added), which reads as one
	// title rather than as a grouping — this is what lets the card show that
	// a collection HAS members. Populated by the list query only; the
	// single-collection GET leaves it empty because that view renders the
	// real member grid and has no use for a mosaic.
	PosterPaths []string  `json:"poster_paths,omitempty"`
	CreatedAt   time.Time `json:"created_at"`
	UpdatedAt   time.Time `json:"updated_at"`
}

type CollectionItem struct {
	ID           int64     `json:"id"`
	CollectionID int64     `json:"collection_id"`
	MediaItemID  int64     `json:"media_item_id"`
	Position     int       `json:"position"`
	AddedAt      time.Time `json:"added_at"`
}

type CreateCollectionRequest struct {
	Name        string `json:"name"`
	Description string `json:"description,omitempty"`
	Kind        string `json:"kind,omitempty"`   // defaults to 'manual'
	Prompt      string `json:"prompt,omitempty"` // required when kind=='ai'
	IsPublic    bool   `json:"is_public,omitempty"`
}

type AddToCollectionRequest struct {
	MediaItemID int64 `json:"media_item_id"`
}

// ============================================================
// Phase 6: Gamification — XP, levels, streaks, achievements
// ============================================================
//
// UserXP is one row per user. XP grows on completed watches; level
// is derived from XP via the leveling table in
// `internal/gamification/levels.go`. Streak counts distinct watch
// days; missing a day resets to 0.

type UserXP struct {
	UserID        int64      `json:"user_id"`
	XP            int        `json:"xp"`
	Level         int        `json:"level"`
	CurrentStreak int        `json:"current_streak"`
	LongestStreak int        `json:"longest_streak"`
	LastWatchDate *time.Time `json:"last_watch_date,omitempty"`
	TotalWatches  int        `json:"total_watches"`
	// Audit H1 — the progress bar needs BOTH endpoints to render
	// correctly. PrevLevelTotal is the absolute XP at the start of
	// the current level; NextLevelTotal is the absolute XP at the
	// next. Client computes pct = (xp - prev) / (next - prev). The
	// older code emitted only Next, which produced misleading bars.
	XPToNextLevel  int `json:"xp_to_next_level,omitempty"` // derived
	NextLevelTotal int `json:"next_level_total,omitempty"` // derived
	PrevLevelTotal int `json:"prev_level_total,omitempty"` // derived
}

// UserAchievement is one unlock row. `Key` is an opaque app-level
// identifier — display name/icon/XP-reward live in code.
type UserAchievement struct {
	ID             int64     `json:"id"`
	UserID         int64     `json:"user_id"`
	AchievementKey string    `json:"achievement_key"`
	UnlockedAt     time.Time `json:"unlocked_at"`
}

// ============================================================
// Phase 4: Activity Log & Admin
// ============================================================

type ActivityEntry struct {
	ID        int64                  `json:"id"`
	UserID    *int64                 `json:"user_id,omitempty"`
	ProfileID *int64                 `json:"profile_id,omitempty"`
	EventType string                 `json:"event_type"`
	Details   map[string]interface{} `json:"details,omitempty"`
	IPAddress string                 `json:"ip_address,omitempty"`
	CreatedAt time.Time              `json:"created_at"`
	Username  string                 `json:"username,omitempty"`
}

// ActivityEventType is one distinct event_type present in activity_log with
// the number of rows carrying it. It backs the admin Activity tab's filter.
//
// The option list is derived from the DATA rather than a constant, because
// event types are registered ad hoc at ~24 call sites across activity.go,
// party_handlers.go, oauth_handlers.go and request_handlers.go with no
// central registry — a hardcoded SPA list would silently drift the moment
// anyone adds a type. Deriving it also means an instance only offers the
// types it has actually recorded.
type ActivityEventType struct {
	EventType string `json:"event_type"`
	Count     int64  `json:"count"`
}

type ServerStats struct {
	Version            string  `json:"version"`
	Uptime             string  `json:"uptime"`
	MemoryAllocMB      int64   `json:"memory_alloc_mb"`
	Goroutines         int     `json:"goroutines"`
	CPUCores           float64 `json:"cpu_cores"`
	DiskFreeGB         float64 `json:"disk_free_gb"`
	ActiveStreams      int     `json:"active_streams"`
	WebSocketClients   int     `json:"websocket_clients"`
	LibraryCount       int     `json:"library_count"`
	MovieCount         int64   `json:"movie_count"`
	ShowCount          int64   `json:"show_count"`
	EpisodeCount       int64   `json:"episode_count"`
	UserCount          int64   `json:"user_count"`
	TotalFileSizeBytes int64   `json:"total_file_size_bytes"`
	PendingRequests    int64   `json:"pending_requests"`
	ActiveParties      int64   `json:"active_parties"`
}

type ServerSetting struct {
	Key       string    `json:"key"`
	Value     string    `json:"value"`
	UpdatedAt time.Time `json:"updated_at"`
	UpdatedBy *int64    `json:"updated_by,omitempty"`
}

type UpdateSettingsRequest struct {
	Settings map[string]string `json:"settings"`
}

// ReferralOption is one selectable answer to the referral prompt (migration
// 046), stored as JSON in the `referral_prompt_options` setting. Key is what
// lands in users.referral_source and must never change once answers exist;
// Label is display text the operator can rename freely. The implicit "other"
// option is not in this list — it is always offered, always last, and is not
// deletable, because removing it would strand users.referral_detail.
type ReferralOption struct {
	Key   string `json:"key"`
	Label string `json:"label"`
}

// ReferralSourceCount is one row of the admin breakdown.
//
// Label is nil for BOTH of the keys that have no configured option:
//   - one whose option the operator deleted after users had chosen it — the
//     panel renders those as "<removed: key>" rather than dropping the rows,
//     so history stays readable; and
//   - the implicit "other", which never has a stored option and whose display
//     text is owned by the client (see REFERRAL_OTHER_LABEL).
//
// The KEY separates them: parseReferralOptions refuses to store "other", so no
// configured option can collide with it. A consumer that treats nil as
// "removed" alone will mislabel the free-text row.
type ReferralSourceCount struct {
	Key   string  `json:"key"`
	Label *string `json:"label"`
	Count int64   `json:"count"`
}

// ReferralSummary is the aggregate panel's payload. Answered/Skipped/Pending
// partition the users who were ever eligible; Total is their sum. The window
// (when set) filters on users.created_at — signup date — so every bucket shares
// one timeframe and the panel answers "of the signups in this period, what did
// they say".
type ReferralSummary struct {
	Total      int64                 `json:"total"`
	Answered   int64                 `json:"answered"`
	Skipped    int64                 `json:"skipped"`
	Pending    int64                 `json:"pending"`
	BySource   []ReferralSourceCount `json:"by_source"`
	WindowDays int                   `json:"window_days"`
}

type HealthStatus struct {
	Status      string  `json:"status"`
	Service     string  `json:"service"`
	DBConnected bool    `json:"db_connected"`
	FFmpegAvail bool    `json:"ffmpeg_available"`
	DiskFreeGB  float64 `json:"disk_free_gb,omitempty"`
	Uptime      string  `json:"uptime"`
	Version     string  `json:"version"`
}

type NowPlayingEntry struct {
	UserID      int64  `json:"user_id"`
	Username    string `json:"username"`
	ProfileName string `json:"profile_name,omitempty"`
	MediaTitle  string `json:"media_title"`
	MediaType   string `json:"media_type"`
	EpisodeInfo string `json:"episode_info,omitempty"`
	Progress    int    `json:"progress_percent"`
	Decision    string `json:"decision"`
}

type LogEntry struct {
	Time    time.Time              `json:"time"`
	Level   string                 `json:"level"`
	Message string                 `json:"message"`
	Attrs   map[string]interface{} `json:"attrs,omitempty"`
}

// ============================================================
// Requests
// ============================================================

// RequestStatus constants for the media request lifecycle.
const (
	RequestPending         = "pending"
	RequestPendingApproval = "pending_approval"
	RequestProcessing      = "processing"
	RequestAvailable       = "available"
	RequestFailed          = "failed"
)

// Request represents a user's media request submitted through the Requests feature.
// Tracks TMDB metadata, quality preferences, ARR integration status, and lifecycle timestamps.
type Request struct {
	ID           int64      `json:"id"`
	UserID       int64      `json:"user_id"`
	MediaType    string     `json:"media_type"` // "movie" or "tv"
	TMDBID       int        `json:"tmdb_id"`    // TMDB ID from frontend search
	Title        string     `json:"title"`
	PosterPath   string     `json:"poster_path"`
	Overview     string     `json:"overview"`
	Year         int        `json:"year"`
	Status       string     `json:"status"` // pending, pending_approval, processing, available, failed
	Quality1080p bool       `json:"quality_1080p"`
	Quality4K    bool       `json:"quality_4k"`
	ArrJobIDs    string     `json:"arr_job_ids"` // JSON or comma-sep IDs from Radarr/Sonarr (e.g. TVDB ID for TV)
	ErrorMessage string     `json:"error_message,omitempty"`
	RequestedAt  time.Time  `json:"requested_at"`
	ProcessedAt  *time.Time `json:"processed_at,omitempty"`
	CompletedAt  *time.Time `json:"completed_at,omitempty"`
	UpdatedAt    time.Time  `json:"updated_at"`
	// Username is populated at the API layer for admin list views.
	Username string `json:"username,omitempty"`
}

// ============================================================
// Notifications
// ============================================================

// Notification type constants. v1 covers request lifecycle outcomes; the type
// drives the icon/copy the frontend renders.
const (
	NotificationRequestAvailable = "request_available"
	NotificationRequestFailed    = "request_failed"
	// NotificationPartyReelReady tells the party host their highlight reel
	// finished rendering (minutes after the party — and its UI — ended).
	// Carries the reel URL in Link.
	NotificationPartyReelReady = "party_reel_ready"
	// NotificationAdminNewRequest tells each admin a media request was
	// created (including held pending_approval ones). Deduped per
	// (admin, request, type) by the table's unique index.
	NotificationAdminNewRequest = "admin_new_request"
	// NotificationScanComplete tells admins a library scan finished AND
	// added items. No table-level dedupe (no request_id) — producers only
	// fire it on the new_files>0 terminal transition, once per scan run.
	NotificationScanComplete = "scan_complete"
	// NotificationPartyInvite tells a member they were invited to a watch
	// party (migration 051). Carries the /p/{CODE} deep-join link. No
	// table-level dedupe (no request_id) — the party_invites unique index
	// is the guard: the sender only notifies when the invite row was
	// actually created (re-invites are a no-op).
	NotificationPartyInvite = "party_invite"
	// NotificationPartyRSVP tells a host an invitee accepted ("is in").
	// Fired only on the pending→going transition so flip-flopping an RSVP
	// can't spam the host.
	NotificationPartyRSVP = "party_rsvp"
	// NotificationPartyReminder nudges the host + non-declined invitees
	// ~10 minutes before a scheduled party starts. Fired by the manager's
	// reminder timer; self-validates against reschedules, so a stale timer
	// is a silent no-op rather than a wrong-time ping.
	NotificationPartyReminder = "party_reminder"
)

// AdminNotificationTypes are the types only the admin role receives (other
// members' requests, scan results). They go to the admin ACCOUNT, so a session
// acting as a restricted profile on it is not shown them: the notification
// list leaves them out and the event socket sends them only to admin-role
// connections. A new admin-only type must be added here. A fresh slice each
// call, so no caller can change what another filters.
func AdminNotificationTypes() []string {
	return []string{NotificationAdminNewRequest, NotificationScanComplete}
}

// IsAdminNotification reports whether typ is one of AdminNotificationTypes.
func IsAdminNotification(typ string) bool {
	for _, t := range AdminNotificationTypes() {
		if t == typ {
			return true
		}
	}
	return false
}

// Notification is a durable, per-user in-app notification backing the bell +
// Notifications panel. Created by the request monitor on a status transition and
// also pushed live over the 'notification' WebSocket event; the persisted row is
// the source of truth for users who were offline when the event fired.
type Notification struct {
	ID        int64      `json:"id"`
	UserID    int64      `json:"user_id"`
	Type      string     `json:"type"`                 // request_available | request_failed | party_reel_ready
	Title     string     `json:"title"`                // media title, e.g. "Hook"
	MediaType string     `json:"media_type,omitempty"` // movie | tv
	RequestID *int64     `json:"request_id,omitempty"` // source request, when applicable
	Link      string     `json:"link,omitempty"`       // optional deep link (e.g. highlight-reel MP4)
	ReadAt    *time.Time `json:"read_at,omitempty"`    // nil ⇒ unread
	CreatedAt time.Time  `json:"created_at"`
}

// PushSubscription is one browser-profile-on-a-device's Web Push endpoint
// (migration 047). The endpoint is globally unique per the Push API; the
// upsert reassigns an endpoint to whichever account most recently enabled
// push on that device — the property that stops user A receiving user B's
// notifications on a shared machine. p256dh/auth are the client's
// base64url-encoded encryption parameters (RFC 8291), stored verbatim.
type PushSubscription struct {
	ID            int64      `json:"id"`
	UserID        int64      `json:"user_id"`
	Endpoint      string     `json:"endpoint"`
	P256dh        string     `json:"-"`
	Auth          string     `json:"-"`
	UserAgent     string     `json:"user_agent,omitempty"`
	CreatedAt     time.Time  `json:"created_at"`
	LastSeenAt    time.Time  `json:"last_seen_at"`
	LastSuccessAt *time.Time `json:"last_success_at,omitempty"`
}

// CreateRequestPayload is the JSON body for POST /api/requests.
type CreateRequestPayload struct {
	MediaType    string `json:"media_type"`
	TMDBID       int    `json:"tmdb_id"`
	Title        string `json:"title"`
	PosterPath   string `json:"poster_path"`
	Overview     string `json:"overview"`
	Year         int    `json:"year"`
	Quality1080p bool   `json:"quality_1080p"`
	Quality4K    bool   `json:"quality_4k"`
}

// RequestsConfigResponse is the JSON response for GET /api/requests/config.
// Tells the frontend which ARR services are available.
type RequestsConfigResponse struct {
	Enabled   bool `json:"enabled"`
	HasRadarr bool `json:"has_radarr"`
	HasSonarr bool `json:"has_sonarr"`
	Has4K     bool `json:"has_4k"`
}

// ============================================================
// Watch Parties
// ============================================================

// WatchPartyRoom is the long-lived join identity. A "quick party" creates
// a room with IsPersistent=false that gets soft-deleted when its session
// ends. A "persistent room" survives session ends — friends can bookmark
// its code and rejoin whenever a new party starts. Added in migration 021
// as part of M3 of the watch-party rewrite.
type WatchPartyRoom struct {
	ID           int64     `json:"id"`
	Code         string    `json:"code"`
	Name         string    `json:"name"`
	OwnerUserID  int64     `json:"owner_user_id"`
	IsPersistent bool      `json:"is_persistent"`
	SettingsJSON string    `json:"settings_json,omitempty"`
	CreatedAt    time.Time `json:"created_at"`
	LastActiveAt time.Time `json:"last_active_at"`
	// Soft-delete tombstone. NULL = live (code is reserved). Quick-party
	// rooms get tombstoned on session end; persistent rooms only when the
	// owner explicitly deletes them.
	DeletedAt *time.Time `json:"deleted_at,omitempty"`
}

// WatchParty represents a synchronized viewing session.
type WatchParty struct {
	ID              int64      `json:"id"`
	PartyCode       string     `json:"party_code"`
	HostUserID      int64      `json:"host_user_id"`
	MediaItemID     int64      `json:"media_item_id"`
	EpisodeID       *int64     `json:"episode_id,omitempty"`
	PartyName       string     `json:"party_name"`
	MediaTitle      string     `json:"media_title"`
	MediaPoster     string     `json:"media_poster"`
	MaxParticipants int        `json:"max_participants"`
	IsActive        bool       `json:"is_active"`
	SettingsJSON    string     `json:"settings_json,omitempty"`
	CreatedAt       time.Time  `json:"created_at"`
	EndedAt         *time.Time `json:"ended_at,omitempty"`

	// RoomID links this session to its long-lived room (M3, migration 021).
	// Nullable for backwards-compat with rows created pre-migration; all
	// new parties post-021 will have a non-nil RoomID. The room owns the
	// stable join code; party.PartyCode is preserved as a mirror for the
	// existing share-image URL space.
	RoomID *int64 `json:"room_id,omitempty"`

	// ScheduledStartAt is the host's planned start time. When non-nil, the
	// server runs a per-party timer that fires at this moment and broadcasts
	// a "party-starting" event, auto-triggering play across all connected
	// clients. NULL = no schedule, host plays manually. Added in migration 019.
	ScheduledStartAt *time.Time `json:"scheduled_start_at,omitempty"`

	// StartedAt is the actual moment playback began. Filled either when the
	// scheduled timer fires or when the host manually plays an unscheduled
	// party. Lets late joiners compute "we're X seconds into the movie".
	StartedAt *time.Time `json:"started_at,omitempty"`
}

// WatchPartyParticipant represents a user's participation in a watch party.
type WatchPartyParticipant struct {
	ID       int64      `json:"id"`
	PartyID  int64      `json:"party_id"`
	UserID   int64      `json:"user_id"`
	JoinedAt time.Time  `json:"joined_at"`
	LeftAt   *time.Time `json:"left_at,omitempty"`
	// Username is populated at the DB/API layer via JOIN.
	Username string `json:"username,omitempty"`
}

// CreatePartyRequest is the JSON body for POST /api/parties.
type CreatePartyRequest struct {
	MediaItemID     int64                  `json:"media_item_id"`
	EpisodeID       *int64                 `json:"episode_id,omitempty"`
	PartyName       string                 `json:"party_name"`
	MaxParticipants int                    `json:"max_participants,omitempty"`
	Settings        map[string]interface{} `json:"settings,omitempty"`
	// ScheduledStartAt is optional. When provided, the party doesn't auto-play
	// on join — instead, the server fires "party-starting" at this exact moment
	// across all connected clients. RFC 3339 timestamp (ISO 8601 with timezone).
	// Must be in the future; the API rejects past timestamps with 400.
	ScheduledStartAt *time.Time `json:"scheduled_start_at,omitempty"`
}

// SchedulePartyRequest is the JSON body for POST /api/parties/{code}/schedule,
// which lets the host change the scheduled start time after party creation
// (or clear it entirely by passing null). Host-only via the auth middleware.
type SchedulePartyRequest struct {
	// ScheduledStartAt = null clears the schedule (party reverts to "host
	// plays manually"). A non-nil value must be in the future.
	ScheduledStartAt *time.Time `json:"scheduled_start_at"`
}

// PartyInfo is the enriched response for a watch party, including live state.
type PartyInfo struct {
	Code             string `json:"code"`
	HostUsername     string `json:"host_username"`
	MediaTitle       string `json:"media_title"`
	MediaPoster      string `json:"media_poster"`
	ParticipantCount int    `json:"participant_count"`
	MaxParticipants  int    `json:"max_participants"`
	IsPlaying        bool   `json:"is_playing"`
	CurrentTimeMs    int64  `json:"current_time_ms"`
}

// PartyInvite is one row of party_invites (migration 051): a member invited
// to a watch party, carrying their RSVP. Durable on purpose — a scheduled
// party's roster must survive server restarts and render before anyone has
// opened a WebSocket, so this never lives in the watchparty Manager.
type PartyInvite struct {
	ID            int64      `json:"id"`
	PartyID       int64      `json:"party_id"`
	InviterUserID int64      `json:"inviter_user_id"`
	InviteeUserID int64      `json:"invitee_user_id"`
	RSVP          string     `json:"rsvp"` // pending | going | maybe | declined
	Note          string     `json:"note,omitempty"`
	CreatedAt     time.Time  `json:"created_at"`
	RespondedAt   *time.Time `json:"responded_at,omitempty"`
}

// PartyInviteRosterEntry is the member-visible roster row for a party's
// invite list (lobby "who's coming"). Deliberately mirrors MemberSummary's
// field set — username/display/avatar only, avatar filtered through
// memberSafeAvatar at the handler; no email/role/auth fields ever.
type PartyInviteRosterEntry struct {
	InviteID    int64      `json:"invite_id"`
	UserID      int64      `json:"user_id"`
	Username    string     `json:"username"`
	DisplayName string     `json:"display_name,omitempty"`
	AvatarURL   string     `json:"avatar_url,omitempty"`
	RSVP        string     `json:"rsvp"`
	RespondedAt *time.Time `json:"responded_at,omitempty"`
}

// MyPartyInvite is one entry of the caller's invite feed
// (GET /api/me/party-invites): the invite joined with enough party context
// to render a bell RSVP row or a calendar chip without a second fetch.
// Only parties that are still active appear; ended parties drop out with
// is_active=false.
type MyPartyInvite struct {
	InviteID         int64      `json:"invite_id"`
	PartyCode        string     `json:"party_code"`
	PartyName        string     `json:"party_name,omitempty"`
	MediaTitle       string     `json:"media_title"`
	MediaPoster      string     `json:"media_poster,omitempty"`
	HostUsername     string     `json:"host_username"`
	RSVP             string     `json:"rsvp"`
	Note             string     `json:"note,omitempty"`
	ScheduledStartAt *time.Time `json:"scheduled_start_at,omitempty"`
	StartedAt        *time.Time `json:"started_at,omitempty"`
	CreatedAt        time.Time  `json:"created_at"`
}
