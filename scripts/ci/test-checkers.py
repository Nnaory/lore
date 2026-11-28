#!/usr/bin/env python3
"""Tests for CI tag and cost guardrail checkers, the animation guardrails, the animation contract
sync script and the animation version parity check.

Why: the checkers gate infra changes in CI, the sync script keeps the three copies of
animation-contract.json identical, and the parity check keeps react, react-dom, remotion and
@remotion/player at one version in the verifier and the frontend. Each test runs the real script
as a subprocess; the sync and parity tests copy the script into a temporary repo layout so they
never touch the real contract copies or package files. AnimationCheckersTest proves each
animation cost and tag rule (design 8.3) against the animation-*.json plan fixtures and against
small .tf files written to a temporary directory.

The static tests of task 31.3 read the real files and never touch AWS or Terraform state:
BootstrapPolicyTest checks the three changed bootstrap IAM policies (Requirement 35.2, 35.13,
35.14), AnimationTerraformStaticTest checks the variable validations, the ANIMATION_ENABLED
precondition and the metadata hop limit in infra/*.tf (Requirement 34.11, 34.20, 34.22, 36.12),
and RenderEnvTest runs deploy/common/render-env.sh with a fake `aws` first on PATH
(Requirement 34.17).

VerifierReleaseTest (task 33.1) runs scripts/ci/verifier-release.sh with a fake `aws` and a fake
`docker` first on PATH, so no credential, network or real image is involved (Requirement 37.5 to
37.8 and 37.11 to 37.14).

VerifierWorkflowTest (task 33.2) reads .github/workflows/release-verifier.yml as text and checks
its triggers and path filter, the `production-release` environment, the minimal permissions, the
concurrency group, the commit-SHA pins (equal to ci.yml and release-web.yml), and the call to
scripts/ci/verifier-release.sh. Each mutation of the file in the test must be reported, so the
checks cannot go blind (Requirement 37.4, 37.5, 37.8, 37.9, 37.13).

WebReleaseWorkflowTest (task 33.4) reads .github/workflows/release-web.yml and frontend/Dockerfile
as text and checks the NEXT_PUBLIC_ANIMATIONS build argument, the two added path filters, and the
`ARG ...=off` plus `ENV ...=${...}` pair (Requirement 36.1, 36.2, 36.13, 36.14).

CiWorkflowTest (task 33.3) reads .github/workflows/ci.yml as text and checks the `verifier` and
`contracts` jobs (steps, order, image build settings, RIE step after Vitest in the same job), that
the four old jobs keep their signature commands, and that every `uses:` is pinned to one commit
SHA per action (Requirement 37.1, 37.2, 37.3, 37.9, 3.6, 2.5, 38.8).

CostEstimateLineTest and CostEstimateDocumentTest (task 35.5) guard the line
`Total tambahan AWS per bulan: US$<angka>` in docs/infra/07-cost-guardrails.md (Requirement 41.10,
41.11, 41.5). The first class tests the pure function cost_line_problems against made-up text. The
second runs that function on the real document and is DELIBERATELY RED while the total is US$5 or
more and the user has not written `Persetujuan pengguna: <tanggal>` right under it; only the user
may write that line, so this script exits non-zero until then.
"""

from __future__ import annotations

import datetime
import fnmatch
import json
import os
import re
import shlex
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

CI_DIR = Path(__file__).resolve().parent
# This file has a hyphen in its name, so it is run as a script; make policy_rules importable
# the same way the checker scripts do (their own directory is first on sys.path).
sys.path.insert(0, str(CI_DIR))
import policy_rules  # noqa: E402

REPO_ROOT = CI_DIR.parent.parent
# The smoke script's tests live next to the script (scripts/verify); importing them here makes
# `python3 -B scripts/ci/test-checkers.py -v`, the one command CI runs, execute them too.
sys.path.insert(0, str(REPO_ROOT / "scripts" / "verify"))
from test_animation_smoke import SmokeScriptStaticTest, SmokeScriptTest  # noqa: E402,F401

FIXTURES_DIR = CI_DIR / "fixtures"
SYNC_SCRIPT = REPO_ROOT / "scripts" / "sync-animation-contract.py"
SYNC_SOURCE = Path("animation-verifier/contract/animation-contract.json")
SYNC_COPIES = (
    Path("backend/app/ai/animation/animation-contract.json"),
    Path("frontend/src/lib/animation/animation-contract.json"),
)
VERSIONS_SCRIPT = CI_DIR / "check-animation-versions.py"
VERIFIER_MANIFEST = "animation-verifier/package.json"
FRONTEND_MANIFEST = "frontend/package.json"
VERIFIER_LOCK = "animation-verifier/package-lock.json"
FRONTEND_LOCK = "frontend/package-lock.json"
# Order matters: it is the order of the <file>=<version> pairs the script prints.
VERSION_SOURCES = (VERIFIER_MANIFEST, FRONTEND_MANIFEST, VERIFIER_LOCK, FRONTEND_LOCK)
VERSION_PINS = {
    "react": "19.3.0",
    "react-dom": "19.3.0",
    "remotion": "4.0.543",
    "@remotion/player": "4.0.543",
}

# Static checks of task 31.3 (policies, Terraform, render-env.sh).
INFRA_DIR = REPO_ROOT / "infra"
POLICIES_DIR = INFRA_DIR / "bootstrap" / "policies"
APPLY_POLICY = POLICIES_DIR / "lore-gh-apply-policy.json"
DEPLOY_POLICY = POLICIES_DIR / "lore-gh-deploy-policy.json"
GUARDRAIL_POLICY = POLICIES_DIR / "lore-guardrail-deny.json"
CHANGED_POLICIES = (APPLY_POLICY, DEPLOY_POLICY, GUARDRAIL_POLICY)
POLICY_MAX_CHARS = 6144  # size limit of one IAM managed policy, counted without white space
RENDER_ENV_SCRIPT = REPO_ROOT / "deploy" / "common" / "render-env.sh"
VERIFIER = "lore-prod-animation-verifier"
LOG_GROUP_ARN = f"arn:aws:logs:<AWS_REGION>:<ACCOUNT_ID>:log-group:/aws/lambda/{VERIFIER}"
REPOSITORY_ARN = f"arn:aws:ecr:<AWS_REGION>:<ACCOUNT_ID>:repository/{VERIFIER}"
FUNCTION_ARN = f"arn:aws:lambda:<AWS_REGION>:<ACCOUNT_ID>:function:{VERIFIER}"
BUCKET_ARN = "arn:aws:s3:::lore-prod-animations-<ACCOUNT_ID>"
# What the principal that creates a Lambda function from a container image needs on the repository
# (Lambda docs, images-create, "Amazon ECR permissions"). AnimationEcr must grant all four.
LAMBDA_IMAGE_ECR_ACTIONS = (
    "ecr:SetRepositoryPolicy",
    "ecr:GetRepositoryPolicy",
    "ecr:BatchGetImage",
    "ecr:GetDownloadUrlForLayer",
)
# The statement that exists today and must not change when the Lambda statement is added.
PASS_ROLE_TO_EC2 = {
    "Sid": "PassRoleToEc2",
    "Effect": "Allow",
    "Action": "iam:PassRole",
    "Resource": "arn:aws:iam::<ACCOUNT_ID>:role/lore-prod-*",
    "Condition": {"StringEquals": {"iam:PassedToService": "ec2.amazonaws.com"}},
}
PASS_ROLE_TO_LAMBDA = {
    "Sid": "PassRoleToLambda",
    "Effect": "Allow",
    "Action": "iam:PassRole",
    "Resource": "arn:aws:iam::<ACCOUNT_ID>:role/lore-prod-animation-*",
    "Condition": {"StringEquals": {"iam:PassedToService": "lambda.amazonaws.com"}},
}
# The ten /lore/prod/api/env/ settings of Requirement 34.12 and 34.18. The first six have a
# literal value in animation.tf; the next three are Terraform expressions; ANIMATION_ENABLED is
# its own resource (it needs a precondition) and takes the variable default.
ANIMATION_ENV_LITERALS = {
    "ANIMATION_RATE_PER_MINUTE_IP": "4",
    "ANIMATION_DAILY_PER_IP": "30",
    "ANIMATION_MAX_CONCURRENT_PER_IP": "1",
    "ANIMATION_MAX_CONCURRENT_GLOBAL": "2",
    "ANIMATION_MAX_ATTEMPTS": "4",
    "ANIMATION_DEADLINE_MS": "240000",
}
ANIMATION_ENV_EXPRESSIONS = {
    "ANIMATION_BUCKET": "local.animation_bucket",
    "ANIMATION_VERIFIER_FUNCTION": "local.animation_function_name",
    "AWS_REGION": "var.region",
}
ANIMATION_ENABLED_NAME = "ANIMATION_ENABLED"
ANIMATION_ENV_NAMES = sorted(
    [ANIMATION_ENABLED_NAME, *ANIMATION_ENV_LITERALS, *ANIMATION_ENV_EXPRESSIONS]
)
# What those expressions evaluate to in a rendered .env file. No real account id appears here.
ANIMATION_ENV_RENDERED = {
    "local.animation_bucket": "lore-prod-animations-ACCOUNT-ID",
    "local.animation_function_name": VERIFIER,
    "var.region": "ap-southeast-3",
}


