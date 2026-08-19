# Required checks — no merge on red tests

`main` must never take a merge whose tests are not green. That is enforced in
two places, because either one alone leaves a hole:

1. **A branch ruleset on GitHub** — blocks the merge button (and the API) for
   everyone. This lives in repository settings, not in the repo, so it has to
   be applied once by an admin. See below.
2. **The CI workflows themselves** — the aggregate check that the ruleset
   requires, and the auto-merge automation, both fail closed.

## 1. The aggregate check

`.github/workflows/tests.yml` ends with a job named **`All tests green`**. It
`needs:` every gating job (Rust tests, API tests, E2E unit) and runs with
`if: always()`, so it reports even when a dependency failed, was skipped, or the
run was cancelled — anything other than `success` on any dependency fails it.

Requiring that one check, rather than each job by name, means adding or renaming
a test job is a change to `needs:` in `tests.yml` only; the ruleset never has to
be edited (and can never silently stop covering a job it does not know about).

`E2E (mesh, non-blocking)` is deliberately *not* one of its dependencies: the
multi-peer WebRTC suite runs against real loopback ICE and is timing-sensitive,
so it stays advisory (`continue-on-error: true`).

## 2. Applying the ruleset

The ruleset is checked in at
[`.github/rulesets/main-required-tests.json`](../.github/rulesets/main-required-tests.json)
so it is reviewable and restorable, but GitHub does **not** read it from the
repository. Apply it once:

> Repository **Settings → Rules → Rulesets → New ruleset → Import a ruleset**,
> then upload `.github/rulesets/main-required-tests.json` and **Create**.

It sets, on the default branch:

| Rule | Effect |
|---|---|
| Require a pull request before merging | No direct pushes to `main` |
| Require status checks to pass | `All tests green` must be green to merge |
| Require branches to be up to date | The check must have run against current `main` |
| Block force pushes / deletion | `main` history cannot be rewritten or removed |

`bypass_actors` is empty on purpose — an admin bypass is exactly the hole this
is meant to close. Approvals are left at `0` so the rule adds a *test* gate
without also changing the project's review policy; raise
`required_approving_review_count` if that is wanted too.

If the ruleset is edited in the UI afterwards, export it from the same screen
and update the checked-in JSON so the two do not drift.

### Verifying it works

Open a throwaway PR that breaks a test on purpose. The merge button must be
disabled with "Required status check *All tests green* is expected" or
"failing". If it is still clickable, the ruleset was not applied (or something
is listed in `bypass_actors`).

## 3. Auto-merge automation

`.github/workflows/dependabot-automerge.yml` merges minor/patch Dependabot PRs.
It used to merge on the `Tests` workflow reporting success, which said nothing
about CodeQL or about any check that had not finished yet. It now re-reads the
complete check state of the head SHA before merging, and refuses if:

- any check run on that SHA failed (other than the non-blocking mesh job),
- any check run on that SHA is still in progress,
- the `All tests green` check is missing or not successful, or
- a commit status on that SHA is not `success`.

It also passes the head SHA to the merge call, so a commit that lands between
the check and the merge aborts it. Because the last CI workflow to finish is
what makes a SHA fully green, the workflow triggers on both `Tests` and
`CodeQL` completing; the firings where things are still pending simply log and
exit.
