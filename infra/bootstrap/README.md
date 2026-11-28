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

## Animation feature policy changes (manual, pending approval)

> **Status: perubahan bootstrap manual, menunggu persetujuan pengguna, selesai sebelum PR infra di-merge.**
>
> The policy files below are edited in the repository only. Nothing has been applied to the account. An admin reviews the diff and runs `./infra/bootstrap/bootstrap.sh` by hand. The infra PR for the animation feature must not be merged until this step is done, because CI `terraform apply` runs as `lore-gh-apply` and needs these permissions. Agents and CI never run this script.

What changes, all scoped to one bucket, one ECR repository, one Lambda function and one log group:

| File | Change |
|---|---|
| `policies/lore-gh-apply-policy.json` | Adds `AnimationBucket` (`lore-prod-animations-<ACCOUNT_ID>`), `AnimationEcr` and `AnimationLambda` (`lore-prod-animation-verifier`), `AnimationLogGroup` (`/aws/lambda/lore-prod-animation-verifier`), `AnimationLogsDescribe`, and `PassRoleToLambda` (`role/lore-prod-animation-*`, only when `iam:PassedToService` is `lambda.amazonaws.com`). `PassRoleToEc2` is unchanged. `AnimationEcr` holds `ecr:SetRepositoryPolicy`, `ecr:GetRepositoryPolicy`, `ecr:BatchGetImage` and `ecr:GetDownloadUrlForLayer` (see "Review follow-ups" below), all on the one verifier repository. |
| `policies/lore-guardrail-deny.json` | Removes `logs:CreateLogGroup` from `DenyExpensiveServices` and adds `DenyLogGroupsOtherThanVerifier`, which denies `logs:CreateLogGroup` for every log group except the verifier's `/aws/lambda/lore-prod-animation-verifier`. Its `NotResource` lists both ARN forms of that group: with and without the trailing `:*`. |
| `policies/lore-gh-deploy-policy.json` | Adds `EcrAuthToken` (the only new statement with `Resource: "*"`), `EcrPushVerifier`, and `LambdaVerifierRelease`. The existing `SsmReleaseImageTag` already covers `/lore/prod/verifier/release/image_tag`. |

Size check: each file stays within the 6144 non-whitespace character limit for IAM policies, so no second managed policy and no change to `bootstrap.sh` is needed. `lore-gh-apply-policy.json` is the closest at 5529 characters; one more statement of any size means moving the animation statements to a second managed policy attached to the same role.

### Review follow-ups (two findings, both still unapplied)

1. **`AnimationEcr` needed three more actions.** The Lambda documentation ([Amazon ECR permissions](https://docs.aws.amazon.com/lambda/latest/dg/images-create.html)) says the principal that creates a function from a container image needs `ecr:SetRepositoryPolicy`, `ecr:GetRepositoryPolicy`, `ecr:BatchGetImage` and `ecr:GetDownloadUrlForLayer` on the repository. The statement only had `ecr:GetRepositoryPolicy`, so the second infra PR (the one that creates `aws_lambda_function.animation_verifier`) would likely have failed with an ECR access error. When the repository has no policy for Lambda, Lambda adds one itself, and that needs the Get and Set pair. The `Resource` is still the single verifier repository, with no `*`.
2. **`DenyLogGroupsOtherThanVerifier` listed one ARN form.** It exempted only `...:log-group:/aws/lambda/lore-prod-animation-verifier:*`. It is not certain whether IAM evaluates `logs:CreateLogGroup` against the log group ARN with or without the `:*` suffix. If it uses the form without it, the Deny would match the verifier's own log group and block Terraform from creating it. `NotResource` now lists both forms and nothing else, so the deny still applies to every other log group. There is still exactly one Deny statement for `logs:CreateLogGroup`, and `DenyExpensiveServices` still holds no `logs:` action.

The static tests in `scripts/ci/test-checkers.py` (`BootstrapPolicyTest`) pin both changes. They cannot show how IAM evaluates the ARN, so the two simulations below stay mandatory.

### Idempotency

`bootstrap.sh` compares each rendered policy with the one in the account and only writes on a difference.

- First run after this change reports `[updated] IAM managed policy version updated: lore-guardrail-deny`, `[updated] Inline policy applied: lore-gh-apply-inline` and `[updated] Inline policy applied: lore-gh-deploy-inline`.
- A second run changes nothing and reports `[ok] IAM managed policy unchanged: lore-guardrail-deny`, `[ok] Inline policy unchanged: lore-gh-apply-inline` and `[ok] Inline policy unchanged: lore-gh-deploy-inline`. Any `[updated]` or `[created]` line on the second run is a problem to investigate before merging.

### Read-only verification (admin only, required before merge)

Run both checks after the bootstrap run, with the admin profile. They only simulate policy evaluation and change nothing. Agents and CI do not run them. Replace `<ACCOUNT_ID>` and `<AWS_REGION>` with your values.

1. The verifier log group must be `allowed`:

```bash
aws iam simulate-principal-policy \
  --policy-source-arn arn:aws:iam::<ACCOUNT_ID>:role/lore-gh-apply \
  --action-names logs:CreateLogGroup \
  --resource-arns "arn:aws:logs:<AWS_REGION>:<ACCOUNT_ID>:log-group:/aws/lambda/lore-prod-animation-verifier:*" \
  --query 'EvaluationResults[].{Action:EvalActionName,Resource:EvalResourceName,Decision:EvalDecision}'
```

2. Any other log group must be `explicitDeny`:

```bash
aws iam simulate-principal-policy \
  --policy-source-arn arn:aws:iam::<ACCOUNT_ID>:role/lore-gh-apply \
  --action-names logs:CreateLogGroup \
  --resource-arns "arn:aws:logs:<AWS_REGION>:<ACCOUNT_ID>:log-group:/aws/lambda/other:*" \
  --query 'EvaluationResults[].{Action:EvalActionName,Resource:EvalResourceName,Decision:EvalDecision}'
```

Record both decisions in the infra PR description. Expected: `allowed` for the verifier log group and `explicitDeny` for any other log group. If the first returns anything other than `allowed`, or the second anything other than `explicitDeny`, do not merge the PR. The `NotResource` fix above makes the first result more likely but does not replace this check.

## After Bootstrap (GitHub Setup)

1. Run the `gh variable set` commands printed at the end of the script (`AWS_REGION`, `AWS_ROLE_PLAN_ARN`, `AWS_ROLE_APPLY_ARN`, `AWS_ROLE_DEPLOY_ARN`).
2. Create GitHub Environments in **Settings -> Environments**:
   - `production`: deployment branch `main`, required reviewers enabled
   - `production-release`: deployment branch `main`, no required reviewers
3. Trigger the `whoami` workflow (`workflow_dispatch`) to verify OIDC role assumption.
