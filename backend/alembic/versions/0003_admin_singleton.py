from alembic import op
import sqlalchemy as sa
revision='0003_admin_singleton'; down_revision='0002_admin_sessions'; branch_labels=None; depends_on=None
def upgrade():
 op.add_column('admins',sa.Column('singleton_key',sa.Integer(),nullable=True)); op.execute('UPDATE admins SET singleton_key=1'); op.alter_column('admins','singleton_key',nullable=False); op.create_unique_constraint('uq_admins_singleton_key','admins',['singleton_key'])
def downgrade():
 op.drop_constraint('uq_admins_singleton_key','admins',type_='unique'); op.drop_column('admins','singleton_key')
