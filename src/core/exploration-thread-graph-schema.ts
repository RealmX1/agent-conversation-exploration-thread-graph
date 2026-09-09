// thread graph 的领域 schema（handoff A.4）：zod 形状 + 派生类型 + 文件级集合包裹。
// 这里是**唯一**定义实体形状的地方；store 与 apply 漏斗都复用本文件的 schema 做校验。
// 改动纪律：改 schema 必 bump EXPLORATION_THREAD_GRAPH_SCHEMA_VERSION 并记 CHANGELOG（契约 A.13-4）。

import { z } from "zod";

/** collection / topic-registry 文件的 schema 版本；改 schema 必 bump 并在 CHANGELOG 记（契约 A.13-4）。 */
export const EXPLORATION_THREAD_GRAPH_SCHEMA_VERSION = 1;

// ── 尺寸上限（对外导出，供作业 prompt 与宿主 UI 复用同一组数字，避免两处各写一份） ──
export const TOPIC_TITLE_MAX_LENGTH = 80;
export const TOPIC_ALIAS_MAX_COUNT = 8;
export const TOPIC_SUMMARY_MARKDOWN_MAX_LENGTH = 400;
export const TURN_SUBJECT_TAG_MAX_COUNT = 8;
export const TURN_SUBJECT_TAG_MAX_LENGTH = 40;
export const DEVIATION_RATIONALE_MAX_LENGTH = 400;
export const TURN_EVENT_MARK_NOTE_MAX_LENGTH = 400;
export const THREAD_TITLE_MAX_LENGTH = 80;

/** 标识符的通用形状：非空、有界，避免把整段文本当 id 塞进来。 */
const identifierSchema = z.string().min(1).max(200);

/** 时间戳一律 epoch 毫秒整数（与 CompletedConversationTurn 的 ISO 字符串不同——那是 harness 原始值）。 */
const epochMillisecondsSchema = z.number().int().nonnegative();

/**
 * 一条记录是谁写的。`user_manual_edit` 优先级恒最高：维护作业不得改动这类记录（漏斗闸）。
 */
export const explorationThreadGraphRecordGenerationSourceSchema = z.enum([
	"work_branch_maintenance_job",
	"user_manual_edit",
]);
export type ExplorationThreadGraphRecordGenerationSource = z.infer<
	typeof explorationThreadGraphRecordGenerationSourceSchema
>;

/**
 * Turn 的引用键。turnCheckpointCommit 是**可选的锦上添花**（宿主若有 checkpoint 体系则填），
 * 解析不了时降级为 null 而不是拒绝——turn 编号才是权威（CompletedTurnSequenceSource）。
 */
export const explorationTurnRefSchema = z.object({
	conversationSessionId: identifierSchema,
	turnNumber: z.number().int().positive(),
	turnCheckpointCommit: identifierSchema.nullable(),
});
export type ExplorationTurnRef = z.infer<typeof explorationTurnRefSchema>;

/** Topic 是 workspace 级可复用实体，只挂在 thread 上；跨 exploration 的「同主题」关联靠它。 */
export const explorationTopicSchema = z.object({
	topicId: identifierSchema,
	topicTitle: z.string().min(1).max(TOPIC_TITLE_MAX_LENGTH),
	topicAliases: z.array(z.string().min(1).max(TOPIC_TITLE_MAX_LENGTH)).max(TOPIC_ALIAS_MAX_COUNT),
	topicSummaryMarkdown: z.string().max(TOPIC_SUMMARY_MARKDOWN_MAX_LENGTH).nullable(),
	supersededByTopicId: identifierSchema.nullable(),
	generationSource: explorationThreadGraphRecordGenerationSourceSchema,
	createdAt: epochMillisecondsSchema,
	updatedAt: epochMillisecondsSchema,
});
export type ExplorationTopic = z.infer<typeof explorationTopicSchema>;

/** thread 的生命周期。离开一条 thread 时由作业给出状态，配合 `concludes` 边画合流线。 */
export const explorationThreadLifecycleStatusSchema = z.enum(["active", "concluded", "parked", "abandoned"]);
export type ExplorationThreadLifecycleStatus = z.infer<typeof explorationThreadLifecycleStatusSchema>;

/** thread id 由漏斗派生，形如 `thread-1`；agent 只能自报临时 id，不得自定正式 id。 */
export const explorationThreadIdSchema = z
	.string()
	.regex(/^thread-\d+$/u, "threadId 必须形如 thread-<n>（正式 id 由 apply 漏斗派生）");

