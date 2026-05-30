package auth

import (
	"testing"
	"time"

	"github.com/aurora-media/aurora/internal/config"
	"github.com/golang-jwt/jwt/v5"
)

// signClaims signs the given claims with svc's secret using HS256, bypassing
// GenerateAccessToken so tests can mint tokens with deliberately wrong fields
// (e.g. a non-"aurora" issuer or a missing expiry).
func signClaims(t *testing.T, svc *Service, claims JWTClaims) string {
	t.Helper()
	tok := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	signed, err := tok.SignedString([]byte(svc.cfg.JWTSecret))
	if err != nil {
		t.Fatalf("signClaims: %v", err)
	}
	return signed
}

// newTestService creates a Service with known test configuration.
func newTestService() *Service {
	return NewService(config.AuthConfig{
		JWTSecret:          "test-secret-key-that-is-at-least-32-chars-long-for-testing",
		AccessTokenExpiry:  15 * time.Minute,
		RefreshTokenExpiry: 7 * 24 * time.Hour,
		Argon2Memory:       64 * 1024,
		Argon2Iterations:   1, // Low iterations for fast tests
		Argon2Parallelism:  1,
		Argon2SaltLength:   16,
		Argon2KeyLength:    32,
		InviteCodeLength:   16,
	})
}

func TestHashPassword_RoundTrip(t *testing.T) {
	svc := newTestService()
	password := "correct-horse-battery-staple"

	hash, err := svc.HashPassword(password)
	if err != nil {
		t.Fatalf("HashPassword() error: %v", err)
	}

	if hash == "" {
		t.Fatal("HashPassword() returned empty hash")
	}

	// Verify the hash starts with the argon2id prefix
	if len(hash) < 10 || hash[:9] != "$argon2id" {
		t.Errorf("hash does not start with $argon2id: %q", hash[:20])
	}

	ok, err := svc.VerifyPassword(password, hash)
	if err != nil {
		t.Fatalf("VerifyPassword() error: %v", err)
	}
	if !ok {
		t.Error("VerifyPassword() returned false for correct password")
	}
}

func TestVerifyPassword_WrongPassword(t *testing.T) {
	svc := newTestService()
	password := "correct-password"

	hash, err := svc.HashPassword(password)
	if err != nil {
		t.Fatalf("HashPassword() error: %v", err)
	}

	ok, err := svc.VerifyPassword("wrong-password", hash)
	if err != nil {
		t.Fatalf("VerifyPassword() error: %v", err)
	}
	if ok {
		t.Error("VerifyPassword() returned true for wrong password")
	}
}

func TestHashPassword_DifferentSalts(t *testing.T) {
	svc := newTestService()
	password := "same-password"

	hash1, err := svc.HashPassword(password)
	if err != nil {
		t.Fatal(err)
	}
	hash2, err := svc.HashPassword(password)
	if err != nil {
		t.Fatal(err)
	}

	if hash1 == hash2 {
		t.Error("same password produced identical hashes (salt should differ)")
	}

	// Both hashes should verify
	ok1, _ := svc.VerifyPassword(password, hash1)
	ok2, _ := svc.VerifyPassword(password, hash2)
	if !ok1 || !ok2 {
		t.Error("one or both hashes failed verification")
	}
}

func TestVerifyPassword_InvalidFormat(t *testing.T) {
	svc := newTestService()

	_, err := svc.VerifyPassword("password", "not-a-valid-hash")
	if err == nil {
		t.Error("VerifyPassword() should return error for invalid hash format")
	}
}

