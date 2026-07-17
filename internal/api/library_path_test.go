package api

import "testing"

func TestLibraryPathRejectionReason(t *testing.T) {
	t.Parallel()

	for _, path := range []string{
		"/srv/media",
		"/mnt/nas/media",
		"/media/disk/movies",
		"/home/alice/videos",
		"/var/media",
		"/var/media/tv",
	} {
		if reason := libraryPathRejectionReason(path); reason != "" {
			t.Errorf("safe path %q rejected: %s", path, reason)
		}
	}

	for _, path := range []string{
		"/",
		"/home",
		"/home/alice",
		"/home/alice/.ssh",
		"/home/alice/.config/aurora",
		"/etc",
		"/etc/ssl/private",
		"/var",
		"/var/lib/postgresql",
		"/var/log",
		"/var/backups",
		"/var/spool",
		"/var/cache",
		"/opt/aurora",
		"/tmp/aurora-transcode",
		"relative/media",
	} {
		if reason := libraryPathRejectionReason(path); reason == "" {
			t.Errorf("unsafe path %q was accepted", path)
		}
	}
}
