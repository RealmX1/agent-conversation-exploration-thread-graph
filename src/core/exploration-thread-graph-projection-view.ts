// projection 整值（handoff A.3 / CONTEXT.md 的 ProjectionView）：
// collection + turn 快照 → 一整份宿主渲染所需的派生值。每次整值替换，不做增量补丁。
//
// 本模块是**纯函数**且不落盘：它派生的东西（parentIds、lane、跨会话时间序）都不是事实层的，
// 事实层只有 placement 与 edge。宿主 UI 只 import 本文件的类型与 layoutThreadGraphLanes。

import type { CompletedTurnSequenceSnapshot } from "./completed-turn-sequence-source.js";
import {
	EXPLORATION_THREAD_GRAPH_SCHEMA_VERSION,
	type ExplorationThread,
	type ExplorationThreadGraphCollection,
	type ExplorationThreadGraphMaintenanceJobUsage,
	type ExplorationThreadGraphStaleReason,
	type ExplorationTopic,
	type ExplorationTopicRegistry,
	type ExplorationTurnRef,
	formatExplorationTurnRefKey,
	type TurnEventMarkKind,
	type TurnThreadPlacementConfidence,
} from "./exploration-thread-graph-schema.js";
import {
	countThreadGraphLanes,
	layoutThreadGraphLanes,
	type ThreadGraphLaneLayoutRow,
} from "./thread-graph-lane-layout.js";

export interface ExplorationThreadGraphProjectionViewEventMark {
	mark: TurnEventMarkKind;
	note: string | null;
	externalReferenceId: string | null;
}

export interface ExplorationThreadGraphProjectionViewTurnRow {
	/** 行 id = `${conversationSessionId}#${turnNumber}`，也是 parentTurnRowIds 里用的键。 */
	turnRowId: string;
	turnRef: ExplorationTurnRef;
	userPromptExcerpt: string;
	assistantResponseExcerpt: string;
	startedAt: string;
	endedAt: string;
	toolCallCount: number;
	/** 尚未归位的 turn 这里是 null（图上仍要显示它，只是还没有 lane 身份）。 */
	threadId: string | null;
	placementConfidence: TurnThreadPlacementConfidence | null;
	deviationRationale: string | null;
	turnSubjectTags: string[];
	eventMarks: ExplorationThreadGraphProjectionViewEventMark[];
	/** 渲染层派生值：本行在 git-graph 里的 parent 行（可多条 = 合流）。 */
	parentTurnRowIds: string[];
	laneLayout: ThreadGraphLaneLayoutRow;
}

export interface ExplorationThreadGraphProjectionViewThread {
	thread: ExplorationThread;
	/** primaryTopicId 解析出的 topic；注册表里查不到时为 null（不阻断渲染）。 */
	primaryTopic: ExplorationTopic | null;
	turnCount: number;
}

export interface ExplorationThreadGraphProjectionView {
	schemaVersion: number;
	explorationId: string;
	/** **新→旧**（与 `git log` 一致），lane 布局就是按这个序算的。 */
	turnRows: ExplorationThreadGraphProjectionViewTurnRow[];
	threads: ExplorationThreadGraphProjectionViewThread[];
	laneCount: number;
	staleReason: ExplorationThreadGraphStaleReason | null;
	/** 各会话是否有已完成但尚未归位的 turn（宿主据此提示「图还差 N 个 turn」）。 */
	unplacedTurnCountBySession: Record<string, number>;
	lastMaintenanceJobCompletedAt: number | null;
	lastMaintenanceJobUsage: ExplorationThreadGraphMaintenanceJobUsage | null;
	/** 任一会话的 turn 来源是重建而非权威时为 true，宿主可据此弱化图的确定性表述。 */
	anyTurnSourceIsTranscriptReconstructed: boolean;
}

interface ChronologicalTurnEntry {
	turnRowId: string;
	turnRef: ExplorationTurnRef;
	userPromptExcerpt: string;
	assistantResponseExcerpt: string;
	startedAt: string;
	endedAt: string;
	startedAtMilliseconds: number;
	toolCallCount: number;
}

/**
 * 跨会话按时间合并成一条链。同一时刻的两个 turn 按会话 id 稳定排序——
 * 顺序必须是确定的，否则 lane 布局会在两次调用间抖动。
 */
