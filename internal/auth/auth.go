package auth

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/aurora-media/aurora/internal/config"
	"github.com/golang-jwt/jwt/v5"
	"golang.org/x/crypto/argon2"
)

var (
	ErrInvalidCredentials = errors.New("invalid credentials")
	ErrInvalidToken       = errors.New("invalid or expired token")
	ErrInvalidInvite      = errors.New("invalid or expired invite code")
	ErrUserExists         = errors.New("username or email already taken")
)

// ScopeCast marks a JWT as bound to a single HLS transcode session, for
// handing to Chromecast/AirPlay receivers that fetch URLs without our
// Authorization headers. Cast tokens are accepted ONLY by RequireStreamAuth
// (HLS playlist/segment routes). ValidateAccessToken rejects them so a
// leaked cast token cannot be promoted to a regular session credential.
const ScopeCast = "stream:cast"

type JWTClaims struct {
	UserID       int64  `json:"user_id"`
	Username     string `json:"username"`
	Role         string `json:"role"`
	TokenVersion int    `json:"tv,omitempty"` // matches users.token_version at issue time
	// Scope, when non-empty, restricts the token to a narrow purpose
	// (e.g. ScopeCast for HLS-only). Regular access tokens have Scope == "".
	Scope string `json:"scope,omitempty"`
	// SessionID is the resource binding for cast-scoped tokens; empty for
	// regular access tokens. Two binding forms exist (2026-07):
	//   - an HLS transcode session ID (32 hex chars) — the original form,
	//     enforced by requireSessionAccess on the HLS routes;
	//   - the direct-play file sentinel "direct:<media|episode>:<fileID>",
	//     minted by the API layer's CreateDirectCastToken and enforced by
	//     ServeDirectCastFile. The prefix can never collide with a hex
	//     session ID, so each consumer matches exactly one form.
	// Consumers MUST NOT assume this names a transcode session (e.g. by
	// blindly calling GetSession with it).
	SessionID string `json:"sid,omitempty"`
	// RefreshTokenID references the refresh_tokens row this access token was
	// minted alongside (0 for tokens minted before this field existed, and
	// always 0 for cast-scoped tokens, which have no profile concept of
	// their own). It is the ONLY server-authoritative link from a request to
	// "which sub-profile is currently acting" — internal/db's
	// ResolveActingProfile looks up refresh_tokens.active_profile_id by this
	// id, falling back to the account default profile when it's 0 or unset.
	// Issue #462: this replaced trusting a client-supplied profile_id/
	// max_rating for rating-ceiling enforcement, which was a full bypass.
	RefreshTokenID int64 `json:"rtid,omitempty"`
	jwt.RegisteredClaims
}

type Service struct {
	cfg config.AuthConfig
}

func NewService(cfg config.AuthConfig) *Service {
	return &Service{cfg: cfg}
}

// ============================================================
// Password Hashing (Argon2id)
// ============================================================

func (s *Service) HashPassword(password string) (string, error) {
	salt := make([]byte, s.cfg.Argon2SaltLength)
	if _, err := rand.Read(salt); err != nil {
		return "", fmt.Errorf("generate salt: %w", err)
	}

	hash := argon2.IDKey(
		[]byte(password), salt,
		s.cfg.Argon2Iterations, s.cfg.Argon2Memory,
		s.cfg.Argon2Parallelism, s.cfg.Argon2KeyLength,
	)

	// Encode as: $argon2id$v=19$m=65536,t=3,p=4$<salt>$<hash>
	b64Salt := base64.RawStdEncoding.EncodeToString(salt)
	b64Hash := base64.RawStdEncoding.EncodeToString(hash)

	encoded := fmt.Sprintf("$argon2id$v=%d$m=%d,t=%d,p=%d$%s$%s",
		argon2.Version, s.cfg.Argon2Memory, s.cfg.Argon2Iterations,
		s.cfg.Argon2Parallelism, b64Salt, b64Hash,
	)
	return encoded, nil
}

