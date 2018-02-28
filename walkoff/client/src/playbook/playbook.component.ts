import { Component, ViewEncapsulation, ViewChild, ElementRef, ChangeDetectorRef, OnInit,
	AfterViewChecked, OnDestroy } from '@angular/core';
// import * as _ from 'lodash';
// import { Observable } from 'rxjs';
import { ToastyService, ToastyConfig } from 'ng2-toasty';
import { DatatableComponent } from '@swimlane/ngx-datatable';
import { UUID } from 'angular2-uuid';
import { Observable } from 'rxjs';

import { PlaybookService } from './playbook.service';
import { AuthService } from '../auth/auth.service';
import { UtilitiesService } from '../utilities.service';

import { AppApi } from '../models/api/appApi';
import { ActionApi } from '../models/api/actionApi';
import { ParameterApi } from '../models/api/parameterApi';
import { ConditionApi } from '../models/api/conditionApi';
import { TransformApi } from '../models/api/transformApi';
import { DeviceApi } from '../models/api/deviceApi';
import { ReturnApi } from '../models/api/returnApi';
import { Playbook } from '../models/playbook/playbook';
import { Workflow } from '../models/playbook/workflow';
import { Action } from '../models/playbook/action';
import { Branch } from '../models/playbook/branch';
import { GraphPosition } from '../models/playbook/graphPosition';
import { Device } from '../models/device';
import { Argument } from '../models/playbook/argument';
import { User } from '../models/user';
import { Role } from '../models/role';
import { ActionStatus } from '../models/execution/actionStatus';
import { ConditionalExpression } from '../models/playbook/conditionalExpression';
import { ActionStatusEvent } from '../models/execution/actionStatusEvent';

@Component({
	selector: 'playbook-component',
	templateUrl: './playbook.html',
	styleUrls: [
		'./playbook.css',
	],
	encapsulation: ViewEncapsulation.None,
	providers: [PlaybookService, AuthService],
})
export class PlaybookComponent implements OnInit, AfterViewChecked, OnDestroy {
	@ViewChild('cyRef') cyRef: ElementRef;
	@ViewChild('workflowResultsContainer') workflowResultsContainer: ElementRef;
	@ViewChild('workflowResultsTable') workflowResultsTable: DatatableComponent;

	devices: Device[] = [];
	relevantDevices: Device[] = [];
	users: User[];
	roles: Role[];

	loadedPlaybook: Playbook;
	loadedWorkflow: Workflow;
	playbooks: Playbook[] = [];
	cy: any;
	ur: any;
	appApis: AppApi[] = [];
	offset: GraphPosition = { x: -330, y: -170 };
	selectedAction: Action; // node being displayed in json editor
	selectedActionApi: ActionApi;
	selectedBranchParams: {
		branch: Branch;
		returnTypes: ReturnApi[];
		appName: string;
		actionName: string;
	};
	cyJsonData: string;
	actionStatuses: ActionStatus[] = [];
	executionResultsComponentWidth: number;
	waitingOnData: boolean = false;
	actionStatusStartedRelativeTimes: { [key: string]: string } = {};
	actionStatusCompletedRelativeTimes: { [key: string]: string } = {};
	eventSource: any;

	// Simple bootstrap modal params
	modalParams: {
		title: string,
		submitText: string,
		shouldShowPlaybook?: boolean,
		shouldShowExistingPlaybooks?: boolean,
		selectedPlaybookId?: string,
		newPlaybook?: string,
		shouldShowWorkflow?: boolean,
		newWorkflow?: string,
		submit: () => any,
	} = {
		title: '',
		submitText: '',
		shouldShowPlaybook: false,
		shouldShowExistingPlaybooks: false,
		selectedPlaybookId: '',
		newPlaybook: '',
		shouldShowWorkflow: false,
		newWorkflow: '',
		submit: (() => null) as () => any,
	};

	constructor(
		private playbookService: PlaybookService, private authService: AuthService,
		private toastyService: ToastyService, private toastyConfig: ToastyConfig,
		private cdr: ChangeDetectorRef, private utils: UtilitiesService,
	) {}

	/**
	 * On component initialization, we grab arrays of devices, app apis, and playbooks/workflows (id, name pairs).
	 * We also initialize an EventSoruce for Action Statuses for the execution results table.
	 * Also initialize cytoscape event bindings.
	 */
	ngOnInit(): void {
		this.toastyConfig.theme = 'bootstrap';

		this.playbookService.getDevices().then(devices => this.devices = devices);
		this.playbookService.getApis().then(appApis => this.appApis = appApis.sort((a, b) => a.name > b.name ? 1 : -1));
		this.getActionStatusSSE();
		this.getPlaybooksWithWorkflows();
		this._addCytoscapeEventBindings();

		Observable.interval(30000).subscribe(() => {
			this.recalculateRelativeTimes();
		});
	}

	/**
	 * This angular function is used primarily to recalculate column widths for execution results table.
	 */
	ngAfterViewChecked(): void {
		// Check if the table size has changed,
		if (this.workflowResultsTable && this.workflowResultsTable.recalculate && 
			(this.workflowResultsContainer.nativeElement.clientWidth !== this.executionResultsComponentWidth)) {
			this.executionResultsComponentWidth = this.workflowResultsContainer.nativeElement.clientWidth;
			this.workflowResultsTable.recalculate();
			this.cdr.detectChanges();
		}
	}

	/**
	 * Closes our SSEs on component destroy.
	 */
	ngOnDestroy(): void {
		if (this.eventSource && this.eventSource.close) { this.eventSource.close(); }
	}

	///------------------------------------------------------------------------------------------------------
	/// Playbook CRUD etc functions
	///------------------------------------------------------------------------------------------------------
	/**
	 * Sets up the EventStream for receiving stream actions from the server. Binds various events to the event handler.
	 * Will currently return ALL stream actions and not just the ones manually executed.
	 */
	getActionStatusSSE(): void {
		this.authService.getAccessTokenRefreshed()
			.then(authToken => {
				this.eventSource = new (window as any).EventSource('api/streams/workflowqueue/actions?access_token=' + authToken);

				this.eventSource.addEventListener('started', (e: any) => this.actionStatusEventHandler(e));
				this.eventSource.addEventListener('success', (e: any) => this.actionStatusEventHandler(e));
				this.eventSource.addEventListener('failure', (e: any) => this.actionStatusEventHandler(e));
				this.eventSource.addEventListener('awaiting_data', (e: any) => this.actionStatusEventHandler(e));

				this.eventSource.onerror = (err: Error) => {
					// this.toastyService.error(`Error retrieving workflow results: ${err.message}`);
					console.error(err);
				};
			});
	}

