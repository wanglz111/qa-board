from alembic import op
import sqlalchemy as sa
revision='0003_admin_singleton'; down_revision='0002_admin_sessions'; branch_labels=None; depends_on=None
def upgrade():
 op.add_column('admins',sa.Column('singleton_key',sa.Integer(),server_default='1',nullable=False)); op.create_unique_constraint('uq_admins_singleton_key','admins',['singleton_key']); op.create_check_constraint('ck_admins_singleton_key','admins',sa.column('singleton_key') == 1)
def downgrade():
 op.drop_constraint('ck_admins_singleton_key','admins',type_='check'); op.drop_constraint('uq_admins_singleton_key','admins',type_='unique'); op.drop_column('admins','singleton_key')
