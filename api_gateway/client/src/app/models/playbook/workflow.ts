import { Type, Expose } from 'class-transformer';
import { Select2OptionData } from 'ng2-select2/ng2-select2';

import { Action } from './action';
import { Branch } from './branch';
import { ExecutionElement } from './executionElement';
import { EnvironmentVariable } from './environmentVariable';
import { ConditionalExpression } from './conditionalExpression';
import { Argument } from './argument';
import { Condition } from './condition';
import { ActionType } from '../api/actionApi';
import { Trigger } from './trigger';
import { WorkflowNode } from './WorkflowNode';

export class Workflow extends ExecutionElement {
	// _playbook_id: number;
	/**
	 * Playbook ID this workflow resides under. Only used on create/duplicate.
	 */
	playbook_id?: string;

	/**
	 * Name of the workflow. Updated by passing in new_name in POST.
	 */
	name: string;

	/**
	 * Name of the workflow. Updated by passing in new_name in POST.
	 */
	description: string;

	/**
	 * Name of the workflow. Updated by passing in new_name in POST.
	 */
	tags: string[] = [];

	/**
	 * Array of actions specified in the workflow.
	 */
	@Type(() => Action)
	actions?: Action[] = [];

	/**
	 * Array of branches between actions.
	 */
	@Type(() => Branch)
	branches?: Branch[] = [];

	/**
	 * Array of conditions between actions.
	 */
	@Type(() => Condition)
	conditions?: Condition[] = [];

	/**
	 * Array of triggers between actions.
	 */
	@Type(() => Trigger)
	triggers?: Trigger[] = [];

	/**
	 * Array of environment variables.
	 */
	@Type(() => EnvironmentVariable)
	@Expose({name: 'workflow_variables'})
	environment_variables?: EnvironmentVariable[] = [];

	/**
	 * ID of the action designated as the start action.
	 */
	start?: string;
	
	/**
	 * A factor of how often the workflow fails.
	 */
	accumulated_risk?: number;

	/**
	 * Returns true if this workflow doesn't contain any errors
	 */
	is_valid: boolean;

	get nodes(): WorkflowNode[] {
		return [].concat(this.actions, this.conditions, this.triggers);
	}

	/**
	 * Array of errors returned from the server for this Argument and any of its descendants 
	 */
	get all_errors(): string[] {
		return this.errors.concat(...this.nodes.map(action => action.all_errors))
	}

	get all_arguments(): Argument[] {
		let allArgs: Argument[] = [];
		this.nodes.forEach(action => allArgs = allArgs.concat(action.arguments));
		return allArgs;
	}

	get referenced_variables() : EnvironmentVariable[] {
		if (!this.environment_variables) return [];
		return this.environment_variables.filter(variable => this.all_arguments.some(arg => arg.value == variable.id));
	}

	addNode(node: WorkflowNode) {
		if (node instanceof Action )
			this.actions.push(node);
		else if (node instanceof Condition)
			this.conditions.push(node);
		else if (node instanceof Trigger)
			this.triggers.push(node);
	}

	removeNode(nodeId: string) {
		this.actions = this.actions.filter(a => a.id !== nodeId);
		this.conditions = this.conditions.filter(a => a.id !== nodeId);
		this.triggers = this.triggers.filter(a => a.id !== nodeId);
		this.branches = this.branches.filter(b => !(b.source_id === nodeId || b.destination_id === nodeId));
	}

	deleteVariable(deletedVariable: EnvironmentVariable) {
		this.environment_variables = this.environment_variables.filter(variable => variable.id !== deletedVariable.id);
		this.all_arguments.filter(arg => arg.value == deletedVariable.id).forEach(arg => arg.value = '');
	}

	getNextActionName(actionName: string) : string {
		let numActions = this.nodes.filter(a => a.action_name === actionName && a.name).length;
		return numActions ? `${actionName}_${ ++numActions }` : actionName;
	}

	getPreviousActions(action: WorkflowNode): WorkflowNode[] {
		return this.branches
			.filter(b => b.destination_id == action.id)
			.map(b => this.nodes.find(a => a.id == b.source_id))
			.reduce((previous, action) => previous.concat([action], this.getPreviousActions(action)).filter((v, i, a) => a.indexOf(v) == i), []);
	}
}