func TestGenerateAccessToken_RoundTrip(t *testing.T) {
	svc := newTestService()

	tokenStr, expiresAt, err := svc.GenerateAccessToken(42, "testuser", "admin", 0)
	if err != nil {
		t.Fatalf("GenerateAccessToken() error: %v", err)
	}

	if tokenStr == "" {
		t.Fatal("GenerateAccessToken() returned empty token")
	}

	// Expiry should be in the future
	if expiresAt.Before(time.Now()) {
		t.Error("token expiry is in the past")
	}

	claims, err := svc.ValidateAccessToken(tokenStr)
	if err != nil {
		t.Fatalf("ValidateAccessToken() error: %v", err)
	}

	if claims.UserID != 42 {
		t.Errorf("claims.UserID = %d, want 42", claims.UserID)
	}
	if claims.Username != "testuser" {
		t.Errorf("claims.Username = %q, want %q", claims.Username, "testuser")
	}
	if claims.Role != "admin" {
		t.Errorf("claims.Role = %q, want %q", claims.Role, "admin")
	}
	if claims.Issuer != "aurora" {
		t.Errorf("claims.Issuer = %q, want %q", claims.Issuer, "aurora")
	}
}

func TestValidateAccessToken_Expired(t *testing.T) {
	svc := NewService(config.AuthConfig{
		JWTSecret:         "test-secret-key-that-is-at-least-32-chars-long-for-testing",
		AccessTokenExpiry: -1 * time.Hour, // Already expired
		Argon2Memory:      64 * 1024,
		Argon2Iterations:  1,
		Argon2Parallelism: 1,
		Argon2SaltLength:  16,
		Argon2KeyLength:   32,
	})

	tokenStr, _, err := svc.GenerateAccessToken(1, "user", "user", 0)
	if err != nil {
		t.Fatalf("GenerateAccessToken() error: %v", err)
	}

	_, err = svc.ValidateAccessToken(tokenStr)
	if err == nil {
		t.Error("ValidateAccessToken() should return error for expired token")
	}
	if err != ErrInvalidToken {
		t.Errorf("error = %v, want ErrInvalidToken", err)
	}
}

func TestValidateAccessToken_Tampered(t *testing.T) {
	svc := newTestService()

	tokenStr, _, err := svc.GenerateAccessToken(1, "user", "user", 0)
	if err != nil {
		t.Fatalf("GenerateAccessToken() error: %v", err)
	}

	// Tamper with the token payload (middle segment) to ensure signature mismatch.
	// JWT has 3 dot-separated segments: header.payload.signature
	// We modify the payload to reliably invalidate the signature.
	parts := splitJWT(tokenStr)
	if len(parts) != 3 {
		t.Fatalf("expected 3 JWT parts, got %d", len(parts))
	}

	// Flip bytes in the payload (middle segment)
	payload := []byte(parts[1])
	if len(payload) > 5 {
		// Change several characters to ensure base64 corruption of the payload
		payload[2] = 'A'
		payload[3] = 'B'
		payload[4] = 'C'
	}
	tampered := parts[0] + "." + string(payload) + "." + parts[2]

	_, err = svc.ValidateAccessToken(tampered)
	if err == nil {
		t.Error("ValidateAccessToken() should return error for tampered token")
	}
	if err != ErrInvalidToken {
		t.Errorf("error = %v, want ErrInvalidToken", err)
	}
}

// splitJWT splits a JWT into its 3 dot-separated segments.
func splitJWT(token string) []string {
	var parts []string
	start := 0
	for i := 0; i < len(token); i++ {
		if token[i] == '.' {
			parts = append(parts, token[start:i])
			start = i + 1
		}
	}
	parts = append(parts, token[start:])
	return parts
}

func TestValidateAccessToken_WrongSecret(t *testing.T) {
	svc1 := NewService(config.AuthConfig{
		JWTSecret:         "secret-one-that-is-at-least-32-chars-long-for-testing-1234",
		AccessTokenExpiry: 15 * time.Minute,
		Argon2Memory:      64 * 1024,
		Argon2Iterations:  1,
		Argon2Parallelism: 1,
		Argon2SaltLength:  16,
		Argon2KeyLength:   32,
	})
	svc2 := NewService(config.AuthConfig{
		JWTSecret:         "secret-two-that-is-at-least-32-chars-long-for-testing-5678",
		AccessTokenExpiry: 15 * time.Minute,
		Argon2Memory:      64 * 1024,
		Argon2Iterations:  1,
		Argon2Parallelism: 1,
		Argon2SaltLength:  16,
		Argon2KeyLength:   32,
	})

	tokenStr, _, err := svc1.GenerateAccessToken(1, "user", "user", 0)
	if err != nil {
		t.Fatalf("GenerateAccessToken() error: %v", err)
	}

	_, err = svc2.ValidateAccessToken(tokenStr)
	if err == nil {
		t.Error("ValidateAccessToken() should reject token signed with different secret")
	}
}