	/**
	 * For an incoming action, will try to find the matching action in the graph (if applicable).
	 * Will style nodes based on the action status (executing/success/failure).
	 * Will update the information in the action statuses table as well, adding new rows or updating existing ones.
	 */
	actionStatusEventHandler(message: any): void {
		const actionStatusEvent: ActionStatusEvent = JSON.parse(message.data);

		// If we have a graph loaded, find the matching node for this event and style it appropriately if possible.
		if (this.cy) {
			const matchingNode = this.cy.elements(`node[_id="${actionStatusEvent.action_id}"]`);

			if (matchingNode) {
				switch (actionStatusEvent.status) {
					case 'success':
						matchingNode.addClass('success-highlight');
						matchingNode.removeClass('failure-highlight');
						matchingNode.removeClass('executing-highlight');
						matchingNode.removeClass('awaiting-data-highlight');
						break;
					case 'failure':
						matchingNode.removeClass('success-highlight');
						matchingNode.addClass('failure-highlight');
						matchingNode.removeClass('executing-highlight');
						matchingNode.removeClass('awaiting-data-highlight');
						break;
					case 'executing':
						matchingNode.removeClass('success-highlight');
						matchingNode.removeClass('failure-highlight');
						matchingNode.addClass('executing-highlight');
						matchingNode.removeClass('awaiting-data-highlight');
						break;
					case 'awaiting_data':
						matchingNode.removeClass('success-highlight');
						matchingNode.removeClass('failure-highlight');
						matchingNode.removeClass('executing-highlight');
						matchingNode.addClass('awaiting-data-highlight');
					default:
						break;
				}
			}
		}

		// Additionally, add or update the actionstatus in our datatable.
		const matchingActionStatus = this.actionStatuses.find(as => as.execution_id === actionStatusEvent.execution_id);
		if (matchingActionStatus) {
			matchingActionStatus.status = actionStatusEvent.status;

			switch (message.type) {
				case 'started':
					// shouldn't happen
					matchingActionStatus.started_at = actionStatusEvent.timestamp;
					break;
				case 'success':
				case 'failure':
					matchingActionStatus.completed_at = actionStatusEvent.timestamp;
					matchingActionStatus.result = actionStatusEvent.result;
					break;
				case 'awaiting_data':
					// don't think anything needs to happen here
					break;
				default:
					this.toastyService.warning(`Unknown Action Status SSE Type: ${message.type}.`);
					break;
			}

			this.recalculateRelativeTimes(matchingActionStatus);
			this.calculateLocalizedTimes(matchingActionStatus);
		} else {
			const newActionStatus = ActionStatusEvent.toNewActionStatus(actionStatusEvent);
			this.calculateLocalizedTimes(newActionStatus);
			this.actionStatuses.push(newActionStatus);
		}
		// Induce change detection by slicing array
		this.actionStatuses = this.actionStatuses.slice();
	}

	/**
	 * Executes the loaded workflow as it exists on the server. Will not currently execute the workflow as it stands.
	 */
	executeWorkflow(): void {
		if (!this.loadedWorkflow) { return; }
		this.clearExecutionHighlighting();
		this.playbookService.addWorkflowToQueue(this.loadedWorkflow.id)
			.then(() => this.toastyService
				.success(`Starting execution of ${this.loadedPlaybook.name} - ${this.loadedWorkflow.name}.`))
			.catch(e => this.toastyService
				.error(`Error starting execution of ${this.loadedPlaybook.name} - ${this.loadedWorkflow.name}: ${e.message}`));
	}

	/**
	 * Loads a workflow from a given playbook / workflow name pair and calls function to set up graph.
	 * @param playbook Playbook to load
	 * @param workflow Workflow to load
	 */
	loadWorkflow(playbook: Playbook, workflow: Workflow): void {
		if (playbook.id && workflow.id) {
			this.playbookService.loadWorkflow(playbook.id, workflow.id)
				.then(loadedWorkflow => {
					this.loadedPlaybook = playbook;
					this.loadedWorkflow = loadedWorkflow;
					this.setupGraph();
					this._closeWorkflowsModal();
				})
				.catch(e => this.toastyService.error(`Error loading workflow "${playbook.name} - ${workflow.name}": ${e.message}`));
		} else {
			this.loadedPlaybook = playbook;
			this.loadedWorkflow = workflow;
			this.setupGraph();
		}
	}

