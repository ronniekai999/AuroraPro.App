package auth

// Cookie names for the browser auth flow (deep-debug H10). The httpOnly
// access/refresh cookies replace localStorage token storage in the SPA so
// neither token is readable from JavaScript; the auth middlewares read the
// access cookie as a fallback to the Authorization header, which lets
// same-origin <video>/<img>/WebSocket requests authenticate without a
// JS-accessible token (and removes the old ?token= query-param hack for the
// browser; cast/AirPlay receivers, which aren't same-origin, still use it).
const (
	AccessCookieName  = "aurora_access"
	RefreshCookieName = "aurora_refresh"
)