func TestValidateAccessToken_GarbageInput(t *testing.T) {
	svc := newTestService()

	_, err := svc.ValidateAccessToken("not.a.valid.jwt.token")
	if err == nil {
		t.Error("ValidateAccessToken() should return error for garbage input")
	}

	_, err = svc.ValidateAccessToken("")
	if err == nil {
		t.Error("ValidateAccessToken() should return error for empty string")
	}
}

// A token signed with the correct secret but a foreign/blank issuer must be
// rejected now that ValidateAccessToken opts into jwt.WithIssuer("aurora").
func TestValidateAccessToken_WrongIssuer(t *testing.T) {
	svc := newTestService()

	for _, iss := range []string{"", "evil", "Aurora"} {
		tok := signClaims(t, svc, JWTClaims{
			UserID: 1, Username: "u", Role: "user",
			RegisteredClaims: jwt.RegisteredClaims{
				ExpiresAt: jwt.NewNumericDate(time.Now().Add(15 * time.Minute)),
				IssuedAt:  jwt.NewNumericDate(time.Now()),
				Issuer:    iss,
				Subject:   "1",
			},
		})
		if _, err := svc.ValidateAccessToken(tok); err != ErrInvalidToken {
			t.Errorf("issuer %q: ValidateAccessToken() = %v, want ErrInvalidToken", iss, err)
		}
	}
}

// A token with the correct issuer but NO exp claim must be rejected now that
// ValidateAccessToken opts into jwt.WithExpirationRequired().
func TestValidateAccessToken_MissingExpiry(t *testing.T) {
	svc := newTestService()
	tok := signClaims(t, svc, JWTClaims{
		UserID: 1, Username: "u", Role: "user",
		RegisteredClaims: jwt.RegisteredClaims{
			IssuedAt: jwt.NewNumericDate(time.Now()),
			Issuer:   "aurora",
			Subject:  "1",
			// ExpiresAt deliberately omitted.
		},
	})
	if _, err := svc.ValidateAccessToken(tok); err != ErrInvalidToken {
		t.Errorf("ValidateAccessToken(no-exp) = %v, want ErrInvalidToken", err)
	}
}

// The cast validator gained the same issuer guard; a cast-scoped token with a
// wrong issuer must be rejected.
func TestValidateCastToken_WrongIssuer(t *testing.T) {
	svc := newCastTestService()
	tok := signClaims(t, svc, JWTClaims{
		UserID: 1, Username: "u", Role: "user",
		Scope: ScopeCast, SessionID: "sess-1",
		RegisteredClaims: jwt.RegisteredClaims{
			ExpiresAt: jwt.NewNumericDate(time.Now().Add(time.Hour)),
			IssuedAt:  jwt.NewNumericDate(time.Now()),
			Issuer:    "evil",
			Subject:   "1",
		},
	})
	if _, err := svc.ValidateCastToken(tok); err != ErrInvalidToken {
		t.Errorf("ValidateCastToken(wrong-issuer) = %v, want ErrInvalidToken", err)
	}
}

func TestGenerateRefreshToken(t *testing.T) {
	svc := newTestService()

	token1, err := svc.GenerateRefreshToken()
	if err != nil {
		t.Fatalf("GenerateRefreshToken() error: %v", err)
	}

	token2, err := svc.GenerateRefreshToken()
	if err != nil {
		t.Fatalf("GenerateRefreshToken() error: %v", err)
	}

	if token1 == "" || token2 == "" {
		t.Error("GenerateRefreshToken() returned empty token")
	}

	if token1 == token2 {
		t.Error("GenerateRefreshToken() produced duplicate tokens")
	}
}

