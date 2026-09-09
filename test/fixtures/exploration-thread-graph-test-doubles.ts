// 各单测共用的构造器：把「造一份合法快照/集合」的样板集中一处，
// 免得每个测试各写一份、日后 schema 一改要改十处。

import type {
	CompletedConversationTurn,
	CompletedTurnSequenceSnapshot,
	ExplorationThread,
	ExplorationThreadGraphCollection,
	ExplorationTopic,
	ExplorationTopicRegistry,
	ExplorationTurnRef,
	TurnThreadPlacement,
} from "../../src/core/index.js";
import { createEmptyExplorationThreadGraphCollection } from "../../src/core/index.js";

export const TEST_NOW_MILLISECONDS = 1_760_000_000_000;

/** 第 n 个 turn 的开始时间：每个 turn 间隔一分钟，方便断言跨会话时间合并。 */
export function buildTurnStartedAt(turnNumber: number, sessionOffsetMinutes = 0): string {
	return new Date(TEST_NOW_MILLISECONDS + (turnNumber + sessionOffsetMinutes) * 60_000).toISOString();
}

export function buildCompletedConversationTurn(
	turnNumber: number,
	overrides: Partial<CompletedConversationTurn> = {},
	sessionOffsetMinutes = 0,
): CompletedConversationTurn {
	return {
		turnNumber,
		userPromptExcerpt: `用户消息 ${turnNumber}`,
		assistantResponseExcerpt: `助手回答 ${turnNumber}`,
		startedAt: buildTurnStartedAt(turnNumber, sessionOffsetMinutes),
		endedAt: buildTurnStartedAt(turnNumber + 0.5, sessionOffsetMinutes),
		userMessageOrigin: "human_typed",
		toolCallCount: 0,
		...overrides,
	};
}

export function buildCompletedTurnSequenceSnapshot(
	conversationSessionId: string,
	turnCount: number,
	overrides: Partial<CompletedTurnSequenceSnapshot> = {},
	sessionOffsetMinutes = 0,
): CompletedTurnSequenceSnapshot {
	return {
		conversationSessionId,
		sourceKind: "claude_code_transcript",
		turns: Array.from({ length: turnCount }, (_unused, index) =>
			buildCompletedConversationTurn(index + 1, {}, sessionOffsetMinutes),
		),
		sourceSignature: `signature-${conversationSessionId}-${turnCount}`,
		projectionConfidence: "transcript_reconstructed",
		inProgressTurnNumber: null,
		...overrides,
	};
}

export function buildTurnSnapshotsBySession(
	snapshots: readonly CompletedTurnSequenceSnapshot[],
): Map<string, CompletedTurnSequenceSnapshot> {
	return new Map(snapshots.map((snapshot) => [snapshot.conversationSessionId, snapshot]));
}

export function buildSignatureBySession(snapshots: readonly CompletedTurnSequenceSnapshot[]): Record<string, string> {
	return Object.fromEntries(snapshots.map((snapshot) => [snapshot.conversationSessionId, snapshot.sourceSignature]));
}

export function buildTurnRef(conversationSessionId: string, turnNumber: number): ExplorationTurnRef {
	return { conversationSessionId, turnNumber, turnCheckpointCommit: null };
}

export function buildTopic(topicId: string, topicTitle: string): ExplorationTopic {
	return {
		topicId,
		topicTitle,
		topicAliases: [],
		topicSummaryMarkdown: null,
		supersededByTopicId: null,
		generationSource: "work_branch_maintenance_job",
		createdAt: TEST_NOW_MILLISECONDS,
		updatedAt: TEST_NOW_MILLISECONDS,
	};
}

export function buildTopicRegistry(topics: readonly ExplorationTopic[] = []): ExplorationTopicRegistry {
	return { schemaVersion: 1, topics: [...topics] };
}

export function buildThread(threadId: string, overrides: Partial<ExplorationThread> = {}): ExplorationThread {
	return {
		threadId,
		threadTitle: `线 ${threadId}`,
		parentThreadId: null,
		forkedFromTurnRef: null,
		primaryTopicId: "topic-1",
		threadLifecycleStatus: "active",
		concludedAtTurnRef: null,
		generationSource: "work_branch_maintenance_job",
		createdAt: TEST_NOW_MILLISECONDS,
		updatedAt: TEST_NOW_MILLISECONDS,
		...overrides,
	};
}

export function buildPlacement(
	conversationSessionId: string,
	turnNumber: number,
	threadId: string,
	overrides: Partial<TurnThreadPlacement> = {},
): TurnThreadPlacement {
	return {
		turnRef: buildTurnRef(conversationSessionId, turnNumber),
		threadId,
		placementConfidence: "high",
		deviationRationale: null,
		placementSource: "work_branch_maintenance_job",
		createdAt: TEST_NOW_MILLISECONDS,
		updatedAt: TEST_NOW_MILLISECONDS,
		...overrides,
	};
}

export function buildCollection(
	explorationId: string,
	overrides: Partial<ExplorationThreadGraphCollection> = {},
): ExplorationThreadGraphCollection {
	return {
		...createEmptyExplorationThreadGraphCollection(explorationId, TEST_NOW_MILLISECONDS),
		...overrides,
	};
}

/** 一份最小的合法提案；各测试只覆盖自己关心的那几个数组。 */
export function buildProposal(
	overrides: Partial<{
		placements: unknown[];
		newThreads: unknown[];
		topicProposals: unknown[];
		edges: unknown[];
		eventMarks: unknown[];
		threadRevisions: unknown[];
		subjectTaggings: unknown[];
	}> = {},
): Record<string, unknown> {
	return {
		placements: [],
		newThreads: [],
		topicProposals: [],
		edges: [],
		eventMarks: [],
		threadRevisions: [],
		subjectTaggings: [],
		...overrides,
	};
}
