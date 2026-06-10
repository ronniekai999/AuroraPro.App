package watchparty

import (
	"errors"
	"fmt"
)

// userError marks an error whose message was written for end users and is
// safe to send verbatim over the wire ("only the host can pause",
// "party is full (5/5)", …).
//
// 2026-06 review (security finding 2) — the WS handlers used to forward
// EVERY manager error to the client via err.Error(). Today all of those
// messages happen to be benign, but the pattern is a footgun: the first
// manager path that wraps a DB or filesystem error would leak internal
// detail to any party member. Manager methods now build user-facing
// errors with errUser; the WS handlers send unmarked errors as a generic
// "internal error" instead (see safeWSError in the api package).
type userError struct {
	msg string
}

func (e userError) Error() string { return e.msg }

// errUser builds a user-presentable error. Use ONLY for messages that are
// written for humans and contain no internal detail.
func errUser(format string, args ...interface{}) error {
	return userError{msg: fmt.Sprintf(format, args...)}
}

// IsUserError reports whether err (or anything it wraps) carries a
// user-presentable message minted via errUser. Exported for the WS
// handlers' outbound error filter.
func IsUserError(err error) bool {
	var ue userError
	return errors.As(err, &ue)
}