func TestGenerateInviteCode(t *testing.T) {
	svc := newTestService()

	code1, err := svc.GenerateInviteCode()
	if err != nil {
		t.Fatalf("GenerateInviteCode() error: %v", err)
	}

	code2, err := svc.GenerateInviteCode()
	if err != nil {
		t.Fatalf("GenerateInviteCode() error: %v", err)
	}

	if len(code1) != 16 {
		t.Errorf("invite code length = %d, want 16", len(code1))
	}

	if code1 == code2 {
		t.Error("GenerateInviteCode() produced duplicate codes")
	}
}

func TestRefreshTokenExpiry(t *testing.T) {
	svc := newTestService()

	expiry := svc.RefreshTokenExpiry()
	expected := time.Now().Add(7 * 24 * time.Hour)

	// Allow 5 seconds of drift
	diff := expiry.Sub(expected)
	if diff < -5*time.Second || diff > 5*time.Second {
		t.Errorf("RefreshTokenExpiry() off by %v", diff)
	}
}

func TestTokenClaims_Subject(t *testing.T) {
	svc := newTestService()

	tokenStr, _, err := svc.GenerateAccessToken(123, "testuser", "user", 0)
	if err != nil {
		t.Fatalf("GenerateAccessToken() error: %v", err)
	}

	claims, err := svc.ValidateAccessToken(tokenStr)
	if err != nil {
		t.Fatalf("ValidateAccessToken() error: %v", err)
	}

	// Subject should be the string representation of UserID
	if claims.Subject != "123" {
		t.Errorf("claims.Subject = %q, want %q", claims.Subject, "123")
	}
}

// ============================================================
// Cast token (Chromecast / AirPlay)
// ============================================================

func newCastTestService() *Service {
	return NewService(config.AuthConfig{
		JWTSecret:         "test-secret-key-that-is-at-least-32-chars-long-for-testing",
		AccessTokenExpiry: 15 * time.Minute,
		CastTokenExpiry:   4 * time.Hour,
		Argon2Memory:      64 * 1024,
		Argon2Iterations:  1,
		Argon2Parallelism: 1,
		Argon2SaltLength:  16,
		Argon2KeyLength:   32,
	})
}

func TestGenerateCastToken_RoundTrip(t *testing.T) {
	svc := newCastTestService()

	tokenStr, expiresAt, err := svc.GenerateCastToken(42, "testuser", "admin", 7, "sess-abc")
	if err != nil {
		t.Fatalf("GenerateCastToken() error: %v", err)
	}
	if tokenStr == "" {
		t.Fatal("GenerateCastToken() returned empty token")
	}
	// Cast tokens should live longer than the 15-min access token TTL.
	if want := time.Now().Add(3 * time.Hour); expiresAt.Before(want) {
		t.Errorf("cast expiry too short: %v (want > %v)", expiresAt, want)
	}

	claims, err := svc.ValidateCastToken(tokenStr)
	if err != nil {
		t.Fatalf("ValidateCastToken() error: %v", err)
	}
	if claims.UserID != 42 {
		t.Errorf("claims.UserID = %d, want 42", claims.UserID)
	}
	if claims.Scope != ScopeCast {
		t.Errorf("claims.Scope = %q, want %q", claims.Scope, ScopeCast)
	}
	if claims.SessionID != "sess-abc" {
		t.Errorf("claims.SessionID = %q, want %q", claims.SessionID, "sess-abc")
	}
	if claims.TokenVersion != 7 {
		t.Errorf("claims.TokenVersion = %d, want 7", claims.TokenVersion)
	}
}

func TestGenerateCastToken_RequiresSessionID(t *testing.T) {
	svc := newCastTestService()
	if _, _, err := svc.GenerateCastToken(1, "u", "user", 0, ""); err == nil {
		t.Error("GenerateCastToken should reject empty sessionID")
	}
}

