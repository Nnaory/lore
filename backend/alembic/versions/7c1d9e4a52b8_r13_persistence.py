"""r13 persistence: projects, project_stories, project_state

Purpose: first business schema. Moves player projects from browser IndexedDB to PostgreSQL.
Why: additive only (expand-and-contract), so the previous API image keeps working after
`alembic upgrade head` runs in the one-shot migrate service. Ids are text and timestamps are
bigint (ms) so the client and the server share one representation without conversion.

Revision ID: 7c1d9e4a52b8
Revises: 4ee36ac0a0f8
Create Date: 2026-11-20 10:00:00.000000

"""

from collections.abc import Sequence

from alembic import op

revision: str = "7c1d9e4a52b8"
down_revision: str | Sequence[str] | None = "4ee36ac0a0f8"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Create the three project tables and the owner/updated index."""
    op.execute(
        """
        CREATE TABLE projects (
            id                text PRIMARY KEY,
            owner_id          uuid,
            created_at        bigint NOT NULL,
            updated_at        bigint NOT NULL,
            source            jsonb NOT NULL,
            campaign          jsonb NOT NULL,
            materials         jsonb,
            title             text NOT NULL,
            genre             text NOT NULL,
            source_name       text NOT NULL,
            stories_total     integer NOT NULL,
            stories_completed integer NOT NULL DEFAULT 0,
            schema_version    integer NOT NULL DEFAULT 1
        )
        """
    )
    op.execute(
        """
        CREATE TABLE project_stories (
            project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            story_id   text NOT NULL,
            blueprint  jsonb NOT NULL,
            PRIMARY KEY (project_id, story_id)
        )
        """
    )
    op.execute(
        """
        CREATE TABLE project_state (
            project_id     text PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
            campaign_state jsonb NOT NULL,
            updated_at     bigint NOT NULL
        )
        """
    )
    op.execute("CREATE INDEX idx_projects_owner_updated ON projects (owner_id, updated_at DESC)")


def downgrade() -> None:
    """Drop everything this revision created, children first."""
    op.execute("DROP INDEX IF EXISTS idx_projects_owner_updated")
    op.execute("DROP TABLE IF EXISTS project_state")
    op.execute("DROP TABLE IF EXISTS project_stories")
    op.execute("DROP TABLE IF EXISTS projects")
