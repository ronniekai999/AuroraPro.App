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

type JWTClaims struct {
	UserID       int64  `json:"user_id"`
	Username     string `json:"username"`
	Role         string `json:"role"`
	TokenVersion int    `json:"tv,omitempty"` // matches users.token_version at issue time
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
func (s *Service) GenerateAccessToken(userID int64, username, role string, tokenVersion int) (string, time.Time, error) {
	expiresAt := time.Now().Add(s.cfg.AccessTokenExpiry)
	claims := JWTClaims{
		UserID:       userID,
		Username:     username,
		Role:         role,
		TokenVersion: tokenVersion,
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
	})
	if err != nil {
		return nil, ErrInvalidToken
	}

	claims, ok := token.Claims.(*JWTClaims)
	if !ok || !token.Valid {
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