// A cast token must NOT be accepted by ValidateAccessToken — otherwise a
// leaked cast URL token could be lifted into a Bearer header on any other
// authenticated endpoint. This is the load-bearing isolation guarantee.
func TestValidateAccessToken_RejectsCastToken(t *testing.T) {
	svc := newCastTestService()
	castTok, _, err := svc.GenerateCastToken(1, "u", "user", 0, "sess-xyz")
	if err != nil {
		t.Fatalf("GenerateCastToken() error: %v", err)
	}
	if _, err := svc.ValidateAccessToken(castTok); err != ErrInvalidToken {
		t.Errorf("ValidateAccessToken(castToken) = %v, want ErrInvalidToken", err)
	}
}

// A regular access token must NOT be accepted by ValidateCastToken — the
// dedicated validator should require Scope == ScopeCast.
func TestValidateCastToken_RejectsRegularToken(t *testing.T) {
	svc := newCastTestService()
	tok, _, err := svc.GenerateAccessToken(1, "u", "user", 0)
	if err != nil {
		t.Fatalf("GenerateAccessToken() error: %v", err)
	}
	if _, err := svc.ValidateCastToken(tok); err != ErrInvalidToken {
		t.Errorf("ValidateCastToken(accessToken) = %v, want ErrInvalidToken", err)
	}
}

func TestValidateCastToken_Expired(t *testing.T) {
	svc := NewService(config.AuthConfig{
		JWTSecret:         "test-secret-key-that-is-at-least-32-chars-long-for-testing",
		CastTokenExpiry:   -1 * time.Hour, // already expired
		Argon2Memory:      64 * 1024,
		Argon2Iterations:  1,
		Argon2Parallelism: 1,
		Argon2SaltLength:  16,
		Argon2KeyLength:   32,
	})
	tok, _, err := svc.GenerateCastToken(1, "u", "user", 0, "sess-1")
	if err != nil {
		t.Fatalf("GenerateCastToken() error: %v", err)
	}
	if _, err := svc.ValidateCastToken(tok); err != ErrInvalidToken {
		t.Errorf("ValidateCastToken(expired) = %v, want ErrInvalidToken", err)
	}
}

func TestValidateCastToken_Tampered(t *testing.T) {
	svc := newCastTestService()
	tok, _, err := svc.GenerateCastToken(1, "u", "user", 0, "sess-1")
	if err != nil {
		t.Fatalf("GenerateCastToken() error: %v", err)
	}
	// Flip a character in the signature segment.
	tampered := tok[:len(tok)-2] + "AA"
	if _, err := svc.ValidateCastToken(tampered); err != ErrInvalidToken {
		t.Errorf("ValidateCastToken(tampered) = %v, want ErrInvalidToken", err)
	}
}

// Cast tokens fall back to a sensible default TTL (4h) when config is unset,
// so a misconfigured deployment doesn't accidentally mint zero-lifetime tokens.
func TestGenerateCastToken_DefaultExpiryWhenUnset(t *testing.T) {
	svc := NewService(config.AuthConfig{
		JWTSecret:         "test-secret-key-that-is-at-least-32-chars-long-for-testing",
		AccessTokenExpiry: 15 * time.Minute,
		// CastTokenExpiry deliberately omitted (zero value).
		Argon2Memory:      64 * 1024,
		Argon2Iterations:  1,
		Argon2Parallelism: 1,
		Argon2SaltLength:  16,
		Argon2KeyLength:   32,
	})
	_, expiresAt, err := svc.GenerateCastToken(1, "u", "user", 0, "sess-1")
	if err != nil {
		t.Fatalf("GenerateCastToken() error: %v", err)
	}
	if want := time.Now().Add(3 * time.Hour); expiresAt.Before(want) {
		t.Errorf("default cast expiry too short: %v (want > %v)", expiresAt, want)
	}
}
