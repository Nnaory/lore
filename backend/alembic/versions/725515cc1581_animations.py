"""animations: per-owner registry of generated Remotion animations

Purpose: adds the `animations` table that records every animation the AI agent produced (hashes,
S3 prefix, verified meta, attempts, model, sizes). The bundle itself lives in S3; stories only
keep a loose `animation_id` reference, so there is no foreign key to `projects`.
Why: additive only (expand-and-contract), so the previous API image keeps working after
`alembic upgrade head` runs in the one-shot migrate service. Same style as `7c1d9e4a52b8`: raw SQL
through `op.execute`, text ids, bigint millisecond timestamps. The CHECK constraints make Postgres
reject malformed ids, hashes, sizes and an `s3_prefix` that does not match `source_sha256`.

Revision ID: 725515cc1581
Revises: 7c1d9e4a52b8
Create Date: 2026-11-27 09:00:00.000000

"""

from collections.abc import Sequence

from alembic import op

revision: str = "725515cc1581"
down_revision: str | Sequence[str] | None = "7c1d9e4a52b8"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Create the animations table and its owner/created index."""
    op.execute(
        """
        CREATE TABLE animations (
            id               text    PRIMARY KEY
                CHECK (id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
            owner_id         uuid    NOT NULL,
            request_hash     text    NOT NULL CHECK (request_hash  ~ '^[0-9a-f]{64}$'),
            source_sha256    text    NOT NULL CHECK (source_sha256 ~ '^[0-9a-f]{64}$'),
            bundle_sha256    text    NOT NULL CHECK (bundle_sha256 ~ '^[0-9a-f]{64}$'),
            s3_prefix        text    NOT NULL
                CHECK (s3_prefix = 'animations/v1/' || substr(source_sha256, 1, 2) || '/'
                    || source_sha256 || '/'),
            kind             text    NOT NULL CHECK (kind IN ('lesson', 'puzzle')),
            meta             jsonb   NOT NULL,
            attempts         integer NOT NULL CHECK (attempts BETWEEN 1 AND 4),
            model            text    NOT NULL,
            verifier_version text    NOT NULL,
            contract_version integer NOT NULL,
            runtime_version  jsonb   NOT NULL,
            source_bytes     integer NOT NULL CHECK (source_bytes BETWEEN 1 AND 32768),
            bundle_bytes     integer NOT NULL CHECK (bundle_bytes BETWEEN 1 AND 131072),
            created_at       bigint  NOT NULL,
            CONSTRAINT uq_animations_owner_request UNIQUE (owner_id, request_hash)
        )
        """
    )
    op.execute(
        "CREATE INDEX idx_animations_owner_created ON animations (owner_id, created_at DESC)"
    )


def downgrade() -> None:
    """Drop everything this revision created, index first."""
    op.execute("DROP INDEX IF EXISTS idx_animations_owner_created")
    op.execute("DROP TABLE IF EXISTS animations")
