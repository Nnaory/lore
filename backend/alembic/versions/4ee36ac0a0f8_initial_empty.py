"""initial empty

Revision ID: 4ee36ac0a0f8
Revises:
Create Date: 2026-11-19 18:08:13.092365

"""

from collections.abc import Sequence

revision: str = "4ee36ac0a0f8"
down_revision: str | Sequence[str] | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    pass


def downgrade() -> None:
    """Downgrade schema."""
    pass
