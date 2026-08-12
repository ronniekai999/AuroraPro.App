# Personal Match v2 — calibrated satisfaction, not a pool-relative percentile

**Status:** Phase 2 beta measurement implemented. Aurora now uses the pool-invariant
`match-v2-bootstrap-2` curve, exposes its evidence confidence/model version, and
records API-selected slates plus foreground, ≥50%-visible hero exposures for
time-forward calibration. The checked-in
bootstrap coefficients are conservative engineering priors, not empirical
calibration: Aurora must not describe the value as a satisfaction probability
until a fitted model passes the calibration gates below.

`bootstrap-2` (review follow-up) changed the **evidence term**, not the curve:
`support` is now `db.MatchEvidenceCount` — DISTINCT supporting titles, uncapped
— where `bootstrap-1` reused the capped top-20 taste slice. That cap pinned
`rho` at `20/25 = 0.8`, so no profile could ever be shown more than ~86% and the
manifest's own 0.05/0.95 clamps were unreachable; counting per-episode rows also
let one binged show impersonate a mature profile. Because displayed values move
for evidence-rich profiles, the generation is versioned so the two populations
stay separable in the calibration report.
**Scope:** the personal `Match` percentage shown on personalized media; the
global Aurora `Score` remains a separate quality/engagement signal.

## Executive decision

Aurora should define **Match %** as:

> The estimated probability that this profile will have a satisfying experience
> with this title if it starts it now, given the evidence Aurora currently has.

The displayed value should be a calibrated probability, not a percentile or a
ranking score. Ranking should use a separate multi-objective utility and a final
diversification pass. This distinction is important: the best order for a rail
is not necessarily a truthful percentage, and diversity/repetition/business
rules should not alter what “82% Match” means.

This proposal is deliberately implementable on a private, self-hosted server. It
does not require sending watch history to a hosted training service. It starts
with a deterministic Bayesian/logistic model, gains local calibration as a
profile accumulates outcomes, and leaves a clean seam for an optional learned
ranker once impression data is sufficient.

## What Aurora does today

The current path is stronger than a basic “TMDB rating × 10” system:

1. It builds a taste slice from the 20 most recent eligible signals: meaningful
   watches, onboarding seeds, thumbs-up, 4–5 star ratings, and saved/favourite
   titles, while removing strong negative ratings.
2. With enough history it clusters that slice into up to three taste centroids,
   retrieves nearest unseen titles per centroid, and interleaves the lists.
3. Cosine distance from pgvector becomes `similarity = clamp(1-distance, 0, 1)`.
4. An optional listwise LLM scores and narrows candidates using title, genres,
   overview, and a short taste summary. Hero then deterministically shuffles that
   pool to reduce position bias, attaches Aurora Score, and runs a second LLM
   curator that selects for taste fit, variety, novelty, maturity, anti-taste,
   and quality. If curation is unavailable or incomplete, missing slots are
   filled in Aurora Score order. Discover has its own later LLM curation pass.
5. Match is currently a **hero-only** field. For display, the selected hero's
   original vector cosine (not either LLM judgment) is z-scored against the
   current candidate pool and passed through a logistic function:

   ```text
   z = (cosine_similarity - candidate_pool_mean) / candidate_pool_stddev
   Match = round(100 * sigmoid(z))
   ```

   If the pool has effectively zero variance, a fixed linear map turns cosine
   similarities around 0.70–0.95 into approximately 60–96.

The separate global Aurora Score blends Bayesian-shrunk public rating,
freshness, local heat, favourites/collections, and a Wilson lower bound for
completion. It is a useful quality prior, but it is not personal fit.

## Diagnosis

### What is working