class CheckerScriptsTest(unittest.TestCase):
    """Verify check-tags, check-cost, and check-cost-static against fixtures."""

    def _run(self, script: str, arg: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [str(CI_DIR / script), arg],
            capture_output=True,
            text=True,
            check=False,
        )

    def test_valid_plan_passes_tags_and_cost(self) -> None:
        plan = str(FIXTURES_DIR / "valid-plan.json")
        self.assertEqual(self._run("check-tags", plan).returncode, 0)
        self.assertEqual(self._run("check-cost", plan).returncode, 0)

    def test_bad_tags_plan_fails(self) -> None:
        res = self._run("check-tags", str(FIXTURES_DIR / "bad-tags-plan.json"))
        self.assertNotEqual(res.returncode, 0)
        self.assertIn("missing required tag Name", res.stderr)
        self.assertIn("Project tag must be 'lore'", res.stderr)
        self.assertIn("invalid Component tag 'unknown'", res.stderr)

    def test_bad_cost_plan_fails(self) -> None:
        res = self._run("check-cost", str(FIXTURES_DIR / "bad-cost-plan.json"))
        self.assertNotEqual(res.returncode, 0)
        self.assertIn("t3.small", res.stderr)
        self.assertIn("aws_nat_gateway", res.stderr)
        self.assertIn("db.t3.small", res.stderr)
        self.assertIn("Interface VPC endpoints", res.stderr)

    def test_rds_gp3_baseline_and_excess_iops(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            ok_plan = Path(tmp) / "ok.json"
            ok_plan.write_text(
                '{"resource_changes":[{"address":"aws_db_instance.db","type":"aws_db_instance",'
                '"change":{"actions":["update"],"after":{"instance_class":"db.t3.micro",'
                '"multi_az":false,"allocated_storage":20,"storage_type":"gp3","iops":3000}}}]}',
                encoding="utf-8",
            )
            self.assertEqual(self._run("check-cost", str(ok_plan)).returncode, 0)

            bad_plan = Path(tmp) / "bad.json"
            bad_plan.write_text(
                '{"resource_changes":[{"address":"aws_db_instance.hi","type":"aws_db_instance",'
                '"change":{"actions":["create"],"after":{"instance_class":"db.t3.micro",'
                '"multi_az":false,"allocated_storage":20,"storage_type":"gp3","iops":4000}}},'
                '{"address":"aws_db_instance.io","type":"aws_db_instance",'
                '"change":{"actions":["create"],"after":{"instance_class":"db.t3.micro",'
                '"multi_az":false,"allocated_storage":20,"storage_type":"io1","iops":1000}}}]}',
                encoding="utf-8",
            )
            res = self._run("check-cost", str(bad_plan))
            self.assertNotEqual(res.returncode, 0)
            self.assertIn("provisioned iops (4000) is disallowed", res.stderr)
            self.assertIn("storage_type 'io1' is disallowed", res.stderr)

    def test_ssm_secure_string_standard_passes_and_advanced_fails(self) -> None:
        def plan(tier: str) -> str:
            return (
                '{"resource_changes":[{"address":"aws_ssm_parameter.api_google_api_key",'
                '"type":"aws_ssm_parameter","change":{"actions":["create"],'
                f'"after":{{"type":"SecureString","tier":"{tier}"}}}}}}]}}'
            )

        with tempfile.TemporaryDirectory() as tmp:
            ok_plan = Path(tmp) / "ok.json"
            ok_plan.write_text(plan("Standard"), encoding="utf-8")
            self.assertEqual(self._run("check-cost", str(ok_plan)).returncode, 0)

            bad_plan = Path(tmp) / "bad.json"
            bad_plan.write_text(plan("Advanced"), encoding="utf-8")
            res = self._run("check-cost", str(bad_plan))
            self.assertNotEqual(res.returncode, 0)
            self.assertIn("SSM Parameter tier 'Advanced' is disallowed", res.stderr)

    def test_static_scan_passes_repo_infra(self) -> None:
        res = self._run("check-cost-static", str(REPO_ROOT / "infra"))
        self.assertEqual(res.returncode, 0, msg=res.stderr)

    def test_static_scan_rejects_denylist_and_ignores_comments(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            tf = Path(tmp) / "bad.tf"
            tf.write_text(
                '# resource "aws_nat_gateway" "commented_out" {}\n'
                'resource "aws_lb" "forbidden" {}\n'
                'resource "aws_instance" "x" {\n'
                '  instance_type = "t3.medium"\n'
                "}\n",
                encoding="utf-8",
            )
            res = self._run("check-cost-static", tmp)
            self.assertNotEqual(res.returncode, 0)
            self.assertNotIn("aws_nat_gateway", res.stderr)
            self.assertIn("aws_lb.forbidden", res.stderr)
            self.assertIn("t3.medium", res.stderr)


class SyncContractTest(unittest.TestCase):
    """Verify sync-animation-contract.py in a temporary repo layout (Requirement 2.2-2.5, 2.14)."""

    SOURCE_BYTES = b'{"contract_version": 1}\n'
    STALE_BYTES = b'{"contract_version": 0}\n'

    def setUp(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        # The script resolves ROOT from its own location, so a copy under <tmp>/scripts/ makes
        # <tmp> the repo root for the run.
        self.script = self.root / "scripts" / SYNC_SCRIPT.name
        self.script.parent.mkdir()
        shutil.copy(SYNC_SCRIPT, self.script)
        self.source = self.root / SYNC_SOURCE
        self.copies = [self.root / rel for rel in SYNC_COPIES]

    def _write(self, path: Path, data: bytes) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)

    def _run(self, *args: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [sys.executable, "-B", str(self.script), *args],
            capture_output=True,
            text=True,
            check=False,
            cwd=self.root,
        )

    def _snapshot(self) -> dict[str, bytes | None]:
        """Every path under the temp repo mapped to its bytes (None for directories)."""
        return {
            str(p.relative_to(self.root)): p.read_bytes() if p.is_file() else None
            for p in sorted(self.root.rglob("*"))
        }

    def test_check_passes_when_copies_are_identical(self) -> None:
        self._write(self.source, self.SOURCE_BYTES)
        for copy in self.copies:
            self._write(copy, self.SOURCE_BYTES)
        res = self._run("--check")
        self.assertEqual(res.returncode, 0, msg=res.stderr)
        self.assertEqual(res.stdout, "")
        self.assertEqual(res.stderr, "")

    def test_check_reports_one_path_per_line_for_every_drifted_copy(self) -> None:
        self._write(self.source, self.SOURCE_BYTES)
        self._write(self.copies[0], self.STALE_BYTES)  # differs; the second copy is missing
        res = self._run("--check")
        self.assertEqual(res.returncode, 1)
        self.assertEqual(res.stdout, "")
        self.assertEqual(res.stderr.splitlines(), [str(rel) for rel in SYNC_COPIES])

    def test_check_reports_only_the_copy_that_drifted(self) -> None:
        self._write(self.source, self.SOURCE_BYTES)
        self._write(self.copies[0], self.SOURCE_BYTES)
        self._write(self.copies[1], self.STALE_BYTES)
        res = self._run("--check")
        self.assertEqual(res.returncode, 1)
        self.assertEqual(res.stderr.splitlines(), [str(SYNC_COPIES[1])])

    def test_check_detects_a_newline_only_difference(self) -> None:
        self._write(self.source, self.SOURCE_BYTES)
        self._write(self.copies[0], self.SOURCE_BYTES)
        self._write(self.copies[1], self.SOURCE_BYTES.replace(b"\n", b"\r\n"))
        res = self._run("--check")
        self.assertEqual(res.returncode, 1)
        self.assertEqual(res.stderr.splitlines(), [str(SYNC_COPIES[1])])

    def test_check_never_writes_files_or_directories(self) -> None:
        self._write(self.source, self.SOURCE_BYTES)
        self._write(self.copies[0], self.STALE_BYTES)  # stale; the frontend directory is absent
        before = self._snapshot()
        self.assertEqual(self._run("--check").returncode, 1)
        self.assertEqual(self._snapshot(), before)
        self.assertFalse(self.copies[1].parent.exists())

    def test_missing_source_exits_2_and_writes_nothing(self) -> None:
        before = self._snapshot()
        for args in (("--check",), ()):
            with self.subTest(args=args):
                res = self._run(*args)
                self.assertEqual(res.returncode, 2)
                self.assertEqual(res.stdout, "")
                self.assertIn("cannot read a valid JSON source", res.stderr)
                self.assertEqual(self._snapshot(), before)

    def test_source_that_is_not_json_exits_2_and_writes_nothing(self) -> None:
        for label, data in (
            ("syntax error", b'{"contract_version": '),
            ("not utf-8", b"\xff\xfe\x00"),
            ("empty", b""),
        ):
            self._write(self.source, data)
            before = self._snapshot()
            for args in (("--check",), ()):
                with self.subTest(source=label, args=args):
                    res = self._run(*args)
                    self.assertEqual(res.returncode, 2)
                    self.assertIn("cannot read a valid JSON source", res.stderr)
                    self.assertEqual(self._snapshot(), before)

    def test_unknown_arguments_exit_2_and_write_nothing(self) -> None:
        self._write(self.source, self.SOURCE_BYTES)
        before = self._snapshot()
        for args in (("--bogus",), ("check",), ("--check", "--check"), ("--check", "extra")):
            with self.subTest(args=args):
                res = self._run(*args)
                self.assertEqual(res.returncode, 2)
                self.assertIn("usage: sync-animation-contract.py [--check]", res.stderr)
                self.assertEqual(res.stdout, "")
                self.assertEqual(self._snapshot(), before)

    def test_write_mode_creates_directories_and_identical_copies(self) -> None:
        # CRLF, no trailing newline and non-ASCII bytes: any text-mode conversion would show.
        data = b'{"name": "kontrak \xc3\xa9",\r\n "n": 1}'
        self._write(self.source, data)
        self.assertFalse(self.copies[0].parent.exists())
        self.assertFalse(self.copies[1].parent.exists())
        res = self._run()
        self.assertEqual(res.returncode, 0, msg=res.stderr)
        self.assertEqual(res.stdout.splitlines(), [str(rel) for rel in SYNC_COPIES])
        self.assertEqual(res.stderr, "")
        for copy in self.copies:
            self.assertEqual(copy.read_bytes(), data)
        self.assertEqual(self.source.read_bytes(), data)
        self.assertEqual(self._run("--check").returncode, 0)

    def test_write_mode_overwrites_a_stale_copy_and_is_idempotent(self) -> None:
        self._write(self.source, self.SOURCE_BYTES)
        self._write(self.copies[0], self.STALE_BYTES)
        for _ in range(2):
            res = self._run()
            self.assertEqual(res.returncode, 0, msg=res.stderr)
            self.assertEqual(res.stdout.splitlines(), [str(rel) for rel in SYNC_COPIES])
            for copy in self.copies:
                self.assertEqual(copy.read_bytes(), self.SOURCE_BYTES)

    def test_exit_code_priority_is_2_then_1_then_0(self) -> None:
        # 0: source valid and both copies identical.
        self._write(self.source, self.SOURCE_BYTES)
        for copy in self.copies:
            self._write(copy, self.SOURCE_BYTES)
        self.assertEqual(self._run("--check").returncode, 0)

        # 1: source valid, one copy drifted.
        self._write(self.copies[1], self.STALE_BYTES)
        self.assertEqual(self._run("--check").returncode, 1)

        # 2 beats 1: the copy still drifts, but the source is no longer valid JSON.
        self._write(self.source, b"not json")
        res = self._run("--check")
        self.assertEqual(res.returncode, 2)
        self.assertNotIn(str(SYNC_COPIES[1]), res.stderr)

        # 2 beats 1: unknown argument while a copy drifts and the source is valid.
        self._write(self.source, self.SOURCE_BYTES)
        res = self._run("--bogus")
        self.assertEqual(res.returncode, 2)
        self.assertNotIn(str(SYNC_COPIES[1]), res.stderr)

        # 2 beats 1: source missing while a copy drifts.
        self.source.unlink()
        self.assertEqual(self._run("--check").returncode, 2)


class VersionParityTest(unittest.TestCase):
    """Verify check-animation-versions.py in a temp repo layout (Requirement 3.2-3.5, 3.9-3.11).

    setUp writes four files that agree; each test changes one thing and reads stderr, which holds
    one problem per line.
    """

    NEEDED = "needed for react, react-dom, remotion, @remotion/player"

    def setUp(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        # The script resolves its root from its own location (<root>/scripts/ci/<script>).
        self.script = self.root / "scripts" / "ci" / VERSIONS_SCRIPT.name
        self.script.parent.mkdir(parents=True)
        shutil.copy(VERSIONS_SCRIPT, self.script)
        self.docs: dict[str, dict] = {}
        self._reset()

    def _reset(self) -> None:
        """Rewrite all four files as a matching, exactly pinned layout."""
        for rel in (VERIFIER_MANIFEST, FRONTEND_MANIFEST):
            self.docs[rel] = {"name": "pkg", "dependencies": {"next": "16.4.5", **VERSION_PINS}}
        for rel in (VERIFIER_LOCK, FRONTEND_LOCK):
            packages: dict[str, dict] = {"": {"name": "pkg"}}
            packages.update({f"node_modules/{p}": {"version": v} for p, v in VERSION_PINS.items()})
            self.docs[rel] = {"name": "pkg", "lockfileVersion": 3, "packages": packages}
        self._flush()

    def _flush(self) -> None:
        for rel, doc in self.docs.items():
            self._write(rel, json.dumps(doc, indent=2).encode())

    def _write(self, rel: str, data: bytes) -> None:
        path = self.root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)

    def _set(self, rel: str, pkg: str, version: str) -> None:
        if rel.endswith("package-lock.json"):
            self.docs[rel]["packages"][f"node_modules/{pkg}"]["version"] = version
        else:
            self.docs[rel]["dependencies"][pkg] = version

    def _drop(self, rel: str, pkg: str) -> None:
        if rel.endswith("package-lock.json"):
            del self.docs[rel]["packages"][f"node_modules/{pkg}"]
        else:
            del self.docs[rel]["dependencies"][pkg]

    def _run(self, *args: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [sys.executable, "-B", str(self.script), *args],
            capture_output=True,
            text=True,
            check=False,
            cwd=self.root,
        )

    def _problems(self) -> list[str]:
        """Flush the documents, run the script, require exit 1 and return the stderr lines."""
        self._flush()
        res = self._run()
        self.assertEqual(res.returncode, 1, msg=res.stdout + res.stderr)
        self.assertEqual(res.stdout, "")
        self.assertNotIn("Traceback", res.stderr)
        return res.stderr.splitlines()

    def test_matching_versions_exit_0(self) -> None:
        res = self._run()
        self.assertEqual(res.returncode, 0, msg=res.stderr)
        self.assertEqual(res.stderr, "")
        self.assertIn("react=19.3.0", res.stdout)
        self.assertIn("@remotion/player=4.0.543", res.stdout)

    def test_dev_dependencies_are_read_like_dependencies(self) -> None:
        deps = self.docs[FRONTEND_MANIFEST]["dependencies"]
        self.docs[FRONTEND_MANIFEST]["devDependencies"] = {"react": deps.pop("react")}
        self._flush()
        res = self._run()
        self.assertEqual(res.returncode, 0, msg=res.stderr)

    def test_one_differing_version_prints_the_four_file_version_pairs(self) -> None:
        self._set(VERIFIER_LOCK, "react-dom", "19.2.0")
        self.assertEqual(
            self._problems(),
            [
                "react-dom: animation-verifier/package.json=19.3.0 frontend/package.json=19.3.0"
                " animation-verifier/package-lock.json=19.2.0 frontend/package-lock.json=19.3.0",
                # react and react-dom now also differ inside that one lockfile (3.11).
                "animation-verifier/package-lock.json: react=19.3.0 and react-dom=19.2.0"
                " must be the same version",
            ],
        )

    def test_each_source_is_reported_when_it_is_the_odd_one_out(self) -> None:
        for odd in VERSION_SOURCES:
            with self.subTest(source=odd):
                self._reset()
                # Both members of the pair move, so only the cross-source lines remain.
                self._set(odd, "react", "19.2.0")
                self._set(odd, "react-dom", "19.2.0")
                lines = self._problems()
                self.assertEqual(len(lines), 2, msg=lines)
                self.assertTrue(lines[0].startswith("react: "), msg=lines)
                self.assertTrue(lines[1].startswith("react-dom: "), msg=lines)
                for line in lines:
                    self.assertEqual(line.count("="), 4)
                    for rel in VERSION_SOURCES:
                        version = "19.2.0" if rel == odd else "19.3.0"
                        self.assertIn(f"{rel}={version}", line)

    def test_range_specifiers_and_non_exact_pins_are_rejected(self) -> None:
        for spec in ("^19.3.0", "~19.3.0", ">=19.3.0", "19.x", "*", "latest", "npm:react@19.3.0"):
            with self.subTest(spec=spec):
                self._reset()
                self._set(FRONTEND_MANIFEST, "react", spec)
                self.assertIn(
                    f'frontend/package.json: react "{spec}" is not an exact pin',
                    self._problems(),
                )

    def test_range_specifier_in_the_verifier_manifest_is_rejected(self) -> None:
        self._set(VERIFIER_MANIFEST, "@remotion/player", "^4.0.543")
        self.assertIn(
            'animation-verifier/package.json: @remotion/player "^4.0.543" is not an exact pin',
            self._problems(),
        )

    def test_non_string_version_is_reported(self) -> None:
        self.docs[FRONTEND_MANIFEST]["dependencies"]["remotion"] = 4
        self.assertEqual(
            self._problems(),
            ["frontend/package.json: remotion has a non-string version: 4"],
        )

    def test_missing_package_names_the_file_and_the_package(self) -> None:
        for rel in VERSION_SOURCES:
            with self.subTest(source=rel):
                self._reset()
                self._drop(rel, "@remotion/player")
                key = (
                    "node_modules/@remotion/player"
                    if rel.endswith("package-lock.json")
                    else "@remotion/player"
                )
                self.assertEqual(self._problems(), [f"{rel}: {key} is missing"])

    def test_missing_source_file_names_the_file_and_the_packages(self) -> None:
        for rel in VERSION_SOURCES:
            with self.subTest(source=rel):
                self._reset()
                (self.root / rel).unlink()
                res = self._run()
                self.assertEqual(res.returncode, 1)
                self.assertEqual(
                    res.stderr.splitlines(), [f"{rel}: file is missing ({self.NEEDED})"]
                )

    def test_invalid_json_names_the_file_and_the_packages(self) -> None:
        payloads = {
            "syntax error": b'{"dependencies": ',
            "empty": b"",
            "not utf-8": b"\xff\xfe\x00",
            "not an object": b"[]",
        }
        for rel in VERSION_SOURCES:
            for label, data in payloads.items():
                with self.subTest(source=rel, payload=label):
                    self._reset()
                    self._write(rel, data)
                    res = self._run()
                    self.assertEqual(res.returncode, 1)
                    self.assertNotIn("Traceback", res.stderr)
                    lines = res.stderr.splitlines()
                    self.assertEqual(len(lines), 1, msg=lines)
                    self.assertTrue(lines[0].startswith(f"{rel}: "), msg=lines)
                    self.assertTrue(lines[0].endswith(f"({self.NEEDED})"), msg=lines)

    def test_lockfile_without_packages_map_is_reported(self) -> None:
        del self.docs[FRONTEND_LOCK]["packages"]
        self.assertEqual(
            self._problems(),
            [
                f'{FRONTEND_LOCK}: no "packages" map, lockfileVersion 2 or 3 required'
                f" ({self.NEEDED})"
            ],
        )

    def test_nested_lockfile_entry_with_another_version_prints_its_path(self) -> None:
        cases = (
            (VERIFIER_LOCK, "node_modules/foo/node_modules/react", "18.3.1", "19.3.0"),
            (FRONTEND_LOCK, "node_modules/next/node_modules/@remotion/player", "4.0.1", "4.0.543"),
        )
        for rel, key, version, pin in cases:
            with self.subTest(entry=key):
                self._reset()
                self.docs[rel]["packages"][key] = {"version": version}
                self.assertEqual(
                    self._problems(), [f"{rel}: nested entry {key} is {version}, pin is {pin}"]
                )

    def test_nested_lockfile_entry_with_the_pinned_version_passes(self) -> None:
        self.docs[FRONTEND_LOCK]["packages"]["node_modules/foo/node_modules/react"] = {
            "version": "19.3.0"
        }
        self._flush()
        res = self._run()
        self.assertEqual(res.returncode, 0, msg=res.stderr)

    def test_pairs_with_different_versions_are_reported_in_every_source(self) -> None:
        for first, second, other in (
            ("react", "react-dom", "19.2.0"),
            ("remotion", "@remotion/player", "4.0.544"),
        ):
            with self.subTest(pair=(first, second)):
                self._reset()
                for rel in VERSION_SOURCES:  # equal across sources, so only the pair rule fires
                    self._set(rel, second, other)
                lines = self._problems()
                self.assertEqual(
                    lines,
                    [
                        f"{rel}: {first}={VERSION_PINS[first]} and {second}={other}"
                        " must be the same version"
                        for rel in VERSION_SOURCES
                    ],
                )

    def test_arguments_exit_2(self) -> None:
        for args in (("--check",), ("extra",)):
            with self.subTest(args=args):
                res = self._run(*args)
                self.assertEqual(res.returncode, 2)
                self.assertIn("usage: check-animation-versions.py", res.stderr)

    def test_real_manifests_pin_identical_exact_versions(self) -> None:
        manifests = [
            json.loads((REPO_ROOT / rel).read_text(encoding="utf-8"))
            for rel in (VERIFIER_MANIFEST, FRONTEND_MANIFEST)
        ]
        lock = json.loads((REPO_ROOT / FRONTEND_LOCK).read_text(encoding="utf-8"))
        for pkg in VERSION_PINS:
            with self.subTest(package=pkg):
                pins = [m["dependencies"][pkg] for m in manifests]
                self.assertEqual(pins[0], pins[1])
                self.assertRegex(pins[0], r"\A\d+\.\d+\.\d+\Z")
                self.assertEqual(lock["packages"][f"node_modules/{pkg}"]["version"], pins[0])


class AnimationCheckersTest(unittest.TestCase):
    """Verify the animation cost and tag guardrails (design 8.3, Requirement 35.7 to 35.17).

    Plan tests run check-tags and check-cost on the animation-*.json fixtures, or on a copy of
    animation-valid-plan.json changed in one place. Static tests write one .tf file to a
    temporary directory and run check-cost-static on it. Each failing case compares the exact
    violation lines, so a fixture that also fails for a second, unintended reason is caught.
    """

    VALID_PLAN = FIXTURES_DIR / "animation-valid-plan.json"
    LAMBDA = "aws_lambda_function.animation_verifier[0]"
    LOG_GROUP = "aws_cloudwatch_log_group.animation_verifier"
    PAB = "aws_s3_bucket_public_access_block.animations"
    DENYLISTED = (
        "aws_lambda_provisioned_concurrency_config",
        "aws_lambda_function_url",
        "aws_apigatewayv2_api",
    )
    LOG_GROUP_DENIED = "resource type 'aws_cloudwatch_log_group' is on the cost denylist"
    # Fixture file -> the one check-cost violation it must produce (and no check-tags violation).
    BAD_PLANS = {
        "animation-bad-lambda-memory.json": f"{LAMBDA}: memory_size 1537 > 1536 MB",
        "animation-bad-lambda-timeout.json": f"{LAMBDA}: timeout 61 > 60 s",
        "animation-bad-lambda-package.json": f"{LAMBDA}: package_type 'Zip' must be 'Image'",
        "animation-bad-lambda-reserved.json": (
            f"{LAMBDA}: reserved_concurrent_executions (1) must not be set"
        ),
        "animation-bad-lambda-url.json": (
            "aws_lambda_function_url.animation_verifier:"
            " resource type 'aws_lambda_function_url' is on the cost denylist"
        ),
        "animation-bad-provisioned.json": (
            "aws_lambda_provisioned_concurrency_config.animation_verifier:"
            " resource type 'aws_lambda_provisioned_concurrency_config' is on the cost denylist"
        ),
        "animation-bad-ecr-mutable.json": (
            "aws_ecr_repository.animation_verifier:"
            " image_tag_mutability 'MUTABLE' must be 'IMMUTABLE'"
        ),
        "animation-bad-ecr-noscan.json": (
            "aws_ecr_repository.animation_verifier:"
            " image_scanning_configuration.scan_on_push must be true"
        ),
        "animation-bad-s3-pab.json": f"{PAB}: block_public_policy must be true",
        "animation-bad-s3-acl.json": (
            "aws_s3_bucket_acl.animations: aws_s3_bucket_acl is disallowed (ACLs stay off)"
        ),
        "animation-bad-loggroup-other.json": f"aws_cloudwatch_log_group.other: {LOG_GROUP_DENIED}",
        "animation-bad-loggroup-retention.json": f"{LOG_GROUP}: {LOG_GROUP_DENIED}",
    }

    def setUp(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.tmp = Path(tmp.name)

    def _run(self, script: str, arg: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [str(CI_DIR / script), arg], capture_output=True, text=True, check=False
        )

    # --- plan helpers -----------------------------------------------------------------------

    def _plan(self) -> dict:
        return json.loads(self.VALID_PLAN.read_text(encoding="utf-8"))

    def _entry(self, plan: dict, address: str) -> dict:
        (entry,) = [e for e in plan["resource_changes"] if e["address"] == address]
        return entry

    def _after(self, plan: dict, address: str) -> dict:
        return self._entry(plan, address)["change"]["after"]

    def _violations(self, script: str, plan: dict | Path) -> list[str]:
        """Run a plan checker; return its stderr lines, requiring exit 1 exactly when any."""
        if isinstance(plan, dict):
            path = self.tmp / "plan.json"
            path.write_text(json.dumps(plan), encoding="utf-8")
        else:
            path = plan
        res = self._run(script, str(path))
        lines = res.stderr.splitlines()
        self.assertEqual(res.returncode, 1 if lines else 0, msg=res.stdout + res.stderr)
        return lines

    def _cost(self, message: str) -> str:
        return f"COST VIOLATION: {message}"

    # --- plan fixtures ----------------------------------------------------------------------

    def test_valid_plan_passes_tags_and_cost(self) -> None:
        for script in ("check-tags", "check-cost"):
            with self.subTest(script=script):
                self.assertEqual(self._violations(script, self.VALID_PLAN), [])

    def test_valid_plan_has_every_resource_type_declared_in_animation_tf(self) -> None:
        source = (REPO_ROOT / "infra" / "animation.tf").read_text(encoding="utf-8")
        declared = set(re.findall(r'^resource\s+"([^"]+)"', source, re.MULTILINE))
        planned = {entry["type"] for entry in self._plan()["resource_changes"]}
        self.assertIn("aws_lambda_function", declared)  # the pattern still finds resources
        self.assertEqual(declared - planned, set(), msg="add the missing types to the fixture")
        addresses = {entry["address"] for entry in self._plan()["resource_changes"]}
        self.assertIn(self.LOG_GROUP, addresses)
        self.assertIn(self.LAMBDA, addresses)

    def test_each_bad_plan_fails_cost_with_only_its_own_violation(self) -> None:
        on_disk = {p.name for p in FIXTURES_DIR.glob("animation-bad-*.json")}
        self.assertEqual(on_disk, set(self.BAD_PLANS))
        for name, message in self.BAD_PLANS.items():
            with self.subTest(fixture=name):
                path = FIXTURES_DIR / name
                self.assertEqual(self._violations("check-cost", path), [self._cost(message)])
                # The tags are valid in every fixture, so only the cost rule is under test.
                self.assertEqual(self._violations("check-tags", path), [])

    # --- plan rules -------------------------------------------------------------------------

    def test_lambda_limits_pass_at_1536_and_60_and_fail_just_above(self) -> None:
        memory_error = f"{self.LAMBDA}: memory_size 1537 > 1536 MB"
        timeout_error = f"{self.LAMBDA}: timeout 61 > 60 s"
        cases = (
            (1536, 60, []),
            (128, 3, []),
            (1537, 60, [memory_error]),
            (1536, 61, [timeout_error]),
            (1537, 61, [memory_error, timeout_error]),
        )
        for memory, timeout, expected in cases:
            with self.subTest(memory_size=memory, timeout=timeout):
                plan = self._plan()
                after = self._after(plan, self.LAMBDA)
                after["memory_size"], after["timeout"] = memory, timeout
                self.assertEqual(
                    self._violations("check-cost", plan), [self._cost(m) for m in expected]
                )

    def test_lambda_reserved_concurrency_passes_unset_default_and_zero(self) -> None:
        for value in (None, -1, 0):
            with self.subTest(reserved_concurrent_executions=value):
                plan = self._plan()
                self._after(plan, self.LAMBDA)["reserved_concurrent_executions"] = value
                self.assertEqual(self._violations("check-cost", plan), [])

    def test_ecr_needs_a_scan_on_push_block(self) -> None:
        address = "aws_ecr_repository.animation_verifier"
        for blocks in ([], [{}], [{"scan_on_push": False}]):
            with self.subTest(image_scanning_configuration=blocks):
                plan = self._plan()
                self._after(plan, address)["image_scanning_configuration"] = blocks
                message = f"{address}: image_scanning_configuration.scan_on_push must be true"
                self.assertEqual(self._violations("check-cost", plan), [self._cost(message)])

    def test_every_public_access_block_flag_must_be_true(self) -> None:
        for flag in (
            "block_public_acls",
            "block_public_policy",
            "ignore_public_acls",
            "restrict_public_buckets",
        ):
            with self.subTest(flag=flag):
                plan = self._plan()
                self._after(plan, self.PAB)[flag] = False
                self.assertEqual(
                    self._violations("check-cost", plan),
                    [self._cost(f"{self.PAB}: {flag} must be true")],
                )

    def test_log_group_exception_needs_address_name_and_retention_7(self) -> None:
        cases = (
            ("another address", f"{self.LOG_GROUP}_copy", {}),
            ("another name", self.LOG_GROUP, {"name": "/aws/lambda/other"}),
            ("retention 14", self.LOG_GROUP, {"retention_in_days": 14}),
            ("never expires", self.LOG_GROUP, {"retention_in_days": 0}),
            ("retention unset", self.LOG_GROUP, {"retention_in_days": None}),
        )
        for label, address, changes in cases:
            with self.subTest(case=label):
                plan = self._plan()
                entry = self._entry(plan, self.LOG_GROUP)
                entry["address"] = address
                entry["change"]["after"].update(changes)
                self.assertEqual(
                    self._violations("check-cost", plan),
                    [self._cost(f"{address}: {self.LOG_GROUP_DENIED}")],
                )

    def test_new_denylisted_types_are_rejected_in_a_plan(self) -> None:
        for rtype in self.DENYLISTED:
            with self.subTest(type=rtype):
                plan = {
                    "resource_changes": [
                        {
                            "address": f"{rtype}.x",
                            "type": rtype,
                            "change": {"actions": ["create"], "after": {}},
                        }
                    ]
                }
                self.assertEqual(
                    self._violations("check-cost", plan),
                    [self._cost(f"{rtype}.x: resource type '{rtype}' is on the cost denylist")],
                )

    def test_new_types_need_a_name_tag(self) -> None:
        for address in (
            self.LAMBDA,
            "aws_ecr_repository.animation_verifier",
            "aws_s3_bucket.animations",
        ):
            with self.subTest(address=address):
                plan = self._plan()
                del self._after(plan, address)["tags_all"]["Name"]
                self.assertEqual(
                    self._violations("check-tags", plan),
                    [f"TAG VIOLATION: {address}: missing required tag Name"],
                )

    def test_animation_is_an_allowed_component_and_a_near_miss_is_not(self) -> None:
        plan = self._plan()
        self._after(plan, self.LAMBDA)["tags_all"]["Component"] = "animations"
        self.assertEqual(
            self._violations("check-tags", plan),
            [f"TAG VIOLATION: {self.LAMBDA}: invalid Component tag 'animations'"],
        )

    # --- static scan of .tf files -----------------------------------------------------------

    def _static(self, text: str) -> tuple[Path, list[str]]:
        """Scan one .tf file; return its path and the violation lines without the prefix."""
        root = self.tmp / "static"
        root.mkdir(exist_ok=True)
        path = root / "main.tf"
        path.write_text(text, encoding="utf-8")
        res = self._run("check-cost-static", str(root))
        prefix = "STATIC COST VIOLATION: "
        lines = res.stderr.splitlines()
        self.assertEqual(res.returncode, 1 if lines else 0, msg=res.stdout + res.stderr)
        self.assertTrue(all(line.startswith(prefix) for line in lines), msg=res.stderr)
        return path, [line.removeprefix(prefix) for line in lines]

    def _lambda_tf(self, name: str = "verifier", **attrs: str | None) -> str:
        """A Lambda block; a keyword replaces an attribute value and None leaves it out."""
        values = {"memory_size": "1536", "timeout": "60", "package_type": '"Image"', **attrs}
        body = "".join(f"  {key} = {val}\n" for key, val in values.items() if val is not None)
        return f'resource "aws_lambda_function" "{name}" {{\n{body}}}\n'

    def test_static_lambda_limits_pass_at_1536_and_60_and_fail_just_above(self) -> None:
        address = "aws_lambda_function.verifier"
        cases = (
            ("the limits", {}, []),
            ("the lowest values", {"memory_size": "128", "timeout": "3"}, []),
            ("memory 1537", {"memory_size": "1537"}, [f"{address}: memory_size 1537 > 1536 MB"]),
            ("timeout 61", {"timeout": "61"}, [f"{address}: timeout 61 > 60 s"]),
            (
                "both above",
                {"memory_size": "1537", "timeout": "61"},
                [f"{address}: memory_size 1537 > 1536 MB", f"{address}: timeout 61 > 60 s"],
            ),
            ("reserved -1", {"reserved_concurrent_executions": "-1"}, []),
            ("reserved 0", {"reserved_concurrent_executions": "0"}, []),
            (
                "reserved 1",
                {"reserved_concurrent_executions": "1"},
                [f"{address}: reserved_concurrent_executions 1 is set"],
            ),
        )
        for label, attrs, expected in cases:
            with self.subTest(case=label):
                path, lines = self._static(self._lambda_tf(**attrs))
                self.assertEqual(lines, [f"{path}: {m}" for m in expected])

    def test_static_lambda_rejects_missing_and_non_literal_attributes(self) -> None:
        address = "aws_lambda_function.verifier"
        number = "must be a literal number"
        string = 'must be a literal string ("Image")'
        cases = (
            ("memory missing", {"memory_size": None}, f"memory_size {number}"),
            ("timeout missing", {"timeout": None}, f"timeout {number}"),
            ("package missing", {"package_type": None}, f"package_type {string}"),
            ("memory from a variable", {"memory_size": "var.memory"}, f"memory_size {number}"),
            ("timeout from a local", {"timeout": "local.timeout"}, f"timeout {number}"),
            ("memory expression", {"memory_size": "1024 + 512"}, f"memory_size {number}"),
            ("memory quoted", {"memory_size": '"1536"'}, f"memory_size {number}"),
            ("package from a variable", {"package_type": "var.package"}, f"package_type {string}"),
            ("package interpolated", {"package_type": '"${var.p}"'}, f"package_type {string}"),
            ("package Zip", {"package_type": '"Zip"'}, "package_type 'Zip' must be 'Image'"),
        )
        for label, attrs, message in cases:
            with self.subTest(case=label):
                path, lines = self._static(self._lambda_tf(**attrs))
                self.assertEqual(lines, [f"{path}: {address}: {message}"])

    def test_static_lambda_ignores_attributes_of_nested_blocks(self) -> None:
        text = (
            'resource "aws_lambda_function" "verifier" {\n'
            "  memory_size  = 1536\n"
            "  timeout      = 60\n"
            '  package_type = "Image"\n'
            "\n"
            "  nested {\n"
            "    memory_size = 99999\n"
            "    timeout     = 999\n"
            "  }\n"
            "}\n"
        )
        self.assertEqual(self._static(text)[1], [])

    def test_static_scan_is_not_hidden_by_a_slash_star_inside_a_string(self) -> None:
        # The regex in the first string holds "/*", the start of a block comment. A scan that
        # strips comments without reading strings would remove everything up to the "*/" in the
        # last line, including the Lambda that breaks the memory cap.
        text = (
            'variable "origin" {\n'
            "  validation {\n"
            '    condition     = can(regex("^https?://[^/*]+$", var.origin))\n'
            '    error_message = "Use https://host, no path."\n'
            "  }\n"
            "}\n"
            "\n" + self._lambda_tf("hidden", memory_size="1537") + "\n"
            "/* an ordinary comment */\n"
        )
        path, lines = self._static(text)
        self.assertEqual(lines, [f"{path}: aws_lambda_function.hidden: memory_size 1537 > 1536 MB"])

    def test_static_scan_handles_comment_markers_and_braces_inside_strings(self) -> None:
        # Braces and comment markers inside strings, an interpolation with its own string, and
        # a real comment that holds a brace. Each block is judged on its own attributes.
        text = (
            'resource "aws_lambda_function" "good" {\n'
            '  description  = "open { brace, https://example.test/${var.host} # not a comment"\n'
            "  memory_size  = 1536\n"
            "  timeout      = 60\n"
            '  package_type = "Image"\n'
            "}\n"
            "\n"
            'resource "aws_lambda_function" "bad" {\n'
            '  description  = "close } brace // not a comment ${format("%s}", var.x)}"\n'
            "  memory_size  = 1537 // real comment {\n"
            "  timeout      = 60\n"
            '  package_type = "Image"\n'
            "}\n"
        )
        path, lines = self._static(text)
        self.assertEqual(lines, [f"{path}: aws_lambda_function.bad: memory_size 1537 > 1536 MB"])

    def test_static_scan_ignores_commented_out_attributes_and_resources(self) -> None:
        text = (
            'resource "aws_lambda_function" "verifier" {\n'
            "  # memory_size = 9999\n"
            "  // timeout = 999\n"
            '  /* package_type = "Zip" */\n'
            "  memory_size  = 1536\n"
            "  timeout      = 60\n"
            '  package_type = "Image"\n'
            "}\n"
            '# resource "aws_cloudwatch_log_group" "other" {}\n'
            '/* resource "aws_lambda_function_url" "url" {} */\n'
        )
        self.assertEqual(self._static(text)[1], [])

    def test_static_log_group_is_allowed_only_as_animation_verifier_with_retention_7(self) -> None:
        def group(name: str, retention: str | None = "7") -> str:
            body = "" if retention is None else f"  retention_in_days = {retention}\n"
            return f'resource "aws_cloudwatch_log_group" "{name}" {{\n{body}}}\n'

        not_7 = " (retention_in_days must be the literal 7)"
        cases = (
            ("animation_verifier", group("animation_verifier"), []),
            ("another name", group("other"), ["log group 'other' is not allowed"]),
            (
                "another name with retention 14",
                group("other", "14"),
                ["log group 'other' is not allowed"],
            ),
            (
                "retention 14",
                group("animation_verifier", "14"),
                [f"log group 'animation_verifier' is not allowed{not_7}"],
            ),
            (
                "retention from a variable",
                group("animation_verifier", "var.days"),
                [f"log group 'animation_verifier' is not allowed{not_7}"],
            ),
            (
                "retention missing",
                group("animation_verifier", None),
                [f"log group 'animation_verifier' is not allowed{not_7}"],
            ),
            (
                "the allowed group does not hide another one",
                group("animation_verifier") + group("other"),
                ["log group 'other' is not allowed"],
            ),
        )
        for label, text, expected in cases:
            with self.subTest(case=label):
                path, lines = self._static(text)
                self.assertEqual(lines, [f"{path}: {m}" for m in expected])

    def test_static_scan_rejects_the_new_denylisted_types(self) -> None:
        for rtype in self.DENYLISTED:
            with self.subTest(type=rtype):
                path, lines = self._static(f'resource "{rtype}" "x" {{}}\n')
                self.assertEqual(lines, [f"{path}: resource '{rtype}.x' is on the cost denylist"])

    # --- strip_hcl_comments -----------------------------------------------------------------

    def test_strip_hcl_comments_removes_comments_outside_strings_only(self) -> None:
        cases = (
            ("a = 1 # c\nb = 2", "a = 1 \nb = 2"),
            ("a = 1 // c\nb = 2", "a = 1 \nb = 2"),
            ("a /* c\n d */ b", "a  b"),
            ('u = "https://x.test/${var.h}" # c', 'u = "https://x.test/${var.h}" '),
            ('r = "^https?://[^/*]+$" // c', 'r = "^https?://[^/*]+$" '),
            ('s = "# not" # c', 's = "# not" '),
            ('s = "/* not */" /* c */', 's = "/* not */" '),
            ('s = "a\\"//b" # c', 's = "a\\"//b" '),  # an escaped quote does not end the string
            ('s = "x ${"//"} y" # c', 's = "x ${"//"} y" '),  # a string inside an interpolation
            ('s = "$${//}" # c', 's = "$${//}" '),  # "$${" is an escape, not an interpolation
            ("a = 1", "a = 1"),
        )
        for text, expected in cases:
            with self.subTest(text=text):
                self.assertEqual(policy_rules.strip_hcl_comments(text), expected)

    def test_strip_hcl_comments_keeps_text_it_cannot_close(self) -> None:
        for text in (
            'a = 1\n/* never closed\nresource "x" "y" {}\n',
            'a = "never closed # still inside\nb = 2\n',
        ):
            with self.subTest(text=text):
                self.assertEqual(policy_rules.strip_hcl_comments(text), text)


# --- helpers for the static checks of task 31.3 ---------------------------------------------


def as_list(value: object) -> list:
    """An IAM element is a string or a list of strings; return it as a list."""
    return list(value) if isinstance(value, list) else [value]


def statement_actions(statement: dict) -> list[str]:
    return as_list(statement.get("Action", []))


def action_matches(pattern: str, action: str) -> bool:
    """IAM action matching: case-insensitive, `*` and `?` wildcards."""
    return fnmatch.fnmatchcase(action.lower(), pattern.lower())


def hcl_blocks(text: str, header: str) -> list[str]:
    """Return the body of every block whose header matches the regex `header`.

    `header` is the text before the opening brace (for example `resource\\s+"aws_x"\\s+"y"`).
    Braces inside quoted strings and `${...}` interpolations do not count. A block that never
    closes is left out, so the caller's count check fails instead of reading past the file.
    """
    bodies: list[str] = []
    for match in re.finditer(header + r"\s*\{", text):
        depth = 1
        i = match.end()
        while i < len(text):
            ch = text[i]
            if ch == '"':
                i = policy_rules.skip_hcl_string(text, i)
                continue
            if ch == "{":
                depth += 1
            elif ch == "}":
                depth -= 1
                if depth == 0:
                    bodies.append(text[match.end() : i])
                    break
            i += 1
    return bodies


def hcl_block(text: str, header: str) -> str | None:
    bodies = hcl_blocks(text, header)
    return bodies[0] if bodies else None


def hcl_attr(body: str, name: str) -> str | None:
    """Return the raw one-line value of `name = value` in `body`, or None."""
    match = re.search(rf"^\s*{re.escape(name)}\s*=\s*(.+?)\s*$", body, re.MULTILINE)
    return match.group(1) if match else None


def read_hcl(name: str) -> str:
    """Read infra/<name> with the comments removed."""
    return policy_rules.strip_hcl_comments((INFRA_DIR / name).read_text(encoding="utf-8"))


def tf_regex_matches(pattern: str, value: str) -> bool:
    """Terraform regex() is RE2: unanchored search, and `$` means the end of the text only."""
    if pattern.endswith("$") and not pattern.endswith("\\$"):
        pattern = pattern[:-1] + r"\Z"
    return re.search(pattern, value) is not None


def animation_ssm_params_map() -> dict[str, str]:
    """Raw `NAME = value` text of locals.animation_ssm_params in infra/animation.tf."""
    body = hcl_block(read_hcl("animation.tf"), r"animation_ssm_params\s*=")
    if body is None:
        raise AssertionError("locals.animation_ssm_params not found in infra/animation.tf")
    return dict(re.findall(r"^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.+?)\s*$", body, re.MULTILINE))


def animation_env_params() -> dict[str, str]:
    """Names and rendered values of the ten animation API settings declared in animation.tf.

    The nine in `animation_ssm_params` come from the map; ANIMATION_ENABLED is its own resource
    and takes the variable default (`false`). Terraform expressions are replaced by
    ANIMATION_ENV_RENDERED. A value that is neither a plain string nor a known expression fails
    the test, so a new kind of value is looked at by a person.
    """
    params = {ANIMATION_ENABLED_NAME: "false"}
    for name, raw in animation_ssm_params_map().items():
        literal = re.fullmatch(r'"([^"$%\\]*)"', raw)
        if literal:
            params[name] = literal.group(1)
        elif raw in ANIMATION_ENV_RENDERED:
            params[name] = ANIMATION_ENV_RENDERED[raw]
        else:
            raise AssertionError(f"unknown value expression for {name}: {raw}")
    return params


class HclHelpersTest(unittest.TestCase):
    """The static Terraform tests are only as good as these helpers, so they get their own tests."""

    TEXT = (
        'resource "aws_x" "one" {\n'
        '  note = "}{ ${format("}", var.a)}"\n'
        "  inner {\n"
        "    flag = true\n"
        "  }\n"
        "}\n"
        'resource "aws_x" "two" {\n'
        "  flag = false\n"
        "}\n"
    )

    def test_a_block_ends_at_its_own_brace_not_at_one_inside_a_string(self) -> None:
        body = hcl_block(self.TEXT, r'resource\s+"aws_x"\s+"one"')
        assert body is not None
        self.assertIn("inner {", body)
        self.assertNotIn("false", body)
        self.assertEqual(hcl_attr(body, "note"), '"}{ ${format("}", var.a)}"')

    def test_nested_block_is_found_inside_its_parent_only(self) -> None:
        body = hcl_block(self.TEXT, r'resource\s+"aws_x"\s+"one"')
        assert body is not None
        inner = hcl_block(body, "inner")
        assert inner is not None
        self.assertEqual(hcl_attr(inner, "flag"), "true")
        self.assertIsNone(hcl_attr(inner, "note"))

    def test_every_matching_block_is_returned_and_a_missing_one_is_none(self) -> None:
        self.assertEqual(len(hcl_blocks(self.TEXT, r'resource\s+"aws_x"\s+"[a-z]+"')), 2)
        self.assertIsNone(hcl_block(self.TEXT, r'resource\s+"aws_y"\s+"one"'))

    def test_a_block_that_never_closes_is_not_returned(self) -> None:
        self.assertIsNone(hcl_block('resource "a" "b" {\n  x = 1\n', r'resource\s+"a"\s+"b"'))

    def test_terraform_regex_dollar_matches_the_end_of_the_text_only(self) -> None:
        self.assertTrue(tf_regex_matches("^sha-[0-9a-f]{7}$", "sha-0123abc"))
        self.assertFalse(tf_regex_matches("^sha-[0-9a-f]{7}$", "sha-0123abc\n"))
        self.assertFalse(tf_regex_matches("^sha-[0-9a-f]{7}$", "xsha-0123abc"))
        self.assertTrue(tf_regex_matches("abc", "xabcx"))  # regex() searches, it does not anchor


class BootstrapPolicyTest(unittest.TestCase):
    """Static checks of the three bootstrap policies changed for the animation feature.

    Requirement 35.2 (guardrail), 35.13 (apply), 35.14 (all three, and the deploy `*`). The
    invariants live in `_check_*` methods that take a policy dict, so the same assertions run on
    the real file and, in the negative tests, on a copy changed in one place.
    """

    def _load(self, path: Path) -> dict:
        return json.loads(path.read_text(encoding="utf-8"))

    def _mutated(self, path: Path) -> dict:
        return json.loads(json.dumps(self._load(path)))  # a deep copy

    def _statement(self, policy: dict, sid: str) -> dict:
        found = [s for s in policy["Statement"] if s.get("Sid") == sid]
        self.assertEqual(len(found), 1, msg=f"expected exactly one statement with Sid {sid}")
        return found[0]

    # --- size, version, account id ----------------------------------------------------------

    def test_changed_policies_are_valid_json_with_the_iam_version(self) -> None:
        for path in CHANGED_POLICIES:
            with self.subTest(policy=path.name):
                policy = self._load(path)
                self.assertEqual(policy["Version"], "2012-10-17")
                statements = policy["Statement"]
                self.assertTrue(statements)
                sids = [s["Sid"] for s in statements]  # every statement has a Sid
                self.assertEqual(len(sids), len(set(sids)), msg="Sid must be unique")
                for statement in statements:
                    self.assertIn(statement["Effect"], ("Allow", "Deny"))

    def test_changed_policies_fit_the_6144_character_limit_without_white_space(self) -> None:
        for path in CHANGED_POLICIES:
            with self.subTest(policy=path.name):
                size = len(re.sub(r"\s", "", path.read_text(encoding="utf-8")))
                self.assertLessEqual(size, POLICY_MAX_CHARS)

    def test_changed_policies_hold_no_literal_account_id(self) -> None:
        for path in CHANGED_POLICIES:
            with self.subTest(policy=path.name):
                text = path.read_text(encoding="utf-8")
                self.assertEqual(re.findall(r"(?<!\d)\d{12}(?!\d)", text), [])
                self.assertIn("<ACCOUNT_ID>", text)  # the placeholder is still there

    # --- lore-guardrail-deny.json (Requirement 35.2, 35.12) ---------------------------------

    def _check_guardrail(self, policy: dict) -> None:
        statements = policy["Statement"]
        expensive = self._statement(policy, "DenyExpensiveServices")
        self.assertEqual(expensive["Effect"], "Deny")
        self.assertNotIn("logs:CreateLogGroup", statement_actions(expensive))
        # A wildcard such as logs:* would deny the verifier log group too and undo the carve-out.
        self.assertEqual([a for a in statement_actions(expensive) if a.startswith("logs:")], [])

        only_create = [
            s
            for s in statements
            if s["Effect"] == "Deny" and statement_actions(s) == ["logs:CreateLogGroup"]
        ]
        self.assertEqual(len(only_create), 1, msg="exactly one Deny for logs:CreateLogGroup")
        carve_out = only_create[0]
        self.assertEqual(carve_out["Sid"], "DenyLogGroupsOtherThanVerifier")
        # Both ARN forms of the verifier log group, and nothing else. It is not certain whether IAM
        # evaluates logs:CreateLogGroup against the ARN with or without the trailing `:*`; with only
        # one form listed, the other would be denied and Terraform could not create the group.
        self.assertEqual(
            sorted(as_list(carve_out["NotResource"])), sorted([LOG_GROUP_ARN, f"{LOG_GROUP_ARN}:*"])
        )
        self.assertNotIn("Resource", carve_out)  # IAM rejects Resource together with NotResource

        for statement in statements:
            if statement is carve_out or statement["Effect"] != "Deny":
                continue
            self.assertNotIn("NotAction", statement, msg=statement["Sid"])
            for action in statement_actions(statement):
                self.assertFalse(
                    action_matches(action, "logs:CreateLogGroup"),
                    msg=f"{statement['Sid']} would also deny the verifier log group: {action}",
                )

    def test_guardrail_denies_create_log_group_except_for_the_verifier_log_group(self) -> None:
        self._check_guardrail(self._load(GUARDRAIL_POLICY))

    def test_guardrail_check_catches_each_way_of_undoing_the_carve_out(self) -> None:
        def broad(policy: dict) -> None:
            self._statement(policy, "DenyExpensiveServices")["Action"].append("logs:CreateLogGroup")

        def wildcard(policy: dict) -> None:
            self._statement(policy, "DenyExpensiveServices")["Action"].append("logs:*")

        def second_deny(policy: dict) -> None:
            copy = dict(self._statement(policy, "DenyLogGroupsOtherThanVerifier"), Sid="Other")
            policy["Statement"].append(copy)

        def without_suffix(policy: dict) -> None:
            carve = self._statement(policy, "DenyLogGroupsOtherThanVerifier")
            carve["NotResource"] = LOG_GROUP_ARN

        def only_with_suffix(policy: dict) -> None:
            carve = self._statement(policy, "DenyLogGroupsOtherThanVerifier")
            carve["NotResource"] = f"{LOG_GROUP_ARN}:*"  # the form before the second finding

        def only_with_suffix_as_list(policy: dict) -> None:
            carve = self._statement(policy, "DenyLogGroupsOtherThanVerifier")
            carve["NotResource"] = [f"{LOG_GROUP_ARN}:*"]

        def another_group(policy: dict) -> None:
            carve = self._statement(policy, "DenyLogGroupsOtherThanVerifier")
            carve["NotResource"] = [arn.replace(VERIFIER, "other") for arn in carve["NotResource"]]

        def two_groups(policy: dict) -> None:
            carve = self._statement(policy, "DenyLogGroupsOtherThanVerifier")
            carve["NotResource"] = [*carve["NotResource"], f"{LOG_GROUP_ARN}-x:*"]

        def wider_prefix(policy: dict) -> None:
            carve = self._statement(policy, "DenyLogGroupsOtherThanVerifier")
            carve["NotResource"] = [*carve["NotResource"], "arn:aws:logs:*:*:log-group:/aws/*"]

        def all_log_groups(policy: dict) -> None:
            carve = self._statement(policy, "DenyLogGroupsOtherThanVerifier")
            carve["NotResource"] = [*carve["NotResource"], "*"]

        def bare_form_duplicated(policy: dict) -> None:
            carve = self._statement(policy, "DenyLogGroupsOtherThanVerifier")
            carve["NotResource"] = [LOG_GROUP_ARN, LOG_GROUP_ARN]

        def dropped(policy: dict) -> None:
            policy["Statement"].remove(self._statement(policy, "DenyLogGroupsOtherThanVerifier"))

        def allow(policy: dict) -> None:
            self._statement(policy, "DenyLogGroupsOtherThanVerifier")["Effect"] = "Allow"

        for change in (
            broad,
            wildcard,
            second_deny,
            without_suffix,
            only_with_suffix,
            only_with_suffix_as_list,
            another_group,
            two_groups,
            wider_prefix,
            all_log_groups,
            bare_form_duplicated,
            dropped,
            allow,
        ):
            with self.subTest(change=change.__name__):
                policy = self._mutated(GUARDRAIL_POLICY)
                change(policy)
                with self.assertRaises(AssertionError):
                    self._check_guardrail(policy)

    def test_guardrail_exempts_both_arn_forms_of_the_verifier_log_group_and_no_other(self) -> None:
        # NotResource makes the Deny apply to every resource that matches none of its patterns.
        carve = self._statement(self._load(GUARDRAIL_POLICY), "DenyLogGroupsOtherThanVerifier")

        def denied(arn: str) -> bool:
            return not any(fnmatch.fnmatchcase(arn, p) for p in as_list(carve["NotResource"]))

        prefix = "arn:aws:logs:<AWS_REGION>:<ACCOUNT_ID>:log-group:/aws/lambda/"
        for arn in (f"{prefix}{VERIFIER}", f"{prefix}{VERIFIER}:*"):
            with self.subTest(exempt=arn):
                self.assertFalse(denied(arn))
        for arn in (
            f"{prefix}other",
            f"{prefix}other:*",
            f"{prefix}{VERIFIER}-x",
            f"{prefix}{VERIFIER}-x:*",
            f"{prefix}x{VERIFIER}",
            "arn:aws:logs:<AWS_REGION>:<ACCOUNT_ID>:log-group:/lore/other",
            "arn:aws:logs:<AWS_REGION>:<ACCOUNT_ID>:log-group:*",
        ):
            with self.subTest(denied=arn):
                self.assertTrue(denied(arn))

    # --- lore-gh-apply-policy.json (Requirement 35.13) --------------------------------------

    def _check_apply_pass_role(self, policy: dict) -> None:
        pass_role = [
            s
            for s in policy["Statement"]
            if any(action_matches(a, "iam:PassRole") for a in statement_actions(s))
        ]
        self.assertEqual(sorted(s["Sid"] for s in pass_role), ["PassRoleToEc2", "PassRoleToLambda"])
        self.assertEqual(self._statement(policy, "PassRoleToEc2"), PASS_ROLE_TO_EC2)
        self.assertEqual(self._statement(policy, "PassRoleToLambda"), PASS_ROLE_TO_LAMBDA)

    def test_apply_policy_passes_animation_roles_to_lambda_in_a_separate_statement(self) -> None:
        self._check_apply_pass_role(self._load(APPLY_POLICY))

    def test_apply_pass_role_check_catches_a_changed_or_merged_statement(self) -> None:
        def ec2_resource(policy: dict) -> None:
            self._statement(policy, "PassRoleToEc2")["Resource"] = "arn:aws:iam::<ACCOUNT_ID>:*"

        def ec2_service(policy: dict) -> None:
            ec2 = self._statement(policy, "PassRoleToEc2")
            ec2["Condition"]["StringEquals"]["iam:PassedToService"] = ["ec2.amazonaws.com"] * 2

        def lambda_resource(policy: dict) -> None:
            self._statement(policy, "PassRoleToLambda")["Resource"] = (
                "arn:aws:iam::<ACCOUNT_ID>:role/lore-prod-*"
            )

        def lambda_no_condition(policy: dict) -> None:
            del self._statement(policy, "PassRoleToLambda")["Condition"]

        def lambda_other_service(policy: dict) -> None:
            lam = self._statement(policy, "PassRoleToLambda")
            lam["Condition"]["StringEquals"]["iam:PassedToService"] = "lambda.amazonaws.com*"

        def lambda_removed(policy: dict) -> None:
            policy["Statement"].remove(self._statement(policy, "PassRoleToLambda"))

        def extra_pass_role(policy: dict) -> None:
            policy["Statement"].append(
                {"Sid": "Wide", "Effect": "Allow", "Action": "iam:*", "Resource": "*"}
            )

        for change in (
            ec2_resource,
            ec2_service,
            lambda_resource,
            lambda_no_condition,
            lambda_other_service,
            lambda_removed,
            extra_pass_role,
        ):
            with self.subTest(change=change.__name__):
                policy = self._mutated(APPLY_POLICY)
                change(policy)
                with self.assertRaises(AssertionError):
                    self._check_apply_pass_role(policy)

    def test_apply_policy_scopes_each_animation_statement_to_the_feature_resources(self) -> None:
        policy = self._load(APPLY_POLICY)
        scopes = {
            "AnimationBucket": [BUCKET_ARN],
            "AnimationEcr": [REPOSITORY_ARN],
            "AnimationLambda": [FUNCTION_ARN],
            "AnimationLogGroup": [LOG_GROUP_ARN, f"{LOG_GROUP_ARN}:*"],
        }
        for sid, resources in scopes.items():
            with self.subTest(sid=sid):
                statement = self._statement(policy, sid)
                self.assertEqual(statement["Effect"], "Allow")
                self.assertEqual(as_list(statement["Resource"]), resources)
        # DescribeLogGroups does not support a single group, so it is the one wildcard resource.
        describe = self._statement(policy, "AnimationLogsDescribe")
        self.assertEqual(describe["Action"], "logs:DescribeLogGroups")
        self.assertEqual(describe["Resource"], "arn:aws:logs:<AWS_REGION>:<ACCOUNT_ID>:log-group:*")

    def _check_apply_ecr(self, policy: dict) -> None:
        ecr = self._statement(policy, "AnimationEcr")
        self.assertEqual(ecr["Effect"], "Allow")
        # Every one of them stays on the single verifier repository, never `*`.
        self.assertEqual(as_list(ecr["Resource"]), [REPOSITORY_ARN])
        actions = statement_actions(ecr)
        self.assertEqual(len(actions), len(set(actions)), msg="no duplicate action")
        for action in LAMBDA_IMAGE_ECR_ACTIONS:
            self.assertIn(action, actions)
        for action in actions:
            self.assertNotIn(action, ("*", "ecr:*"))
            self.assertNotEqual(action, "ecr:GetAuthorizationToken")  # that one needs Resource *

    def test_apply_policy_ecr_statement_lets_terraform_create_a_function_from_the_image(
        self,
    ) -> None:
        # Lambda docs, "Amazon ECR permissions" (images-create): the principal that creates a
        # function from a container image needs these four on the repository.
        self._check_apply_ecr(self._load(APPLY_POLICY))

    def test_apply_ecr_check_catches_a_missing_action_or_a_wider_scope(self) -> None:
        def drop(action: str):
            def change(policy: dict) -> None:
                self._statement(policy, "AnimationEcr")["Action"].remove(action)

            change.__name__ = "drop_" + action.split(":")[1]
            return change

        def on_all(policy: dict) -> None:
            self._statement(policy, "AnimationEcr")["Resource"] = "*"

        def on_a_prefix(policy: dict) -> None:
            self._statement(policy, "AnimationEcr")["Resource"] = REPOSITORY_ARN + "*"

        def on_two(policy: dict) -> None:
            ecr = self._statement(policy, "AnimationEcr")
            ecr["Resource"] = [REPOSITORY_ARN, REPOSITORY_ARN.replace(VERIFIER, "other")]

        def wildcard(policy: dict) -> None:
            self._statement(policy, "AnimationEcr")["Action"].append("ecr:*")

        def duplicate(policy: dict) -> None:
            self._statement(policy, "AnimationEcr")["Action"].append("ecr:BatchGetImage")

        changes = [drop(action) for action in LAMBDA_IMAGE_ECR_ACTIONS]
        for change in (*changes, on_all, on_a_prefix, on_two, wildcard, duplicate):
            with self.subTest(change=change.__name__):
                policy = self._mutated(APPLY_POLICY)
                change(policy)
                with self.assertRaises(AssertionError):
                    self._check_apply_ecr(policy)

    # --- lore-gh-deploy-policy.json (Requirement 35.14, 35.3) -------------------------------

    def _check_deploy(self, policy: dict) -> None:
        feature = [
            s
            for s in policy["Statement"]
            if any(a.lower().startswith(("ecr:", "lambda:")) for a in statement_actions(s))
        ]
        token = [s for s in feature if "ecr:GetAuthorizationToken" in statement_actions(s)]
        self.assertEqual(len(token), 1)
        self.assertEqual(token[0]["Effect"], "Allow")
        self.assertEqual(statement_actions(token[0]), ["ecr:GetAuthorizationToken"])
        self.assertEqual(token[0].get("Resource"), "*")

        # Every other ecr: and lambda: statement is limited to the one repository or function.
        others = [s for s in feature if s is not token[0]]
        self.assertEqual(
            sorted(s["Sid"] for s in others), ["EcrPushVerifier", "LambdaVerifierRelease"]
        )
        for statement in others:
            self.assertEqual(statement["Effect"], "Allow", msg=statement["Sid"])
            for action in statement_actions(statement):
                self.assertNotIn("*", action, msg=f"{statement['Sid']}: {action}")
            self.assertIn(
                as_list(statement.get("Resource")),
                ([REPOSITORY_ARN], [FUNCTION_ARN]),
                msg=statement["Sid"],
            )

    def test_deploy_policy_has_a_wildcard_resource_only_for_the_ecr_auth_token(self) -> None:
        self._check_deploy(self._load(DEPLOY_POLICY))

    def test_deploy_policy_ecr_and_lambda_actions_match_the_release_script_needs(self) -> None:
        policy = self._load(DEPLOY_POLICY)
        push = self._statement(policy, "EcrPushVerifier")
        for action in (
            "ecr:BatchCheckLayerAvailability",
            "ecr:InitiateLayerUpload",
            "ecr:UploadLayerPart",
            "ecr:CompleteLayerUpload",
            "ecr:PutImage",
            "ecr:DescribeImages",
        ):
            self.assertIn(action, statement_actions(push))
        release = self._statement(policy, "LambdaVerifierRelease")
        self.assertEqual(
            sorted(statement_actions(release)),
            [
                "lambda:GetFunction",
                "lambda:GetFunctionConfiguration",
                "lambda:InvokeFunction",
                "lambda:UpdateFunctionCode",
            ],
        )

    def test_deploy_policy_existing_ssm_statement_covers_the_verifier_tag_parameter(self) -> None:
        statement = self._statement(self._load(DEPLOY_POLICY), "SsmReleaseImageTag")
        parameter = (
            "arn:aws:ssm:<AWS_REGION>:<ACCOUNT_ID>:parameter/lore/prod/verifier/release/image_tag"
        )
        self.assertTrue(
            any(fnmatch.fnmatchcase(parameter, r) for r in as_list(statement["Resource"]))
        )
        for action in ("ssm:PutParameter", "ssm:GetParameter", "ssm:AddTagsToResource"):
            self.assertIn(action, statement_actions(statement))

    def test_deploy_check_catches_a_wider_ecr_or_lambda_statement(self) -> None:
        def push_on_all(policy: dict) -> None:
            self._statement(policy, "EcrPushVerifier")["Resource"] = "*"

        def push_on_a_prefix(policy: dict) -> None:
            self._statement(policy, "EcrPushVerifier")["Resource"] = REPOSITORY_ARN + "*"

        def lambda_on_all(policy: dict) -> None:
            self._statement(policy, "LambdaVerifierRelease")["Resource"] = "*"

        def token_with_push(policy: dict) -> None:
            self._statement(policy, "EcrAuthToken")["Action"] = [
                "ecr:GetAuthorizationToken",
                "ecr:PutImage",
            ]

        def token_on_the_repository(policy: dict) -> None:
            self._statement(policy, "EcrAuthToken")["Resource"] = REPOSITORY_ARN

        def wildcard_action(policy: dict) -> None:
            self._statement(policy, "LambdaVerifierRelease")["Action"].append("lambda:*")

        def new_statement(policy: dict) -> None:
            policy["Statement"].append(
                {"Sid": "Wide", "Effect": "Allow", "Action": "ecr:DescribeImages", "Resource": "*"}
            )

        def token_missing(policy: dict) -> None:
            policy["Statement"].remove(self._statement(policy, "EcrAuthToken"))

        for change in (
            push_on_all,
            push_on_a_prefix,
            lambda_on_all,
            token_with_push,
            token_on_the_repository,
            wildcard_action,
            new_statement,
            token_missing,
        ):
            with self.subTest(change=change.__name__):
                policy = self._mutated(DEPLOY_POLICY)
                change(policy)
                with self.assertRaises(AssertionError):
                    self._check_deploy(policy)


class AnimationTerraformStaticTest(unittest.TestCase):
    """Static checks of infra/*.tf that `terraform validate` cannot make without values.

    Requirement 36.12 (precondition on ANIMATION_ENABLED), 34.20 (image tag variable), 34.22
    (CORS origins variable), 34.11 (hop limit), and 34.12 and 34.18 (the ten parameters).
    The regexes in the variable validations are cut out of variables.tf and run on sample
    values, so a changed pattern is caught, not only a changed sentence.
    """

    TAG_PATTERN_EXPR = (
        r'var\.animation_verifier_image_tag == "" \|\| '
        r'can\(regex\("(?P<re>[^"]+)", var\.animation_verifier_image_tag\)\)'
    )
    ORIGIN_PATTERN_EXPR = (
        r"alltrue\(\[for o in var\.animation_cors_extra_origins : "
        r'can\(regex\("(?P<re>[^"]+)", o\)\)\]\)'
    )

    def _variable(self, name: str) -> str:
        body = hcl_block(read_hcl("variables.tf"), rf'variable\s+"{name}"')
        assert body is not None, f"variable {name} not found in infra/variables.tf"
        return body

    def _validations(self, name: str) -> list[tuple[str, str]]:
        """(condition on one line, error_message) of every validation block of a variable."""
        found = []
        for block in hcl_blocks(self._variable(name), "validation"):
            condition = hcl_attr(block, "condition")
            message = hcl_attr(block, "error_message")
            assert condition is not None and message is not None
            found.append((" ".join(condition.split()), message))
        return found

    # --- ANIMATION_ENABLED precondition (Requirement 36.12) ---------------------------------

    def _enabled_parameter(self) -> str:
        body = hcl_block(
            read_hcl("animation.tf"), r'resource\s+"aws_ssm_parameter"\s+"animation_enabled"'
        )
        assert body is not None, "aws_ssm_parameter.animation_enabled not found"
        return body

    def test_animation_enabled_parameter_refuses_to_turn_on_without_an_image_tag(self) -> None:
        body = self._enabled_parameter()
        lifecycle = hcl_block(body, "lifecycle")
        assert lifecycle is not None
        precondition = hcl_block(lifecycle, "precondition")
        assert precondition is not None
        condition = hcl_attr(precondition, "condition")
        assert condition is not None
        self.assertEqual(
            " ".join(condition.split()),
            '!var.animation_enabled || var.animation_verifier_image_tag != ""',
        )
        self.assertEqual(
            hcl_attr(precondition, "error_message"),
            '"animation_enabled requires animation_verifier_image_tag."',
        )

    def test_animation_enabled_parameter_value_and_name_follow_the_variable(self) -> None:
        body = self._enabled_parameter()
        self.assertEqual(hcl_attr(body, "value"), 'var.animation_enabled ? "true" : "false"')
        self.assertEqual(
            hcl_attr(body, "name"), '"/lore/${var.environment}/api/env/ANIMATION_ENABLED"'
        )
        self.assertEqual(hcl_attr(body, "type"), '"String"')

    def test_animation_enabled_is_not_also_created_by_the_for_each_without_the_precondition(
        self,
    ) -> None:
        # The other nine come from for_each over animation_ssm_params. A tenth entry there would
        # create ANIMATION_ENABLED a second time, with no precondition.
        self.assertNotIn(ANIMATION_ENABLED_NAME, animation_ssm_params_map())

    def test_animation_variables_default_to_off(self) -> None:
        enabled = self._variable("animation_enabled")
        self.assertEqual(hcl_attr(enabled, "type"), "bool")
        self.assertIn(hcl_attr(enabled, "default"), ("false", "true"))
        tag = self._variable("animation_verifier_image_tag")
        self.assertEqual(hcl_attr(tag, "type"), "string")
        tag_default = hcl_attr(tag, "default")
        self.assertTrue(
            tag_default == '""' or re.fullmatch(r'"sha-[0-9a-f]{7}"', tag_default) is not None,
            f"unexpected default for animation_verifier_image_tag: {tag_default}",
        )
        origins = self._variable("animation_cors_extra_origins")
        self.assertEqual(hcl_attr(origins, "type"), "list(string)")
        self.assertEqual(hcl_attr(origins, "default"), "[]")

    # --- image tag variable (Requirement 34.20) ---------------------------------------------

    def test_image_tag_variable_accepts_empty_or_sha_and_seven_hex_digits_only(self) -> None:
        validations = self._validations("animation_verifier_image_tag")
        self.assertEqual(len(validations), 1)
        condition, message = validations[0]
        match = re.fullmatch(self.TAG_PATTERN_EXPR, condition)
        assert match is not None, condition
        self.assertIn("sha-xxxxxxx", message)

        def allowed(value: str) -> bool:
            return value == "" or tf_regex_matches(match.group("re"), value)

        for value in ("", "sha-0123abc", "sha-abcdef0", "sha-0000000"):
            with self.subTest(accepted=value):
                self.assertTrue(allowed(value))
        for value in (
            "latest",
            "sha-",
            "sha-0123ab",
            "sha-0123abcd",
            "sha-0123ABC",
            "sha-0123abg",
            "SHA-0123abc",
            " sha-0123abc",
            "sha-0123abc ",
            "sha-0123abc\n",
            "v1.0.0",
        ):
            with self.subTest(rejected=value):
                self.assertFalse(allowed(value))

    # --- CORS origins variable (Requirement 34.22) ------------------------------------------

    def test_cors_origins_variable_allows_at_most_five_plain_http_origins(self) -> None:
        validations = self._validations("animation_cors_extra_origins")
        self.assertEqual(len(validations), 2)
        by_kind = {
            "count": [c for c, _ in validations if c.startswith("length(")],
            "pattern": [c for c, _ in validations if c.startswith("alltrue(")],
        }
        self.assertEqual(by_kind["count"], ["length(var.animation_cors_extra_origins) <= 5"])
        (pattern_condition,) = by_kind["pattern"]
        match = re.fullmatch(self.ORIGIN_PATTERN_EXPR, pattern_condition)
        assert match is not None, pattern_condition

        for value in (
            "https://lore.example",
            "http://203.0.113.10",
            "https://lore.example:8443",
            "http://localhost:3000",
        ):
            with self.subTest(accepted=value):
                self.assertTrue(tf_regex_matches(match.group("re"), value))
        for value in (
            "*",
            "https://*",
            "https://*.lore.example",
            "https://lore.example/",
            "https://lore.example/path",
            "https://",
            "ftp://lore.example",
            "lore.example",
            "",
        ):
            with self.subTest(rejected=value):
                self.assertFalse(tf_regex_matches(match.group("re"), value))

    # --- hop limit (Requirement 34.11) ------------------------------------------------------

    def test_hop_limit_is_2_only_on_the_api_instance_and_tokens_stay_required(self) -> None:
        text = read_hcl("compute.tf")
        expected = {"nat": "1", "web": "1", "api": "2"}
        declared = re.findall(r'resource\s+"aws_instance"\s+"([^"]+)"', text)
        self.assertEqual(sorted(declared), sorted(expected))
        for name, hop_limit in expected.items():
            with self.subTest(instance=name):
                body = hcl_block(text, rf'resource\s+"aws_instance"\s+"{name}"')
                assert body is not None
                options = hcl_block(body, "metadata_options")
                assert options is not None
                self.assertEqual(hcl_attr(options, "http_tokens"), '"required"')
                self.assertEqual(hcl_attr(options, "http_put_response_hop_limit"), hop_limit)

    def test_no_other_resource_sets_a_metadata_hop_limit(self) -> None:
        # A launch template or a second instance resource would be a hop limit this test misses.
        total = sum(
            read_hcl(path.name).count("http_put_response_hop_limit")
            for path in sorted(INFRA_DIR.glob("*.tf"))
        )
        self.assertEqual(total, 3)

    # --- the ten API settings (Requirement 34.12, 34.18) ------------------------------------

    def test_animation_tf_declares_the_ten_api_settings_with_the_required_values(self) -> None:
        declared = animation_ssm_params_map()
        expected = {name: f'"{value}"' for name, value in ANIMATION_ENV_LITERALS.items()}
        expected.update(ANIMATION_ENV_EXPRESSIONS)
        self.assertEqual(declared, expected)
        self.assertEqual(sorted(animation_env_params()), ANIMATION_ENV_NAMES)
        self.assertEqual(animation_env_params()[ANIMATION_ENABLED_NAME], "false")

    def test_the_bucket_and_function_names_are_built_without_a_literal_account_id(self) -> None:
        body = hcl_block(read_hcl("animation.tf"), r"locals")
        assert body is not None
        self.assertEqual(
            hcl_attr(body, "animation_bucket"),
            '"lore-prod-animations-${data.aws_caller_identity.current.account_id}"',
        )
        self.assertEqual(
            hcl_attr(body, "animation_function_name"), '"${local.name_prefix}-animation-verifier"'
        )


@unittest.skipUnless(shutil.which("jq"), "render-env.sh needs jq")
class RenderEnvTest(unittest.TestCase):
    """Run the unchanged deploy/common/render-env.sh against a fake `aws` (Requirement 34.17).

    The fake sits first on PATH, serves the ten animation settings (names and values taken from
    infra/animation.tf) plus two older ones, and logs every call. The script must write each of
    them as a `NAME="value"` line, and must make no call other than the two reads it makes
    today, so the new parameters need no change under deploy/.
    """

    FAKE_AWS = """#!/bin/bash
# Fake aws for render-env.sh: log every call, answer the reads the script makes, fail the rest.
printf '%s\\n' "$*" >> @LOG@
service="${1:-} ${2:-}"
name=""
path=""
for ((i = 1; i <= $#; i++)); do
  j=$((i + 1))
  [[ "${!i}" == "--name" ]] && name="${!j:-}"
  [[ "${!i}" == "--path" ]] && path="${!j:-}"
done
case "$service" in
  "ssm get-parameters-by-path")
    [[ "$path" == "/lore/prod/api/env/" ]] || { echo "unexpected path $path" >&2; exit 99; }
    cat @PARAMS@ ;;
  "ssm get-parameter")
    case "$name" in
      /lore/prod/api/config/db_secret_arn)
        echo "An error occurred (ParameterNotFound) when calling the GetParameter operation" >&2
        exit 254 ;;
      /lore/prod/api/release/image_tag) echo "sha-abc1234" ;;
      *) echo "unexpected parameter $name" >&2; exit 99 ;;
    esac ;;
  *) echo "unexpected aws call: $*" >&2; exit 99 ;;
esac
"""
    OLDER_SETTINGS = {"AI_PROVIDER": "google", "PGHOST": "db.internal.example"}

    def setUp(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.tmp = Path(tmp.name)
        self.bin = self.tmp / "bin"
        self.bin.mkdir()
        self.log = self.tmp / "aws-calls.log"
        self.env_file = self.tmp / "out" / ".env"
        self.settings = {**self.OLDER_SETTINGS, **animation_env_params()}
        params = self.tmp / "params.json"
        params.write_text(
            json.dumps(
                {
                    "Parameters": [
                        {"Name": f"/lore/prod/api/env/{name}", "Type": "String", "Value": value}
                        for name, value in self.settings.items()
                    ]
                }
            ),
            encoding="utf-8",
        )
        script = self.FAKE_AWS.replace("@LOG@", shlex.quote(str(self.log)))
        script = script.replace("@PARAMS@", shlex.quote(str(params)))
        fake = self.bin / "aws"
        fake.write_text(script, encoding="utf-8")
        fake.chmod(0o755)

    def _render(self) -> subprocess.CompletedProcess[str]:
        env = {
            "PATH": f"{self.bin}{os.pathsep}{os.environ.get('PATH', '/usr/bin:/bin')}",
            "HOME": str(self.tmp),
            "ENV_FILE": str(self.env_file),
            "ENVIRONMENT": "prod",
            "AWS_REGION": "ap-southeast-3",
        }
        return subprocess.run(
            ["bash", str(RENDER_ENV_SCRIPT), "api"],
            capture_output=True,
            text=True,
            check=False,
            env=env,
        )

    def test_every_animation_setting_appears_as_a_name_value_line(self) -> None:
        res = self._render()
        self.assertEqual(res.returncode, 0, msg=res.stdout + res.stderr)
        lines = self.env_file.read_text(encoding="utf-8").splitlines()
        animation_names = set(self.settings) - set(self.OLDER_SETTINGS)
        self.assertEqual(sorted(animation_names), ANIMATION_ENV_NAMES)
        for name, value in self.settings.items():
            with self.subTest(name=name):
                # None of the values holds a backslash, a quote or a dollar sign, so the line is
                # exactly NAME="value" with nothing to escape.
                self.assertNotRegex(value, r'[\\"$\n]')
                self.assertEqual(lines.count(f'{name}="{value}"'), 1)
        app_image = [ln for ln in lines if ln.startswith("APP_IMAGE=")]
        self.assertEqual(len(app_image), 1)
        self.assertRegex(app_image[0], r'^APP_IMAGE="ghcr\.io/[^/]+/lore-api:sha-abc1234"$')

    def test_render_makes_only_the_reads_it_made_before_the_animation_settings(self) -> None:
        res = self._render()
        self.assertEqual(res.returncode, 0, msg=res.stdout + res.stderr)
        calls = self.log.read_text(encoding="utf-8").splitlines()
        kinds = [" ".join(call.split()[:2]) for call in calls]
        self.assertEqual(kinds.count("ssm get-parameters-by-path"), 1)
        self.assertEqual(set(kinds), {"ssm get-parameters-by-path", "ssm get-parameter"})


@unittest.skipUnless(shutil.which("jq") and shutil.which("python3"), "needs jq and python3")
class VerifierReleaseTest(unittest.TestCase):
    """Run scripts/ci/verifier-release.sh against a fake `aws` and `docker` (task 33.1).

    Requirements 37.5 to 37.8 and 37.11 to 37.14. The two fakes sit first on PATH, so the real
    `aws` and `docker` are never reached and no credential is needed. Each fake appends one JSON
    line per call (tool, op, argv; the docker build also its working directory, the docker login
    its stdin, an invoke its payload) to a log, and answers from a scenario file, so a test can
    assert the order of the calls, their arguments, the exit code and the output. The script is
    started from a temporary directory: it must find the repository root itself.
    """

    SCRIPT = CI_DIR / "verifier-release.sh"
    FIXTURES = REPO_ROOT / "animation-verifier" / "fixtures"
    CONTRACT = REPO_ROOT / "animation-verifier" / "contract" / "animation-contract.json"
    ACCOUNT = "9" * 12
    REGION = "ap-southeast-3"
    PARAM = "/lore/prod/verifier/release/image_tag"
    SHA = "abcdef0123456789abcdef0123456789abcdef01"
    TAG = "sha-abcdef0"
    PREVIOUS_TAG = "sha-1111111"
    ROLLBACK_TAG = "sha-2222222"
    PASSWORD = "fake-ecr-password"
    FIRST_RELEASE_WARNING = (
        "[warn] function lore-prod-animation-verifier does not exist yet; "
        "skipping update and checks"
    )
    EXPECTED_TAGS = [
        "Key=Project,Value=lore",
        "Key=Environment,Value=prod",
        "Key=Component,Value=animation",
        "Key=ManagedBy,Value=github-actions",
        "Key=Repo,Value=example/lore",
    ]
    PUSH_OPS = [
        "aws sts get-caller-identity",
        "aws ecr describe-images",
        "aws ecr get-login-password",
        "docker login",
        "docker buildx build",
    ]
    RELEASE_OPS = [
        "aws lambda get-function",
        "aws ssm get-parameter",
        "aws lambda update-function-code",
        "aws lambda wait function-updated",
        "aws lambda invoke",
        "aws lambda invoke",
        "aws ssm put-parameter",
    ]

    FAKE_AWS = r'''#!/usr/bin/env python3
"""Fake aws for verifier-release.sh: log every call and answer from the scenario file."""
import json
import os
import sys

argv = sys.argv[1:]
with open(os.environ["FAKE_SCENARIO"], encoding="utf-8") as handle:
    scenario = json.load(handle)
log_path = os.environ["FAKE_LOG"]
op = "aws " + (" ".join(argv[:3]) if argv[:2] == ["lambda", "wait"] else " ".join(argv[:2]))
earlier = []
if os.path.exists(log_path):
    with open(log_path, encoding="utf-8") as handle:
        earlier = [json.loads(line) for line in handle if line.strip()]
nth = sum(1 for call in earlier if call["op"] == op)
entry = {"tool": "aws", "op": op, "argv": argv}


def option(name):
    return argv[argv.index(name) + 1] if name in argv else None


def pick(key, default):
    values = scenario.get(key, default)
    return values[min(nth, len(values) - 1)]


def finish(code=0, out="", err=""):
    with open(log_path, "a", encoding="utf-8") as handle:
        handle.write(json.dumps(entry) + "\n")
    sys.stdout.write(out)
    sys.stderr.write(err)
    sys.exit(code)


def error(name, operation, message="refused by the fake"):
    return f"An error occurred ({name}) when calling the {operation} operation: {message}\n"


if op == "aws sts get-caller-identity":
    if scenario.get("sts_fails"):
        finish(254, err=error("ExpiredToken", "GetCallerIdentity"))
    finish(out=scenario["account"] + "\n")
if op == "aws ecr get-login-password":
    finish(out="fake-ecr-password\n")
if op == "aws ecr describe-images":
    tag = (option("--image-ids") or "").removeprefix("imageTag=")
    if scenario.get("describe_error"):
        finish(254, err=error("AccessDeniedException", "DescribeImages"))
    if tag in scenario["ecr_tags"]:
        finish(out="sha256:" + "0" * 64 + "\n")
    finish(254, err=error("ImageNotFoundException", "DescribeImages", "no image " + tag))
if op == "aws lambda get-function":
    if scenario.get("get_function_error"):
        finish(254, err=error("AccessDeniedException", "GetFunction"))
    if not scenario["function_exists"]:
        finish(254, err=error("ResourceNotFoundException", "GetFunction", "Function not found"))
    finish(out="lore-prod-animation-verifier\n")
if op == "aws ssm get-parameter":
    if scenario.get("get_parameter_error"):
        finish(254, err=error("AccessDeniedException", "GetParameter"))
    if scenario["previous_tag"] is None:
        finish(254, err=error("ParameterNotFound", "GetParameter"))
    finish(out=scenario["previous_tag"] + "\n")
if op == "aws lambda update-function-code":
    code = pick("update_rc", [0])
    if code:
        finish(code, err=error("InvalidParameterValueException", "UpdateFunctionCode"))
    finish(out="{}\n")
if op == "aws lambda wait function-updated":
    code = pick("wait_rc", [0])
    finish(code, err="Waiter FunctionUpdated failed: max attempts exceeded\n" if code else "")
if op == "aws lambda invoke":
    item = pick("invoke", [{}])
    payload = option("--payload") or ""
    if payload.startswith("file://"):
        with open(payload[len("file://"):], encoding="utf-8") as handle:
            payload = handle.read()
    try:
        entry["payload"] = json.loads(payload)
    except ValueError:
        entry["payload"] = None
    with open(argv[-1], "w", encoding="utf-8") as handle:
        json.dump(item.get("response", {}), handle)
    meta = {"StatusCode": 200, "ExecutedVersion": "$LATEST"}
    if item.get("function_error"):
        meta["FunctionError"] = item["function_error"]
    finish(item.get("rc", 0), out=json.dumps(meta) + "\n", err=item.get("stderr", ""))
if op in ("aws ssm put-parameter", "aws ssm add-tags-to-resource"):
    finish(out="{}\n")
finish(99, err="unexpected aws call: " + " ".join(argv) + "\n")
'''

    FAKE_DOCKER = r'''#!/usr/bin/env python3
"""Fake docker for verifier-release.sh: log every call, optionally fail it."""
import json
import os
import sys

argv = sys.argv[1:]
is_build = argv[:2] == ["buildx", "build"]
op = "docker " + (" ".join(argv[:2]) if is_build else (argv[0] if argv else ""))
entry = {"tool": "docker", "op": op, "argv": argv, "cwd": os.getcwd()}
if argv[:1] == ["login"]:
    entry["stdin"] = sys.stdin.read()
with open(os.environ["FAKE_SCENARIO"], encoding="utf-8") as handle:
    scenario = json.load(handle)
code = scenario.get("docker_rc", {}).get(op, 0)
with open(os.environ["FAKE_LOG"], "a", encoding="utf-8") as handle:
    handle.write(json.dumps(entry) + "\n")
if code:
    sys.stderr.write("fake " + op + " failed\n")
elif argv[:1] == ["login"]:
    sys.stdout.write("Login Succeeded\n")
sys.exit(code)
'''

    def setUp(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.tmp = Path(tmp.name)
        self.bin = self.tmp / "bin"
        self.bin.mkdir()
        for name, source in (("aws", self.FAKE_AWS), ("docker", self.FAKE_DOCKER)):
            fake = self.bin / name
            fake.write_text(source, encoding="utf-8")
            fake.chmod(0o755)
        self.path = f"{self.bin}{os.pathsep}{os.environ.get('PATH', '/usr/bin:/bin')}"
        for name in ("aws", "docker"):
            # Whatever else is installed on this machine, the fake must win.
            self.assertEqual(shutil.which(name, path=self.path), str(self.bin / name))
        self.log = self.tmp / "calls.log"
        self.scenario_file = self.tmp / "scenario.json"
        manifest = json.loads((self.FIXTURES / "release-smoke.json").read_text(encoding="utf-8"))
        self.expected_codes: list[str] = manifest["bad"]["expected_codes"]
        self.sources: dict[str, str] = {}
        self.companions: dict[str, dict] = {}
        for role in ("good", "bad"):
            self.sources[role] = (self.FIXTURES / manifest[role]["source"]).read_text(
                encoding="utf-8"
            )
            self.companions[role] = json.loads(
                (self.FIXTURES / manifest[role]["companion"]).read_text(encoding="utf-8")
            )
        self.contract_version = json.loads(self.CONTRACT.read_text(encoding="utf-8"))[
            "contract_version"
        ]

    # ---- scenario and run helpers ----

    def good_response(self) -> dict:
        return {"ok": True, "diagnostics": []}

    def bad_response(self, *extra_codes: str) -> dict:
        codes = [*self.expected_codes, *extra_codes]
        return {"ok": False, "diagnostics": [{"code": c, "severity": "error"} for c in codes]}

    def scenario(self, **overrides: object) -> dict:
        base: dict[str, object] = {
            "account": self.ACCOUNT,
            "ecr_tags": [],
            "function_exists": True,
            "previous_tag": self.PREVIOUS_TAG,
            "update_rc": [0],
            "wait_rc": [0],
            "invoke": [
                {"response": self.good_response()},
                {"response": self.bad_response()},
            ],
        }
        base.update(overrides)
        return base

    def run_release(
        self,
        *args: str,
        scenario: dict | None = None,
        sha: str | None = SHA,
        script: Path | None = None,
    ) -> subprocess.CompletedProcess[str]:
        self.log.unlink(missing_ok=True)
        self.scenario_file.write_text(
            json.dumps(scenario if scenario is not None else self.scenario()), encoding="utf-8"
        )
        env = {
            "PATH": self.path,
            "HOME": str(self.tmp),
            "AWS_REGION": self.REGION,
            "GITHUB_REPOSITORY": "example/lore",
            "FAKE_SCENARIO": str(self.scenario_file),
            "FAKE_LOG": str(self.log),
        }
        if sha is not None:
            env["GITHUB_SHA"] = sha
        return subprocess.run(
            ["bash", str(script or self.SCRIPT), *args],
            capture_output=True,
            text=True,
            check=False,
            env=env,
            cwd=self.tmp,
        )

    def calls(self) -> list[dict]:
        if not self.log.exists():
            return []
        lines = self.log.read_text(encoding="utf-8").splitlines()
        return [json.loads(line) for line in lines if line.strip()]

    def ops(self) -> list[str]:
        return [call["op"] for call in self.calls()]

    def calls_of(self, op: str) -> list[dict]:
        return [call for call in self.calls() if call["op"] == op]

    @staticmethod
    def arg(call: dict, name: str) -> str:
        argv = call["argv"]
        return argv[argv.index(name) + 1]

    def image_uri(self, tag: str) -> str:
        return f"{self.ACCOUNT}.dkr.ecr.{self.REGION}.amazonaws.com/{VERIFIER}:{tag}"

    def assert_parameter_untouched(self) -> None:
        ops = self.ops()
        self.assertNotIn("aws ssm put-parameter", ops)
        self.assertNotIn("aws ssm add-tags-to-resource", ops)

    def assert_rolled_back_to_previous(self) -> None:
        """Two function updates, the second one back to PREVIOUS_TAG, then a wait; no parameter."""
        updates = self.calls_of("aws lambda update-function-code")
        self.assertEqual(len(updates), 2, msg=self.ops())
        self.assertEqual(self.arg(updates[0], "--image-uri"), self.image_uri(self.TAG))
        self.assertEqual(self.arg(updates[1], "--image-uri"), self.image_uri(self.PREVIOUS_TAG))
        self.assertEqual(
            self.ops()[-2:], ["aws lambda update-function-code", "aws lambda wait function-updated"]
        )
        self.assert_parameter_untouched()

    # ---- the script itself ----

    def test_script_is_executable_bash_with_the_repo_conventions(self) -> None:
        self.assertTrue(os.access(self.SCRIPT, os.X_OK))
        text = self.SCRIPT.read_text(encoding="utf-8")
        self.assertTrue(text.startswith("#!"))
        self.assertIn("set -euo pipefail", text)
        self.assertRegex(text, r"(?m)^fail\(\) \{$")
        res = subprocess.run(
            ["bash", "-n", str(self.SCRIPT)], capture_output=True, text=True, check=False
        )
        self.assertEqual(res.returncode, 0, msg=res.stderr)

    # ---- arguments (Requirement 37.12) ----

    def test_an_invalid_tag_exits_1_before_any_aws_or_docker_call(self) -> None:
        bad_tags = [
            "latest",
            "abcdef0",
            "sha-abcdef",
            "sha-abcdef01",
            "sha-ABCDEF0",
            "sha-abcdeg0",
            "sha-abcdef0 ",
            " sha-abcdef0",
            "sha-abcdef0\n",
            "sha-abcdef0\nsha-1234567",
            "::add-mask::sha-abcdef0",
            "sha-abcdef0/../x",
        ]
        for tag in bad_tags:
            with self.subTest(tag=tag):
                res = self.run_release("build-and-release", tag)
                self.assertEqual(res.returncode, 1, msg=res.stdout + res.stderr)
                self.assertIn("[fail] Invalid image tag", res.stderr)
                self.assertEqual(self.calls(), [])
                # A hostile tag must not become a workflow command: none may start a line.
                for line in (res.stdout + res.stderr).splitlines():
                    self.assertFalse(line.startswith("::"), msg=line)

    def test_an_empty_tag_needs_a_usable_github_sha(self) -> None:
        for sha in (None, "", "abc", "ABCDEF0123456789", "ghijklm0123456789"):
            with self.subTest(sha=sha):
                res = self.run_release("build-and-release", "", sha=sha)
                self.assertEqual(res.returncode, 1, msg=res.stdout + res.stderr)
                self.assertIn("[fail]", res.stderr)
                self.assertEqual(self.calls(), [])

    def test_wrong_usage_exits_2_without_a_call(self) -> None:
        for args in ([], ["deploy"], ["build-and-release", self.TAG, "extra"], [""]):
            with self.subTest(args=args):
                res = self.run_release(*args)
                self.assertEqual(res.returncode, 2, msg=res.stdout + res.stderr)
                self.assertIn("Usage:", res.stderr)
                self.assertEqual(self.calls(), [])

    # ---- rollback tag (Requirement 37.12) ----

    def test_a_rollback_tag_that_is_not_in_ecr_fails_before_the_function_or_the_parameter(
        self,
    ) -> None:
        res = self.run_release("build-and-release", self.ROLLBACK_TAG)
        self.assertEqual(res.returncode, 1, msg=res.stdout + res.stderr)
        self.assertIn(f"[fail] rollback tag {self.ROLLBACK_TAG} is not in ECR", res.stderr)
        self.assertEqual(self.ops(), ["aws sts get-caller-identity", "aws ecr describe-images"])

    def test_a_rollback_tag_in_ecr_is_released_without_a_build(self) -> None:
        # GITHUB_SHA must not matter when a tag is given.
        scenario = self.scenario(ecr_tags=[self.ROLLBACK_TAG])
        res = self.run_release("build-and-release", self.ROLLBACK_TAG, scenario=scenario)
        self.assertEqual(res.returncode, 0, msg=res.stdout + res.stderr)
        ops = self.ops()
        self.assertEqual(ops[:2], ["aws sts get-caller-identity", "aws ecr describe-images"])
        self.assertEqual(ops[2:], self.RELEASE_OPS)
        self.assertEqual(self.arg(self.calls_of("aws ecr describe-images")[0], "--image-ids"),
                         f"imageTag={self.ROLLBACK_TAG}")
        update = self.calls_of("aws lambda update-function-code")[0]
        self.assertEqual(self.arg(update, "--image-uri"), self.image_uri(self.ROLLBACK_TAG))
        put = self.calls_of("aws ssm put-parameter")[0]
        self.assertEqual(self.arg(put, "--value"), self.ROLLBACK_TAG)

    # ---- first release: no function yet (Requirement 37.11) ----

    def test_without_a_function_the_image_is_pushed_and_the_tag_written_and_nothing_else(
        self,
    ) -> None:
        scenario = self.scenario(function_exists=False, previous_tag=None)
        res = self.run_release("build-and-release", scenario=scenario)
        self.assertEqual(res.returncode, 0, msg=res.stdout + res.stderr)
        self.assertIn(self.FIRST_RELEASE_WARNING, res.stderr)
        self.assertEqual(
            self.ops(),
            [
                *self.PUSH_OPS,
                "aws lambda get-function",
                "aws ssm get-parameter",
                "aws ssm put-parameter",
                "aws ssm add-tags-to-resource",
            ],
        )
        put = self.calls_of("aws ssm put-parameter")[0]
        self.assertEqual(self.arg(put, "--name"), self.PARAM)
        self.assertEqual(self.arg(put, "--value"), self.TAG)
        self.assertEqual(self.arg(put, "--type"), "String")
        self.assertIn("--overwrite", put["argv"])
        tagging = self.calls_of("aws ssm add-tags-to-resource")[0]
        self.assertEqual(self.arg(tagging, "--resource-id"), self.PARAM)
        self.assertEqual(tagging["argv"][tagging["argv"].index("--tags") + 1 :], self.EXPECTED_TAGS)

    def test_without_a_function_an_existing_parameter_is_not_tagged_again(self) -> None:
        scenario = self.scenario(function_exists=False, ecr_tags=[self.TAG])
        res = self.run_release("build-and-release", scenario=scenario)
        self.assertEqual(res.returncode, 0, msg=res.stdout + res.stderr)
        self.assertIn(self.FIRST_RELEASE_WARNING, res.stderr)
        self.assertEqual(
            self.ops(),
            [
                "aws sts get-caller-identity",
                "aws ecr describe-images",
                "aws lambda get-function",
                "aws ssm get-parameter",
                "aws ssm put-parameter",
            ],
        )

    # ---- successful release (Requirements 37.5, 37.6, 37.13, 37.14) ----

    def test_a_successful_release_pushes_updates_checks_both_fixtures_and_records_the_tag(
        self,
    ) -> None:
        res = self.run_release("build-and-release")
        output = res.stdout + res.stderr
        self.assertEqual(res.returncode, 0, msg=output)
        self.assertEqual(self.ops(), [*self.PUSH_OPS, *self.RELEASE_OPS])
        self.assertNotIn("[warn]", output)

        # Every aws call that can carry a region does (the login password call has one too).
        for call in self.calls():
            if call["tool"] == "aws":
                self.assertEqual(self.arg(call, "--region"), self.REGION, msg=call)

        login = self.calls_of("docker login")[0]
        self.assertEqual(
            login["argv"],
            ["login", "--username", "AWS", "--password-stdin",
             f"{self.ACCOUNT}.dkr.ecr.{self.REGION}.amazonaws.com"],
        )  # fmt: skip
        self.assertEqual(login["stdin"], self.PASSWORD + "\n")
        build = self.calls_of("docker buildx build")[0]
        self.assertEqual(
            build["argv"],
            ["buildx", "build", "--platform", "linux/amd64", "--provenance=false",
             "--sbom=false", "--push", "-t", self.image_uri(self.TAG), "animation-verifier"],
        )  # fmt: skip
        self.assertEqual(Path(build["cwd"]).resolve(), REPO_ROOT.resolve())

        describe = self.calls_of("aws ecr describe-images")[0]
        self.assertEqual(self.arg(describe, "--repository-name"), VERIFIER)
        self.assertEqual(self.arg(describe, "--image-ids"), f"imageTag={self.TAG}")

        update = self.calls_of("aws lambda update-function-code")[0]
        self.assertEqual(self.arg(update, "--function-name"), VERIFIER)
        self.assertEqual(self.arg(update, "--image-uri"), self.image_uri(self.TAG))
        wait = self.calls_of("aws lambda wait function-updated")[0]
        self.assertEqual(self.arg(wait, "--function-name"), VERIFIER)

        invokes = self.calls_of("aws lambda invoke")
        for call in invokes:
            self.assertEqual(self.arg(call, "--function-name"), VERIFIER)
            self.assertEqual(self.arg(call, "--cli-binary-format"), "raw-in-base64-out")
        for call, role in zip(invokes, ("good", "bad")):
            self.assertEqual(
                call["payload"],
                {
                    "source": self.sources[role],
                    "kind": self.companions[role]["kind"],
                    "required_tokens": self.companions[role]["required_tokens"],
                    "forbidden_tokens": self.companions[role]["forbidden_tokens"],
                    "contract_version": self.contract_version,
                },
            )

        put = self.calls_of("aws ssm put-parameter")[0]
        self.assertEqual(self.arg(put, "--name"), self.PARAM)
        self.assertEqual(self.arg(put, "--value"), self.TAG)
        self.assertIn("--overwrite", put["argv"])
        self.assertNotIn("aws ssm add-tags-to-resource", self.ops())

        # The account id is masked first and then stays out of the log; no password, no source.
        self.assertEqual(res.stdout.splitlines()[0], f"::add-mask::{self.ACCOUNT}")
        for line in output.splitlines()[1:]:
            self.assertNotIn(self.ACCOUNT, line)
        self.assertNotIn(self.PASSWORD, output)
        self.assertNotIn(self.sources["good"][:60], output)
        self.assertNotIn(self.sources["bad"][:60], output)

    def test_a_new_parameter_is_tagged_after_it_is_written(self) -> None:
        res = self.run_release("build-and-release", scenario=self.scenario(previous_tag=None))
        self.assertEqual(res.returncode, 0, msg=res.stdout + res.stderr)
        self.assertEqual(self.ops(), [*self.PUSH_OPS, *self.RELEASE_OPS, "aws ssm add-tags-to-resource"])
        tagging = self.calls_of("aws ssm add-tags-to-resource")[0]
        self.assertEqual(self.arg(tagging, "--resource-type"), "Parameter")
        self.assertEqual(self.arg(tagging, "--resource-id"), self.PARAM)
        self.assertEqual(tagging["argv"][tagging["argv"].index("--tags") + 1 :], self.EXPECTED_TAGS)

    def test_the_push_is_skipped_when_the_tag_is_already_in_ecr(self) -> None:
        res = self.run_release("build-and-release", scenario=self.scenario(ecr_tags=[self.TAG]))
        self.assertEqual(res.returncode, 0, msg=res.stdout + res.stderr)
        self.assertEqual(
            self.ops(),
            ["aws sts get-caller-identity", "aws ecr describe-images", *self.RELEASE_OPS],
        )
        self.assertFalse([op for op in self.ops() if op.startswith("docker")])
        self.assertIn("already in ECR", res.stdout)

    # ---- failed checks roll back (Requirement 37.7) ----

    def test_a_failed_check_rolls_back_to_the_previous_tag_and_leaves_the_parameter_alone(
        self,
    ) -> None:
        bad_ok = {"ok": True, "diagnostics": []}
        cases = {
            "the bad fixture comes back ok=true": (
                {"invoke": [{"response": self.good_response()}, {"response": bad_ok}]},
                "expected ok=false, got ok=true",
            ),
            "the good fixture comes back ok=false": (
                {"invoke": [{"response": self.bad_response("TSC_2322")}]},
                "expected ok=true, got ok=false",
            ),
            "the good fixture raises a FunctionError": (
                {"invoke": [{"function_error": "Unhandled", "response": {"errorType": "Boom"}}]},
                "returned FunctionError Unhandled",
            ),
            "the bad fixture raises a FunctionError": (
                {"invoke": [
                    {"response": self.good_response()},
                    {"function_error": "Unhandled", "response": {"errorType": "Boom"}},
                ]},
                "bad fixture invocation returned FunctionError Unhandled",
            ),  # fmt: skip
            "the bad fixture lacks an expected code": (
                {"invoke": [
                    {"response": self.good_response()},
                    {"response": {"ok": False, "diagnostics": [{"code": "TSC_2322"}]}},
                ]},
                f"codes missing from the result: {','.join(self.expected_codes)}",
            ),  # fmt: skip
            "the bad fixture carries a VERIFIER_ code": (
                {"invoke": [
                    {"response": self.good_response()},
                    {"response": self.bad_response("VERIFIER_INTERNAL")},
                ]},
                "the verifier reported its own failure: VERIFIER_INTERNAL",
            ),  # fmt: skip
            "the answer is not a Verifier_Result": (
                {"invoke": [
                    {"response": self.good_response()},
                    {"response": {"errorMessage": "Task timed out"}},
                ]},
                "the response is not a Verifier_Result",
            ),  # fmt: skip
            "the invoke command itself fails": (
                {"invoke": [{"rc": 255, "stderr": "Read timeout on endpoint URL\n"}]},
                "invoking the good fixture failed",
            ),
            "update-function-code fails": (
                {"update_rc": [254, 0]},
                "update-function-code to sha-abcdef0 failed",
            ),
            "the function never reaches function-updated": (
                {"wait_rc": [255, 0]},
                "did not reach function-updated for sha-abcdef0",
            ),
        }
        for name, (overrides, message) in cases.items():
            with self.subTest(name):
                res = self.run_release("build-and-release", scenario=self.scenario(**overrides))
                self.assertEqual(res.returncode, 1, msg=res.stdout + res.stderr)
                self.assertIn(message, res.stderr)
                self.assertIn(f"rolling lore-prod-animation-verifier back to {self.PREVIOUS_TAG}",
                              res.stderr)
                self.assertIn("[fail] release of sha-abcdef0 failed its checks", res.stderr)
                self.assert_rolled_back_to_previous()

    def test_a_failed_check_without_a_previous_tag_still_fails_the_job(self) -> None:
        scenario = self.scenario(
            previous_tag=None,
            invoke=[{"response": self.good_response()}, {"response": {"ok": True, "diagnostics": []}}],
        )
        res = self.run_release("build-and-release", scenario=scenario)
        self.assertEqual(res.returncode, 1, msg=res.stdout + res.stderr)
        self.assertIn("no previous tag", res.stderr)
        self.assertEqual(len(self.calls_of("aws lambda update-function-code")), 1)
        self.assert_parameter_untouched()

    def test_a_rollback_that_fails_too_is_reported_and_the_job_still_fails(self) -> None:
        scenario = self.scenario(
            update_rc=[0, 254],
            invoke=[{"response": self.good_response()}, {"response": {"ok": True, "diagnostics": []}}],
        )
        res = self.run_release("build-and-release", scenario=scenario)
        self.assertEqual(res.returncode, 1, msg=res.stdout + res.stderr)
        self.assertIn(f"the rollback to {self.PREVIOUS_TAG} failed too", res.stderr)
        self.assert_parameter_untouched()

    # ---- an unclear answer is never read as "not there" ----

    def test_an_unclear_answer_from_aws_or_docker_stops_the_run_without_writing_anything(
        self,
    ) -> None:
        cases = {
            "sts fails": ({"sts_fails": True}, ["aws sts get-caller-identity"]),
            "describe-images is refused": (
                {"describe_error": True},
                ["aws sts get-caller-identity", "aws ecr describe-images"],
            ),
            "docker login fails": ({"docker_rc": {"docker login": 1}}, self.PUSH_OPS[:4]),
            "docker build fails": ({"docker_rc": {"docker buildx build": 1}}, self.PUSH_OPS),
            "get-function is refused": (
                {"get_function_error": True}, [*self.PUSH_OPS, "aws lambda get-function"]
            ),
            "get-parameter is refused": (
                {"get_parameter_error": True},
                [*self.PUSH_OPS, "aws lambda get-function", "aws ssm get-parameter"],
            ),
        }  # fmt: skip
        for name, (overrides, expected_ops) in cases.items():
            with self.subTest(name):
                res = self.run_release("build-and-release", scenario=self.scenario(**overrides))
                self.assertEqual(res.returncode, 1, msg=res.stdout + res.stderr)
                self.assertIn("[fail]", res.stderr)
                self.assertEqual(self.ops(), expected_ops)

    # ---- the smoke manifest is checked before anything is pushed or changed ----

    def make_repo(self, manifest: dict | str) -> Path:
        """A minimal repository layout around a copy of the script, for manifest problems."""
        repo = self.tmp / "repo"
        shutil.rmtree(repo, ignore_errors=True)
        (repo / "scripts" / "ci").mkdir(parents=True)
        script = repo / "scripts" / "ci" / "verifier-release.sh"
        shutil.copy2(self.SCRIPT, script)
        fixtures = repo / "animation-verifier" / "fixtures"
        (fixtures / "good").mkdir(parents=True)
        (fixtures / "bad").mkdir()
        (fixtures / "good" / "g.ts").write_text("export const g = 1;\n", encoding="utf-8")
        (fixtures / "bad" / "b.ts").write_text("export const b = 1;\n", encoding="utf-8")
        (repo / "animation-verifier" / "contract").mkdir()
        (repo / "animation-verifier" / "contract" / "animation-contract.json").write_text(
            '{"contract_version": 1}\n', encoding="utf-8"
        )
        text = manifest if isinstance(manifest, str) else json.dumps(manifest)
        (fixtures / "release-smoke.json").write_text(text, encoding="utf-8")
        return script

    def test_a_manifest_problem_stops_the_run_before_any_call(self) -> None:
        good = {"source": "good/g.ts"}
        bad = {"source": "bad/b.ts", "expected_codes": ["FIDELITY_TOKEN_MISSING"]}
        # The control: this manifest is fine, so the cases below fail because of what they change.
        script = self.make_repo({"good": good, "bad": bad})
        res = self.run_release(
            "build-and-release", scenario=self.scenario(ecr_tags=[self.TAG]), script=script
        )
        self.assertEqual(res.returncode, 0, msg=res.stdout + res.stderr)

        cases = {
            "not JSON": ("{", "bad.expected_codes"),
            "no good entry": ({"bad": bad}, "has no good.source"),
            "no bad entry": ({"good": good}, "bad.expected_codes"),
            "empty expected_codes": (
                {"good": good, "bad": {**bad, "expected_codes": []}}, "bad.expected_codes"),
            "a VERIFIER_ code is expected": (
                {"good": good, "bad": {**bad, "expected_codes": ["VERIFIER_INTERNAL"]}},
                "bad.expected_codes"),
            "a path climbs out of the fixtures": (
                {"good": {"source": "../contract/animation-contract.json"}, "bad": bad},
                "unsafe fixture path"),
            "an absolute path": (
                {"good": {"source": "/etc/passwd"}, "bad": bad}, "unsafe fixture path"),
            "a fixture is missing": (
                {"good": {"source": "good/missing.ts"}, "bad": bad}, "not found"),
            "a companion is missing": (
                {"good": {**good, "companion": "good/g.json"}, "bad": bad}, "not found"),
        }  # fmt: skip
        for name, (manifest, message) in cases.items():
            with self.subTest(name):
                script = self.make_repo(manifest)
                res = self.run_release("build-and-release", script=script)
                self.assertEqual(res.returncode, 1, msg=res.stdout + res.stderr)
                self.assertIn(message, res.stderr)
                self.assertEqual(self.calls(), [])


class WebReleaseWorkflowTest(unittest.TestCase):
    """Guard how the web release passes the animation flag to the image build (task 33.4).

    Requirements 36.1, 36.2, 36.13 and 36.14. `release-web.yml` and `frontend/Dockerfile` are read
    as text, so nothing here needs Docker, GitHub or a YAML library (a PyYAML cross-check runs
    only where PyYAML is installed). The checks are functions of the file text: the real files
    must give no problem, and a broken copy of each (a line removed, a default flipped, an
    expression that could inject into a shell) must give one, so a guard that stops guarding
    shows up as a failing test. What this cannot show is that GitHub accepts the workflow; that
    stays `[belum diverifikasi]` until the workflow has run once.
    """

    try:
        import yaml as _yaml
    except ImportError:  # the text checks below do not need it
        _yaml = None

    WORKFLOW = REPO_ROOT / ".github" / "workflows" / "release-web.yml"
    DOCKERFILE = REPO_ROOT / "frontend" / "Dockerfile"
    FLAG = "NEXT_PUBLIC_ANIMATIONS"
    # The one build argument, byte for byte (Requirement 36.2): an unset or empty repository
    # variable builds with the flag off, and no github.event value reaches a shell.
    BUILD_ARGS = "build-args: NEXT_PUBLIC_ANIMATIONS=${{ vars.NEXT_PUBLIC_ANIMATIONS || 'off' }}"
    BUILD_ARGS_INDENT = " " * 10  # a key of `with:` of a step of a job
    NEW_PATHS = ("frontend/sandbox-runtime/**", "frontend/scripts/**")
    OLD_PATHS = (
        "frontend/src/**",
        "frontend/public/**",
        "frontend/package.json",
        "frontend/package-lock.json",
        "frontend/next.config.ts",
        "frontend/tsconfig.json",
        "frontend/.nvmrc",
        "frontend/Dockerfile",
        "frontend/.dockerignore",
        "scripts/ci/ssm-deploy.sh",
        ".github/workflows/release-web.yml",
    )
    DOCKER_ARG = "ARG NEXT_PUBLIC_ANIMATIONS=off"
    DOCKER_ENV = "ENV NEXT_PUBLIC_ANIMATIONS=${NEXT_PUBLIC_ANIMATIONS}"

    # ---- readers: small functions of the text ----

    @staticmethod
    def code_lines(text: str) -> list[str]:
        """Lines that are neither blank nor a comment."""
        return [
            line for line in text.splitlines() if line.strip() and not line.lstrip().startswith("#")
        ]

    @classmethod
    def push_paths(cls, text: str) -> list[str]:
        """Entries of `on.push.paths`, quotes removed."""
        paths: list[str] = []
        state = "outside"
        for line in cls.code_lines(text):
            if state == "outside":
                if re.fullmatch(r"  push:\s*", line):
                    state = "push"
            elif state == "push":
                if re.fullmatch(r"    paths:\s*", line):
                    state = "paths"
                elif not line.startswith("    "):
                    break  # left `push:`
            else:
                item = re.fullmatch(r"      - (.+?)\s*", line)
                if item is None:
                    break
                paths.append(item.group(1).strip("\"'"))
        return paths

    @staticmethod
    def steps(text: str) -> list[tuple[str, list[str]]]:
        """`(job, lines)` for every step of every job; a step starts at a `- ` at indent 6."""
        found: list[tuple[str, list[str]]] = []
        in_jobs = False
        job = ""
        current: tuple[str, list[str]] | None = None
        for line in text.splitlines():
            bare = line.strip()
            indent = len(line) - len(line.lstrip())
            if not bare or bare.startswith("#"):
                if current is not None:
                    current[1].append(line)
            elif indent == 0:
                in_jobs = bare == "jobs:"
                current = None
            elif not in_jobs:
                continue
            elif indent == 2 and bare.endswith(":"):
                job = bare[:-1]
                current = None
            elif indent == 6 and bare.startswith("- "):
                current = (job, [line])
                found.append(current)
            elif indent < 6:
                current = None
            elif current is not None:
                current[1].append(line)
        return found

    # ---- the checks ----

    @classmethod
    def check_workflow(cls, text: str) -> list[str]:
        """Problems with `release-web.yml`; empty when it is right."""
        problems: list[str] = []

        builds = [
            (job, lines)
            for job, lines in cls.steps(text)
            if any(re.search(r"\buses:\s*docker/build-push-action@", ln) for ln in lines)
        ]
        if len(builds) != 1:
            problems.append(f"expected one docker/build-push-action step, found {len(builds)}")
        else:
            job, lines = builds[0]
            if job != "build":
                problems.append(f'the docker/build-push-action step is in job "{job}", not "build"')
            found = [ln for ln in lines if ln.strip().startswith("build-args:")]
            if found != [cls.BUILD_ARGS_INDENT + cls.BUILD_ARGS]:
                problems.append(
                    f"build-args must be the one line {cls.BUILD_ARGS!r} under with:, "
                    f"found {found!r}"
                )

        paths = cls.push_paths(text)
        for path in (*cls.NEW_PATHS, *cls.OLD_PATHS):
            if paths.count(path) != 1:
                problems.append(
                    f"push path {path!r} must be listed once, found {paths.count(path)}"
                )

        # The `tag` input did not change (rollback without a build, Requirement 36.14).
        for line in ('      tag:', '        required: false', '        default: ""'):
            if text.splitlines().count(line) != 1:
                problems.append(
                    f"workflow_dispatch input tag: expected exactly one {line.strip()!r}"
                )

        code = "\n".join(cls.code_lines(text))
        # `github.event_name` is fine (a pull request cannot set it); `github.event.<field>` is not.
        forbidden = (
            (r"github\.event\.", "github.event.*"),
            (r"github\.head_ref", "github.head_ref"),
        )
        for pattern, label in forbidden:
            if re.search(pattern, code):
                problems.append(f"the workflow uses {label}, which must not reach a shell")
        for action in re.findall(r"\buses:\s*(\S+)", code):
            if not re.fullmatch(r"[\w./-]+@[0-9a-f]{40}", action):
                problems.append(f"action not pinned to a 40 hexadecimal commit: {action}")
        if not re.search(r"^permissions: \{\}\s*$", text, re.MULTILINE):
            problems.append("the top-level permissions must stay {}")
        if re.search(r"\b\d{12}\b", code):
            problems.append("the workflow holds a 12 digit number (an AWS account id?)")
        return problems

    @classmethod
    def check_dockerfile(cls, text: str) -> list[str]:
        """Problems with how `frontend/Dockerfile` sets the flag; empty when it is right."""
        problems: list[str] = []
        lines = [line.strip() for line in cls.code_lines(text)]
        args = [i for i, ln in enumerate(lines) if re.fullmatch(rf"ARG {cls.FLAG}(=.*)?", ln)]
        envs = [i for i, ln in enumerate(lines) if re.fullmatch(rf"ENV {cls.FLAG}[= ].*", ln)]
        if len(args) != 1:
            problems.append(f"expected exactly one ARG {cls.FLAG}, found {len(args)}")
        elif lines[args[0]] != cls.DOCKER_ARG:
            problems.append(f'ARG must be exactly "{cls.DOCKER_ARG}", found "{lines[args[0]]}"')
        if len(envs) != 1:
            problems.append(f"expected exactly one ENV {cls.FLAG}, found {len(envs)}")
        elif lines[envs[0]] != cls.DOCKER_ENV:
            problems.append(f'ENV must be exactly "{cls.DOCKER_ENV}", found "{lines[envs[0]]}"')
        if len(args) != 1 or len(envs) != 1:
            return problems

        arg, env = args[0], envs[0]
        if env != arg + 1:
            problems.append("ENV must be the instruction right after ARG")
        stage = next((i for i in range(arg, -1, -1) if lines[i].startswith("FROM ")), None)
        if stage is None or not re.search(r"\sAS\s+build$", lines[stage], re.IGNORECASE):
            problems.append('ARG and ENV must be in the "build" stage')
        build = next(
            (i for i, ln in enumerate(lines) if re.match(r"RUN npm run build\b", ln)), None
        )
        if build is None:
            problems.append("the Dockerfile has no RUN npm run build")
        elif arg > build or env > build:
            problems.append("ARG and ENV must come before RUN npm run build")
        return problems

    # ---- tests ----

    def workflow_text(self) -> str:
        return self.WORKFLOW.read_text(encoding="utf-8")

    def dockerfile_text(self) -> str:
        return self.DOCKERFILE.read_text(encoding="utf-8")

    def test_the_real_workflow_passes_every_check(self) -> None:
        self.assertEqual(self.check_workflow(self.workflow_text()), [])

    def test_the_build_step_passes_exactly_the_flag_build_argument(self) -> None:
        text = self.workflow_text()
        self.assertEqual(text.count(self.BUILD_ARGS), 1)
        builds = [
            (job, lines)
            for job, lines in self.steps(text)
            if any("docker/build-push-action@" in ln for ln in lines)
        ]
        self.assertEqual([job for job, _ in builds], ["build"])
        self.assertIn(self.BUILD_ARGS_INDENT + self.BUILD_ARGS, builds[0][1])
        # The context is still `frontend`, where the Dockerfile with the ARG lives.
        self.assertIn("          context: frontend", builds[0][1])

    def test_both_new_path_filters_are_listed_and_the_old_ones_stay(self) -> None:
        paths = self.push_paths(self.workflow_text())
        for path in self.NEW_PATHS:
            self.assertEqual(paths.count(path), 1, path)
        self.assertEqual(sorted(paths), sorted((*self.NEW_PATHS, *self.OLD_PATHS)))

    def test_the_dockerfile_has_the_off_default_and_the_env_right_after_it(self) -> None:
        text = self.dockerfile_text()
        self.assertEqual(self.check_dockerfile(text), [])
        lines = text.split("\n")
        arg = lines.index(self.DOCKER_ARG)
        self.assertEqual(lines[arg + 1], self.DOCKER_ENV)

    def test_a_broken_workflow_is_caught(self) -> None:
        real = self.workflow_text()
        line = self.BUILD_ARGS_INDENT + self.BUILD_ARGS
        shell = 'echo "tag=sha-${GITHUB_SHA::7}" >> "$GITHUB_OUTPUT"'
        cases = {
            "build-args removed": (line + "\n", "", "build-args"),
            "the default turned on": ("|| 'off' }}", "|| 'on' }}", "build-args"),
            "another variable": ("vars.NEXT_PUBLIC_ANIMATIONS", "vars.ANIMATIONS", "build-args"),
            "a second build argument": (
                line + "\n",
                line + "\n" + self.BUILD_ARGS_INDENT + "build-args: X=1\n",
                "build-args",
            ),
            "sandbox-runtime path removed": (
                '      - "frontend/sandbox-runtime/**"\n', "", "frontend/sandbox-runtime/**"),
            "scripts path removed": ('      - "frontend/scripts/**"\n', "", "frontend/scripts/**"),
            "an old path removed": ('      - "frontend/src/**"\n', "", "frontend/src/**"),
            "a path listed twice": (
                '      - "frontend/scripts/**"\n',
                '      - "frontend/scripts/**"\n      - "frontend/scripts/**"\n',
                "frontend/scripts/**",
            ),
            "github.event in a shell": (
                shell, 'echo "tag=${{ github.event.head_commit.message }}"', "github.event"),
            "an action not pinned": (
                "actions/checkout@11d5960a326750d5838078e36cf38b85af677262",
                "actions/checkout@v4",
                "not pinned",
            ),
            "tag no longer optional": ("        required: false", "        required: true", "tag"),
            "tag default changed": ('        default: ""', '        default: "sha-1234567"', "tag"),
            "permissions widened": (
                "permissions: {}", "permissions:\n  contents: write", "permissions"),
            "an account id": (
                "ghcr.io/nnaory/lore-web", "ghcr.io/nnaory/lore-web-999999999999", "12 digit"),
        }  # fmt: skip
        for name, (old, new, expected) in cases.items():
            with self.subTest(name):
                self.assertIn(old, real, "the case no longer matches the workflow")
                problems = self.check_workflow(real.replace(old, new, 1))
                self.assertTrue(
                    any(expected in problem for problem in problems),
                    msg=f"{expected!r} not in {problems!r}",
                )

    def test_a_broken_dockerfile_is_caught(self) -> None:
        real = self.dockerfile_text()
        arg, env, run = self.DOCKER_ARG, self.DOCKER_ENV, "RUN npm run build"
        pair = arg + "\n" + env + "\n"
        without_pair = real.replace(pair, "")
        cases = {
            "no ARG": (real.replace(arg + "\n", ""), "expected exactly one ARG"),
            "no ENV": (real.replace(env + "\n", ""), "expected exactly one ENV"),
            "default on": (
                real.replace(arg, "ARG NEXT_PUBLIC_ANIMATIONS=on"), "ARG must be exactly"),
            "no default": (real.replace(arg, "ARG NEXT_PUBLIC_ANIMATIONS"), "ARG must be exactly"),
            "ENV fixed to off": (
                real.replace(env, "ENV NEXT_PUBLIC_ANIMATIONS=off"), "ENV must be exactly"),
            "ENV before ARG": (
                real.replace(pair, env + "\n" + arg + "\n"), "right after ARG"),
            "a line between ARG and ENV": (
                real.replace(pair, arg + "\nARG OTHER=1\n" + env + "\n"), "right after ARG"),
            "in the runtime stage": (
                without_pair.replace("USER app", pair + "USER app"), '"build" stage'),
            "after npm run build": (
                without_pair.replace(run, run + "\n" + pair.rstrip("\n")),
                "before RUN npm run build"),
            "ARG twice": (real.replace(arg, arg + "\n" + arg), "expected exactly one ARG"),
            "only in comments": (
                without_pair.replace(run, "# " + arg + "\n# " + env + "\n" + run),
                "expected exactly one ARG"),
        }  # fmt: skip
        for name, (broken, expected) in cases.items():
            with self.subTest(name):
                self.assertNotEqual(broken, real, "the case did not change the Dockerfile")
                problems = self.check_dockerfile(broken)
                self.assertTrue(
                    any(expected in problem for problem in problems),
                    msg=f"{expected!r} not in {problems!r}",
                )

    @unittest.skipUnless(_yaml is not None, "needs PyYAML")
    def test_the_parsed_workflow_has_the_same_facts(self) -> None:
        doc = self._yaml.safe_load(self.workflow_text())
        trigger = doc.get("on", doc.get(True))  # YAML 1.1 reads the key `on` as True
        self.assertEqual(
            sorted(trigger["push"]["paths"]), sorted((*self.NEW_PATHS, *self.OLD_PATHS))
        )
        self.assertEqual(
            trigger["workflow_dispatch"]["inputs"]["tag"],
            {
                "description": "Tag sha-xxxxxxx untuk rollback (melewati build)",
                "required": False,
                "default": "",
            },
        )
        self.assertEqual(doc["permissions"], {})
        build = [
            step
            for step in doc["jobs"]["build"]["steps"]
            if str(step.get("uses", "")).startswith("docker/build-push-action@")
        ]
        self.assertEqual(len(build), 1)
        self.assertEqual(
            build[0]["with"]["build-args"],
            "NEXT_PUBLIC_ANIMATIONS=${{ vars.NEXT_PUBLIC_ANIMATIONS || 'off' }}",
        )
        self.assertFalse(
            [s for s in doc["jobs"]["deploy"]["steps"] if "build-args" in (s.get("with") or {})]
        )


class VerifierWorkflowTest(unittest.TestCase):
    """Static checks of .github/workflows/release-verifier.yml (task 33.2).

    Requirements 37.4, 37.5, 37.8, 37.9, 37.13 and design 8.4. The `terraform` job runs this file
    with the runner's bare python3, which has no YAML library, so the workflow is read with a
    small indentation-based reader. It is enough for the shape these workflows have: nested
    mappings, `- item` lists and one-line values. `problems()` turns a workflow text into a list
    of findings. The real file must have none, and every mutation in MUTATIONS must be found, so
    a check that stopped looking fails here instead of passing silently.

    This proves the file has the intended shape. It does not prove that GitHub accepts the
    workflow, or that the OIDC role may be assumed from the `production-release` environment:
    both show only when the workflow runs on a pull request or on main.
    """

    WORKFLOWS = REPO_ROOT / ".github" / "workflows"
    WORKFLOW = WORKFLOWS / "release-verifier.yml"
    SCRIPT = "scripts/ci/verifier-release.sh"
    # Design 8.4: the same SHA as the jobs that already exist in these two workflows.
    PIN_SOURCES = (WORKFLOWS / "ci.yml", WORKFLOWS / "release-web.yml")
    REQUIRED_ACTIONS = (
        "actions/checkout",
        "aws-actions/configure-aws-credentials",
        "docker/setup-buildx-action",
    )
    EXPECTED_PATHS = [
        "animation-verifier/**",
        SCRIPT,
        ".github/workflows/release-verifier.yml",
    ]
    EXPECTED_RUN = f'{SCRIPT} build-and-release "$TAG_INPUT"'
    GROUP = "lore-prod-deploy-verifier"
    ENVIRONMENT = "production-release"
    KEY = re.compile(r"^([A-Za-z0-9_.-]+):(?:\s+(.*))?$")
    PINNED = re.compile(
        r"^(?P<action>[\w.-]+/[\w.-]+(?:/[\w./-]+)?)@(?P<sha>[0-9a-f]{40})(?:\s+#.*)?$"
    )
    USES_LINE = re.compile(r"^\s*(?:-\s+)?uses:\s*(\S+?)@([0-9a-f]{40})\b", re.M)

    # name: (text to replace, replacement, fragment the finding must contain)
    MUTATIONS = {
        "an unpinned action": (
            "actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4",
            "actions/checkout@v4",
            "not pinned",
        ),
        "a short SHA": (
            "actions/checkout@11d5960a326750d5838078e36cf38b85af677262",
            "actions/checkout@11d5960",
            "not pinned",
        ),
        "a pin that differs from the existing workflows": (
            "docker/setup-buildx-action@8d2750c68a42422c14e847fe6c8ac0403b4cbd6f",
            "docker/setup-buildx-action@8d2750c68a42422c14e847fe6c8ac0403b4cbd6e",
            "differs",
        ),
        "no environment": (
            "    environment: production-release\n", "", "environment must be production-release",
        ),
        "another environment": (
            "environment: production-release", "environment: production",
            "environment must be production-release",
        ),
        "another concurrency group": (
            "group: lore-prod-deploy-verifier", "group: lore-prod-deploy-api", "concurrency group",
        ),
        "a run that cancels the running one": (
            "cancel-in-progress: false", "cancel-in-progress: true", "cancel-in-progress",
        ),
        "no cancel-in-progress": (
            "  cancel-in-progress: false\n", "", "cancel-in-progress",
        ),
        "an extra path": (
            '      - "scripts/ci/verifier-release.sh"\n',
            '      - "scripts/ci/verifier-release.sh"\n      - "frontend/**"\n',
            "push paths",
        ),
        "a missing path": (
            '      - "scripts/ci/verifier-release.sh"\n', "", "push paths",
        ),
        "a second branch": ("branches: [main]", "branches: [main, dev]", "branches [main]"),
        "a pull_request trigger": (
            "  workflow_dispatch:\n", "  pull_request:\n  workflow_dispatch:\n", "triggers",
        ),
        "no tag input": ("      tag:\n", "      other:\n", "input tag"),
        "a required tag input": ("required: false", "required: true", "input tag"),
        "permissions for every job": (
            "permissions: {}", "permissions: write-all", "permissions: {}",
        ),
        "no OIDC permission": ("      id-token: write\n", "", "job permissions"),
        "write access to contents": (
            "      contents: read\n", "      contents: write\n", "job permissions",
        ),
        "another role": (
            "${{ vars.AWS_ROLE_DEPLOY_ARN }}", "${{ vars.AWS_ROLE_APPLY_ARN }}", "role-to-assume",
        ),
        "the tag in the shell text": (
            'build-and-release "$TAG_INPUT"', 'build-and-release "${{ inputs.tag }}"', "run:",
        ),
        "no tag argument": ('build-and-release "$TAG_INPUT"', "build-and-release", "run:"),
        "another script mode": ('build-and-release "$TAG_INPUT"', 'release "$TAG_INPUT"', "run:"),
        "a tag input that is not passed": (
            "TAG_INPUT: ${{ inputs.tag }}", "TAG_INPUT: ''", "TAG_INPUT",
        ),
        "a secret": (
            "TAG_INPUT: ${{ inputs.tag }}",
            "TAG_INPUT: ${{ inputs.tag }}\n          KEY: ${{ secrets.AWS_KEY }}",
            "secrets",
        ),
        "an account id": (
            "TAG_INPUT: ${{ inputs.tag }}",
            "TAG_INPUT: ${{ inputs.tag }}\n          ACCOUNT: 123456789012",
            "12-digit",
        ),
        "an access key id": (
            "TAG_INPUT: ${{ inputs.tag }}",
            "TAG_INPUT: ${{ inputs.tag }}\n          KEY: AKIAABCDEFGHIJKLMNOP",
            "access key",
        ),
    }

    # ---- a small YAML reader, enough for these workflows ----

    @staticmethod
    def indent(line: str) -> int:
        return len(line) - len(line.lstrip(" "))

    @staticmethod
    def code_lines(text: str) -> list[str]:
        """The lines of a workflow without full-line comments (they break the indent logic)."""
        return [line.rstrip() for line in text.splitlines() if not line.lstrip().startswith("#")]

    @classmethod
    def fields(cls, body: list[str]) -> dict[str, tuple[str, list[str]]]:
        """Group the lines of one mapping by its direct keys: key -> (one-line value, nested)."""
        rows = [line for line in body if line.strip()]
        if not rows:
            return {}
        base = min(cls.indent(line) for line in rows)
        found: dict[str, tuple[str, list[str]]] = {}
        key = None
        for line in rows:
            match = cls.KEY.match(line.strip()) if cls.indent(line) == base else None
            if match:
                key = match.group(1)
                found[key] = (match.group(2) or "", [])
            elif key is not None:
                found[key][1].append(line)
        return found

    @staticmethod
    def items(body: list[str]) -> list[str]:
        """The values of a `- item` list, without quotes."""
        return [
            re.sub(r"^-\s+", "", line.strip()).strip("\"'")
            for line in body
            if line.strip().startswith("- ")
        ]

    @classmethod
    def steps(cls, body: list[str]) -> list[dict[str, tuple[str, list[str]]]]:
        """Split a `steps:` list into one field mapping per step."""
        rows = [line for line in body if line.strip()]
        if not rows:
            return []
        base = min(cls.indent(line) for line in rows)
        groups: list[list[str]] = []
        for line in rows:
            if cls.indent(line) == base and line.lstrip().startswith("- "):
                groups.append([line[:base] + "  " + line[base + 2 :]])
            elif groups:
                groups[-1].append(line)
        return [cls.fields(group) for group in groups]

    @classmethod
    def reference_pins(cls) -> dict[str, set[str]]:
        """Action -> the commit SHAs the existing workflows pin it to."""
        pins: dict[str, set[str]] = {}
        for path in cls.PIN_SOURCES:
            for action, sha in cls.USES_LINE.findall(path.read_text(encoding="utf-8")):
                pins.setdefault(action, set()).add(sha)
        return pins

    @classmethod
    def problems(cls, text: str, references: dict[str, set[str]]) -> list[str]:
        """Every way the workflow text departs from design 8.4; an empty list means none."""
        found: list[str] = []

        def need(ok: bool, message: str) -> None:
            if not ok:
                found.append(message)

        def val(mapping: dict, key: str) -> str:
            return mapping.get(key, ("", []))[0]

        def sub(mapping: dict, key: str) -> dict:
            return cls.fields(mapping.get(key, ("", []))[1])

        top = cls.fields(cls.code_lines(text))
        need(val(top, "name") == "release-verifier", "name must be release-verifier")
        need(val(top, "permissions") == "{}", "top-level permissions: {} is required")

        triggers = sub(top, "on")
        need(sorted(triggers) == ["push", "workflow_dispatch"],
             f"triggers must be push and workflow_dispatch only, got {sorted(triggers)}")
        push = sub(triggers, "push")
        need(val(push, "branches") == "[main]", "push must be limited to branches [main]")
        paths = cls.items(push.get("paths", ("", []))[1])
        need(sorted(paths) == sorted(cls.EXPECTED_PATHS),
             f"push paths must be exactly {cls.EXPECTED_PATHS}, got {paths}")
        tag = sub(sub(sub(triggers, "workflow_dispatch"), "inputs"), "tag")
        need(val(tag, "required") == "false" and val(tag, "default") == '""',
             "workflow_dispatch needs the optional input tag with an empty default")

        concurrency = sub(top, "concurrency")
        need(val(concurrency, "group") == cls.GROUP, f"concurrency group must be {cls.GROUP}")
        need(val(concurrency, "cancel-in-progress") == "false",
             "concurrency needs cancel-in-progress: false")

        jobs = sub(top, "jobs")
        need(list(jobs) == ["release"], f"jobs must be exactly [release], got {list(jobs)}")
        job = sub(jobs, "release")
        need(val(job, "environment") == cls.ENVIRONMENT,
             f"environment must be {cls.ENVIRONMENT}")
        need({k: v[0] for k, v in sub(job, "permissions").items()}
             == {"contents": "read", "id-token": "write"},
             "job permissions must be exactly contents: read and id-token: write")

        steps = cls.steps(job.get("steps", ("", []))[1])
        uses = [val(step, "uses") for step in steps if val(step, "uses")]
        for ref in uses:
            match = cls.PINNED.match(ref)
            if not match:
                found.append(f"action not pinned to a 40-hex commit SHA: {ref}")
                continue
            known = references.get(match["action"], set())
            need(bool(known), f"no pin of {match['action']} in ci.yml or release-web.yml")
            need(not known or {match["sha"]} == known,
                 f"pin of {match['action']} differs from ci.yml and release-web.yml")
        names = [re.sub(r"@.*", "", ref) for ref in uses]
        for action in cls.REQUIRED_ACTIONS:
            need(action in names, f"step {action} is missing")

        configure_prefix = "aws-actions/configure-aws-credentials@"
        configure = next((s for s in steps if val(s, "uses").startswith(configure_prefix)), {})
        with_ = sub(configure, "with")
        need(val(with_, "role-to-assume") == "${{ vars.AWS_ROLE_DEPLOY_ARN }}",
             "role-to-assume must be ${{ vars.AWS_ROLE_DEPLOY_ARN }}")
        need(val(with_, "aws-region") == "${{ vars.AWS_REGION }}",
             "aws-region must be ${{ vars.AWS_REGION }}")

        runs = [s for s in steps if "run" in s]
        need(len(runs) == 1, f"exactly one run step is expected, got {len(runs)}")
        if runs:
            run = val(runs[0], "run")
            need(run == cls.EXPECTED_RUN, f"run: must be {cls.EXPECTED_RUN}, got {run}")
            need("${{" not in run, "run: must not interpolate an expression into the shell text")
            env = sub(runs[0], "env")
            need(val(env, "TAG_INPUT") == "${{ inputs.tag }}",
                 "env TAG_INPUT must be ${{ inputs.tag }}")
            need(val(env, "AWS_REGION") == "${{ vars.AWS_REGION }}",
                 "env AWS_REGION must be ${{ vars.AWS_REGION }}")
            position = steps.index(runs[0])
            need(all(i < position for i, s in enumerate(steps) if val(s, "uses")),
                 "the release step must come after every action step")

        need("secrets." not in text, "the workflow must not use the secrets context")
        need(not re.search(r"\b\d{12}\b", text), "a 12-digit number (account id) is in the file")
        need(not re.search(r"\b(AKIA|ASIA)[0-9A-Z]{16}\b", text), "an access key id is in the file")
        return found

    # ---- tests ----

    def read(self) -> str:
        return self.WORKFLOW.read_text(encoding="utf-8")

    def test_the_workflow_has_no_findings(self):
        self.assertEqual(self.problems(self.read(), self.reference_pins()), [])

    def test_every_uses_is_pinned_to_the_same_sha_as_the_existing_workflows(self):
        text = self.read()
        pinned = self.USES_LINE.findall(text)
        # A `uses:` line the pin pattern does not match (a tag or branch) would be missed above.
        self.assertEqual(len(pinned), len(re.findall(r"^\s*(?:-\s+)?uses:", text, re.M)))
        self.assertEqual({action for action, _ in pinned}, set(self.REQUIRED_ACTIONS))
        references = self.reference_pins()
        for action, sha in pinned:
            with self.subTest(action):
                self.assertRegex(sha, r"^[0-9a-f]{40}$")
                self.assertEqual(references.get(action), {sha})

    def test_the_job_runs_in_the_release_environment_with_minimal_permissions(self):
        top = self.fields(self.code_lines(self.read()))
        jobs = self.fields(top["jobs"][1])
        self.assertEqual(list(jobs), ["release"])
        release = self.fields(jobs["release"][1])
        self.assertEqual(release["environment"][0], self.ENVIRONMENT)
        self.assertEqual(top["permissions"][0], "{}")
        self.assertEqual(
            {k: v[0] for k, v in self.fields(release["permissions"][1]).items()},
            {"contents": "read", "id-token": "write"},
        )

    def test_concurrency_serialises_releases_without_cancelling_the_running_one(self):
        top = self.fields(self.code_lines(self.read()))
        concurrency = self.fields(top["concurrency"][1])
        self.assertEqual(concurrency["group"][0], self.GROUP)
        self.assertEqual(concurrency["cancel-in-progress"][0], "false")

    def test_it_runs_on_main_for_the_verifier_files_only_and_by_hand(self):
        top = self.fields(self.code_lines(self.read()))
        triggers = self.fields(top["on"][1])
        self.assertEqual(sorted(triggers), ["push", "workflow_dispatch"])
        push = self.fields(triggers["push"][1])
        self.assertEqual(push["branches"][0], "[main]")
        self.assertEqual(self.items(push["paths"][1]), self.EXPECTED_PATHS)
        inputs = self.fields(self.fields(triggers["workflow_dispatch"][1])["inputs"][1])
        tag = self.fields(inputs["tag"][1])
        self.assertEqual((tag["required"][0], tag["default"][0]), ("false", '""'))

    def test_the_release_step_calls_the_script_with_the_tag_from_the_environment(self):
        top = self.fields(self.code_lines(self.read()))
        job = self.fields(self.fields(top["jobs"][1])["release"][1])
        runs = [s for s in self.steps(job["steps"][1]) if "run" in s]
        self.assertEqual(len(runs), 1)
        self.assertEqual(runs[0]["run"][0], self.EXPECTED_RUN)
        env = self.fields(runs[0]["env"][1])
        self.assertEqual(env["TAG_INPUT"][0], "${{ inputs.tag }}")
        self.assertEqual(env["AWS_REGION"][0], "${{ vars.AWS_REGION }}")
        # The only `${{` on a line that is shell text would be an injectable expression.
        self.assertNotIn("${{", runs[0]["run"][0])

    def test_the_script_the_workflow_runs_exists_and_is_executable(self):
        script = REPO_ROOT / self.SCRIPT
        self.assertTrue(script.is_file())
        self.assertTrue(os.access(script, os.X_OK), "the workflow runs the script directly")
        for path in self.EXPECTED_PATHS:
            if "*" not in path:
                self.assertTrue((REPO_ROOT / path).is_file(), path)
        self.assertTrue((REPO_ROOT / "animation-verifier").is_dir())

    def test_no_secret_account_id_or_access_key_is_in_the_file(self):
        text = self.read()
        self.assertNotIn("secrets.", text)
        self.assertIsNone(re.search(r"\b\d{12}\b", text))
        self.assertIsNone(re.search(r"\b(AKIA|ASIA)[0-9A-Z]{16}\b", text))

    def test_each_mutation_of_the_workflow_is_found(self):
        text = self.read()
        references = self.reference_pins()
        for name, (old, new, fragment) in self.MUTATIONS.items():
            self.assertIn(old, text, f"the mutation '{name}' no longer matches the file")
            mutated = text.replace(old, new, 1)
            with self.subTest(name):
                self.assertNotEqual(mutated, text)
                found = self.problems(mutated, references)
                self.assertTrue(
                    any(fragment in message for message in found),
                    f"'{name}' was not reported (looking for {fragment!r}); got {found}",
                )

    def test_a_second_job_is_found(self):
        extra = "  other:\n    runs-on: ubuntu-latest\n    steps:\n      - run: 'true'\n"
        text = self.read() + extra
        found = self.problems(text, self.reference_pins())
        self.assertTrue(any("jobs must be exactly" in message for message in found), found)


class CiWorkflowTest(unittest.TestCase):
    """Static checks of the `verifier` and `contracts` jobs in .github/workflows/ci.yml (33.3).

    Requirements 37.1, 37.2, 37.3, 37.9, 3.6, 2.5, 38.8 and design 8.4. The `terraform` job runs
    this file with the runner's bare python3, so `ci.yml` is read with a small indentation-based
    reader (one-line values, `with:`/`env:` mappings and `run: |` blocks are all it needs) and a
    PyYAML cross-check runs only where PyYAML is installed. `problems()` turns a workflow text
    into findings. The real file must have none, and every entry of MUTATIONS must be found, so a
    check that stopped looking fails here instead of passing silently.

    What it guards: both new jobs exist with the expected steps in the expected order (Vitest,
    which writes the gitignored animation-verifier/.corpus-results.json, runs in the SAME job
    before the RIE script reads it); the four old jobs (`web`, `api`, `docker`, `terraform`) are
    still there with their signature commands, and `terraform` still runs `test-checkers.py -v`,
    the one job that also runs the smoke-script tests of scripts/verify; every `uses:` is pinned
    to a 40-hex SHA and one action has one SHA in the whole file; no job needs a secret or
    `id-token`; no new job can be skipped by an `if:` (a skipped job counts as a pass for a
    required check) or made non-blocking with `continue-on-error`.

    What it cannot show: that GitHub accepts the file, that `ci/verifier` passes (its
    `npm ci` fails until animation-verifier/package-lock.json is committed), or that the two new
    checks are required. Adding `ci/verifier` and `ci/contracts` to ruleset `protection-main` is
    a manual repository setting that waits for the user's approval.
    """

    try:
        import yaml as _yaml
    except ImportError:  # the text checks below do not need it
        _yaml = None

    WORKFLOW = REPO_ROOT / ".github" / "workflows" / "ci.yml"
    PKG = "animation-verifier"
    IMAGE = "lore-verifier:ci"
    RIE = "scripts/ci/verifier-rie-check.sh"
    SHELLCHECK = "shellcheck scripts/ci/*.sh"
    OLD_JOBS = ("web", "api", "docker", "terraform")
    NEW_JOBS = ("verifier", "contracts")
    # In order, each exactly one step (the design's `npx tsc --noEmit` plus the second tsconfig).
    VERIFIER_RUNS = (
        "npm ci",
        "npm run lint",
        "npx tsc --noEmit",
        "npm run typecheck",
        "npx vitest run",
    )
    NODE_WITH = {
        "node-version-file": "animation-verifier/.nvmrc",
        "cache": "npm",
        "cache-dependency-path": "animation-verifier/package-lock.json",
    }
    BUILD_WITH = {
        "context": "animation-verifier",
        "load": "true",
        "push": "false",
        "tags": IMAGE,
        "platforms": "linux/amd64",
        "provenance": "false",
        "sbom": "false",
    }
    CONTRACTS_RUNS = [
        "python3 scripts/sync-animation-contract.py --check",
        "python3 scripts/ci/check-animation-versions.py",
    ]
    # Signature of each old job: substrings of its `run` values, found in this order (one step may
    # hold several). Not a snapshot of the job, so a later edit that keeps these still passes.
    OLD_RUNS = {
        "web": (
            "npm ci",
            "npm run lint",
            "npx next typegen",
            "npx tsc --noEmit",
            "npx vitest run --testTimeout=60000",
            "npm run build",
        ),
        "api": ("pip install -r requirements-dev.txt", "alembic upgrade head", "pytest -q"),
        "docker": (
            "docker compose -f deploy/web/compose.yml config",
            "docker compose -f deploy/api/compose.yml config",
            "caddy validate",
        ),
        "terraform": (
            "terraform -chdir=infra fmt -check -recursive",
            "terraform -chdir=infra init -backend=false",
            "terraform -chdir=infra validate",
            "python3 -B scripts/ci/check-cost-static infra",
            "python3 -B scripts/ci/test-checkers.py -v",
            "scripts/verify/*.sh",
        ),
    }
    OLD_DEFAULT_DIRS = {"web": "frontend"}
    OLD_BUILD_CONTEXTS = {"docker": ["frontend", "backend"]}
    USES = re.compile(r"^\s*(?:-\s+)?uses:\s*(\S+)", re.M)
    PINNED = re.compile(r"([\w.-]+/[\w./-]+)@([0-9a-f]{40})")
    SHA_CHECKOUT = "actions/checkout@11d5960a326750d5838078e36cf38b85af677262"
    SHA_PYTHON = "actions/setup-python@a26af69be951a213d495a4c3e4e4022e16d87065 # v5"

    # (name, text to replace, replacement, replace the last occurrence, fragment of the finding)
    MUTATIONS = (
        ("an unpinned action in contracts", SHA_PYTHON, "actions/setup-python@v5", True,
         "not pinned"),
        ("a second SHA for one action", SHA_CHECKOUT, SHA_CHECKOUT[:-1] + "3", True,
         "more than one SHA"),
        ("a verifier image that is pushed", "          push: false\n          tags: lore-verifier",
         "          push: true\n          tags: lore-verifier", False, "build step"),
        ("a build with provenance", "          provenance: false\n", "", False, "build step"),
        ("a build with an SBOM", "          sbom: false\n", "", False, "build step"),
        ("another platform", "platforms: linux/amd64", "platforms: linux/arm64", False,
         "build step"),
        ("an image that is not loaded", "          load: true\n", "          load: false\n",
         False, "build step"),
        ("a RIE run on another image", "verifier-rie-check.sh lore-verifier:ci",
         "verifier-rie-check.sh lore-verifier:latest", False, "one step must run"),
        ("a RIE run inside the package", "        working-directory: .\n        run: scripts/ci/ver",
         "        run: scripts/ci/ver", False, "RIE step needs working-directory"),
        ("no Vitest in verifier", "      - run: npx vitest run\n", "", False, "npx vitest run"),
        ("no second tsconfig", "      - run: npm run typecheck\n", "", False, "npm run typecheck"),
        ("no lint in verifier", "      - run: npm run lint\n", "", True, "npm run lint"),
        ("no tsc in verifier", "      - run: npx tsc --noEmit\n", "", True, "npx tsc --noEmit"),
        ("no shellcheck in verifier", "        run: shellcheck scripts/ci/*.sh\n",
         "        run: echo skipped\n", False, "shellcheck scripts/ci"),
        ("a sync check that writes", "sync-animation-contract.py --check",
         "sync-animation-contract.py", False, "contracts: run steps"),
        ("no version check", "      - run: python3 scripts/ci/check-animation-versions.py\n", "",
         False, "contracts: run steps"),
        ("a verifier job that can be skipped", "  verifier:\n    runs-on: ubuntu-latest\n",
         "  verifier:\n    if: github.event_name == 'push'\n    runs-on: ubuntu-latest\n", False,
         "could skip"),
        ("a contracts job that cannot fail", "  contracts:\n    runs-on: ubuntu-latest\n",
         "  contracts:\n    runs-on: ubuntu-latest\n    continue-on-error: true\n", False,
         "continue-on-error"),
        ("no terraform job", "  terraform:\n", "  infra-checks:\n", False,
         "job terraform is missing"),
        ("a web job without the build", "      - run: npm run build\n", "", False, "web:"),
        ("a terraform job without test-checkers",
         "      - run: python3 -B scripts/ci/test-checkers.py -v\n", "", False, "terraform:"),
        ("an api job without migrations", "          alembic upgrade head\n", "", False, "api:"),
        ("a docker job without the compose check",
         "        run: docker compose -f deploy/web/compose.yml config >/dev/null",
         "        run: true", False, "docker:"),
        ("a secret", "      - run: npm ci\n",
         "      - run: npm ci\n        env:\n          T: ${{ secrets.NPM_TOKEN }}\n", True,
         "secrets"),
        ("an OIDC permission", "permissions:\n  contents: read\n",
         "permissions:\n  contents: read\n  id-token: write\n", False, "id-token"),
    )

    # ---- a small YAML reader, enough for this workflow ----

    @staticmethod
    def jobs(text: str) -> dict[str, list[str]]:
        """`job id -> its lines` (comments and blank lines dropped, indentation kept)."""
        found: dict[str, list[str]] = {}
        current: str | None = None
        in_jobs = False
        for line in text.splitlines():
            bare = line.strip()
            if not bare or bare.startswith("#"):
                continue
            indent = len(line) - len(line.lstrip(" "))
            if indent == 0:
                in_jobs = bare == "jobs:"
                current = None
            elif not in_jobs:
                continue
            elif indent == 2 and bare.endswith(":"):
                current = bare[:-1]
                found[current] = []
            elif current is not None:
                found[current].append(line)
        return found

    @staticmethod
    def _put(step: dict, text: str) -> str:
        """Store `key: value` in `step` and return the key. `key:` starts a nested mapping."""
        name, _, rest = text.partition(":")
        name, rest = name.strip(), rest.strip()
        if rest == "":
            step[name] = {}
        elif rest in ("|", "|-", ">", ">-"):
            step[name] = ""
        else:
            if name == "uses":
                rest = re.sub(r"\s+#.*$", "", rest)
            if len(rest) >= 2 and rest[0] == rest[-1] and rest[0] in "\"'":
                rest = rest[1:-1]
            step[name] = rest
        return name

    @classmethod
    def parse_steps(cls, lines: list[str]) -> list[dict]:
        """Steps of one job (`    steps:` at indent 4, each `- ` at indent 6) as dicts."""
        steps: list[dict] = []
        in_steps = False
        step: dict | None = None
        key: str | None = None
        for line in lines:
            bare = line.strip()
            indent = len(line) - len(line.lstrip(" "))
            if indent == 4:
                in_steps = bare == "steps:"
                step = None
            elif not in_steps:
                continue
            elif indent == 6 and bare.startswith("- "):
                step = {}
                steps.append(step)
                key = cls._put(step, bare[2:])
            elif step is None:
                continue
            elif indent == 8:
                key = cls._put(step, bare)
            elif key is not None:  # indent 10 and deeper: a nested mapping or a block scalar
                value = step[key]
                if isinstance(value, dict):
                    cls._put(value, bare)
                else:
                    step[key] = (value + "\n" + bare).strip()
        return steps

    # ---- the checks ----

    @classmethod
    def problems(cls, text: str) -> list[str]:
        """Findings for a `ci.yml` text; empty when it is right."""
        code = [ln for ln in text.splitlines() if ln.strip() and not ln.lstrip().startswith("#")]
        body = "\n".join(code)
        jobs = cls.jobs(text)
        found = [f"job {name} is missing" for name in (*cls.OLD_JOBS, *cls.NEW_JOBS)
                 if name not in jobs]
        found += cls.pin_problems(body)
        if "secrets." in body:
            found.append("ci.yml must not use secrets.* (Requirement 37.9)")
        if "id-token" in body:
            found.append("ci.yml must not ask for id-token: CI has no AWS access")
        for name in cls.OLD_JOBS:
            if name in jobs:
                found += cls.old_job_problems(name, jobs[name])
        for name in cls.NEW_JOBS:
            if name in jobs:
                found += cls.gate_problems(name, jobs[name])
        if "verifier" in jobs:
            found += cls.verifier_problems(jobs["verifier"])
        if "contracts" in jobs:
            found += cls.contracts_problems(jobs["contracts"])
        return found

    @classmethod
    def pin_problems(cls, body: str) -> list[str]:
        found: list[str] = []
        shas: dict[str, set[str]] = {}
        for ref in cls.USES.findall(body):
            pinned = cls.PINNED.fullmatch(ref)
            if pinned is None:
                found.append(f"{ref} is not pinned to a 40 hex commit SHA")
            else:
                shas.setdefault(pinned.group(1), set()).add(pinned.group(2))
        found += [f"{action} is pinned to more than one SHA" for action, seen in sorted(
            shas.items()) if len(seen) > 1]
        return found

    @staticmethod
    def default_dir(lines: list[str]) -> str | None:
        match = re.search(
            r"^    defaults:\n      run:\n        working-directory: (\S+)$", "\n".join(lines), re.M
        )
        return match.group(1) if match else None

    @classmethod
    def old_job_problems(cls, name: str, lines: list[str]) -> list[str]:
        found: list[str] = []
        steps = cls.parse_steps(lines)
        runs = [str(s.get("run", "")) for s in steps]
        at = 0
        for command in cls.OLD_RUNS[name]:
            hits = [i for i in range(at, len(runs)) if command in runs[i]]
            if not hits:
                found.append(f"{name}: no step runs `{command}` at or after the previous one")
            else:
                at = hits[0]
        if cls.default_dir(lines) != cls.OLD_DEFAULT_DIRS.get(name):
            found.append(f"{name}: the default working directory changed")
        if name in cls.OLD_BUILD_CONTEXTS:
            contexts = [
                (s.get("with") or {}).get("context")
                for s in steps
                if str(s.get("uses", "")).startswith("docker/build-push-action@")
            ]
            if contexts != cls.OLD_BUILD_CONTEXTS[name]:
                found.append(f"{name}: image build contexts are {contexts}")
        return found

    @classmethod
    def gate_problems(cls, name: str, lines: list[str]) -> list[str]:
        """Things that would let a new job pass without doing its work."""
        found: list[str] = []
        joined = "\n".join(lines)
        if "    runs-on: ubuntu-latest" not in lines:
            found.append(f"{name}: runs-on must be ubuntu-latest")
        if re.search(r"^\s*(?:-\s+)?if:", joined, re.M):
            found.append(f"{name}: an if: could skip the job, and a skipped job counts as a pass")
        if "continue-on-error" in joined:
            found.append(f"{name}: continue-on-error would hide a failure")
        steps = cls.parse_steps(lines)
        if not steps or not str(steps[0].get("uses", "")).startswith("actions/checkout@"):
            found.append(f"{name}: the first step must be actions/checkout")
        return found

    @staticmethod
    def wrong_with(step: dict | None, want: dict[str, str]) -> dict[str, object]:
        """Entries of `want` that `step.with` lacks or has with another value."""
        got = (step or {}).get("with")
        got = got if isinstance(got, dict) else {}
        return {k: got.get(k) for k, v in want.items() if got.get(k) != v}

    @classmethod
    def verifier_problems(cls, lines: list[str]) -> list[str]:
        found: list[str] = []
        steps = cls.parse_steps(lines)
        if cls.default_dir(lines) != cls.PKG:
            found.append(f"verifier: the default working directory must be {cls.PKG}")

        def uses(prefix: str) -> list[int]:
            return [i for i, s in enumerate(steps) if str(s.get("uses", "")).startswith(prefix)]

        node = uses("actions/setup-node@")
        if len(node) != 1 or cls.wrong_with(steps[node[0]], cls.NODE_WITH):
            found.append(f"verifier: one setup-node step with {cls.NODE_WITH} is required")
        last = -1
        for command in cls.VERIFIER_RUNS:
            hits = [i for i, s in enumerate(steps) if s.get("run") == command]
            if len(hits) != 1 or hits[0] <= last:
                found.append(f"verifier: `{command}` must be one step, after the previous one")
            else:
                last = hits[0]
        tests = [i for i, s in enumerate(steps) if s.get("run") == "npx vitest run"]
        shell = [i for i, s in enumerate(steps) if s.get("run") == cls.SHELLCHECK]
        if len(shell) != 1 or steps[shell[0]].get("working-directory") != ".":
            found.append(f"verifier: one step `{cls.SHELLCHECK}` with working-directory . needed")
        buildx, builds = uses("docker/setup-buildx-action@"), uses("docker/build-push-action@")
        if len(builds) != 1:
            found.append("verifier: expected one docker/build-push-action step")
        else:
            wrong = cls.wrong_with(steps[builds[0]], cls.BUILD_WITH)
            if wrong:
                found.append(f"verifier: build step settings differ from the design: {wrong}")
            if not buildx or buildx[0] > builds[0]:
                found.append("verifier: docker/setup-buildx-action must come before the build")
        want_run = f"{cls.RIE} {cls.IMAGE} {cls.PKG}"
        rie = [i for i, s in enumerate(steps) if s.get("run") == want_run]
        if len(rie) != 1:
            found.append(f"verifier: one step must run `{want_run}`")
        else:
            if steps[rie[0]].get("working-directory") != ".":
                found.append("verifier: the RIE step needs working-directory . (repository root)")
            if not tests or not builds or rie[0] < max(tests[0], builds[0]):
                found.append("verifier: the RIE step must come after Vitest and the image build")
        return found

    @classmethod
    def contracts_problems(cls, lines: list[str]) -> list[str]:
        found: list[str] = []
        steps = cls.parse_steps(lines)
        python = [s for s in steps if str(s.get("uses", "")).startswith("actions/setup-python@")]
        if len(python) != 1 or cls.wrong_with(python[0], {"python-version": "3.12"}):
            found.append("contracts: one setup-python step with python-version 3.12 is required")
        runs = [s["run"] for s in steps if "run" in s]
        if runs != cls.CONTRACTS_RUNS:
            found.append(f"contracts: run steps must be exactly {cls.CONTRACTS_RUNS}, got {runs}")
        return found

    @staticmethod
    def mutate(text: str, old: str, new: str, last: bool) -> str:
        if last:
            head, _, tail = text.rpartition(old)
            return head + new + tail
        return text.replace(old, new, 1)

    # ---- the tests ----

    def setUp(self) -> None:
        self.text = self.WORKFLOW.read_text(encoding="utf-8")

    def test_the_real_workflow_has_no_problems(self) -> None:
        self.assertEqual(self.problems(self.text), [])

    def test_every_mutation_is_found(self) -> None:
        for name, old, new, last, fragment in self.MUTATIONS:
            with self.subTest(name):
                self.assertIn(old, self.text, msg="stale mutation: the text is not in ci.yml")
                mutated = self.mutate(self.text, old, new, last)
                self.assertNotEqual(mutated, self.text)
                findings = self.problems(mutated)
                self.assertTrue(
                    any(fragment in f for f in findings),
                    msg=f"no finding contains {fragment!r}: {findings}",
                )

    def test_both_new_jobs_and_the_four_old_jobs_exist(self) -> None:
        self.assertTrue(set(self.jobs(self.text)).issuperset({*self.OLD_JOBS, *self.NEW_JOBS}))

    def test_no_job_has_a_name_that_would_rename_its_check(self) -> None:
        """Check names `ci/<job>` come from the job ids, so no job may have a `name:`."""
        for name, lines in self.jobs(self.text).items():
            with self.subTest(name):
                self.assertFalse(
                    [ln for ln in lines if ln.startswith("    name:")],
                    msg="a job `name:` would rename the check that protection-main matches",
                )

    def test_files_the_jobs_run_exist(self) -> None:
        rie = REPO_ROOT / self.RIE
        self.assertTrue(rie.is_file(), msg=str(rie))
        self.assertTrue(os.access(rie, os.X_OK), msg="the job runs the script directly")
        for path in (
            "scripts/sync-animation-contract.py",
            "scripts/ci/check-animation-versions.py",
            f"{self.PKG}/Dockerfile",
            f"{self.PKG}/package.json",
        ):
            with self.subTest(path):
                self.assertTrue((REPO_ROOT / path).is_file())
        self.assertEqual(
            (REPO_ROOT / self.PKG / ".nvmrc").read_text(encoding="utf-8").strip(), "22",
            msg="Requirement 37.1: the verifier job runs on Node 22",
        )
        scripts = json.loads((REPO_ROOT / self.PKG / "package.json").read_text(encoding="utf-8"))
        self.assertIn("lint", scripts["scripts"])
        self.assertIn("typecheck", scripts["scripts"])
        self.assertTrue(list((REPO_ROOT / "scripts" / "ci").glob("*.sh")))

    def test_the_terraform_job_still_runs_the_checker_tests(self) -> None:
        """That job runs this file, which imports the scripts/verify smoke tests above."""
        lines = self.jobs(self.text)["terraform"]
        runs = [str(s.get("run", "")) for s in self.parse_steps(lines)]
        self.assertIn("python3 -B scripts/ci/test-checkers.py -v", runs)
        self.assertTrue(any(r.startswith("shellcheck ") and "scripts/ci/*.sh" in r for r in runs))
        self.assertTrue(callable(SmokeScriptTest) and callable(SmokeScriptStaticTest))

    @unittest.skipIf(_yaml is None, "PyYAML is not installed")
    def test_the_reader_agrees_with_a_real_yaml_parser(self) -> None:
        doc = self._yaml.safe_load(self.text)
        jobs = self.jobs(self.text)
        self.assertEqual(sorted(doc["jobs"]), sorted(jobs))
        for name, job in doc["jobs"].items():
            mine = self.parse_steps(jobs[name])
            self.assertEqual(len(mine), len(job["steps"]), msg=name)
            for read, real in zip(mine, job["steps"], strict=True):
                for key in ("uses", "working-directory"):
                    self.assertEqual(read.get(key), real.get(key), msg=f"{name}: {key}")
                self.assertEqual(
                    str(read.get("run", "")).split(), str(real.get("run", "")).split(),
                    msg=f"{name}: run",
                )
                real_with = {k: str(v).lower() for k, v in (real.get("with") or {}).items()}
                read_with = {k: str(v).lower() for k, v in (read.get("with") or {}).items()}
                self.assertEqual(read_with, real_with, msg=f"{name}: with")


COST_DOC = REPO_ROOT / "docs" / "infra" / "07-cost-guardrails.md"
COST_TOTAL_LABEL = "Total tambahan AWS per bulan"
COST_APPROVAL_LABEL = "Persetujuan pengguna"
# US$ per month. A total at or above this may not be merged without the user's approval
# (Requirement 41.5); the document writes decimals with a comma (US$5,74), so a dot is accepted too.
COST_APPROVAL_LIMIT = 5
COST_TOTAL_LINE = re.compile(r"Total tambahan AWS per bulan: US\$(([0-9]+)(?:[.,][0-9]+)?)")
COST_APPROVAL_LINE = re.compile(r"Persetujuan pengguna: ([0-9]{4}-[0-9]{2}-[0-9]{2})")
COST_APPROVAL_NEEDED = (
    "butuh persetujuan pengguna: tulis `Persetujuan pengguna: <tanggal>` "
    "tepat di bawah baris total"
)


def is_calendar_date(value: str) -> bool:
    """True for a real calendar date written YYYY-MM-DD."""
    try:
        datetime.date.fromisoformat(value)
    except ValueError:
        return False
    return True


def cost_line_problems(text: str) -> list[str]:
    """What is wrong with the monthly cost total line in `text`; an empty list means it is fine.

    Why: Requirement 41.10 and 41.11 want exactly one line `Total tambahan AWS per bulan:
    US$<angka>` in the cost document, and an amount of US$5 or more may only be merged when the
    user wrote `Persetujuan pengguna: <tanggal>` on the very next line (Requirement 41.5).

    Rules, all on whole lines:
    - a total line starts at column 0 with the label; a line that only mentions it is not one;
    - zero total lines, or more than one, is a problem;
    - the line must be exactly `<label>: US$<angka>`, the number being digits with an optional
      comma or dot fraction (no sign, no thousands separator, nothing after it but spaces);
    - a total whose integer part is below 5 needs nothing else;
    - otherwise the next line, with no gap, must be `Persetujuan pengguna: YYYY-MM-DD` (a real
      date). The number is compared by its integer part as text, so no float or int is involved.
    """
    lines = re.split(r"\r\n|\r|\n", text)
    totals = [n for n, line in enumerate(lines) if line.startswith(COST_TOTAL_LABEL)]
    if not totals:
        return [f"baris `{COST_TOTAL_LABEL}: US$<angka>` hilang, harus ada tepat satu"]
    if len(totals) > 1:
        where = ", ".join(str(n + 1) for n in totals)
        return [f"ada {len(totals)} baris `{COST_TOTAL_LABEL}` (baris {where}), harus tepat satu"]
    index = totals[0]
    shown = lines[index].rstrip()
    total = COST_TOTAL_LINE.fullmatch(shown)
    if total is None:
        return [
            f"baris {index + 1} salah format: harus `{COST_TOTAL_LABEL}: US$<angka>` "
            f"(angka dengan koma atau titik desimal, tanpa tanda atau teks lain), "
            f"ditemukan {shown[:80]!r}"
        ]
    # Compare the integer part as text (no int(), which raises on thousands of digits).
    whole = total.group(2).lstrip("0")
    limit = str(COST_APPROVAL_LIMIT)
    if (len(whole), whole) < (len(limit), limit):
        return []
    below = lines[index + 1].rstrip() if index + 1 < len(lines) else ""
    approval = COST_APPROVAL_LINE.fullmatch(below)
    if approval is not None and is_calendar_date(approval.group(1)):
        return []
    if below.startswith(COST_APPROVAL_LABEL):
        detail = "baris persetujuan ada tetapi tanggalnya kosong atau bukan YYYY-MM-DD yang sah"
    else:
        detail = "baris tepat di bawah total bukan baris persetujuan"
    return [
        f"{COST_APPROVAL_NEEDED} (total US${total.group(1)} adalah US${COST_APPROVAL_LIMIT} "
        f"atau lebih; tanggal UTC berformat YYYY-MM-DD; {detail})"
    ]


class CostEstimateLineTest(unittest.TestCase):
    """The checker logic on made-up text (task 35.5). Every test here must be green."""

    TOTAL = "Total tambahan AWS per bulan: US$"
    APPROVAL = "Persetujuan pengguna: 2026-11-24"

    @staticmethod
    def text(*lines: str) -> str:
        return "\n".join(["# Biaya", "", *lines, "", "Penutup."]) + "\n"

    def assertFine(self, text: str, msg: str = "") -> None:  # noqa: N802 (unittest style)
        self.assertEqual(cost_line_problems(text), [], msg=msg)

    def assertBad(self, text: str, fragment: str, msg: str = "") -> None:  # noqa: N802
        problems = cost_line_problems(text)
        self.assertTrue(problems, msg=f"expected a problem; {msg}")
        self.assertTrue(
            any(fragment in p for p in problems), msg=f"{fragment!r} not in {problems}; {msg}"
        )

    def test_a_missing_line_fails(self) -> None:
        for text in ("", "\n", self.text("Tidak ada baris total di sini."), "Total tambahan\n"):
            with self.subTest(text=text):
                self.assertBad(text, "hilang")

    def test_two_lines_fail_even_when_one_is_approved(self) -> None:
        for second in (f"{self.TOTAL}0,34", f"{self.TOTAL}5,74"):
            with self.subTest(second=second):
                text = self.text(f"{self.TOTAL}0,34", "", second, self.APPROVAL)
                self.assertBad(text, "ada 2 baris")

    def test_below_five_passes_without_approval(self) -> None:
        for amount in ("4,99", "4.99", "0,34", "0", "4", "04,99", "4,999", "4,9999999"):
            with self.subTest(amount=amount):
                self.assertFine(self.text(f"{self.TOTAL}{amount}"))

    def test_five_or_more_fails_without_approval(self) -> None:
        for amount in ("5,00", "5.00", "5", "5,0", "05,00", "5,74", "5.74", "10,00", "123,45"):
            with self.subTest(amount=amount):
                self.assertBad(self.text(f"{self.TOTAL}{amount}"), COST_APPROVAL_NEEDED)

    def test_the_message_tells_the_user_what_to_write(self) -> None:
        problems = cost_line_problems(self.text(f"{self.TOTAL}5,74"))
        self.assertEqual(len(problems), 1)
        self.assertIn(
            "butuh persetujuan pengguna: tulis `Persetujuan pengguna: <tanggal>` "
            "tepat di bawah baris total",
            problems[0],
        )
        self.assertIn("US$5,74", problems[0])

    def test_five_or_more_passes_with_the_approval_line_right_below(self) -> None:
        for amount in ("5,00", "5", "5,74", "5.74", "99,99"):
            with self.subTest(amount=amount):
                self.assertFine(self.text(f"{self.TOTAL}{amount}", self.APPROVAL))

    def test_below_five_with_an_approval_line_still_passes(self) -> None:
        self.assertFine(self.text(f"{self.TOTAL}0,34", self.APPROVAL))

    def test_trailing_spaces_and_windows_line_endings_are_fine(self) -> None:
        self.assertFine(f"x\r\n{self.TOTAL}5,74   \r\n{self.APPROVAL}  \r\nx\r\n")
        self.assertFine(f"x\r{self.TOTAL}5,74\r{self.APPROVAL}\r")
        self.assertBad(f"x\r\n{self.TOTAL}5,74\r\n\r\n{self.APPROVAL}\r\n", COST_APPROVAL_NEEDED)

    def test_an_approval_line_that_is_not_right_below_fails(self) -> None:
        total = f"{self.TOTAL}5,74"
        cases = {
            "blank line between": self.text(total, "", self.APPROVAL),
            "other line between": self.text(total, "Lihat bagian 12.", self.APPROVAL),
            "two lines below": self.text(total, "x", "y", self.APPROVAL),
            "above the total": self.text(self.APPROVAL, total),
            "indented below": self.text(total, f"  {self.APPROVAL}"),
        }
        for name, text in cases.items():
            with self.subTest(name):
                self.assertBad(text, COST_APPROVAL_NEEDED)

    def test_an_empty_or_invalid_date_fails(self) -> None:
        total = f"{self.TOTAL}5,74"
        for approval in (
            "Persetujuan pengguna:",
            "Persetujuan pengguna: ",
            "Persetujuan pengguna:   ",
            "Persetujuan pengguna: <tanggal>",
            "Persetujuan pengguna: kemarin",
            "Persetujuan pengguna: 2026-13-01",
            "Persetujuan pengguna: 2026-02-30",
            "Persetujuan pengguna: 2026-00-10",
            "Persetujuan pengguna: 24-11-2026",
            "Persetujuan pengguna: 2026/11/24",
            "Persetujuan pengguna: 2026-11-24 disetujui",
            "Persetujuan pengguna 2026-11-24",
            "persetujuan pengguna: 2026-11-24",
            "Persetujuan Pengguna: 2026-11-24",
            "- Persetujuan pengguna: 2026-11-24",
        ):
            with self.subTest(approval=approval):
                self.assertBad(self.text(total, approval), COST_APPROVAL_NEEDED)

    def test_a_bad_date_is_called_out_as_a_date_problem(self) -> None:
        problems = cost_line_problems(self.text(f"{self.TOTAL}5,74", "Persetujuan pengguna:"))
        self.assertIn("tanggalnya kosong", problems[0])

    def test_a_wrong_number_format_fails_even_with_an_approval_line(self) -> None:
        for amount in (
            "", "5,", "5.", ",74", ".74", "5,7,4", "5.7.4", "1.234,56", "1,234.56", "abc",
            "-1", "-5,74", "+5,74", " 5,74", "5 ,74", "5, 74", "5,74 per bulan", "5,74x",
            "5,74.", "1e1", "0x5", "٥,٧٤", "5,74)",
        ):
            with self.subTest(amount=amount):
                self.assertBad(self.text(f"{self.TOTAL}{amount}", self.APPROVAL), "salah format")

    def test_a_missing_us_sign_fails(self) -> None:
        label = "Total tambahan AWS per bulan"
        for rest in (": 5,74", ": $5,74", ": Rp5,74", ": US 5,74", ": US5,74", ": us$5,74",
                     ": USD5,74", ": US$", " US$5,74", "- US$5,74", ":US$5,74", " : US$5,74"):
            with self.subTest(rest=rest):
                self.assertBad(self.text(f"{label}{rest}", self.APPROVAL), "salah format")

    def test_a_line_that_only_mentions_the_label_is_not_a_total(self) -> None:
        prose = f"Baris `{self.TOTAL}9,99` dijaga tes; {self.TOTAL}9,99 juga disebut di sini."
        self.assertFine(self.text(prose, f"{self.TOTAL}0,34"))
        self.assertBad(self.text(prose, f"- {self.TOTAL}0,34"), "hilang")
        self.assertBad(self.text(f"  {self.TOTAL}0,34"), "hilang")
        self.assertBad(self.text(f"| {self.TOTAL}0,34 |"), "hilang")
        self.assertBad(self.text(f"**{self.TOTAL}0,34**"), "hilang")

    def test_the_total_on_the_last_line_is_handled(self) -> None:
        self.assertFine(f"{self.TOTAL}0,34")
        self.assertBad(f"{self.TOTAL}5,74", COST_APPROVAL_NEEDED)
        self.assertBad(f"{self.TOTAL}5,74\n", COST_APPROVAL_NEEDED)
        self.assertFine(f"{self.TOTAL}5,74\n{self.APPROVAL}")

    def test_odd_input_gives_a_list_and_never_raises(self) -> None:
        for text in ("", "\n\n", "\r\n", "\x00", "Total tambahan AWS per bulan", "é" * 10_000,
                     "Total tambahan AWS per bulan: US$" + "9" * 10_000):
            with self.subTest(text=text[:20]):
                self.assertIsInstance(cost_line_problems(text), list)

    def test_a_long_integer_part_is_still_compared_correctly(self) -> None:
        self.assertBad(self.text(f"{self.TOTAL}" + "9" * 5000), COST_APPROVAL_NEEDED)
        self.assertFine(self.text(f"{self.TOTAL}0000000000000004,99"))

    def test_a_real_calendar_date_is_accepted(self) -> None:
        for date in ("2026-11-24", "2028-02-29", "2026-12-31", "2027-01-01"):
            with self.subTest(date=date):
                self.assertFine(self.text(f"{self.TOTAL}5,74", f"Persetujuan pengguna: {date}"))
        self.assertBad(
            self.text(f"{self.TOTAL}5,74", "Persetujuan pengguna: 2026-02-29"),
            COST_APPROVAL_NEEDED,
        )


class CostEstimateDocumentTest(unittest.TestCase):
    """The checker run on the real cost document (task 35.5).

    DELIBERATELY RED until the user approves. The total in the document is US$5,74 (the gross
    upper bound without the Lambda free tier), which is US$5 or more, so Requirement 41.5 forbids
    merging the infra PR until the user writes `Persetujuan pengguna: <tanggal>` right under that
    line. Only the user writes that line; an agent must not, and this test must not be skipped or
    marked as an expected failure. It turns green by itself once the line exists, or once the
    total is lowered by a PR (for example after the free tier is proven to apply).
    """

    def test_the_real_cost_document_total_line_is_valid_or_approved(self) -> None:
        relative = COST_DOC.relative_to(REPO_ROOT)
        if not COST_DOC.is_file():
            self.fail(f"{relative} tidak ada")
        problems = cost_line_problems(COST_DOC.read_text(encoding="utf-8"))
        if problems:
            self.fail(f"{relative}: " + "; ".join(problems))


if __name__ == "__main__":
    unittest.main()