	setupGraph(): void {
		// Convert our selection arrays to a string
		if (!this.loadedWorkflow.actions) { this.loadedWorkflow.actions = []; }
		this.loadedWorkflow.actions.forEach(action => {
			action.arguments.forEach(argument => {
				if (argument.selection && Array.isArray(argument.selection)) {
					argument.selection = (argument.selection as Array<string | number>).join('.');
				}
			});
		});

		// Create the Cytoscape graph
		this.cy = cytoscape({
			container: document.getElementById('cy'),
			boxSelectionEnabled: false,
			autounselectify: false,
			wheelSensitivity: 0.1,
			layout: { name: 'preset' },
			style: [
				{
					selector: 'node',
					css: {
						'content': 'data(label)',
						'text-valign': 'center',
						'text-halign': 'center',
						'shape': 'roundrectangle',
						'background-color': '#bbb',
						'selection-box-color': 'red',
						'font-family': 'Segoe UI, Tahoma, Geneva, Verdana, sans-serif, sans-serif',
						'font-weight': 'lighter',
						'font-size': '15px',
						'width': '40',
						'height': '40',
					},
				},
				{
					selector: 'node[type="action"]',
					css: {
						'background-color': '#bbb',
					},
				},
				{
					selector: 'node[type="eventAction"]',
					css: {
						'shape': 'star',
						'background-color': '#edbd21',
					},
				},
				{
					selector: 'node[?isStartNode]',
					css: {
						'border-width': '2px',
						'border-color': '#991818',
					},
				},
				{
					selector: 'node:selected',
					css: {
						'background-color': '#77b0d0',
					},
				},
				{
					selector: '.success-highlight',
					css: {
						'background-color': '#399645',
						'transition-property': 'background-color',
						'transition-duration': '0.5s',
					},
				},
				{
					selector: '.failure-highlight',
					css: {
						'background-color': '#8e3530',
						'transition-property': 'background-color',
						'transition-duration': '0.5s',
					},
				},
				{
					selector: '.executing-highlight',
					css: {
						'background-color': '#ffef47',
						'transition-property': 'background-color',
						'transition-duration': '0.5s',
					},
				},
				{
					selector: '.awaiting-data-highlight',
					css: {
						'background-color': '#f4ad42',
						'transition-property': 'background-color',
						'transition-duration': '0.5s',
					},
				},
				{
					selector: '$node > node',
					css: {
						'padding-top': '10px',
						'padding-left': '10px',
						'padding-bottom': '10px',
						'padding-right': '10px',
						'text-valign': 'top',
						'text-halign': 'center',
					},
				},
				{
					selector: 'edge',
					css: {
						'target-arrow-shape': 'triangle',
						'curve-style': 'bezier',
					},
				},
			],
		});

		// Enable various Cytoscape extensions
		// Undo/Redo extension
		this.ur = this.cy.undoRedo({});

		// Panzoom extension
		this.cy.panzoom({});

		// Extension for drawing edges
		this.cy.edgehandles({
			preview: false,
			toggleOffOnLeave: true,
			complete: (sourceNode: any, targetNodes: any[], addedEntities: any[]) => {
				if (!this.loadedWorkflow.branches) { this.loadedWorkflow.branches = []; }

				// The edge handles extension is not integrated into the undo/redo extension.
				// So in order that adding edges is contained in the undo stack,
				// remove the edge just added and add back in again using the undo/redo
				// extension. Also add info to edge which is displayed when user clicks on it.
				for (let i = 0; i < targetNodes.length; i++) {
					const tempId = UUID.UUID();
					const sourceId: string = sourceNode.data('_id');
					const destinationId: string = targetNodes[i].data('_id');

					addedEntities[i].data({
						_id: tempId,
						// We set temp because this actually triggers onEdgeRemove since we manually remove and re-add the edge later
						// There is logic in onEdgeRemove to bypass that logic if temp is true
						temp: true,
					});

					//If we attempt to draw an edge that already exists, please remove it and take no further action
					if (this.loadedWorkflow.branches.find(b => b.source_id === sourceId && b.destination_id === destinationId)) {
						this.cy.remove(addedEntities);
						return;
					}

					const sourceAction = this.loadedWorkflow.actions.find(a => a.id === sourceId);
					const sourceActionApi = this._getAction(sourceAction.app_name, sourceAction.action_name);

					// Get our default status either from the default return if specified, or the first return status
					let defaultStatus = '';
					if (sourceActionApi.default_return) {
						defaultStatus = sourceActionApi.default_return;
					} else if (sourceActionApi.returns.length) {
						defaultStatus = sourceActionApi.returns[0].status;
					}

					// Add our branch to the actual loadedWorkflow model
					this.loadedWorkflow.branches.push({
						id: tempId,
						source_id: sourceId,
						destination_id: destinationId,
						status: defaultStatus,
						priority: 1,
					});
				}

				this.cy.remove(addedEntities);

				// Get rid of our temp flag
				addedEntities.forEach(ae => ae.data('temp', false));

				// Re-add with the undo-redo extension.
				this.ur.do('add', addedEntities); // Added back in using undo/redo extension
			},
		});

		// Extension for copy and paste
		this.cy.clipboard();

		//Extension for grid and guidelines
		this.cy.gridGuide({
			snapToGridDuringDrag: true,
			zoomDash: true,
			panGrid: true,
			centerToEdgeAlignment: true,
			distributionGuidelines: true, // Distribution guidelines
			geometricGuideline: true, // Geometric guidelines
			// Guidelines
			guidelinesStackOrder: 4, // z-index of guidelines
			guidelinesTolerance: 2.00, // Tolerance distance for rendered positions of nodes' interaction.
			guidelinesStyle: { // Set ctx properties of line. Properties are here:
				strokeStyle: '#8b7d6b', // color of geometric guidelines
				geometricGuidelineRange: 400, // range of geometric guidelines
				range: 100, // max range of distribution guidelines
				minDistRange: 10, // min range for distribution guidelines
				distGuidelineOffset: 10, // shift amount of distribution guidelines
				horizontalDistColor: '#ff0000', // color of horizontal distribution alignment
				verticalDistColor: '#00ff00', // color of vertical distribution alignment
				initPosAlignmentColor: '#0000ff', // color of alignment to initial mouse location
				lineDash: [0, 0], // line style of geometric guidelines
				horizontalDistLine: [0, 0], // line style of horizontal distribution guidelines
				verticalDistLine: [0, 0], // line style of vertical distribution guidelines
				initPosAlignmentLine: [0, 0], // line style of alignment to initial mouse position
			},
		});

		// Load the data into the graph
		// If a node does not have a label field, set it to
		// the action. The label is what is displayed in the graph.
		const edges = this.loadedWorkflow.branches.map(branch => {
			const edge: any = { group: 'edges' };
			edge.data = {
				id: branch.id,
				_id: branch.id,
				source: branch.source_id,
				target: branch.destination_id,
			};
			return edge;
		});

		const nodes = this.loadedWorkflow.actions.map(action => {
			const node: any = { group: 'nodes', position: _.clone(action.position) };
			node.data = {
				id: action.id,
				_id: action.id,
				label: action.name,
				isStartNode: action.id === this.loadedWorkflow.start,
			};
			this._setNodeDisplayProperties(node, action);
			return node;
		});

		this.cy.add(nodes.concat(edges));

		this.cy.fit(null, 50);

		this.setStartNode(this.loadedWorkflow.start);

		// Note: these bindings need to use arrow notation
		// to actually be able to use 'this' to refer to the PlaybookComponent.
		// Configure handler when user clicks on node or edge
		this.cy.on('select', 'node', (e: any) => this.onNodeSelect(e));
		this.cy.on('select', 'edge', (e: any) => this.onEdgeSelect(e));
		this.cy.on('unselect', (e: any) => this.onUnselect(e));

		// Configure handlers when nodes/edges are added or removed
		this.cy.on('add', 'node', (e: any) => this.onNodeAdded(e));
		this.cy.on('remove', 'node', (e: any) => this.onNodeRemoved(e));
		this.cy.on('remove', 'edge', (e: any) => this.onEdgeRemove(e));

		// this.cyJsonData = JSON.stringify(this.loadedWorkflow, null, 2);
	}

	/**
	 * Closes the active workflow and clears all relevant variables.
	 */
	closeWorkflow(): void {
		this.loadedPlaybook = null;
		this.loadedWorkflow = null;
		this.selectedBranchParams = null;
		this.selectedAction = null;
	}

	/**
	 * Triggers the save action based on the editor option selected.
	 */
	save(): void {
		this.saveWorkflow(this.cy.elements().jsons());
	}

