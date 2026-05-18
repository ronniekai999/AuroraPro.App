package arr

import "sync"

// ArrClients is a thread-safe registry of ARR service clients.
// Both RequestHandler and RequestMonitor read from this via getters.
// AdminHandler swaps clients via Update* methods when settings change.
type ArrClients struct {
	mu       sync.RWMutex
	radarr   *RadarrClient
	radarr4K *RadarrClient
	sonarr   *SonarrClient
	sonarr4K *SonarrClient
	enabled  bool
}

// NewArrClients creates a new client registry with the given initial clients.
func NewArrClients(radarr, radarr4K *RadarrClient, sonarr, sonarr4K *SonarrClient, enabled bool) *ArrClients {
	return &ArrClients{
		radarr:   radarr,
		radarr4K: radarr4K,
		sonarr:   sonarr,
		sonarr4K: sonarr4K,
		enabled:  enabled,
	}
}

// Getters return a snapshot of the current client pointer.
// The caller uses the returned pointer without holding the lock.

func (a *ArrClients) Radarr() *RadarrClient {
	a.mu.RLock()
	defer a.mu.RUnlock()
	return a.radarr
}

func (a *ArrClients) Radarr4K() *RadarrClient {
	a.mu.RLock()
	defer a.mu.RUnlock()
	return a.radarr4K
}

func (a *ArrClients) Sonarr() *SonarrClient {
	a.mu.RLock()
	defer a.mu.RUnlock()
	return a.sonarr
}

func (a *ArrClients) Sonarr4K() *SonarrClient {
	a.mu.RLock()
	defer a.mu.RUnlock()
	return a.sonarr4K
}

func (a *ArrClients) Enabled() bool {
	a.mu.RLock()
	defer a.mu.RUnlock()
	return a.enabled
}

// SetEnabled toggles the requests feature on or off.
func (a *ArrClients) SetEnabled(v bool) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.enabled = v
}

// UpdateRadarr swaps the Radarr client. If url or apiKey is empty, the client is set to nil (unconfigured).
func (a *ArrClients) UpdateRadarr(url, apiKey string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if url != "" && apiKey != "" {
		a.radarr = NewRadarrClient(url, apiKey)
	} else {
		a.radarr = nil
	}
}

// UpdateRadarr4K swaps the Radarr 4K client.
func (a *ArrClients) UpdateRadarr4K(url, apiKey string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if url != "" && apiKey != "" {
		a.radarr4K = NewRadarrClient(url, apiKey)
	} else {
		a.radarr4K = nil
	}
}

// UpdateSonarr swaps the Sonarr client.
func (a *ArrClients) UpdateSonarr(url, apiKey string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if url != "" && apiKey != "" {
		a.sonarr = NewSonarrClient(url, apiKey)
	} else {
		a.sonarr = nil
	}
}

// UpdateSonarr4K swaps the Sonarr 4K client.
func (a *ArrClients) UpdateSonarr4K(url, apiKey string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if url != "" && apiKey != "" {
		a.sonarr4K = NewSonarrClient(url, apiKey)
	} else {
		a.sonarr4K = nil
	}
}