- **Two-stage architecture:** vector recall followed by reranking is the right
  scalable shape. This is the same broad candidate-generation/ranking split
  described in the [YouTube recommendations paper](https://research.google/pubs/deep-neural-networks-for-youtube-recommendations/).
- **Multi-interest taste:** multiple centroids avoid averaging unrelated tastes
  into a “muddy midpoint.”
- **Hard safety and preference exclusions:** watched, disliked, low-rated,
  already-saved, and age-ineligible items are filtered before presentation.
- **Quality is separate from personal taste:** Aurora already has the right API
  concept even though the final ranking/display contract needs tightening.
- **Graceful local operation:** vector retrieval and deterministic fallbacks keep
  recommendations available when the LLM is absent or fails.

### Why the current percentage is not trustworthy

1. **It is relative to whichever candidates happened to be recalled.** The same
   title and profile can show 45% in a strong pool and 85% in a weak pool without
   any taste evidence changing. Pool size, content availability, anti-repeat
   demotion, and centroid interleaving can all change the number.
2. **The pool arithmetic mean is anchored to 50%.** A candidate whose cosine
   equals the current pool's arithmetic mean maps to 50, regardless of whether
   that pool is uniformly excellent or uniformly poor. Because the sigmoid is
   nonlinear and a mean need not split a skewed distribution in half, the mean
   displayed value is not necessarily 50 and Match is not literally a
   percentile. It is still a pool-relative comparison, not “likely right for
   you.”
3. **Cosine similarity is not a probability.** Embedding model/version, metadata
   density, language, title type, and catalog composition shift its scale. A
   logistic applied to a z-score improves visual spread but does not calibrate
   against user outcomes.
4. **Display and final rank can disagree.** Both the listwise narrowing stage and
   later hero curator can change the selected order using signals beyond vector
   cosine, while Match is computed afterward from the original bi-encoder cosine
   only. A fallback slot may instead be elevated by global Aurora Score. None of
   those reasons for elevation appear in its displayed percentage.
5. **Positive evidence is flattened.** A completed favourite, a 20%-watched
   title, a setup seed, and a watchlist click can occupy one centroid slice even
   though they express different confidence and preference strength. The hard
   top-20 cutoff also makes preferences change discontinuously.
6. **Negative preference is mostly exclusion, not repulsion.** A disliked title
   disappears, but nearby themes are not explicitly pushed down. The positive
   centroid can continue retrieving “more like” the rejected trait.
7. **No uncertainty is communicated.** Three onboarding clicks and hundreds of
   completed/rated titles can produce similarly confident-looking percentages.
8. **There is no outcome calibration loop.** Aurora does not currently test
   whether items shown as 80% actually satisfy users about eight times in ten.

## Revised formula

### 1. Define a measurable satisfaction outcome

For an impression `i` of profile `u`, title `m`, and context `c`, define a soft
label `y ∈ [0,1]`. Explicit feedback wins over inferred behavior:

| Observed outcome | Suggested label |
|---|---:|
| 5★ or thumbs-up plus completion | 1.00 |
| 4★, or completed with strong engagement | 0.85 |
| completed without explicit verdict | 0.75 |
| sustained partial watch | 0.55 |
| saved after impression but not started yet | censored; not success |
| no start | censored; not automatically negative |
| early abandonment after a meaningful start | 0.20 |
| 2★ | 0.10 |
| 1★ or thumbs-down | 0.00 |

Beta policy decisions (2026-08-09): completed-but-unrated movies are `0.75`;
thumbs-up is `0.85` even without a new completion because it means the viewer has
already seen the title; progress below 20% is early abandonment; show behavior is
aggregated at the **series**, never episode, level; and a detected rewatch is
stronger than first completion (`0.90`). Two engaged/completed episode rows are
the provisional series-engagement threshold; validate it from beta outcomes.

“Completed” must be media-aware: episode completion, movie completion, and a
series binge are different observations. No-click impressions must not be
naively labeled negative because position and exposure strongly affect clicks.
Log the impression, surface, position, candidate set/model version, and eventual
outcome so the bias can be measured.

### 2. Build an absolute personal-fit feature vector

For every eligible candidate calculate these bounded features. All time decay is
continuous rather than a hard last-20 cliff. This is the canonical v2 feature
definition; every scale and coefficient belongs to a versioned model manifest.

```text
event_weight(e) =
    source_confidence(e)
  * preference_strength(e)
  * 2^(-age_days(e) / half_life_days(source_e))

pi_k = sum(event_weight(e) for e assigned to mode k)
       / sum(event_weight(e) for all positive events)

cos01(a,b) = clamp((cosine(a,b) + 1) / 2, 0, 1)
positive_fit = sum_k pi_k * cos01(item, positive_centroid_k)
negative_fit = max_j confidence_j * max(0, cosine(item, negative_anchor_j))

support = (sum(event_weight))^2 / sum(event_weight^2)
```

Recommended source confidence ordering is explicit star/thumb verdict >
completed watch > sustained partial watch > onboarding seed > favourite >
want-to-watch. A save is intent, not evidence that the viewer enjoyed the work.
Fit positive modes with deterministic, event-weighted spherical k-means; compute
each centroid as the L2-normalized weighted mean. The `pi_k` values sum to one,
so adding a taste mode cannot inflate `positive_fit`. Keep a small set of
negative centroids/anchors; define each `confidence_j ∈ [0,1]` from explicit
negative strength and time decay. Do not subtract disliked vectors into one
average, which can create another uninterpretable midpoint.

The base feature vector should include:

- canonical weighted `positive_fit` and `negative_fit` above;
- explicit genre, keyword, cast/creator, language, era, maturity, and media-type
  affinities, each Bayesian-smoothed toward the server/profile prior;
- media-aware runtime fit and series commitment;
- Bayesian global quality and completion-quality priors from Aurora Score;
- popularity only as a cold-start prior, never as evidence of personal fit;
- profile support, feature missingness, and embedding/model identifiers.

### 3. Estimate a regularized satisfaction probability

The first candidate model should be an interpretable regularized logistic model
with hierarchical shrinkage. Every non-cosine continuous feature is winsorized
at training-manifest bounds and min-max scaled to `[0,1]`; missing values get a
separate indicator. Categorical affinities are Bayesian posterior means in
`[0,1]`.

```text
personal_delta(u,m,c) =
    b_media_type
  + w_pos       * positive_fit
  - w_neg       * negative_fit
  + w_explicit  · explicit_affinities
  + w_quality   * bayesian_quality
  + w_complete  * bayesian_completion_quality
  + w_context   · satisfaction_context

personal_logit = prior_logit(media_type, profile_class)
                 + rho(support) * personal_delta

rho(support) = support / (support + k_prior)
p_raw = sigmoid(personal_logit)
```

`satisfaction_context` is an allowlist, not an arbitrary request context. It may
contain media type, runtime/series commitment, and time-of-day only after each is
validated as predictive of post-start satisfaction. It must never contain
surface, slate position, prior impression count, exploration assignment, or
business-rule state. Exposure fatigue and repetition belong only to ranking
utility below; they cannot change the displayed probability or be counted twice.

The shrinkage term is load-bearing for Aurora's audience: most self-hosted
profiles have little data, so unconstrained per-profile learning will overfit.
`k_prior`, priors, feature bounds, half-lives, source confidences, and all model
coefficients must be supplied together in a signed/versioned manifest produced
from consented, de-identified development data and validated on held-out
deployments. **There is no honest hard-coded coefficient set derivable from the
repository alone.** Until that artifact exists and clears the gates below, v2
runs as feature/instrumentation shadowing only and the UI must not label its
output a probability. Local coefficient fitting is disabled below 2,000 labeled
outcomes; otherwise use strong regularization and retain the bundled manifest as
the prior. An optional later model can use [LightGBM's LambdaRank objective](https://lightgbm.readthedocs.io/en/stable/Parameters.html#lambdarank)
for ordering, but its output is still not a probability and must not be shown as
Match directly.

### 4. Calibrate the displayed probability

Fit a monotonic calibrator on held-out, time-forward outcomes:

```text
p_cal = Calibrate(p_raw, media_type, evidence_band)
Match = round(100 * p_cal)
```

Use regularized Platt scaling with at least 500 time-forward labeled outcomes
for a server/media-type
calibrator and 200 for a profile/media-type adjustment. Use isotonic regression
only at 2,000 outcomes with at least 100 observations in each populated decile;
these are launch safety floors to validate, not claims of statistical
optimality. Fall back through profile + media type → server + media type → the
bundled manifest calibrator. Never calibrate against the current candidate pool.
Restricted/kids profiles use an independently trained child-safe bundled prior
and calibrator; they never inherit an adult-dominated server/profile calibrator.

Calibration must be assessed with reliability diagrams, Brier score, log loss,
and expected calibration error. Ranking metrics alone cannot establish that a
percentage is truthful. Because the outcome is delayed, evaluate with temporal
splits rather than random rows. Calibration method comparisons should follow the
held-out discipline in [Predicting good probabilities with supervised learning](https://www.cs.cornell.edu/~alexn/papers/calibration.icml05.crc.rev3.pdf).

For low evidence, either show a range internally (`p10`, `p90`) or reduce UI
precision. Recommended UI policy:

- sufficient evidence: `82% Match`;
- sparse evidence: `Likely a match` with an explanation such as “Based mostly
  on your setup picks”;
- cold start: no personal percentage; retain Aurora Score/popular framing.

### 5. Rank with a separate utility

Use calibrated satisfaction as the leading term, not the entire ranking:

```text
utility(m) =
    logit(p_cal(m))
  + alpha * quality_prior(m)
  + beta  * novelty(m)
  + gamma * uncertainty_bonus(m)
  - delta * exposure_fatigue(m)
  - hard/soft context penalties(m)
```

Then select a slate greedily with constrained maximal marginal relevance:

```text
next = argmax_m [utility(m)
                 - lambda * max_similarity(m, already_selected)]
```

Hard constraints (parental ceiling, explicit dislike, already watched/saved,
availability) remain filters. Soft constraints cover repeated franchise, genre,
era, or nearly identical artwork. Give exploration a small capped bonus and log
its propensity; never inflate the displayed Match because Aurora explored.
Classic [maximal marginal relevance](https://dl.acm.org/doi/10.1145/290941.291025)
provides the useful relevance/diversity separation, while modern systems can
replace the greedy policy later without changing the Match contract.

The LLM is best used as a bounded semantic feature/reranker and explanation
writer—not the probability source. Its score should be normalized by model
version, validated for coverage, blended as one feature, and excluded entirely
when unavailable. That keeps results reproducible and avoids presenting an
uncalibrated 0–100 language-model judgment as statistical confidence.

## Ranking behavior for Aurora's audience

The design optimizes for a household media server rather than engagement at any
cost:

- **Satisfaction over watch time:** do not reward longer content merely because
  it creates more minutes.
- **Profile isolation:** never use one household member's private behavior as
  another profile's personal evidence unless an explicit group feature requests
  it.
- **Children's profiles:** retain the hard rating ceiling; do not explore across
  it. Use the separate child-safe prior/calibrator hierarchy above, and keep
  training/evaluation segmented so adult behavior cannot distort a child's
  calibration.
- **Explainable control:** show the strongest positive and negative feature
  families (“Because you enjoyed…”, “matches your mystery preference”), and let
  thumbs/stars have immediate, inspectable effects.
- **Local-first privacy:** raw impression and outcome rows remain on the server;
  telemetry export is opt-in and aggregated.
- **Catalog-aware:** a small library should return fewer strong recommendations
  rather than manufacture high percentages from a weak candidate pool.

## Evaluation and acceptance criteria

### Offline, time-forward replay

The observable launch estimand is explicitly:

> `P(satisfying outcome | title received a meaningful start, recorded context)`.

It is **not** a causal claim about how every unstarted candidate would perform.
Starts are self-selected by title, artwork, surface, and position, so report
coverage and selection rates beside calibration. Compare current Match and v2 on
impressions whose outcomes occur later. Segment by profile history size,
movie/episode/show, language, maturity tier, and cold start.

Required gates before changing the UI label:

1. Brier score and log loss improve against the current cosine baseline and a
   global-popularity baseline.
2. In every populated 10-point bucket, empirical satisfaction is within ±10
   percentage points of the displayed Match; target ±5 with mature data.
3. NDCG@10 and Recall@20 do not regress materially (suggested guard: no worse
   than 2% relative), while dislike/early-abandon rate improves.
4. Intra-list diversity and catalog coverage do not regress.
5. The same `(profile, title, model version, evidence snapshot)` yields the same
   Match regardless of candidate-pool composition or presentation position.
6. Negative feedback lowers scores of semantically/structurally close titles,
   not only the exact rejected title.
7. Sparse profiles shrink toward honest priors and never receive artificial
   90%+ values solely because they were the best of a poor pool.

### Online interleaving or A/B test

Prefer team-draft interleaving for rank quality when traffic is small, plus a
separate shadow calibration log. To expand beyond the started-title estimand,
reserve a small, bounded eligible slot for randomized exploration, log its exact
selection propensity, and use inverse-propensity-weighted or doubly robust
evaluation. Never relax parental or explicit-negative filters. This follows the
exposure-bias framing in [Recommendations as treatments](https://proceedings.mlr.press/v48/schnabel16.html).
Primary measures should be explicit positive
rate, completion-adjusted satisfaction, early abandonment, recommendation
hides/dislikes, and recommendation-to-play latency. Add guardrails for content
concentration, repeat exposure, latency, and LLM failure fallback.

## Implementation sequence

Current implementation status:

- **Landed:** absolute cosine mapping, evidence shrinkage, model-version and
  confidence metadata, reproducible raw similarity/evidence snapshots, startup
  plus daily 90-day slate/impression retention, profile/media deletion cascades,
  real hero visibility measurement, series-aware outcome attribution with the
  approved beta labels, and pool-invariance/unit/integration coverage.
- **Landed (review follow-up, `bootstrap-2`):** uncapped distinct-title
  evidence (above); the displayed similarity is the item's cosine to the
  profile's CLOSEST taste mode rather than whichever centroid's recall list won
  the interleave dedupe, closing a rebuild-to-rebuild wobble that gate 5 below
  otherwise failed; and the report's metrics cohort is now the exposures that
  actually displayed a Match, with the cold-start remainder counted and
  disclosed instead of scored as a 0% prediction.
- **Next:** source-aware weighted
  taste modes/negative-neighborhood features, fitted manifest development, and
  shadow comparison. The local-only beta targets 11–50 testers over six months;
  introduce 6.5% propensity-logged exploration only after exposure/outcome
  integrity passes, never across parental or explicit-negative constraints.

Known residual on gate 5: an item is only scored against the centroids whose
recall pool actually returned it, so on a large library a distant taste mode can
be truncated away before it is compared. Pool composition no longer moves the
value; recall depth still can.

1. **Instrumentation first:** add versioned impression/slate logging and join it
   to later starts, completion, rating, and feedback. Record censored outcomes;
   do not turn absence into a negative label. Treat rows as sensitive profile
   history: retain raw impressions for a bounded default period (recommended 90
   days), aggregate only what the fitted model needs, cascade-delete them with
   the profile, include them in profile export, and expose an admin retention
   control.
2. **Deterministic feature service:** compute decayed source-aware positive
   modes, negative anchors, explicit affinities, quality priors, fatigue, and
   evidence support. Snapshot the feature/model version with each impression.
3. **Coefficient-development gate:** inventory feature availability/completeness,
   produce the first versioned manifest from consented development data, publish
   its cohort/cardinality and temporal validation report, and define rollback.
4. **Match v2 in shadow mode:** return no UI changes; compare calibration and
   ordering with current production decisions for several weeks of real local
   use.
5. **Calibrator and uncertainty:** implement the fallback hierarchy, temporal
   validation, reliability report, and conservative sparse-evidence copy.
6. **Separate ranking utility:** blend `p_cal`, Aurora quality, novelty,
   exploration, and fatigue; finish with constrained MMR. Keep exclusions and
   maturity controls unchanged.
7. **UI/API cutover:** expose `match_probability`, `match_confidence`,
   `match_model_version`, and reason codes. During migration, keep the existing
   `match` field but populate it from calibrated probability only.
8. **Optional learned ranker:** after sufficient local data, benchmark a
   LambdaMART/LightGBM ranker against the deterministic model. Ship only when it
   clears quality, latency, explainability, and rollback gates.

## Non-goals and cautions

- No formula can be called “state of the art” merely because it has more terms.
  State of the art here is the system discipline: bias-aware logging,
  propensity-aware experiments, multi-stage retrieval/ranking, calibrated
  outcomes, uncertainty, constrained slate
  optimization, temporal evaluation, and continuous monitoring.
- Do not train on recommendations produced by the current ranker without
  impression/position context; that bakes its exposure bias into v2.
- Do not merge Aurora Score and Match into one number. One is title quality in
  this server; the other is a personal satisfaction probability.
- Do not let an LLM emit the user-facing probability directly.
- Do not claim that 80% means “80% chance” until the reliability gate passes.
