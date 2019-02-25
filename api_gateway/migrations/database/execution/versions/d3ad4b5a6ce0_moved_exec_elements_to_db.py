"""moved exec elements to db

Revision ID: d3ad4b5a6ce0
Revises: 
Create Date: 2018-03-07 10:12:03.585845

"""
from alembic import op
import sqlalchemy as sa
import sqlalchemy_utils


# revision identifiers, used by Alembic.
revision = 'd3ad4b5a6ce0'
down_revision = None
branch_labels = None
depends_on = None


def upgrade():
    # ### commands auto generated by Alembic - please adjust! ###
    op.create_table('playbook',
    sa.Column('id', sqlalchemy_utils.types.uuid.UUIDType(binary=False), nullable=False),
    sa.Column('name', sa.String(length=255), nullable=False),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('name')
    )
    op.create_table('saved_workflow',
    sa.Column('workflow_execution_id', sqlalchemy_utils.types.uuid.UUIDType(binary=False), nullable=False),
    sa.Column('workflow_id', sqlalchemy_utils.types.uuid.UUIDType(binary=False), nullable=False),
    sa.Column('action_id', sqlalchemy_utils.types.uuid.UUIDType(binary=False), nullable=False),
    sa.Column('accumulator', sa.PickleType(), nullable=False),
    sa.Column('app_instances', sa.PickleType(), nullable=False),
    sa.PrimaryKeyConstraint('workflow_execution_id')
    )
    op.create_table('workflow_status',
    sa.Column('execution_id', sqlalchemy_utils.types.uuid.UUIDType(binary=False), nullable=False),
    sa.Column('workflow_id', sqlalchemy_utils.types.uuid.UUIDType(binary=False), nullable=False),
    sa.Column('name', sa.String(), nullable=False),
    sa.Column('status', sa.Enum('pending', 'running', 'paused', 'awaiting_data', 'completed', 'aborted', name='workflowstatusenum'), nullable=False),
    sa.Column('started_at', sa.DateTime(), nullable=True),
    sa.Column('completed_at', sa.DateTime(), nullable=True),
    sa.PrimaryKeyConstraint('execution_id')
    )
    op.create_table('action_status',
    sa.Column('execution_id', sqlalchemy_utils.types.uuid.UUIDType(binary=False), nullable=False),
    sa.Column('action_id', sqlalchemy_utils.types.uuid.UUIDType(binary=False), nullable=False),
    sa.Column('name', sa.String(), nullable=False),
    sa.Column('app_name', sa.String(), nullable=False),
    sa.Column('action_name', sa.String(), nullable=False),
    sa.Column('result', sa.String(), nullable=True),
    sa.Column('arguments', sa.String(), nullable=True),
    sa.Column('status', sa.Enum('executing', 'awaiting_data', 'success', 'failure', 'aborted', name='actionstatusenum'), nullable=False),
    sa.Column('started_at', sa.DateTime(), nullable=True),
    sa.Column('completed_at', sa.DateTime(), nullable=True),
    sa.Column('_workflow_status_id', sqlalchemy_utils.types.uuid.UUIDType(binary=False), nullable=True),
    sa.ForeignKeyConstraint(['_workflow_status_id'], ['workflow_status.execution_id'], ),
    sa.PrimaryKeyConstraint('execution_id')
    )
    op.create_table('workflow',
    sa.Column('id', sqlalchemy_utils.types.uuid.UUIDType(binary=False), nullable=False),
    sa.Column('playbook_id', sqlalchemy_utils.types.uuid.UUIDType(binary=False), nullable=True),
    sa.Column('name', sa.String(length=80), nullable=False),
    sa.Column('start', sqlalchemy_utils.types.uuid.UUIDType(binary=False), nullable=True),
    sa.ForeignKeyConstraint(['playbook_id'], ['playbook.id'], ),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('playbook_id', 'name', name='_playbook_workflow')
    )
    op.create_table('action',
    sa.Column('id', sqlalchemy_utils.types.uuid.UUIDType(binary=False), nullable=False),
    sa.Column('workflow_id', sqlalchemy_utils.types.uuid.UUIDType(binary=False), nullable=True),
    sa.Column('app_name', sa.String(length=80), nullable=False),
    sa.Column('action_name', sa.String(length=80), nullable=False),
    sa.Column('name', sa.String(length=80), nullable=False),
    sa.Column('device_id', sa.Integer(), nullable=True),
    sa.ForeignKeyConstraint(['workflow_id'], ['workflow._id'], ),
    sa.PrimaryKeyConstraint('id')
    )
    op.create_table('branch',
    sa.Column('id', sqlalchemy_utils.types.uuid.UUIDType(binary=False), nullable=False),
    sa.Column('workflow_id', sqlalchemy_utils.types.uuid.UUIDType(binary=False), nullable=True),
    sa.Column('source_id', sqlalchemy_utils.types.uuid.UUIDType(binary=False), nullable=False),
    sa.Column('destination_id', sqlalchemy_utils.types.uuid.UUIDType(binary=False), nullable=False),
    sa.Column('status', sa.String(length=80), nullable=True),
    sa.Column('priority', sa.Integer(), nullable=True),
    sa.ForeignKeyConstraint(['workflow_id'], ['workflow._id'], ),
    sa.PrimaryKeyConstraint('id')
    )
    op.create_table('conditional_expression',
    sa.Column('id', sqlalchemy_utils.types.uuid.UUIDType(binary=False), nullable=False),
    sa.Column('action_id', sqlalchemy_utils.types.uuid.UUIDType(binary=False), nullable=True),
    sa.Column('branch_id', sqlalchemy_utils.types.uuid.UUIDType(binary=False), nullable=True),
    sa.Column('parent_id', sqlalchemy_utils.types.uuid.UUIDType(binary=False), nullable=True),
    sa.Column('operator', sa.Enum('and', 'or', 'xor', name='operator_types'), nullable=False),
    sa.Column('is_negated', sa.Boolean(), nullable=True),
    sa.ForeignKeyConstraint(['action_id'], ['action._id'], ),
    sa.ForeignKeyConstraint(['branch_id'], ['branch.id'], ),
    sa.ForeignKeyConstraint(['parent_id'], ['conditional_expression.id'], ),
    sa.PrimaryKeyConstraint('id')
    )
    op.create_table('position',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('action_id', sqlalchemy_utils.types.uuid.UUIDType(binary=False), nullable=True),
    sa.Column('x', sa.Float(), nullable=False),
    sa.Column('y', sa.Float(), nullable=False),
    sa.ForeignKeyConstraint(['action_id'], ['action._id'], ),
    sa.PrimaryKeyConstraint('id')
    )
    op.create_table('condition',
    sa.Column('id', sqlalchemy_utils.types.uuid.UUIDType(binary=False), nullable=False),
    sa.Column('conditional_expression_id', sqlalchemy_utils.types.uuid.UUIDType(binary=False), nullable=True),
    sa.Column('app_name', sa.String(length=80), nullable=False),
    sa.Column('action_name', sa.String(length=80), nullable=False),
    sa.Column('is_negated', sa.Boolean(), nullable=True),
    sa.ForeignKeyConstraint(['conditional_expression_id'], ['conditional_expression.id'], ),
    sa.PrimaryKeyConstraint('id')
    )
    op.create_table('transform',
    sa.Column('id', sqlalchemy_utils.types.uuid.UUIDType(binary=False), nullable=False),
    sa.Column('condition_id', sqlalchemy_utils.types.uuid.UUIDType(binary=False), nullable=True),
    sa.Column('app_name', sa.String(length=80), nullable=False),
    sa.Column('action_name', sa.String(length=80), nullable=False),
    sa.ForeignKeyConstraint(['condition_id'], ['condition.id'], ),
    sa.PrimaryKeyConstraint('id')
    )
    op.create_table('argument',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('action_id', sqlalchemy_utils.types.uuid.UUIDType(binary=False), nullable=True),
    sa.Column('condition_id', sqlalchemy_utils.types.uuid.UUIDType(binary=False), nullable=True),
    sa.Column('transform_id', sqlalchemy_utils.types.uuid.UUIDType(binary=False), nullable=True),
    sa.Column('name', sa.String(length=255), nullable=False),
    sa.Column('value', sqlalchemy_utils.types.json.JSONType(), nullable=True),
    sa.Column('reference', sqlalchemy_utils.types.uuid.UUIDType(binary=False), nullable=True),
    sa.Column('selection', sqlalchemy_utils.types.scalar_list.ScalarListType(), nullable=True),
    sa.ForeignKeyConstraint(['action_id'], ['action._id'], ),
    sa.ForeignKeyConstraint(['condition_id'], ['condition.id'], ),
    sa.ForeignKeyConstraint(['transform_id'], ['transform.id'], ),
    sa.PrimaryKeyConstraint('id')
    )
    # ### end Alembic commands ###


def downgrade():
    # ### commands auto generated by Alembic - please adjust! ###
    op.drop_table('argument')
    op.drop_table('transform')
    op.drop_table('condition')
    op.drop_table('position')
    op.drop_table('conditional_expression')
    op.drop_table('branch')
    op.drop_table('action')
    op.drop_table('workflow')
    op.drop_table('action_status')
    op.drop_table('workflow_status')
    op.drop_table('saved_workflow')
    op.drop_table('playbook')
    # ### end Alembic commands ###