/** 一条时间性探索线 = git 分支 / lane。根 thread 的 parentThreadId 与 forkedFromTurnRef 均为 null。 */
export const explorationThreadSchema = z.object({
	threadId: explorationThreadIdSchema,
	threadTitle: z.string().min(1).max(THREAD_TITLE_MAX_LENGTH),
	parentThreadId: explorationThreadIdSchema.nullable(),
	forkedFromTurnRef: explorationTurnRefSchema.nullable(),
	primaryTopicId: identifierSchema,
	threadLifecycleStatus: explorationThreadLifecycleStatusSchema,
	concludedAtTurnRef: explorationTurnRefSchema.nullable(),
	generationSource: explorationThreadGraphRecordGenerationSourceSchema,
	createdAt: epochMillisecondsSchema,
	updatedAt: epochMillisecondsSchema,
});
export type ExplorationThread = z.infer<typeof explorationThreadSchema>;

/** 判定置信度。低置信度不阻止落盘，只在渲染层提示「这条归属存疑」。 */
export const turnThreadPlacementConfidenceSchema = z.enum(["high", "low"]);
export type TurnThreadPlacementConfidence = z.infer<typeof turnThreadPlacementConfidenceSchema>;

/**
 * Turn → thread 的归属，单独成表。v1 每个 turnRef 恰一行（漏斗闸保证）；
 * 将来允许多行即表示一个 turn 同时坐在多条 lane 上，届时只放宽闸、不改表结构。
 */
export const turnThreadPlacementSchema = z.object({
	turnRef: explorationTurnRefSchema,
	threadId: explorationThreadIdSchema,
	placementConfidence: turnThreadPlacementConfidenceSchema,
	deviationRationale: z.string().max(DEVIATION_RATIONALE_MAX_LENGTH).nullable(),
	placementSource: explorationThreadGraphRecordGenerationSourceSchema,
	createdAt: epochMillisecondsSchema,
	updatedAt: epochMillisecondsSchema,
});
export type TurnThreadPlacement = z.infer<typeof turnThreadPlacementSchema>;

/** Turn 上的自由标签，是原料不是策展产物：不进 topic 注册表，多主题即多标签。 */
export const turnSubjectTaggingSchema = z.object({
	turnRef: explorationTurnRefSchema,
	turnSubjectTags: z.array(z.string().min(1).max(TURN_SUBJECT_TAG_MAX_LENGTH)).max(TURN_SUBJECT_TAG_MAX_COUNT),
	taggingSource: explorationThreadGraphRecordGenerationSourceSchema,
	createdAt: epochMillisecondsSchema,
	updatedAt: epochMillisecondsSchema,
});
export type TurnSubjectTagging = z.infer<typeof turnSubjectTaggingSchema>;

/**
 * 关系边的种类（handoff A.3 固定了它们到渲染层 parentIds 的映射）：
 * `continues` → 上一 turn；`forks_from` / `returns_to` / `draws_from` → target turn；
 * `concludes` → 该 thread 的最后一个 turn（画合流线）。
 */
export const turnRelationEdgeKindSchema = z.enum(["continues", "forks_from", "returns_to", "draws_from", "concludes"]);
export type TurnRelationEdgeKind = z.infer<typeof turnRelationEdgeKindSchema>;

/** Turn → 更早 Turn/thread 的有向边，可多条（D4：多对一）。target 二选一，由漏斗按 edgeKind 校验。 */
export const turnRelationEdgeSchema = z.object({
	sourceTurnRef: explorationTurnRefSchema,
	edgeKind: turnRelationEdgeKindSchema,
	targetTurnRef: explorationTurnRefSchema.nullable(),
	targetThreadId: explorationThreadIdSchema.nullable(),
	generationSource: explorationThreadGraphRecordGenerationSourceSchema,
	createdAt: epochMillisecondsSchema,
});
export type TurnRelationEdge = z.infer<typeof turnRelationEdgeSchema>;

/** Turn 上的事件标记：只是事件，不承担结构（结构由 placement 与 edge 承担）。 */
export const turnEventMarkKindSchema = z.enum(["milestone", "decision_point", "open_question", "finding_candidate"]);
export type TurnEventMarkKind = z.infer<typeof turnEventMarkKindSchema>;

export const turnEventMarkSchema = z.object({
	turnRef: explorationTurnRefSchema,
	mark: turnEventMarkKindSchema,
	note: z.string().max(TURN_EVENT_MARK_NOTE_MAX_LENGTH).nullable(),
	// 宿主侧资产的外键（cline-kanban 的 findingId 等）。本包不解析它，只原样携带。
	externalReferenceId: identifierSchema.nullable(),
	generationSource: explorationThreadGraphRecordGenerationSourceSchema,
	createdAt: epochMillisecondsSchema,
});
export type TurnEventMark = z.infer<typeof turnEventMarkSchema>;