	/**
	 * Saves the workflow loaded in the editor.
	 * Updates the graph positions from the cytoscape model and sanitizes data beforehand.
	 * @param cyData Nodes and edges from the cytoscape graph. Only really used to grab the new positions of nodes.
	 */
	saveWorkflow(cyData: any[]): void {
		// Unselect anything selected first (will trigger onUnselect)
		this.cy.$(':selected').unselect();

		// Clone the loadedWorkflow first, so we don't change the parameters 
		// in the editor when converting it to the format the backend expects.
		const workflowToSave: Workflow = _.cloneDeep(this.loadedWorkflow);

		if (!workflowToSave.start) {
			this.toastyService.warning('Workflow cannot be saved without a starting action.');
			return;
		}

		// Go through our workflow and update some parameters
		workflowToSave.actions.forEach(action => {
			// Set the new cytoscape positions on our loadedworkflow
			action.position = cyData.find(cyAction => cyAction.data._id === action.id).position;

			if (action.device_id === 0) { delete action.device_id; }

			// Properly sanitize arguments through the tree
			this._sanitizeArgumentsForSave(action.arguments);

			this._sanitizeExpressionAndChildren(action.trigger);
		});
		workflowToSave.branches.forEach(branch => {
			this._sanitizeExpressionAndChildren(branch.condition);
		});

		let savePromise: Promise<Workflow>;
		if (this.loadedPlaybook.id) {
			if (this.loadedWorkflow.id) {
				savePromise = this.playbookService.saveWorkflow(this.loadedPlaybook.id, workflowToSave);
			} else {
				savePromise = this.playbookService.newWorkflow(this.loadedPlaybook.id, workflowToSave);
			}
		} else {
			const playbookToSave: Playbook = _.cloneDeep(this.loadedPlaybook);
			playbookToSave.workflows = [workflowToSave];
			savePromise = this.playbookService.newPlaybook(playbookToSave)
				.then(newPlaybook => {
					this.loadedPlaybook = newPlaybook;
					this.playbooks.push(newPlaybook);
					this.playbooks.sort((a, b) => a.name > b.name ? 1 : -1);
					// Return our new workflow to be loaded in the editor, etc.
					return newPlaybook.workflows[0];
				});
		}

		savePromise
			.then(savedWorkflow => {
				// If this workflow doesn't exist, add it to our loaded playbook (and master list for loading)
				if (!this.loadedPlaybook.workflows.find(w => w.id === savedWorkflow.id)) {
					this.loadedPlaybook.workflows.push(savedWorkflow);
					this.loadedPlaybook.workflows.sort((a, b) => a.name > b.name ? 1 : -1);
				}
				this.loadedWorkflow = savedWorkflow;
				this.setupGraph();
				this.toastyService.success(`Successfully saved workflow ${this.loadedPlaybook.name} - ${workflowToSave.name}.`);
			})
			.catch(e => this.toastyService
				.error(`Error saving workflow ${this.loadedPlaybook.name} - ${workflowToSave.name}: ${e.message}`));
	}

	/**
	 * Gets a list of all the loaded playbooks along with their workflows.
	 */
	getPlaybooksWithWorkflows(): void {
		this.playbookService.getPlaybooks()
			.then(playbooks => this.playbooks = playbooks);
	}

	_sanitizeExpressionAndChildren(expression: ConditionalExpression): void {
		if (!expression) { return; }

		if (expression.conditions && expression.conditions.length) {
			expression.conditions.forEach(condition => {
				this._sanitizeArgumentsForSave(condition.arguments);

				condition.transforms.forEach(transform => {
					this._sanitizeArgumentsForSave(transform.arguments);
				});
			});
		}

		if (expression.child_expressions && expression.child_expressions.length) {
			expression.child_expressions.forEach(childExpr => {
				childExpr.conditions.forEach(condition => {
					this._sanitizeArgumentsForSave(condition.arguments);

					condition.transforms.forEach(transform => {
						this._sanitizeArgumentsForSave(transform.arguments);
					});
				});

				this._sanitizeExpressionAndChildren(childExpr);
			});
		}
	}

	/**
	 * Sanitizes an argument so we don't have bad data on save, such as a value when reference is specified.
	 * @param argument The argument to sanitize
	 */
	_sanitizeArgumentsForSave(args: Argument[]): void {
		// Filter out any arguments that are blank, essentially
		const idsToRemove: number[] = [];
		for (const argument of args) {
			// First trim any string inputs for sanitation and so we can check against ''
			if (typeof (argument.value) === 'string') { argument.value = argument.value.trim(); }
			// If value and reference are blank, add this argument's ID in the array to the list
			// Add them in reverse so we don't have problems with the IDs sliding around on the splice
			if ((argument.value == null || argument.value === '') && argument.reference === '') {
				idsToRemove.unshift(args.indexOf(argument));
			}
			// Additionally, remove "value" if reference is specified
			if (argument.reference !== '' && argument.value !== undefined) {
				delete argument.value;
			}
			// Remove reference if unspecified
			if (argument.reference === '') { delete argument.reference; }
		}
		// Actually splice out all the args
		for (const id of idsToRemove) {
			args.splice(id, 1);
		}

		// Split our string argument selector into what the server expects
		args.forEach(argument => {
			if (argument.selection == null) {
				argument.selection = [];
			} else if (typeof (argument.selection) === 'string') {
				argument.selection = argument.selection.trim();
				argument.selection = argument.selection.split('.');

				if (argument.selection[0] === '') {
					argument.selection = [];
				} else {
					// For each value, if it's a valid number, convert it to a number.
					for (let i = 0; i < argument.selection.length; i++) {
						if (!isNaN(argument.selection[i] as number)) { argument.selection[i] = +argument.selection[i]; }
					}
				}
			}
		});
	}

	specifyTrigger(action: Action): void {
		if (action.trigger) { return; }
		action.trigger = new ConditionalExpression();
	}

	removeTrigger(action: Action): void {
		delete action.trigger;
	}

	specifyCondition(branch: Branch): void {
		if (branch.condition) { return; }
		branch.condition = new ConditionalExpression();
	}

	removeCondition(branch: Branch): void {
		delete branch.condition;
	}

	///------------------------------------------------------------------------------------------------------
	/// Cytoscape functions
	///------------------------------------------------------------------------------------------------------

