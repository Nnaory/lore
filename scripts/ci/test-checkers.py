#!/usr/bin/env python3
"""Tests for CI tag and cost guardrail checker scripts."""

from __future__ import annotations

import subprocess
import tempfile
import unittest
from pathlib import Path

CI_DIR = Path(__file__).resolve().parent
FIXTURES_DIR = CI_DIR / "fixtures"
REPO_ROOT = CI_DIR.parent.parent


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


if __name__ == "__main__":
    unittest.main()
