# Match beta analysis report

`scripts/match-report.sh` generates a privacy-bounded JSON snapshot of the
qualified Match exposures and outcomes currently retained by Aurora. It uses the
same label and last-touch attribution implementation as the application rather
than duplicating that policy in SQL or a notebook.

## Run it

On the Aurora host, from the repository checkout:

```bash
umask 077
sudo -u aurora scripts/match-report.sh > match-report.json
```

The wrapper reads `DATABASE_URL` from the environment, or from
`AURORA_ENV_FILE` (default `/etc/aurora/aurora.env`). It never prints the
connection string. Useful options are:

```text
--days 90                 retained UTC window, from 1 through 90 days
--limit 9999              maximum qualified exposures, from 1 through 9999
--minimum-group-size 5    suppress named groups and bins below this count
--pretty=false            emit compact JSON
```

The default output contains no profile IDs, usernames, titles, media IDs, or
individual event rows. Small model/label groups and calibration bins are rolled
up or omitted. The aggregate file still describes private viewing behavior, so
keep it access-restricted and share it only through an approved private channel.

## What the report means

- `qualified_exposures` counts heroes actually measured as visible, not every
  recommendation returned by the API.
- `distinct_profiles` is the number of profiles represented by those qualified
  exposures (not the number of login accounts). It is omitted when fewer than
  `minimum_group_size` profiles are represented.
- `observed_outcomes` and `outcome_coverage` show how much of the retained cohort
  currently has an attributable explicit or behavioral label. No-action rows are
  censored rather than treated as dislikes.
- `brier_score` and `log_loss` measure probability error; lower is better.
- `expected_calibration_error` summarizes the weighted absolute prediction gap
  over ten fixed Match-score bands. `match_bins` exposes only bands containing at
  least `minimum_group_size` **observed outcomes**. A warning about fewer than
  three eligible bins refers to score ranges with outcomes, not to users or
  profiles.

If the limit is reached, `truncated` is true and `selection` explains that the
canonical query returned the oldest qualified exposures first. Do not treat a
truncated report as a complete-window calibration measurement.
- `mean_prediction` versus `mean_outcome` indicates broad over- or
  under-confidence, but does not diagnose ranking quality by itself.

The report deliberately warns when fewer than 100 observed outcomes exist. At
that size it is useful for validating instrumentation and discovering obvious
calibration failures, but not for fitting or approving a production model.

## Sharing for model investigation

Before sharing, inspect the top-level keys and confirm the file contains only the
documented aggregates:

```bash
jq 'keys' match-report.json
```

Provide `match-report.json` together with the exact Aurora commit that generated
it. The `schema_version`, time window, model-version counts, calibration metrics,
label mix, and warnings are sufficient for an initial investigation without
exporting raw household viewing history.