	/**
	 * This function displays a form next to the graph for editing a node when clicked upon
	 * @param e JS Event fired
	 */
	onNodeSelect(e: any): void {
		this.selectedBranchParams = null;

		const data = e.target.data();

		// Unselect anything else we might have selected (via ctrl+click basically)
		this.cy.elements(`[_id!="${data._id}"]`).unselect();

		const action = this.loadedWorkflow.actions.find(a => a.id === data._id);
		if (!action) { return; }
		const actionApi = this._getAction(action.app_name, action.action_name);

		const queryPromises: Array<Promise<any>> = [];

		if (!this.users && 
			(actionApi.parameters.findIndex(p => p.schema.type === 'user') > -1 ||
			actionApi.parameters.findIndex(p => p.schema.items && p.schema.items.type === 'user') > -1)) {
			this.waitingOnData = true;
			queryPromises.push(this.playbookService.getUsers().then(users => this.users = users));
		}
		if (!this.roles && 
			(actionApi.parameters.findIndex(p => p.schema.type === 'role') > -1 ||
			actionApi.parameters.findIndex(p => p.schema.items && p.schema.items.type === 'role') > -1)) {
			this.waitingOnData = true;
			queryPromises.push(this.playbookService.getRoles().then(roles => this.roles = roles));
		}

		if (queryPromises.length) {
			Promise.all(queryPromises)
				.then(() => {
					this.waitingOnData = false;
				})
				.catch(error => {
					this.waitingOnData = false;
					this.toastyService.error(`Error grabbing users or roles: ${error.message}`);
				});
		}

		this.selectedAction = action;
		this.selectedActionApi = actionApi;

		// TODO: maybe scope out relevant devices by action, but for now we're just only scoping out by app
		this.relevantDevices = this.devices.filter(d => d.app_name === this.selectedAction.app_name);
	}

	/**
	 * This function displays a form next to the graph for editing an edge when clicked upon.
	 * @param e JS Event fired
	 */
	onEdgeSelect(e: any): void {
		this.selectedAction = null;
		this.selectedBranchParams = null;

		const id: string = e.target.data('_id');

		// Unselect anything else we might have selected (via ctrl+click basically)
		this.cy.elements(`[_id!="${id}"]`).unselect();

		const branch = this.loadedWorkflow.branches.find(b => b.id === id);
		const sourceAction = this.loadedWorkflow.actions.find(a => a.id === branch.source_id);

		this.selectedBranchParams = {
			branch,
			returnTypes: this._getAction(sourceAction.app_name, sourceAction.action_name).returns,
			appName: sourceAction.app_name,
			actionName: sourceAction.action_name,
		};
	}

	/**
	 * This function unselects any selected nodes/edges and updates the label if necessary.
	 * @param e JS Event fired
	 */
	onUnselect(event: any): void {
		// Update our labels if possible
		if (this.selectedAction) {
			this.cy.elements(`node[_id="${this.selectedAction.id}"]`).data('label', this.selectedAction.name);
		}

		if (!this.cy.$(':selected').length) {
			this.selectedAction = null;
			this.selectedBranchParams = null;
		}
	}

	/**
	 * This function checks when an edge is removed and removes branches as appropriate.
	 * @param e JS Event fired
	 */
	onEdgeRemove(event: any): void {
		const edgeData = event.target.data();
		// Do nothing if this is a temporary edge
		// (edgehandles do not have paramters, and we mark temp edges on edgehandle completion)
		if (!edgeData || edgeData.temp) { return; }

		const sourceId: string = edgeData.source;
		const destinationId: string = edgeData.target;

		// Filter out the one that matches
		this.loadedWorkflow.branches = this.loadedWorkflow.branches
			.filter(b => !(b.source_id === sourceId && b.destination_id === destinationId));
	}

	/**
	 * This function checks when a node is added and sets start node if no other nodes exist.
	 * @param e JS Event fired
	 */
	onNodeAdded(event: any): void {
		const node = event.target;

		// If the number of nodes in the graph is one, set the start node to it.
		if (node.isNode() && this.cy.nodes().size() === 1) { this.setStartNode(node.data('_id')); }
	}

	/**
	 * This function fires when a node is removed. If the node was the start node, it sets it to a new root node.
	 * It also removes the corresponding action from the workflow.
	 * @param e JS Event fired
	 */
	onNodeRemoved(event: any): void {
		const node = event.target;
		const data = node.data();

		// If the start node was deleted, set it to one of the roots of the graph
		if (data && node.isNode() && this.loadedWorkflow.start === data._id) { this.setStartNode(null); }
		if (this.selectedAction && this.selectedAction.id === data._id) { this.selectedAction = null; }

		// Delete the action from the workflow and delete any branches that reference this action
		this.loadedWorkflow.actions = this.loadedWorkflow.actions.filter(a => a.id !== data._id);
		this.loadedWorkflow.branches = this.loadedWorkflow.branches
			.filter(ns => !(ns.source_id === data._id || ns.destination_id === data._id));
	}

	/**
	 * This function fires when an action is dropped onto the graph and fires the insertNode function.
	 * @param e JS Event fired
	 */
	handleDropEvent(e: any): void {
		if (this.cy === null) { return; }

		const appName: string = e.dragData.appName;
		const actionApi: ActionApi = e.dragData.actionApi;

		// The following coordinates is where the user dropped relative to the
		// top-left of the graph
		const dropPosition: GraphPosition = {
			x: e.mouseEvent.layerX,
			y: e.mouseEvent.layerY,
		};

		this.insertNode(appName, actionApi.name, dropPosition, true);
	}

	/**
	 * This function is fired when an action on the left-hand list is double clicked.
	 * It drops a new node of that action in the center of the visible graph.
	 * @param appName App name the action resides under
	 * @param actionName Name of the action that was double clicked
	 */
	handleDoubleClickEvent(appName: string, actionName: string): void {
		if (this.cy === null) { return; }

		const extent = this.cy.extent();

		const centerGraphPosition = { x: this.avg(extent.x1, extent.x2), y: this.avg(extent.y1, extent.y2) };
		this.insertNode(appName, actionName, centerGraphPosition, false);
	}

	avg(a: number, b: number): number {
		return (a + b) / 2;
	}