func (s *Service) VerifyPassword(password, encodedHash string) (bool, error) {
	parts := strings.Split(encodedHash, "$")
	if len(parts) != 6 {
		return false, fmt.Errorf("invalid hash format")
	}

	var memory uint32
	var iterations uint32
	var parallelism uint8
	_, err := fmt.Sscanf(parts[3], "m=%d,t=%d,p=%d", &memory, &iterations, &parallelism)
	if err != nil {
		return false, fmt.Errorf("parse hash params: %w", err)
	}

	salt, err := base64.RawStdEncoding.DecodeString(parts[4])
	if err != nil {
		return false, fmt.Errorf("decode salt: %w", err)
	}

	expectedHash, err := base64.RawStdEncoding.DecodeString(parts[5])
	if err != nil {
		return false, fmt.Errorf("decode hash: %w", err)
	}

	computedHash := argon2.IDKey([]byte(password), salt, iterations, memory, parallelism, uint32(len(expectedHash)))

	return subtle.ConstantTimeCompare(expectedHash, computedHash) == 1, nil
}

// ============================================================
// JWT Tokens
// ============================================================

// GenerateAccessToken signs a new JWT for userID. tokenVersion must be the
// CURRENT users.token_version value at issue time so middleware can detect
// post-issue password changes via mismatch. Pre-existing callers should
// fetch user.TokenVersion right before calling this (or pass 0 if they
// haven't yet adopted the new column — pre-15 tokens remain valid because
// users.token_version defaults to 0).
//
// refreshTokenID should be the id of the refresh_tokens row minted alongside
// this access token (create/rotate that row FIRST so its id is known), or 0
// when none exists (e.g. a caller that hasn't adopted session-bound acting
// profiles yet). See JWTClaims.RefreshTokenID.
func (s *Service) GenerateAccessToken(userID int64, username, role string, tokenVersion int, refreshTokenID int64) (string, time.Time, error) {
	expiresAt := time.Now().Add(s.cfg.AccessTokenExpiry)
	claims := JWTClaims{
		UserID:         userID,
		Username:       username,
		Role:           role,
		TokenVersion:   tokenVersion,
		RefreshTokenID: refreshTokenID,
		RegisteredClaims: jwt.RegisteredClaims{
			ExpiresAt: jwt.NewNumericDate(expiresAt),
			IssuedAt:  jwt.NewNumericDate(time.Now()),
			NotBefore: jwt.NewNumericDate(time.Now()),
			Issuer:    "aurora",
			Subject:   fmt.Sprintf("%d", userID),
		},
	}

	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	tokenStr, err := token.SignedString([]byte(s.cfg.JWTSecret))
	if err != nil {
		return "", time.Time{}, fmt.Errorf("sign access token: %w", err)
	}
	return tokenStr, expiresAt, nil
}

func (s *Service) ValidateAccessToken(tokenStr string) (*JWTClaims, error) {
	token, err := jwt.ParseWithClaims(tokenStr, &JWTClaims{}, func(token *jwt.Token) (interface{}, error) {
		if _, ok := token.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, fmt.Errorf("unexpected signing method: %v", token.Header["alg"])
		}
		return []byte(s.cfg.JWTSecret), nil
	},
		// Reject tokens that don't carry our issuer or an expiry. Every token
		// we mint sets Issuer "aurora" + exp, so this rejects only foreign or
		// malformed tokens (e.g. an exp-less token from a misconfigured signer
		// reusing the secret) without affecting legitimate Aurora sessions.
		jwt.WithIssuer("aurora"),
		jwt.WithExpirationRequired(),
	)
	if err != nil {
		return nil, ErrInvalidToken
	}

	claims, ok := token.Claims.(*JWTClaims)
	if !ok || !token.Valid {
		return nil, ErrInvalidToken
	}
	// Scoped tokens (e.g. ScopeCast) are not valid as a general access
	// token — they must be presented through their dedicated validator
	// (ValidateCastToken). Rejecting them here means a leaked cast token
	// cannot impersonate a full session even if it lands in the Bearer
	// header on a non-stream route.
	if claims.Scope != "" {
		return nil, ErrInvalidToken
	}
	return claims, nil
}

