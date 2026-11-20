---
name: infra-change
description: Change LORE's AWS infrastructure (infra/*.tf, deploy/, scripts/ci/) safely, with the cost and tag guardrails kept in sync. Use when asked to add or modify a Terraform resource, change instance size, storage, IOPS or backup settings, or touch the CI checkers. CI applies Terraform on merge to main, so everything goes through a PR.
---

# Change infrastructure with the guardrails

CI (`infra.yml`) runs `terraform apply` automatically when a change reaches `main`. Never run apply or destroy locally. The plan job blocks deletion of `aws_db_instance`, `aws_eip` and `aws_s3_bucket` unless a `workflow_dispatch` run sets `allow_destroy`.

## 1. Decide the cost impact first
The project is on a free plan. Read `docs/infra/07-cost-guardrails.md`. Flag any increase in instance size, IOPS, storage or backup retention to the user before editing.

## 2. Edit Terraform
Edit `infra/*.tf`. Do not copy account IDs or the tfstate bucket name from `infra/backend.tf` into docs or code.

## 3. Keep the guardrails in sync
- New or changed resource types: update the allowlist or denylist in `scripts/ci/policy_rules.py`.
- Cost rules live in `scripts/ci/check-cost`; static rules in `scripts/ci/check-cost-static`; tag rules in `scripts/ci/check-tags`.
- Add or adjust a fixture in `scripts/ci/fixtures/` (`valid-plan.json`, `bad-cost-plan.json`, `bad-tags-plan.json`) and a test in `scripts/ci/test-checkers.py` so the new rule is proven to pass and to fail.

## 4. Verify locally (read-only, no credentials needed)
```
terraform -chdir=infra fmt -check -recursive
terraform -chdir=infra init -backend=false
terraform -chdir=infra validate
python3 -B scripts/ci/check-cost-static infra
python3 -B scripts/ci/test-checkers.py -v
shellcheck infra/bootstrap/bootstrap.sh scripts/verify/*.sh deploy/common/*.sh scripts/ci/*.sh
```
These are the same checks as the `terraform` job in `.github/workflows/ci.yml`.

## 5. Docs and PR
Update the matching file in `docs/infra/` (runbook, cost guardrails, roadmap status). Open a PR; required checks are `ci/web`, `ci/api`, `ci/docker`, `ci/terraform`. Changes to `deploy/**` can replace an instance (downtime, certificate re-issue), so call that out in the PR description.

Bash scripts use `set -euo pipefail` and a `fail()` helper; Python CI scripts use `def main() -> int` and `raise SystemExit(main())`.