	/**
	 * Inserts node into the graph and adds a corresponding action to the loadedworkflow.
	 * @param appName App name the action resides under
	 * @param actionName Name of the action to add
	 * @param location Graph Position, where to create the node
	 * @param shouldUseRenderedPosition Whether or not to use rendered or "real" graph position
	 */
	insertNode(appName: string, actionName: string, location: GraphPosition, shouldUseRenderedPosition: boolean): void {
		// Grab a new ID for both the ID of the node and the ID of the action in the workflow
		const newActionUuid = UUID.UUID();

		const args: Argument[] = [];
		const parameters = this._getAction(appName, actionName).parameters;
		// TODO: might be able to remove this entirely
		// due to the argument component auto-initializing default values
		if (parameters && parameters.length) {
			this._getAction(appName, actionName).parameters.forEach((parameter) => {
				args.push(this.getDefaultArgument(parameter));
			});
		}

		let actionToBeAdded: Action;
		let numExistingActions = 0;
		this.loadedWorkflow.actions.forEach(a => a.action_name === actionName ? numExistingActions++ : null);
		// Set our name to be something like "action 2" if "action" already exists
		const uniqueActionName = numExistingActions ? `${actionName} ${numExistingActions + 1}` : actionName;

		if (appName && actionName) { actionToBeAdded = new Action(); }
		actionToBeAdded.id = newActionUuid;
		actionToBeAdded.name = uniqueActionName;
		actionToBeAdded.app_name = appName;
		actionToBeAdded.action_name = actionName;
		actionToBeAdded.arguments = args;

		this.loadedWorkflow.actions.push(actionToBeAdded);

		// Add the node with the new ID to the graph in the location dropped
		// into by the mouse.
		const nodeToBeAdded = {
			group: 'nodes',
			data: {
				id: newActionUuid,
				_id: newActionUuid,
				label: uniqueActionName,
			},
			renderedPosition: null as GraphPosition,
			position: null as GraphPosition,
		};

		this._setNodeDisplayProperties(nodeToBeAdded, actionToBeAdded);

		if (shouldUseRenderedPosition) {
			nodeToBeAdded.renderedPosition = location;
		} else { nodeToBeAdded.position = location; }

		this.ur.do('add', nodeToBeAdded);
	}

	// TODO: update this to properly "cut" actions from the loadedWorkflow.
	/**
	 * Cytoscape cut method.
	 */
	// cut(): void {
	// 	const selecteds = this.cy.$(':selected');
	// 	if (selecteds.length > 0) {
	// 		this.cy.clipboard().copy(selecteds);
	// 		this.ur.do('remove', selecteds);
	// 	}
	// }

	/**
	 * Cytoscape copy method.
	 */
	copy(): void {
		this.cy.clipboard().copy(this.cy.$(':selected'));
	}

	// TODO: update this to properly get new UIDs for pasted actions...
	/**
	 * Cytoscape paste method.
	 */
	paste(): void {
		const newNodes = this.ur.do('paste');

		newNodes.forEach((n: any) => {
			// Get a copy of the action we just copied
			const pastedAction: Action = _.clone(this.loadedWorkflow.actions.find(a => a.id === n.data('_id')));

			const newActionUuid = UUID.UUID();

			pastedAction.id = newActionUuid;

			n.data({
				id: newActionUuid,
				_id: newActionUuid,
				isStartNode: false,
			});

			this.loadedWorkflow.actions.push(pastedAction);
		});
	}

	/**
	 * Sets display properties for a given node based on the information on the related Action.
	 * @param actionNode Cytoscape node to update.
	 * @param action Action relating to the cytoscape node to update.
	 */
	_setNodeDisplayProperties(actionNode: any, action: Action): void {
		//add a type field to handle node styling
		if (this._getAction(action.app_name, action.action_name).event) {
			actionNode.type = 'eventAction';
		} else { actionNode.type = 'action'; }
	}

	/**
	 * Clears the red/green highlighting in the cytoscape graph.
	 */
	clearExecutionHighlighting(): void {
		this.cy.elements().removeClass('success-highlight failure-highlight executing-highlight');
	}

	/**
	 * Sets the start action / node to be the one matching the ID specified.
	 * Not specifying a ID just grabs the first root.
	 * @param start DB ID of the new start node (optional)
	 */
	setStartNode(start: string): void {
		// If no start was given set it to one of the root nodes
		if (start) {
			this.loadedWorkflow.start = start;
		} else {
			const roots = this.cy.nodes().roots();
			if (roots.size() > 0) {
				this.loadedWorkflow.start = roots[0].data('_id');
			}
		}

		// Clear start node highlighting of the previous start node(s)
		this.cy.elements('node[?isStartNode]').data('isStartNode', false);
		// Apply start node highlighting to the new start node.
		this.cy.elements(`node[_id="${start}"]`).data('isStartNode', true);
	}

	/**
	 * Removes all selected nodes and edges.
	 */
	removeSelectedNodes(): void {
		const selecteds = this.cy.$(':selected');
		// Unselect the elements first to remove the parameters editor if need be
		// Because deleting elements doesn't unselect them for some reason
		this.cy.elements(':selected').unselect();
		if (selecteds.length > 0) { this.ur.do('remove', selecteds); }
	}

	/**
	 * Adds keyboard event bindings for cut/copy/paste/etc.
	 */
	_addCytoscapeEventBindings(): void {
		// Handle keyboard presses on graph
		document.addEventListener('keydown', (e: any) => {
			// If we aren't "focused" on a body or button tag, don't do anything
			// to prevent events from being fired while in the parameters editor
			const tagName = document.activeElement.tagName;
			if (!(tagName === 'BODY' || tagName === 'BUTTON')) { return; }
			if (this.cy === null) { return; }

			if (e.which === 46) { // Delete
				this.removeSelectedNodes();
			} else if (e.ctrlKey) {
				//TODO: re-enable undo/redo once we restructure how branches / edges are stored
				// if (e.which === 90) // 'Ctrl+Z', Undo
				//     ur.undo();
				// else if (e.which === 89) // 'Ctrl+Y', Redo
				//     ur.redo();
				if (e.which === 67) {
					// Ctrl + C, Copy
					this.copy();
				} else if (e.which === 86) {
					// Ctrl + V, Paste
					this.paste();
				}
				// else if (e.which === 88) {
				// 	// Ctrl + X, Cut
				// 	this.cut();
				// }
				// else if (e.which == 65) { // 'Ctrl+A', Select All
				//     cy.elements().select();
				//     e.preventDefault();
				// }
			}
		});
	}

	///------------------------------------------------------------------------------------------------------
	/// Simple bootstrap modal stuff
	///------------------------------------------------------------------------------------------------------
	/**
	 * Opens a modal to rename a given playbook and performs the rename action on submit.
	 * @param playbook Name of the playbook to rename
	 */
	renamePlaybookModal(playbook: Playbook): void {
		this._closeWorkflowsModal();

		this.modalParams = {
			title: 'Rename Existing Playbook',
			submitText: 'Rename Playbook',
			shouldShowPlaybook: true,
			submit: () => {
				this.playbookService.renamePlaybook(playbook.id, this.modalParams.newPlaybook)
					.then(renamedPlaybook => {
						this.playbooks.find(pb => pb.id === renamedPlaybook.id).name = renamedPlaybook.name;
						this.playbooks.sort((a, b) => a.name > b.name ? 1 : -1);
						this.toastyService.success(`Successfully renamed playbook "${renamedPlaybook.name}".`);
						this._closeModal();
					})
					.catch(e => this.toastyService.error(`Error renaming playbook "${this.modalParams.newPlaybook}": ${e.message}`));
			},
		};

		this._openModal();
	}