// GenerateCastToken issues a JWT bound to a single HLS transcode session,
// suitable for embedding in URLs handed to Chromecast/AirPlay receivers.
// The token carries Scope=ScopeCast and SessionID=sessionID; ValidateCastToken
// requires both to match before granting access. TTL is configured via
// cfg.CastTokenExpiry (default 4h) rather than the 15-min access TTL so a
// long movie does not require mid-playback URL refresh.
func (s *Service) GenerateCastToken(userID int64, username, role string, tokenVersion int, sessionID string) (string, time.Time, error) {
	if sessionID == "" {
		return "", time.Time{}, errors.New("cast token requires sessionID")
	}
	// Only the Go zero value triggers the default fallback. Negative
	// durations are honored verbatim (mostly useful in tests that need
	// to mint an already-expired token, mirroring AccessTokenExpiry).
	ttl := s.cfg.CastTokenExpiry
	if ttl == 0 {
		ttl = 4 * time.Hour
	}
	expiresAt := time.Now().Add(ttl)
	claims := JWTClaims{
		UserID:       userID,
		Username:     username,
		Role:         role,
		TokenVersion: tokenVersion,
		Scope:        ScopeCast,
		SessionID:    sessionID,
		RegisteredClaims: jwt.RegisteredClaims{
			ExpiresAt: jwt.NewNumericDate(expiresAt),
			IssuedAt:  jwt.NewNumericDate(time.Now()),
			NotBefore: jwt.NewNumericDate(time.Now()),
			Issuer:    "aurora",
			Subject:   fmt.Sprintf("%d", userID),
		},
	}
	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	tokenStr, err := token.SignedString([]byte(s.cfg.JWTSecret))
	if err != nil {
		return "", time.Time{}, fmt.Errorf("sign cast token: %w", err)
	}
	return tokenStr, expiresAt, nil
}

// ValidateCastToken parses and validates a cast-scoped JWT. Returns
// ErrInvalidToken if the signature, expiry, scope, or session binding
// fails. The caller is responsible for the TokenVersion (revocation)
// check via TokenVersionStore, mirroring how ValidateAccessToken is paired
// with that store in RequireAuth.
func (s *Service) ValidateCastToken(tokenStr string) (*JWTClaims, error) {
	token, err := jwt.ParseWithClaims(tokenStr, &JWTClaims{}, func(token *jwt.Token) (interface{}, error) {
		if _, ok := token.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, fmt.Errorf("unexpected signing method: %v", token.Header["alg"])
		}
		return []byte(s.cfg.JWTSecret), nil
	},
		// Same issuer + expiry-required checks as ValidateAccessToken. Cast
		// tokens are also minted with Issuer "aurora" + exp.
		jwt.WithIssuer("aurora"),
		jwt.WithExpirationRequired(),
	)
	if err != nil {
		return nil, ErrInvalidToken
	}
	claims, ok := token.Claims.(*JWTClaims)
	if !ok || !token.Valid {
		return nil, ErrInvalidToken
	}
	if claims.Scope != ScopeCast || claims.SessionID == "" {
		return nil, ErrInvalidToken
	}
	return claims, nil
}

func (s *Service) GenerateRefreshToken() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", fmt.Errorf("generate refresh token: %w", err)
	}
	return base64.URLEncoding.EncodeToString(b), nil
}

func (s *Service) RefreshTokenExpiry() time.Time {
	return time.Now().Add(s.cfg.RefreshTokenExpiry)
}

// ============================================================
// Invite Codes
// ============================================================

func (s *Service) GenerateInviteCode() (string, error) {
	b := make([]byte, s.cfg.InviteCodeLength)
	if _, err := rand.Read(b); err != nil {
		return "", fmt.Errorf("generate invite code: %w", err)
	}
	return base64.URLEncoding.EncodeToString(b)[:s.cfg.InviteCodeLength], nil
}