/** collection 落后于会话的原因；null = 与会话同步。 */
export const explorationThreadGraphStaleReasonSchema = z.enum([
	"new_turns_not_yet_placed",
	"turn_source_signature_changed",
]);
export type ExplorationThreadGraphStaleReason = z.infer<typeof explorationThreadGraphStaleReasonSchema>;

/** 一次维护作业的用量回报（契约 A.13-3：必须回报 cache 读量）。 */
export const explorationThreadGraphMaintenanceJobUsageSchema = z.object({
	inputTokens: z.number().int().nonnegative(),
	cacheReadInputTokens: z.number().int().nonnegative(),
	outputTokens: z.number().int().nonnegative(),
	costUsd: z.number().nonnegative().nullable(),
});
export type ExplorationThreadGraphMaintenanceJobUsage = z.infer<typeof explorationThreadGraphMaintenanceJobUsageSchema>;

/** 每个 exploration 一份的集合（落盘在 `<storeRoot>/explorations/<explorationId>/exploration-thread-graph.json`）。 */
export const explorationThreadGraphCollectionSchema = z.object({
	schemaVersion: z.number().int().nonnegative(),
	explorationId: identifierSchema,
	threads: z.array(explorationThreadSchema),
	turnThreadPlacements: z.array(turnThreadPlacementSchema),
	turnSubjectTaggings: z.array(turnSubjectTaggingSchema),
	turnRelationEdges: z.array(turnRelationEdgeSchema),
	turnEventMarks: z.array(turnEventMarkSchema),
	// 作业读到的 turn 序列签名，按会话记；与 apply 时刻不一致即拒绝并标 stale（漏斗的签名对账闸）。
	sourceTurnSequenceSignatureBySession: z.record(z.string(), z.string()),
	// frontier：每个会话最后一个已归位的 turn 编号。
	lastPlacedTurnNumberBySession: z.record(z.string(), z.number().int().nonnegative()),
	staleReason: explorationThreadGraphStaleReasonSchema.nullable(),
	lastMaintenanceJobCompletedAt: epochMillisecondsSchema.nullable(),
	lastMaintenanceJobUsage: explorationThreadGraphMaintenanceJobUsageSchema.nullable(),
	updatedAt: epochMillisecondsSchema,
});
export type ExplorationThreadGraphCollection = z.infer<typeof explorationThreadGraphCollectionSchema>;

/** 每个 storeRoot 一份的 topic 注册表（落盘在 `<storeRoot>/topic-registry.json`）。 */
export const explorationTopicRegistrySchema = z.object({
	schemaVersion: z.number().int().nonnegative(),
	topics: z.array(explorationTopicSchema),
});
export type ExplorationTopicRegistry = z.infer<typeof explorationTopicRegistrySchema>;

/** 空集合的构造子：store 在文件缺失或损坏时回落到它，读路径永不抛。 */
export function createEmptyExplorationThreadGraphCollection(
	explorationId: string,
	now: number,
): ExplorationThreadGraphCollection {
	return {
		schemaVersion: EXPLORATION_THREAD_GRAPH_SCHEMA_VERSION,
		explorationId,
		threads: [],
		turnThreadPlacements: [],
		turnSubjectTaggings: [],
		turnRelationEdges: [],
		turnEventMarks: [],
		sourceTurnSequenceSignatureBySession: {},
		lastPlacedTurnNumberBySession: {},
		staleReason: null,
		lastMaintenanceJobCompletedAt: null,
		lastMaintenanceJobUsage: null,
		updatedAt: now,
	};
}

export function createEmptyExplorationTopicRegistry(): ExplorationTopicRegistry {
	return { schemaVersion: EXPLORATION_THREAD_GRAPH_SCHEMA_VERSION, topics: [] };
}

/**
 * topic 标题的规范化键：漏斗据此在注册表里撞既有 topic 复用（大小写、空白、标点差异不算新 topic）。
 * 别名也走同一个规范化，所以「同一个 topic 换个说法」不会长出第二条记录。
 */
export function normalizeTopicTitleForRegistryLookup(topicTitle: string): string {
	return topicTitle
		.normalize("NFKC")
		.toLowerCase()
		.replace(/[\s　]+/gu, " ")
		.replace(/[.,;:!?、，。；：！？·・_-]+/gu, "")
		.trim();
}

/** turnRef 的稳定字符串键（Map/Set 用）。跨会话唯一，因为带了 conversationSessionId。 */
export function formatExplorationTurnRefKey(turnRef: { conversationSessionId: string; turnNumber: number }): string {
	return `${turnRef.conversationSessionId}#${turnRef.turnNumber}`;
}