function buildChronologicalTurnEntries(
	turnSnapshotsBySession: ReadonlyMap<string, CompletedTurnSequenceSnapshot>,
): ChronologicalTurnEntry[] {
	const entries: ChronologicalTurnEntry[] = [];
	for (const [conversationSessionId, snapshot] of turnSnapshotsBySession) {
		for (const turn of snapshot.turns) {
			const turnRef: ExplorationTurnRef = {
				conversationSessionId,
				turnNumber: turn.turnNumber,
				turnCheckpointCommit: null,
			};
			const startedAtMilliseconds = Date.parse(turn.startedAt);
			entries.push({
				turnRowId: formatExplorationTurnRefKey(turnRef),
				turnRef,
				userPromptExcerpt: turn.userPromptExcerpt,
				assistantResponseExcerpt: turn.assistantResponseExcerpt,
				startedAt: turn.startedAt,
				endedAt: turn.endedAt,
				startedAtMilliseconds: Number.isNaN(startedAtMilliseconds) ? 0 : startedAtMilliseconds,
				toolCallCount: turn.toolCallCount,
			});
		}
	}
	entries.sort((left, right) => {
		if (left.startedAtMilliseconds !== right.startedAtMilliseconds) {
			return left.startedAtMilliseconds - right.startedAtMilliseconds;
		}
		if (left.turnRef.conversationSessionId !== right.turnRef.conversationSessionId) {
			return left.turnRef.conversationSessionId.localeCompare(right.turnRef.conversationSessionId);
		}
		return left.turnRef.turnNumber - right.turnRef.turnNumber;
	});
	return entries;
}