	/**
	 * Opens a modal to copy a given playbook and performs the copy action on submit.
	 * @param playbook Name of the playbook to copy
	 */
	duplicatePlaybookModal(playbook: Playbook): void {
		this._closeWorkflowsModal();

		this.modalParams = {
			title: 'Duplicate Existing Playbook',
			submitText: 'Duplicate Playbook',
			shouldShowPlaybook: true,
			submit: () => {
				this.playbookService.duplicatePlaybook(playbook.id, this.modalParams.newPlaybook)
					.then(duplicatedPlaybook => {
						this.playbooks.push(duplicatedPlaybook);
						this.playbooks.sort((a, b) => a.name > b.name ? 1 : -1);
						this.toastyService
							.success(`Successfully duplicated playbook "${playbook.name}" as "${duplicatedPlaybook.name}".`);
						this._closeModal();
					})
					.catch(e => this.toastyService
						.error(`Error duplicating playbook "${this.modalParams.newPlaybook}": ${e.message}`));
			},
		};

		this._openModal();
	}

	/**
	 * Opens a modal to delete a given playbook and performs the delete action on submit.
	 * @param playbook Playbook to delete
	 */
	deletePlaybook(playbook: Playbook): void {
		if (!confirm(`Are you sure you want to delete playbook "${playbook.name}"?`)) { return; }

		this.playbookService
			.deletePlaybook(playbook.id)
			.then(() => {
				this.playbooks = this.playbooks.filter(p => p.id !== playbook.id);

				// If our loaded workflow is in this playbook, close it.
				if (this.loadedPlaybook && playbook.id === this.loadedPlaybook.id) { this.closeWorkflow(); }
				this.toastyService.success(`Successfully deleted playbook "${playbook.name}".`);
			})
			.catch(e => this.toastyService
				.error(`Error deleting playbook "${playbook.name}": ${e.message}`));
	}

	/**
	 * Opens a modal to add a new workflow to a given playbook or under a new playbook.
	 */
	newWorkflowModal(): void {
		if (this.loadedWorkflow && 
			!confirm('Are you sure you want to create a new workflow? ' +
				`Any unsaved changes on "${this.loadedWorkflow.name}" will be lost!`)) {
			return;
		}

		this.modalParams = {
			title: 'Create New Workflow',
			submitText: 'Add Workflow',
			shouldShowExistingPlaybooks: true,
			shouldShowPlaybook: true,
			shouldShowWorkflow: true,
			submit: () => {
				const newWorkflow = new Workflow();
				newWorkflow.name = this.modalParams.newWorkflow;

				// Grab our playbook.
				let pb = this.playbooks.find(p => p.id === this.modalParams.selectedPlaybookId);
				// If it doesn't exist, create a new temp playbook and add our temp workflow under it.
				if (!pb) {
					pb = new Playbook();
					pb.name = this.modalParams.newPlaybook;
					pb.workflows.push(newWorkflow);
				}

				this.loadWorkflow(pb, newWorkflow);
				this._closeModal();
			},
		};

		this._openModal();
	}

	/**
	 * Opens a modal to copy a given workflow and performs the copy action on submit.
	 * @param sourcePlaybookId ID of the playbook the workflow resides under
	 * @param sourceWorkflowId ID of the workflow to copy
	 */
	duplicateWorkflowModal(sourcePlaybookId: string, sourceWorkflowId: string): void {
		this._closeWorkflowsModal();

		this.modalParams = {
			title: 'Duplicate Existing Workflow',
			submitText: 'Duplicate Workflow',
			shouldShowPlaybook: true,
			shouldShowExistingPlaybooks: true,
			selectedPlaybookId: sourcePlaybookId,
			shouldShowWorkflow: true,
			submit: () => {
				// const sourcePb = this.playbooks.find(p => p.id === sourcePlaybookId);
				// Grab our playbook. If it doesn't exist, set our new playbook name to add
				let destinationPb = this.playbooks.find(p => p.id === this.modalParams.selectedPlaybookId);
				let newPlaybookName: string;
				if (!destinationPb) { newPlaybookName = this.modalParams.newPlaybook; }

				// Make a new playbook if we're adding this under a new playbook
				let newPlaybookPromise: Promise<void>;
				if (newPlaybookName) {
					const playbookToAdd = new Playbook();
					playbookToAdd.name = newPlaybookName;
					newPlaybookPromise = this.playbookService.newPlaybook(playbookToAdd)
						.then(newPlaybook => {
							this.playbooks.push(newPlaybook);
							this.playbooks.sort((a, b) => a.name > b.name ? 1 : -1);
							destinationPb = newPlaybook;
							this.modalParams.selectedPlaybookId = newPlaybook.id;
						});
				} else {
					newPlaybookPromise = Promise.resolve();
				}

				newPlaybookPromise
					.then(() => this.playbookService
						.duplicateWorkflow(sourcePlaybookId, sourceWorkflowId, destinationPb.id, this.modalParams.newWorkflow))
					.then(duplicatedWorkflow => {
						destinationPb.workflows.push(duplicatedWorkflow);
						destinationPb.workflows.sort((a, b) => a.name > b.name ? 1 : -1);

						this.toastyService
							.success(`Successfully duplicated workflow "${destinationPb.name} - ${this.modalParams.newWorkflow}".`);
						this._closeModal();
					})
					.catch(e => this.toastyService
						.error(`Error duplicating workflow "${destinationPb.name} - ${this.modalParams.newWorkflow}": ${e.message}`));
			},
		};

		this._openModal();
	}

	/**
	 * Opens a modal to delete a given workflow and performs the delete action on submit.
	 * @param playbook Playbook the workflow resides under
	 * @param workflow Workflow to delete
	 */
	deleteWorkflow(playbook: Playbook, workflow: Workflow): void {
		if (!confirm(`Are you sure you want to delete workflow "${playbook.name} - ${workflow.name}"?`)) { return; }

		this.playbookService
			.deleteWorkflow(playbook.id, workflow.id)
			.then(() => {
				const pb = this.playbooks.find(p => p.id === playbook.id);
				pb.workflows = pb.workflows.filter(w => w.id !== workflow.id);

				if (!pb.workflows.length) { this.playbooks = this.playbooks.filter(p => p.id !== pb.id); }

				// Close the workflow if the deleted workflow matches the loaded one
				if (this.loadedPlaybook && this.loadedWorkflow &&
					playbook.id === this.loadedPlaybook.id && workflow.id === this.loadedWorkflow.id) { this.closeWorkflow(); }

				this.toastyService.success(`Successfully deleted workflow "${playbook.name} - ${workflow.name}".`);
			})
			.catch(e => this.toastyService.error(`Error deleting workflow "${playbook.name} - ${workflow.name}": ${e.message}`));
	}

