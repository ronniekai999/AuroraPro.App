package httputil

import (
	"encoding/json"
	"log/slog"
	"net/http"
)

// WriteJSON writes a JSON response with the given status code.
func WriteJSON(w http.ResponseWriter, status int, data interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(data); err != nil {
		slog.Error("write json response", "error", err)
	}
}

// WriteError writes a standardized JSON error response.
func WriteError(w http.ResponseWriter, status int, message string) {
	WriteJSON(w, status, map[string]interface{}{
		"error": map[string]interface{}{
			"code":    status,
			"message": message,
		},
	})
}
