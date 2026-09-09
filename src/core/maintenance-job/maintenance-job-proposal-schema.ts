// 维护作业分身输出的**提案** schema（handoff A.5）。
//
// 提案不是已落盘的事实：它只是一份待校验的判定，必须整份经 apply 漏斗才可能落装。
// 分身**不得自报正式 id**——新 thread / 新 topic 一律用本提案内的临时 id，正式 id 由漏斗派生。
// 这条与 cline-kanban 「mapNodeId 恒由漏斗派生」的赋名纪律同源：id 是事实层的东西，不交给模型。

import { z } from "zod";
import {
	DEVIATION_RATIONALE_MAX_LENGTH,
	explorationThreadLifecycleStatusSchema,
	explorationTurnRefSchema,
	THREAD_TITLE_MAX_LENGTH,
	TOPIC_ALIAS_MAX_COUNT,
	TOPIC_SUMMARY_MARKDOWN_MAX_LENGTH,
	TOPIC_TITLE_MAX_LENGTH,
	TURN_EVENT_MARK_NOTE_MAX_LENGTH,
	TURN_SUBJECT_TAG_MAX_COUNT,
	TURN_SUBJECT_TAG_MAX_LENGTH,
	turnEventMarkKindSchema,
	turnRelationEdgeKindSchema,
	turnThreadPlacementConfidenceSchema,
} from "../exploration-thread-graph-schema.js";

/** 单份提案里各数组的条数上限：挡住「分身一次吐一万条」把 store 撑爆。 */
export const MAINTENANCE_PROPOSAL_MAX_ITEMS_PER_COLLECTION = 200;

/**
 * 对 thread 的引用：既可能是已存在的正式 id（`thread-3`），也可能是本提案内新建的临时 id。
 * 漏斗负责把临时 id 解析成派生出来的正式 id；解析不了则整份拒绝。
 */
const proposalThreadIdReferenceSchema = z.string().min(1).max(200);

/** 对 topic 的引用：已存在的 topicId，或本提案 topicProposals 里的临时 id。 */
const proposalTopicIdReferenceSchema = z.string().min(1).max(200);

const boundedProposalArray = <ItemSchema extends z.ZodTypeAny>(itemSchema: ItemSchema) =>
	z.array(itemSchema).max(MAINTENANCE_PROPOSAL_MAX_ITEMS_PER_COLLECTION);

/** 分身对某个 turn 归属的判定。偏离时必须附 deviationRationale（判断清单第 ① 条）。 */
export const maintenanceProposalPlacementSchema = z.object({
	turnRef: explorationTurnRefSchema,
	threadId: proposalThreadIdReferenceSchema,
	placementConfidence: turnThreadPlacementConfidenceSchema,
	deviationRationale: z.string().max(DEVIATION_RATIONALE_MAX_LENGTH).nullable(),
});

/** 新建 thread。temporaryThreadId 只在本提案内有意义，落盘前会被换成 `thread-<n>`。 */
export const maintenanceProposalNewThreadSchema = z.object({
	temporaryThreadId: z.string().min(1).max(200),
	threadTitle: z.string().min(1).max(THREAD_TITLE_MAX_LENGTH),
	parentThreadId: proposalThreadIdReferenceSchema.nullable(),
	/** 分叉锚点：默认上一 turn；用户明示「回到 T3」时锚 T3。根 thread 为 null。 */
	forkedFromTurnRef: explorationTurnRefSchema.nullable(),
	primaryTopicId: proposalTopicIdReferenceSchema,
});

/** 新 topic 提案。漏斗按规范化标题撞注册表，命中则复用既有 topic 而不是长出重复条目。 */
export const maintenanceProposalTopicSchema = z.object({
	temporaryTopicId: z.string().min(1).max(200),
	topicTitle: z.string().min(1).max(TOPIC_TITLE_MAX_LENGTH),
	topicAliases: z.array(z.string().min(1).max(TOPIC_TITLE_MAX_LENGTH)).max(TOPIC_ALIAS_MAX_COUNT),
	topicSummaryMarkdown: z.string().max(TOPIC_SUMMARY_MARKDOWN_MAX_LENGTH).nullable(),
});

/** 关系边提案。target 二选一：`concludes` 指向 thread，其余指向 turn（漏斗按 edgeKind 校验）。 */
export const maintenanceProposalEdgeSchema = z.object({
	sourceTurnRef: explorationTurnRefSchema,
	edgeKind: turnRelationEdgeKindSchema,
	targetTurnRef: explorationTurnRefSchema.nullable(),
	targetThreadId: proposalThreadIdReferenceSchema.nullable(),
});

export const maintenanceProposalEventMarkSchema = z.object({
	turnRef: explorationTurnRefSchema,
	mark: turnEventMarkKindSchema,
	note: z.string().max(TURN_EVENT_MARK_NOTE_MAX_LENGTH).nullable(),
	externalReferenceId: z.string().min(1).max(200).nullable(),
});

/**
 * 对既有 thread 的修订（判断清单第 ⑫ 条：每次运行复核活跃 thread 的标题/topic 是否漂移）。
 * 三个字段都可省，省略即不动该字段。改题与拓宽 topic 是无损操作，漏斗自动应用。
 */
export const maintenanceProposalThreadRevisionSchema = z.object({
	threadId: proposalThreadIdReferenceSchema,
	threadTitle: z.string().min(1).max(THREAD_TITLE_MAX_LENGTH).optional(),
	threadLifecycleStatus: explorationThreadLifecycleStatusSchema.optional(),
	primaryTopicId: proposalTopicIdReferenceSchema.optional(),
});

export const maintenanceProposalSubjectTaggingSchema = z.object({
	turnRef: explorationTurnRefSchema,
	turnSubjectTags: z.array(z.string().min(1).max(TURN_SUBJECT_TAG_MAX_LENGTH)).max(TURN_SUBJECT_TAG_MAX_COUNT),
});

export const explorationThreadGraphMaintenanceProposalSchema = z.object({
	placements: boundedProposalArray(maintenanceProposalPlacementSchema),
	newThreads: boundedProposalArray(maintenanceProposalNewThreadSchema),
	topicProposals: boundedProposalArray(maintenanceProposalTopicSchema),
	edges: boundedProposalArray(maintenanceProposalEdgeSchema),
	eventMarks: boundedProposalArray(maintenanceProposalEventMarkSchema),
	threadRevisions: boundedProposalArray(maintenanceProposalThreadRevisionSchema),
	subjectTaggings: boundedProposalArray(maintenanceProposalSubjectTaggingSchema),
});

export type ExplorationThreadGraphMaintenanceProposal = z.infer<typeof explorationThreadGraphMaintenanceProposalSchema>;
export type MaintenanceProposalPlacement = z.infer<typeof maintenanceProposalPlacementSchema>;
export type MaintenanceProposalNewThread = z.infer<typeof maintenanceProposalNewThreadSchema>;
export type MaintenanceProposalTopic = z.infer<typeof maintenanceProposalTopicSchema>;
export type MaintenanceProposalEdge = z.infer<typeof maintenanceProposalEdgeSchema>;
export type MaintenanceProposalEventMark = z.infer<typeof maintenanceProposalEventMarkSchema>;
export type MaintenanceProposalThreadRevision = z.infer<typeof maintenanceProposalThreadRevisionSchema>;
export type MaintenanceProposalSubjectTagging = z.infer<typeof maintenanceProposalSubjectTaggingSchema>;