	/**
	 * Function to open the bootstrap playbook/workflow action modal.
	 */
	_openModal(): void {
		($('#playbookAndWorkflowActionModal') as any).modal('show');
	}

	/**
	 * Function to close the bootstrap playbook/workflow action modal.
	 */
	_closeModal(): void {
		($('#playbookAndWorkflowActionModal') as any).modal('hide');
	}

	/**
	 * Function to close the bootstrap load workflow modal.
	 */
	_closeWorkflowsModal(): void {
		($('#workflowsModal') as any).modal('hide');
	}

	///------------------------------------------------------------------------------------------------------
	/// Utility functions
	///------------------------------------------------------------------------------------------------------
	// /**
	//  * Gets a list of playbook names from our list of playbooks.
	//  */
	// getPlaybooks(): string[] {
	// 	return this.playbooks.map(pb => pb.name);
	// }

	// TODO: maybe somehow recursively find actions that may occur before. Right now it just returns all of them.
	/**
	 * Gets a list of actions previous to the currently selected action. (Currently just grabs a list of all actions.)
	 */
	getPreviousActions(): Action[] {
		return this.loadedWorkflow.actions;
	}

	/**
	 * Gets an ActionApi object by app and action name
	 * @param appName App name the action resides under
	 * @param actionName Name of the ActionApi to query
	 */
	_getAction(appName: string, actionName: string): ActionApi {
		return this.appApis.find(a => a.name === appName).action_apis.find(a => a.name === actionName);
	}

	/**
	 * Gets a given argument matching an inputted parameter API.
	 * Adds a new argument to the selected action with default values if the argument doesn't exist.
	 * @param parameterApi Parameter API object relating to the argument to return
	 */
	getOrInitializeSelectedActionArgument(parameterApi: ParameterApi): Argument {
		// Find an existing argument
		let argument = this.selectedAction.arguments.find(a => a.name === parameterApi.name);
		if (argument) { return argument; }

		argument = this.getDefaultArgument(parameterApi);
		this.selectedAction.arguments.push(argument);
		return argument;
	}

	/**
	 * Returns an argument based upon a given parameter API and its default value.
	 * @param parameterApi Parameter API used to generate the default argument
	 */
	getDefaultArgument(parameterApi: ParameterApi): Argument {
		return {
			name: parameterApi.name,
			value: parameterApi.schema.default != null ? parameterApi.schema.default : null,
			reference: '',
			selection: '',
		};
	}

	/**
	 * Gets a list of ConditionApis from a given app name.
	 * @param appName App name to query
	 */
	getConditionApis(appName: string): ConditionApi[] {
		return this.appApis.find(a => a.name === appName).condition_apis;
	}

	/**
	 * Gets a list of TransformApis from a given app name.
	 * @param appName App name to query
	 */
	getTransformApis(appName: string): TransformApi[] {
		return this.appApis.find(a => a.name === appName).transform_apis;
	}

	/**
	 * Gets a list of TransformApis from a given app name.
	 * @param appName App name to query
	 */
	getDeviceApis(appName: string): DeviceApi[] {
		return this.appApis.find(a => a.name === appName).device_apis;
	}

	/**
	 * Gets an parameterApi matching the app, action, and input names specified.
	 * @param appName App name the ActionApi resides under
	 * @param actionName Name of the ActionApi to query
	 * @param inputName Name of the action input to query
	 */
	getInputApiArgs(appName: string, actionName: string, inputName: string): ParameterApi {
		return this._getAction(appName, actionName).parameters.find(a => a.name === inputName);
	}

	/**
	 * Filters only the apps that have actions specified
	 */
	getAppsWithActions(): AppApi[] {
		return this.appApis.filter(a => a.action_apis && a.action_apis.length);
	}

	/**
	 * Converts an input object/value to a friendly string for display in the workflow status table.
	 * @param input Input object / value to convert
	 */
	getFriendlyJSON(input: any): string {
		if (!input) { return 'N/A'; }
		let out = JSON.stringify(input, null, 1);
		out = out.replace(/[\{\[\}\]"]/g, '').trim();
		if (!out) { return 'N/A'; }
		return out;
	}

	/**
	 * Converts an input argument array to a friendly string for display in the workflow status table.
	 * @param args Array of arguments to convert
	 */
	getFriendlyArguments(args: Argument[]): string {
		if (!args || !args.length) { return 'N/A'; }

		const obj: { [key: string]: string } = {};
		args.forEach(element => {
			if (element.value) { obj[element.name] = element.value; }
			if (element.reference) { obj[element.name] = element.reference.toString(); }
			if (element.selection && element.selection.length) {
				const selectionString = (element.selection as any[]).join('.');
				obj[element.name] = `${obj[element.name]} (${selectionString})`;
			}
		});

		let out = JSON.stringify(obj, null, 1);
		out = out.replace(/[\{\}"]/g, '');
		return out;
	}

	/**
	 * Removes the white space in a given string.
	 * @param input Input string to remove the whitespace of
	 */
	removeWhitespace(input: string): string {
		return input.replace(/\s/g, '');
	}

	/**
	 * Recalculates the relative times shown for start/end date timestamps (e.g. '5 hours ago').
	 */
	recalculateRelativeTimes(specificStatus?: ActionStatus): void {
		let targetStatuses: ActionStatus[];
		if (specificStatus) {
			targetStatuses = [specificStatus];
		} else {
			targetStatuses = this.actionStatuses;
		}
		if (!targetStatuses || !targetStatuses.length ) { return; }

		targetStatuses.forEach(actionStatus => {
			if (actionStatus.started_at) {
				this.actionStatusStartedRelativeTimes[actionStatus.execution_id] = 
					this.utils.getRelativeLocalTime(actionStatus.started_at);
			}
			if (actionStatus.completed_at) {
				this.actionStatusCompletedRelativeTimes[actionStatus.execution_id] = 
					this.utils.getRelativeLocalTime(actionStatus.completed_at);
			}
		});
	}

	/**
	 * Adds/updates localized time strings to a status object.
	 * @param status Action Status to mutate
	 */
	calculateLocalizedTimes(status: ActionStatus): void {
		if (status.started_at) { 
			status.localized_started_at = this.utils.getLocalTime(status.started_at);
		}
		if (status.completed_at) { 
			status.localized_completed_at = this.utils.getLocalTime(status.completed_at);
		}
	}
}