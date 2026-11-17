# Bootstrap (`infra/bootstrap`)

One-time, idempotent setup for resources that the CI/CD pipeline must not manage itself:

- S3 Terraform state bucket (`lore-tfstate-<ACCOUNT_ID>`) with versioning, encryption, public access block, and 90-day noncurrent expiration
- GitHub OIDC provider (`token.actions.githubusercontent.com`) and STS `v2Token` preference
- IAM guardrail policies (`lore-guardrail-deny`, `lore-deny-new-spend`) and OIDC roles (`lore-gh-plan`, `lore-gh-apply`, `lore-gh-deploy`, `lore-budgets-action`)
- AWS Budgets (`lore-prod-monthly`, `lore-prod-guardrail`) and Cost Anomaly Detection subscription (`lore-anomaly-alert`)

## Prerequisites

- `aws` CLI configured with an IAM Admin user/profile (preferably MFA-enabled)
- `jq` installed
- `gh` CLI (optional, to set GitHub repository variables afterward)

## Configuration

Copy `.env.example` to `.env` (already gitignored by `.gitignore`) and set `ALERT_EMAIL`:

```bash
cp infra/bootstrap/.env.example infra/bootstrap/.env
```

| Variable | Required | Default | Description |
|---|---|---|---|
| `ALERT_EMAIL` | Yes | - | Email for AWS Budgets and Cost Anomaly Detection alerts |
| `AWS_PROFILE` | No | active CLI default | AWS CLI profile used to run bootstrap |
| `AWS_REGION` | No | `ap-southeast-3` | Target AWS region |
| `GITHUB_REPO` | No | `Nnaory/lore` | Exact `owner/repo` string for tags and GitHub API lookup |
| `GITHUB_OIDC_REPO` | No | auto-resolved | Immutable OIDC subject prefix (`owner@id/repo@id`) used in role trust policies |
| `BUDGET_USD` | No | `70` | Monthly USD cost budget threshold (`IncludeCredit: false`) |
| `ALLOW_NAT_GATEWAY` | No | `false` | Set `true` only if relaxing the `ec2:CreateNatGateway` deny guardrail |

Environment variables passed directly on the command line override values in `.env`.

## Run

```bash
./infra/bootstrap/bootstrap.sh
```

Running the script again is safe and reports `[ok]` for unchanged resources.

## After Bootstrap (GitHub Setup)

1. Run the `gh variable set` commands printed at the end of the script (`AWS_REGION`, `AWS_ROLE_PLAN_ARN`, `AWS_ROLE_APPLY_ARN`, `AWS_ROLE_DEPLOY_ARN`).
2. Create GitHub Environments in **Settings -> Environments**:
   - `production`: deployment branch `main`, required reviewers enabled
   - `production-release`: deployment branch `main`, no required reviewers
3. Trigger the `whoami` workflow (`workflow_dispatch`) to verify OIDC role assumption.
