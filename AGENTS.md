# Aurora agent instructions

Read `CLAUDE.md` and `docs/dev-workflow.md` before making code changes. Their
build, test, branching, safety, and subsystem invariants apply to every agent.

## Mandatory independent adversarial review

Every fix, feature, refactor, or other behavior-changing code change must receive
an independent agent review before it is described as complete or ready to
merge. A self-review by the implementing agent does **not** satisfy this gate.

- Dispatch a separate reviewer with fresh context after implementation and
  verification. Give it the issue/acceptance criteria and the complete current
  diff, but do not prime it with the implementer's conclusions.
- The reviewer is read-only: it must inspect surrounding code and tests, trace
  affected data flows, and look adversarially for correctness bugs, regressions,
  races, contract mismatches, stale state, lifecycle failures, missing tests,
  and scope creep.
- Findings must be ordered by severity and cite exact file/line locations. The
  reviewer must also state explicitly when it finds no actionable defects and
  list any residual risks or verification gaps.
- Resolve every high/critical finding before handoff. After substantive
  review-driven changes, run an independent check of the final diff again; an
  earlier clean verdict does not cover later code.
- In the final handoff, report the independent review verdict separately from
  tests/builds. If an independent agent is unavailable, say that the gate is
  incomplete rather than presenting a self-review as equivalent.

## Recording the verdict

Record the verdict. A client-side `pre-push` hook checks it, and the
`review-record` CI job reports it on the PR. Neither binds: the job and the
script it runs are tracked files in this branch, so editing them is a one-line
bypass. Read CLAUDE.md's known-limits list before describing this gate as
enforcement. Both key on the **head commit**, whose diff against
the base is what the reviewer actually read:

```bash
bash scripts/record-review.sh clean --reviewer <id> --findings <n> "<summary>"
```

Verdicts: `clean` / `lows-only` open the gate, `fix-first` keeps it closed,
`bypass` opens it while recording that NO review happened — use that only when
no independent reviewer is available, and say so in the handoff. Records are
keyed to the exact commit, so amending or adding one invalidates them; record
after the final commit, then commit the record itself (record-only commits are
exempt, and records are tracked so CI can read them).

Read CLAUDE.md's "Adversarial review gate" section before relying on any of
this: the client-side hooks are advisory and one `git config` from off, and
the CI job blocks nothing until a human makes it a required status check.
