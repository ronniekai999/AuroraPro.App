package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"time"

	"github.com/aurora-media/aurora/internal/db"
	"github.com/aurora-media/aurora/internal/matchreport"
	"github.com/jackc/pgx/v5/pgxpool"
)

func main() {
	days := flag.Int("days", 90, "number of UTC days to analyze (1-90)")
	limit := flag.Int("limit", 9999, "maximum qualified exposures to analyze (1-9999)")
	minimumGroup := flag.Int("minimum-group-size", 5, "suppress aggregate groups smaller than this")
	pretty := flag.Bool("pretty", true, "indent JSON output")
	flag.Parse()
	if err := validate(*days, *limit, *minimumGroup); err != nil {
		fatal("%v", err)
	}
	databaseURL := os.Getenv("DATABASE_URL")
	if databaseURL == "" {
		fatal("DATABASE_URL is required (the wrapper can read /etc/aurora/aurora.env)")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		fatal("connect to database: %v", err)
	}
	defer pool.Close()
	now := time.Now().UTC()
	rows, err := db.NewQueries(pool).RecommendationCalibrationRows(ctx, now.Add(-time.Duration(*days)*24*time.Hour), *limit+1)
	if err != nil {
		fatal("read matching data: %v", err)
	}
	truncated := len(rows) > *limit
	if truncated {
		rows = rows[:*limit]
	}
	report := matchreport.Build(rows, now, now.Add(-time.Duration(*days)*24*time.Hour), *days, *minimumGroup, truncated)
	encoder := json.NewEncoder(os.Stdout)
	encoder.SetEscapeHTML(false)
	if *pretty {
		encoder.SetIndent("", "  ")
	}
	if err := encoder.Encode(report); err != nil {
		fatal("write report: %v", err)
	}
}

func validate(days, limit, minimumGroup int) error {
	if days < 1 || days > 90 || limit < 1 || limit > 9999 || minimumGroup < 1 {
		return fmt.Errorf("days must be 1-90, limit 1-9999, and minimum-group-size positive")
	}
	return nil
}

func fatal(format string, args ...any) {
	fmt.Fprintf(os.Stderr, "match-report: "+format+"\n", args...)
	os.Exit(1)
}
