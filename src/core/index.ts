// 子路径入口 `agent-conversation-exploration-thread-graph/core`。
// 零宿主依赖：领域 schema（zod）/ 文件 store / apply 漏斗（唯一写点）/ 维护作业 /
// projection view（整值）/ lane 布局（纯函数）。
//
// 宿主的 web-ui 只应 import 这里的**类型与纯函数**（projection view 类型、layoutThreadGraphLanes）——
// store 与漏斗要跑在服务端（契约 A.13-1）。

export type {
	CompletedConversationTurn,
	CompletedTurnSequenceProjectionConfidence,
	CompletedTurnSequenceSnapshot,
	CompletedTurnSequenceSource,
	CompletedTurnSequenceSourceKind,
	ConversationSessionRef,
	ConversationUserMessageOrigin,
} from "./completed-turn-sequence-source.js";
export { COMPLETED_CONVERSATION_TURN_EXCERPT_MAX_LENGTH } from "./completed-turn-sequence-source.js";

export type {
	ApplyExplorationThreadGraphMaintenanceProposalInput,
	ApplyExplorationThreadGraphMaintenanceProposalResult,
	ExplorationThreadGraphApplyRejectionReason,
} from "./exploration-thread-graph-apply-funnel.js";
export {
	applyExplorationThreadGraphMaintenanceProposal,
	DEFAULT_PLACEMENT_REVISION_WINDOW_TURN_COUNT,
} from "./exploration-thread-graph-apply-funnel.js";
export type {
	ExplorationThreadGraphProjectionView,
	ExplorationThreadGraphProjectionViewEventMark,
	ExplorationThreadGraphProjectionViewThread,
	ExplorationThreadGraphProjectionViewTurnRow,
} from "./exploration-thread-graph-projection-view.js";
export { buildExplorationThreadGraphProjectionView } from "./exploration-thread-graph-projection-view.js";
export type {
	ExplorationThread,
	ExplorationThreadGraphCollection,
	ExplorationThreadGraphMaintenanceJobUsage,
	ExplorationThreadGraphRecordGenerationSource,
	ExplorationThreadGraphStaleReason,
	ExplorationThreadLifecycleStatus,
	ExplorationTopic,
	ExplorationTopicRegistry,
	ExplorationTurnRef,
	TurnEventMark,
	TurnEventMarkKind,
	TurnRelationEdge,
	TurnRelationEdgeKind,
	TurnSubjectTagging,
	TurnThreadPlacement,
	TurnThreadPlacementConfidence,
} from "./exploration-thread-graph-schema.js";
export {
	createEmptyExplorationThreadGraphCollection,
	createEmptyExplorationTopicRegistry,
	DEVIATION_RATIONALE_MAX_LENGTH,
	EXPLORATION_THREAD_GRAPH_SCHEMA_VERSION,
	explorationThreadGraphCollectionSchema,
	explorationTopicRegistrySchema,
	formatExplorationTurnRefKey,
	normalizeTopicTitleForRegistryLookup,
	THREAD_TITLE_MAX_LENGTH,
	TOPIC_ALIAS_MAX_COUNT,
	TOPIC_SUMMARY_MARKDOWN_MAX_LENGTH,
	TOPIC_TITLE_MAX_LENGTH,
	TURN_EVENT_MARK_NOTE_MAX_LENGTH,
	TURN_SUBJECT_TAG_MAX_COUNT,
	TURN_SUBJECT_TAG_MAX_LENGTH,
} from "./exploration-thread-graph-schema.js";

export type {
	ExplorationThreadGraphStoreMutator,
	ExplorationThreadGraphStoreSnapshot,
} from "./exploration-thread-graph-store.js";
export {
	mutateExplorationThreadGraph,
	readExplorationThreadGraphCollection,
	readExplorationTopicRegistry,
	resolveExplorationThreadGraphCollectionPath,
	resolveExplorationThreadGraphStoreWriteLockPath,
	resolveExplorationTopicRegistryPath,
} from "./exploration-thread-graph-store.js";

export type {
	ForkedWorkBranchExecutor,
	ForkedWorkBranchRequest,
	ForkedWorkBranchResult,
	ForkedWorkBranchStopReason,
	ForkedWorkBranchUsage,
	ObjectRootedJsonSchema,
} from "./forked-work-branch-executor.js";
export {
	AGENT_CONVERSATION_EXPLORATION_WORK_BRANCH_JOB_ENV_VARIABLE_NAME,
	INHERITED_HOST_CLAUDE_CODE_ENV_VARIABLE_NAMES,
} from "./forked-work-branch-executor.js";
export type {
	RunExplorationThreadGraphMaintenanceJobInput,
	RunExplorationThreadGraphMaintenanceJobResult,
} from "./maintenance-job/exploration-thread-graph-maintenance-job.js";
export {
	DEFAULT_MAINTENANCE_JOB_BATCH_SIZE,
	DEFAULT_MAINTENANCE_JOB_TIMEOUT_MILLISECONDS,
	runExplorationThreadGraphMaintenanceJob,
} from "./maintenance-job/exploration-thread-graph-maintenance-job.js";

export { buildExplorationThreadGraphMaintenanceProposalJsonSchema } from "./maintenance-job/maintenance-job-output-json-schema.js";
export type {
	ExplorationThreadGraphMaintenanceJobMode,
	MaintenanceJobPromptAssemblyInput,
} from "./maintenance-job/maintenance-job-prompt-assembly.js";
export { assembleExplorationThreadGraphMaintenanceJobPrompt } from "./maintenance-job/maintenance-job-prompt-assembly.js";

export type {
	ExplorationThreadGraphMaintenanceProposal,
	MaintenanceProposalEdge,
	MaintenanceProposalEventMark,
	MaintenanceProposalNewThread,
	MaintenanceProposalPlacement,
	MaintenanceProposalSubjectTagging,
	MaintenanceProposalThreadRevision,
	MaintenanceProposalTopic,
} from "./maintenance-job/maintenance-job-proposal-schema.js";
export {
	explorationThreadGraphMaintenanceProposalSchema,
	MAINTENANCE_PROPOSAL_MAX_ITEMS_PER_COLLECTION,
} from "./maintenance-job/maintenance-job-proposal-schema.js";

export type {
	ThreadGraphLaneLayoutInputRow,
	ThreadGraphLaneLayoutRow,
} from "./thread-graph-lane-layout.js";
export { countThreadGraphLanes, layoutThreadGraphLanes } from "./thread-graph-lane-layout.js";