export function buildExplorationThreadGraphProjectionView(
	collection: ExplorationThreadGraphCollection,
	turnSnapshotsBySession: ReadonlyMap<string, CompletedTurnSequenceSnapshot>,
	topicRegistry: ExplorationTopicRegistry,
): ExplorationThreadGraphProjectionView {
	const chronologicalEntries = buildChronologicalTurnEntries(turnSnapshotsBySession);

	const placementByTurnRowId = new Map(
		collection.turnThreadPlacements.map((placement) => [formatExplorationTurnRefKey(placement.turnRef), placement]),
	);
	const subjectTagsByTurnRowId = new Map(
		collection.turnSubjectTaggings.map((tagging) => [
			formatExplorationTurnRefKey(tagging.turnRef),
			tagging.turnSubjectTags,
		]),
	);
	const eventMarksByTurnRowId = new Map<string, ExplorationThreadGraphProjectionViewEventMark[]>();
	for (const eventMark of collection.turnEventMarks) {
		const turnRowId = formatExplorationTurnRefKey(eventMark.turnRef);
		const bucket = eventMarksByTurnRowId.get(turnRowId) ?? [];
		bucket.push({ mark: eventMark.mark, note: eventMark.note, externalReferenceId: eventMark.externalReferenceId });
		eventMarksByTurnRowId.set(turnRowId, bucket);
	}

	// thread → 它最后一个 turn 行（`concludes` 边要落到这里，画成合流线）。
	const chronologicalIndexByTurnRowId = new Map(chronologicalEntries.map((entry, index) => [entry.turnRowId, index]));
	const lastTurnRowIdByThreadId = new Map<string, string>();
	for (const entry of chronologicalEntries) {
		const placement = placementByTurnRowId.get(entry.turnRowId);
		if (placement !== undefined) lastTurnRowIdByThreadId.set(placement.threadId, entry.turnRowId);
	}

	// 显式边：按 source 行归组，映射成 parent 行 id（A.3 固定的映射规则）。
	const explicitParentRowIdsBySourceRowId = new Map<string, string[]>();
	for (const edge of collection.turnRelationEdges) {
		const sourceTurnRowId = formatExplorationTurnRefKey(edge.sourceTurnRef);
		let parentTurnRowId: string | null = null;
		if (edge.edgeKind === "concludes") {
			parentTurnRowId =
				edge.targetThreadId === null ? null : (lastTurnRowIdByThreadId.get(edge.targetThreadId) ?? null);
		} else if (edge.targetTurnRef !== null) {
			parentTurnRowId = formatExplorationTurnRefKey(edge.targetTurnRef);
		}
		if (parentTurnRowId === null || parentTurnRowId === sourceTurnRowId) {
			continue; // 自指边（收口边落在本行时）对渲染无意义，滤掉。
		}
		const bucket = explicitParentRowIdsBySourceRowId.get(sourceTurnRowId) ?? [];
		bucket.push(parentTurnRowId);
		explicitParentRowIdsBySourceRowId.set(sourceTurnRowId, bucket);
	}

	const threadById = new Map(collection.threads.map((thread) => [thread.threadId, thread]));
	// 隐式续接：同一 thread 内的上一个 turn 恒为第一 parent。
	// 这样即便分身漏发 `continues` 边，lane 也不会碎成一堆孤立点。
	const previousTurnRowIdByThreadId = new Map<string, string>();
	const parentTurnRowIdsByTurnRowId = new Map<string, string[]>();
	for (const entry of chronologicalEntries) {
		const placement = placementByTurnRowId.get(entry.turnRowId);
		const parentTurnRowIds: string[] = [];
		if (placement !== undefined) {
			const previousTurnRowIdInThread = previousTurnRowIdByThreadId.get(placement.threadId);
			if (previousTurnRowIdInThread !== undefined) {
				parentTurnRowIds.push(previousTurnRowIdInThread);
			} else {
				// thread 的第一个 turn：它的 parent 是分叉锚点 turn（根 thread 则没有 parent）。
				const thread = threadById.get(placement.threadId);
				const forkAnchorTurnRef = thread?.forkedFromTurnRef ?? null;
				if (forkAnchorTurnRef !== null) {
					const forkAnchorRowId = formatExplorationTurnRefKey(forkAnchorTurnRef);
					if (forkAnchorRowId !== entry.turnRowId && chronologicalIndexByTurnRowId.has(forkAnchorRowId)) {
						parentTurnRowIds.push(forkAnchorRowId);
					}
				}
			}
			previousTurnRowIdByThreadId.set(placement.threadId, entry.turnRowId);
		}
		for (const explicitParentRowId of explicitParentRowIdsBySourceRowId.get(entry.turnRowId) ?? []) {
			// 只认指向**更早**行的 parent，且去重；否则 lane 布局会自相矛盾。
			const parentIndex = chronologicalIndexByTurnRowId.get(explicitParentRowId);
			const ownIndex = chronologicalIndexByTurnRowId.get(entry.turnRowId);
			if (parentIndex === undefined || ownIndex === undefined || parentIndex >= ownIndex) continue;
			if (!parentTurnRowIds.includes(explicitParentRowId)) parentTurnRowIds.push(explicitParentRowId);
		}
		parentTurnRowIdsByTurnRowId.set(entry.turnRowId, parentTurnRowIds);
	}

	// lane 布局要新→旧的行序（git log 语义）。
	const newestFirstEntries = [...chronologicalEntries].reverse();
	const laneLayoutRows = layoutThreadGraphLanes(
		newestFirstEntries.map((entry) => ({
			id: entry.turnRowId,
			parentIds: parentTurnRowIdsByTurnRowId.get(entry.turnRowId) ?? [],
		})),
	);

	const turnRows: ExplorationThreadGraphProjectionViewTurnRow[] = newestFirstEntries.map((entry, index) => {
		const placement = placementByTurnRowId.get(entry.turnRowId) ?? null;
		const laneLayout = laneLayoutRows[index];
		if (laneLayout === undefined) {
			throw new Error(`lane 布局行数与 turn 行数不一致（index=${index}），这是本模块的内部不变量被破坏`);
		}
		return {
			turnRowId: entry.turnRowId,
			turnRef: placement?.turnRef ?? entry.turnRef,
			userPromptExcerpt: entry.userPromptExcerpt,
			assistantResponseExcerpt: entry.assistantResponseExcerpt,
			startedAt: entry.startedAt,
			endedAt: entry.endedAt,
			toolCallCount: entry.toolCallCount,
			threadId: placement?.threadId ?? null,
			placementConfidence: placement?.placementConfidence ?? null,
			deviationRationale: placement?.deviationRationale ?? null,
			turnSubjectTags: subjectTagsByTurnRowId.get(entry.turnRowId) ?? [],
			eventMarks: eventMarksByTurnRowId.get(entry.turnRowId) ?? [],
			parentTurnRowIds: parentTurnRowIdsByTurnRowId.get(entry.turnRowId) ?? [],
			laneLayout,
		};
	});

	const turnCountByThreadId = new Map<string, number>();
	for (const placement of collection.turnThreadPlacements) {
		turnCountByThreadId.set(placement.threadId, (turnCountByThreadId.get(placement.threadId) ?? 0) + 1);
	}
	const topicById = new Map(topicRegistry.topics.map((topic) => [topic.topicId, topic]));
	const threads: ExplorationThreadGraphProjectionViewThread[] = collection.threads.map((thread) => ({
		thread,
		primaryTopic: topicById.get(thread.primaryTopicId) ?? null,
		turnCount: turnCountByThreadId.get(thread.threadId) ?? 0,
	}));

	const unplacedTurnCountBySession: Record<string, number> = {};
	let anyTurnSourceIsTranscriptReconstructed = false;
	for (const [conversationSessionId, snapshot] of turnSnapshotsBySession) {
		if (snapshot.projectionConfidence === "transcript_reconstructed") {
			anyTurnSourceIsTranscriptReconstructed = true;
		}
		let unplacedTurnCount = 0;
		for (const turn of snapshot.turns) {
			const turnRowId = formatExplorationTurnRefKey({ conversationSessionId, turnNumber: turn.turnNumber });
			if (!placementByTurnRowId.has(turnRowId)) unplacedTurnCount += 1;
		}
		unplacedTurnCountBySession[conversationSessionId] = unplacedTurnCount;
	}

	return {
		schemaVersion: EXPLORATION_THREAD_GRAPH_SCHEMA_VERSION,
		explorationId: collection.explorationId,
		turnRows,
		threads,
		laneCount: countThreadGraphLanes(laneLayoutRows),
		staleReason: collection.staleReason,
		unplacedTurnCountBySession,
		lastMaintenanceJobCompletedAt: collection.lastMaintenanceJobCompletedAt,
		lastMaintenanceJobUsage: collection.lastMaintenanceJobUsage,
		anyTurnSourceIsTranscriptReconstructed,
	};
}
