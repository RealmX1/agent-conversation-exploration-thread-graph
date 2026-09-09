// thread graph 的 **唯一写点**（handoff A.5）：维护提案落盘前的全部校验与赋名都在这里。
// 纯函数——调用方先把 turn 快照与现状取好，再在 store 的串行写队列里调本函数，
// 保证「读现状 → 校验 → 落装」与写盘原子于同一把队列锁内。
//
// 闸序（任一失败整体丢弃并回 rejected(reason)）。**编号即真实执行顺序**——
// 多道闸会同时失败时，外部观察到的 rejectionReason 就是编号最小的那道：
//   1. zod 形状（含尺寸上限）
//   2. 签名对账：作业**发起时**留存的签名与**落盘时刻重读**的快照一致，否则拒绝并标 stale
//      （排在所有语义闸之前：签名对不上说明判定基于过期快照，后面校验什么都没有意义）
//   3. 每个 turnRef 可解析：在对应会话的已完成 turn 内，且不是进行中的末 turn
//   4. threadId / topicId 可解析（含本提案新建的临时 id），临时 id 不得与既有 id 撞名、提案内也不得自相重复
//   5. 边只向过去（同会话比 turn 号，跨会话比时间）；target 形状与 edgeKind 匹配
//   6. placements 恰好覆盖本次待判范围：每个待判 turn 恰一行，且不含范围外的 turn
//   7. user_manual_edit 来源的记录不得被作业改动（与闸 8 同一遍遍历，命中时先于闸 8 返回；
//      thread 修订那半要按 topic 维度解析 id，故排在闸 9 之后执行）
//   8. 修订窗口（k）之外的既有 placement 不得改动
//   9. 派生正式 id / 复用 topic
//  10. durable-write-before-ack —— 由 store 的原子写承担，不在本模块
//
// 赋名纪律：threadId / topicId 恒由本漏斗派生，分身只能自报临时 id。id 属于事实层，不交给模型。

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
	normalizeTopicTitleForRegistryLookup,
	type TurnEventMark,
	type TurnRelationEdge,
	type TurnSubjectTagging,
	type TurnThreadPlacement,
} from "./exploration-thread-graph-schema.js";
import {
	type ExplorationThreadGraphMaintenanceProposal,
	explorationThreadGraphMaintenanceProposalSchema,
} from "./maintenance-job/maintenance-job-proposal-schema.js";

/** 修订窗口默认宽度：维护作业可改写最近 3 个已归位 turn 的 placement，更早的冻结。 */
export const DEFAULT_PLACEMENT_REVISION_WINDOW_TURN_COUNT = 3;

export type ExplorationThreadGraphApplyRejectionReason =
	| "proposal_shape_invalid"
	| "turn_ref_unresolvable"
	| "turn_ref_is_in_progress_turn"
	| "thread_id_unresolvable"
	| "topic_id_unresolvable"
	| "temporary_id_collides_with_existing_id"
	| "duplicate_temporary_id_within_proposal"
	| "edge_target_shape_invalid"
	| "edge_target_not_in_past"
	| "duplicate_placement_for_turn"
	| "placement_missing_for_turn_under_judgement"
	| "placement_outside_turns_under_judgement"
	| "frozen_placement_outside_revision_window"
	| "user_manual_edit_conflict"
	| "turn_source_signature_mismatch";

export interface ApplyExplorationThreadGraphMaintenanceProposalInput {
	explorationId: string;
	/** 未校验的分身输出；闸 1 在漏斗内部做，调用方不要先解析。 */
	proposal: unknown;
	/** apply 时刻重新读到的 turn 快照，按 conversationSessionId 索引。 */
	turnSnapshotsBySession: ReadonlyMap<string, CompletedTurnSequenceSnapshot>;
	/** 作业**发起时**读到的各会话签名；与 apply 时刻不一致即闸 2 拒绝。 */
	proposalSourceTurnSequenceSignatureBySession: Readonly<Record<string, string>>;
	/**
	 * 本次作业交给分身判定的 turn 范围（编排侧按模式与批次算好，与 prompt 里列出的那份完全一致）。
	 * 闸 6 拿它校验 placements **恰好覆盖**该范围：漏判与越界都整份拒绝。
	 */
	turnsUnderJudgement: readonly { conversationSessionId: string; turnNumber: number }[];
	currentCollection: ExplorationThreadGraphCollection;
	currentTopicRegistry: ExplorationTopicRegistry;
	revisionWindowTurnCount?: number;
	maintenanceJobUsage?: ExplorationThreadGraphMaintenanceJobUsage | null;
	now: number;
}

export type ApplyExplorationThreadGraphMaintenanceProposalResult =
	| {
			outcome: "accepted";
			collection: ExplorationThreadGraphCollection;
			topicRegistry: ExplorationTopicRegistry;
	  }
	| {
			outcome: "rejected";
			rejectionReason: ExplorationThreadGraphApplyRejectionReason;
			/**
			 * 拒绝时仍需落盘的**唯一**东西：stale 标记（闸 2 的「拒绝并标 stale」）。
			 * 非 null 时调用方原样写盘——除 staleReason / updatedAt 外与现状全等。
			 */
			collectionStaleMarkUpdate: ExplorationThreadGraphCollection | null;
	  };

function reject(
	rejectionReason: ExplorationThreadGraphApplyRejectionReason,
	collectionStaleMarkUpdate: ExplorationThreadGraphCollection | null = null,
): ApplyExplorationThreadGraphMaintenanceProposalResult {
	return { outcome: "rejected", rejectionReason, collectionStaleMarkUpdate };
}

/** turn 在全局时间轴上的位置，用来判「边是否只向过去」（跨会话时 turn 号不可比）。 */
interface ResolvedTurnPosition {
	conversationSessionId: string;
	turnNumber: number;
	startedAtMilliseconds: number;
}

function compareTurnPositions(left: ResolvedTurnPosition, right: ResolvedTurnPosition): number {
	if (left.conversationSessionId === right.conversationSessionId) {
		return left.turnNumber - right.turnNumber;
	}
	if (left.startedAtMilliseconds !== right.startedAtMilliseconds) {
		return left.startedAtMilliseconds - right.startedAtMilliseconds;
	}
	return left.conversationSessionId.localeCompare(right.conversationSessionId);
}

function buildResolvedTurnPositionIndex(
	turnSnapshotsBySession: ReadonlyMap<string, CompletedTurnSequenceSnapshot>,
): Map<string, ResolvedTurnPosition> {
	const index = new Map<string, ResolvedTurnPosition>();
	for (const [conversationSessionId, snapshot] of turnSnapshotsBySession) {
		for (const turn of snapshot.turns) {
			const startedAtMilliseconds = Date.parse(turn.startedAt);
			index.set(formatExplorationTurnRefKey({ conversationSessionId, turnNumber: turn.turnNumber }), {
				conversationSessionId,
				turnNumber: turn.turnNumber,
				// 时间戳解析不了时退化为 0：同会话比较用 turn 号，跨会话比较退化成按会话 id 稳定排序，
				// 不会因为一条坏时间戳就拒绝整份提案。
				startedAtMilliseconds: Number.isNaN(startedAtMilliseconds) ? 0 : startedAtMilliseconds,
			});
		}
	}
	return index;
}

/** 收集提案里出现的所有 turnRef，供闸 3 统一校验。 */
function collectProposalTurnRefs(proposal: ExplorationThreadGraphMaintenanceProposal): ExplorationTurnRef[] {
	const turnRefs: ExplorationTurnRef[] = [];
	for (const placement of proposal.placements) turnRefs.push(placement.turnRef);
	for (const newThread of proposal.newThreads) {
		if (newThread.forkedFromTurnRef !== null) turnRefs.push(newThread.forkedFromTurnRef);
	}
	for (const edge of proposal.edges) {
		turnRefs.push(edge.sourceTurnRef);
		if (edge.targetTurnRef !== null) turnRefs.push(edge.targetTurnRef);
	}
	for (const eventMark of proposal.eventMarks) turnRefs.push(eventMark.turnRef);
	for (const subjectTagging of proposal.subjectTaggings) turnRefs.push(subjectTagging.turnRef);
	return turnRefs;
}

function deriveNextThreadOrdinal(existingThreads: readonly ExplorationThread[]): number {
	let highestOrdinal = 0;
	for (const thread of existingThreads) {
		const ordinalText = thread.threadId.slice("thread-".length);
		const ordinal = Number.parseInt(ordinalText, 10);
		if (Number.isFinite(ordinal) && ordinal > highestOrdinal) highestOrdinal = ordinal;
	}
	return highestOrdinal + 1;
}

function deriveNextTopicOrdinal(existingTopics: readonly ExplorationTopic[]): number {
	let highestOrdinal = 0;
	for (const topic of existingTopics) {
		if (!topic.topicId.startsWith("topic-")) continue;
		const ordinal = Number.parseInt(topic.topicId.slice("topic-".length), 10);
		if (Number.isFinite(ordinal) && ordinal > highestOrdinal) highestOrdinal = ordinal;
	}
	return highestOrdinal + 1;
}

/** 规范化后的标题/别名 → 既有 topicId，用于闸 9 的 topic 复用。 */
function buildTopicLookupByNormalizedTitle(topics: readonly ExplorationTopic[]): Map<string, string> {
	const lookup = new Map<string, string>();
	for (const topic of topics) {
		for (const candidateTitle of [topic.topicTitle, ...topic.topicAliases]) {
			const normalized = normalizeTopicTitleForRegistryLookup(candidateTitle);
			if (normalized !== "" && !lookup.has(normalized)) lookup.set(normalized, topic.topicId);
		}
	}
	return lookup;
}

function placementSemanticFieldsEqual(
	left: Pick<TurnThreadPlacement, "threadId" | "placementConfidence" | "deviationRationale">,
	right: Pick<TurnThreadPlacement, "threadId" | "placementConfidence" | "deviationRationale">,
): boolean {
	return (
		left.threadId === right.threadId &&
		left.placementConfidence === right.placementConfidence &&
		left.deviationRationale === right.deviationRationale
	);
}

export function applyExplorationThreadGraphMaintenanceProposal(
	input: ApplyExplorationThreadGraphMaintenanceProposalInput,
): ApplyExplorationThreadGraphMaintenanceProposalResult {
	const {
		explorationId,
		turnSnapshotsBySession,
		proposalSourceTurnSequenceSignatureBySession,
		currentCollection,
		currentTopicRegistry,
		now,
	} = input;
	const revisionWindowTurnCount = input.revisionWindowTurnCount ?? DEFAULT_PLACEMENT_REVISION_WINDOW_TURN_COUNT;

	// ── 闸 1：zod 形状 ──
	const parsedProposal = explorationThreadGraphMaintenanceProposalSchema.safeParse(input.proposal);
	if (!parsedProposal.success) {
		return reject("proposal_shape_invalid");
	}
	const proposal = parsedProposal.data;

	// ── 闸 2：签名对账（放在形状之后、语义之前——签名不对时后面的校验都没有意义）──
	for (const [conversationSessionId, snapshot] of turnSnapshotsBySession) {
		const signatureSeenByJob = proposalSourceTurnSequenceSignatureBySession[conversationSessionId];
		if (signatureSeenByJob !== undefined && signatureSeenByJob !== snapshot.sourceSignature) {
			return reject("turn_source_signature_mismatch", {
				...currentCollection,
				staleReason: "turn_source_signature_changed",
				updatedAt: now,
			});
		}
	}

	// ── 闸 3：turnRef 可解析，且不是进行中的末 turn ──
	const turnPositionIndex = buildResolvedTurnPositionIndex(turnSnapshotsBySession);
	for (const turnRef of collectProposalTurnRefs(proposal)) {
		const snapshot = turnSnapshotsBySession.get(turnRef.conversationSessionId);
		if (snapshot === undefined) {
			return reject("turn_ref_unresolvable");
		}
		if (snapshot.inProgressTurnNumber !== null && snapshot.inProgressTurnNumber === turnRef.turnNumber) {
			return reject("turn_ref_is_in_progress_turn");
		}
		if (!turnPositionIndex.has(formatExplorationTurnRefKey(turnRef))) {
			return reject("turn_ref_unresolvable");
		}
	}

	// ── 闸 4：thread / topic 引用可解析；临时 id 不得与既有 id 撞名 ──
	const existingThreadIds = new Set(currentCollection.threads.map((thread) => thread.threadId));
	const existingTopicIds = new Set(currentTopicRegistry.topics.map((topic) => topic.topicId));
	const temporaryThreadIds = new Set(proposal.newThreads.map((newThread) => newThread.temporaryThreadId));
	const temporaryTopicIds = new Set(proposal.topicProposals.map((topicProposal) => topicProposal.temporaryTopicId));
	// 提案**内部**的临时 id 也必须互不重复：Set 会把重复项吞掉，而闸 8 与闸 9 的临时 id → 正式 id 映射
	// 是「后写覆盖」的 Map，重复时两条 newThread 会拿到同一个正式 threadId 落盘（事实层无唯一性约束）。
	if (temporaryThreadIds.size !== proposal.newThreads.length) {
		return reject("duplicate_temporary_id_within_proposal");
	}
	if (temporaryTopicIds.size !== proposal.topicProposals.length) {
		return reject("duplicate_temporary_id_within_proposal");
	}
	for (const temporaryThreadId of temporaryThreadIds) {
		if (existingThreadIds.has(temporaryThreadId)) return reject("temporary_id_collides_with_existing_id");
	}
	for (const temporaryTopicId of temporaryTopicIds) {
		if (existingTopicIds.has(temporaryTopicId)) return reject("temporary_id_collides_with_existing_id");
	}
	const isResolvableThreadId = (threadId: string): boolean =>
		existingThreadIds.has(threadId) || temporaryThreadIds.has(threadId);
	const isResolvableTopicId = (topicId: string): boolean =>
		existingTopicIds.has(topicId) || temporaryTopicIds.has(topicId);

	for (const placement of proposal.placements) {
		if (!isResolvableThreadId(placement.threadId)) return reject("thread_id_unresolvable");
	}
	for (const newThread of proposal.newThreads) {
		if (newThread.parentThreadId !== null && !isResolvableThreadId(newThread.parentThreadId)) {
			return reject("thread_id_unresolvable");
		}
		if (!isResolvableTopicId(newThread.primaryTopicId)) return reject("topic_id_unresolvable");
	}
	for (const threadRevision of proposal.threadRevisions) {
		// 修订只能作用于**既有** thread：新建的 thread 直接在 newThreads 里写对即可。
		if (!existingThreadIds.has(threadRevision.threadId)) return reject("thread_id_unresolvable");
		if (threadRevision.primaryTopicId !== undefined && !isResolvableTopicId(threadRevision.primaryTopicId)) {
			return reject("topic_id_unresolvable");
		}
	}
	for (const edge of proposal.edges) {
		if (edge.targetThreadId !== null && !isResolvableThreadId(edge.targetThreadId)) {
			return reject("thread_id_unresolvable");
		}
	}

	// ── 闸 5：边的 target 形状与「只向过去」──
	// `concludes` 指向 thread（渲染为合流线），其余四种指向 turn；两者互斥且必须二选一。
	const proposalPlacementByTurnKey = new Map(
		proposal.placements.map((placement) => [formatExplorationTurnRefKey(placement.turnRef), placement]),
	);
	const resolveThreadLastTurnPosition = (threadId: string): ResolvedTurnPosition | null => {
		let latest: ResolvedTurnPosition | null = null;
		const considerTurnRef = (turnRef: ExplorationTurnRef): void => {
			const position = turnPositionIndex.get(formatExplorationTurnRefKey(turnRef));
			if (position === undefined) return;
			if (latest === null || compareTurnPositions(position, latest) > 0) latest = position;
		};
		for (const placement of currentCollection.turnThreadPlacements) {
			if (placement.threadId === threadId) considerTurnRef(placement.turnRef);
		}
		for (const placement of proposal.placements) {
			if (placement.threadId === threadId) considerTurnRef(placement.turnRef);
		}
		return latest;
	};

	for (const edge of proposal.edges) {
		const sourcePosition = turnPositionIndex.get(formatExplorationTurnRefKey(edge.sourceTurnRef));
		if (sourcePosition === undefined) return reject("turn_ref_unresolvable");
		if (edge.edgeKind === "concludes") {
			if (edge.targetThreadId === null || edge.targetTurnRef !== null) {
				return reject("edge_target_shape_invalid");
			}
			const threadLastTurnPosition = resolveThreadLastTurnPosition(edge.targetThreadId);
			if (threadLastTurnPosition === null) return reject("edge_target_not_in_past");
			// 允许相等：收口边常常就落在该 thread 的最后一个 turn 上（渲染层会滤掉自指）。
			if (compareTurnPositions(threadLastTurnPosition, sourcePosition) > 0) {
				return reject("edge_target_not_in_past");
			}
			continue;
		}
		if (edge.targetTurnRef === null || edge.targetThreadId !== null) {
			return reject("edge_target_shape_invalid");
		}
		const targetPosition = turnPositionIndex.get(formatExplorationTurnRefKey(edge.targetTurnRef));
		if (targetPosition === undefined) return reject("turn_ref_unresolvable");
		if (compareTurnPositions(targetPosition, sourcePosition) >= 0) {
			return reject("edge_target_not_in_past");
		}
	}

	// ── 闸 6：placements 恰好覆盖本次待判范围 ──
	// 三件事一起判：提案内不得对同一个 turn 给两行、待判 turn 一个都不能漏、也不许判范围外的 turn。
	// 漏判尤其要拦死：落装末尾的 frontier 只看「最大已归位 turn 号」，中间被跳过的 turn 连 stale 都标不出来，
	// 调用方会把分身的整体/局部遗漏当成一次成功确认。
	if (proposalPlacementByTurnKey.size !== proposal.placements.length) {
		return reject("duplicate_placement_for_turn");
	}
	const turnUnderJudgementKeys = new Set(
		input.turnsUnderJudgement.map((turnUnderJudgement) => formatExplorationTurnRefKey(turnUnderJudgement)),
	);
	for (const turnUnderJudgementKey of turnUnderJudgementKeys) {
		if (!proposalPlacementByTurnKey.has(turnUnderJudgementKey)) {
			return reject("placement_missing_for_turn_under_judgement");
		}
	}
	for (const proposedPlacementTurnKey of proposalPlacementByTurnKey.keys()) {
		if (!turnUnderJudgementKeys.has(proposedPlacementTurnKey)) {
			return reject("placement_outside_turns_under_judgement");
		}
	}

	// ── 闸 7 / 闸 8：user_manual_edit 不可动 与 修订窗口冻结（同一遍遍历，前者命中时先返回）──
	// frontier 按会话取「既有 placement 里最大的 turn 号」；窗口 = frontier 往回 k 个 turn。
	const frontierTurnNumberBySession = new Map<string, number>();
	for (const placement of currentCollection.turnThreadPlacements) {
		const sessionId = placement.turnRef.conversationSessionId;
		const currentFrontier = frontierTurnNumberBySession.get(sessionId) ?? 0;
		if (placement.turnRef.turnNumber > currentFrontier) {
			frontierTurnNumberBySession.set(sessionId, placement.turnRef.turnNumber);
		}
	}
	const existingPlacementByTurnKey = new Map(
		currentCollection.turnThreadPlacements.map((placement) => [
			formatExplorationTurnRefKey(placement.turnRef),
			placement,
		]),
	);
	// 提案里的 threadId 可能还是临时 id，与既有 placement 的正式 id 无法直接比；
	// 所以先把临时 id 映射成派生出来的正式 id（闸 9 的赋名在此提前算出）。
	let nextThreadOrdinal = deriveNextThreadOrdinal(currentCollection.threads);
	const resolvedThreadIdByTemporaryId = new Map<string, string>();
	for (const newThread of proposal.newThreads) {
		resolvedThreadIdByTemporaryId.set(newThread.temporaryThreadId, `thread-${nextThreadOrdinal}`);
		nextThreadOrdinal += 1;
	}
	const resolveThreadId = (threadIdReference: string): string =>
		resolvedThreadIdByTemporaryId.get(threadIdReference) ?? threadIdReference;

	for (const [turnKey, proposedPlacement] of proposalPlacementByTurnKey) {
		const existingPlacement = existingPlacementByTurnKey.get(turnKey);
		if (existingPlacement === undefined) continue;
		const proposedSemanticFields = {
			threadId: resolveThreadId(proposedPlacement.threadId),
			placementConfidence: proposedPlacement.placementConfidence,
			deviationRationale: proposedPlacement.deviationRationale,
		};
		if (placementSemanticFieldsEqual(existingPlacement, proposedSemanticFields)) {
			continue; // 幂等重放：语义全等就不算「改动」，两道闸都放行。
		}
		if (existingPlacement.placementSource === "user_manual_edit") {
			return reject("user_manual_edit_conflict");
		}
		const sessionFrontier = frontierTurnNumberBySession.get(existingPlacement.turnRef.conversationSessionId) ?? 0;
		if (existingPlacement.turnRef.turnNumber <= sessionFrontier - revisionWindowTurnCount) {
			return reject("frozen_placement_outside_revision_window");
		}
	}

	// ── 闸 9：派生正式 id / 复用 topic ──
	const topicLookupByNormalizedTitle = buildTopicLookupByNormalizedTitle(currentTopicRegistry.topics);
	let nextTopicOrdinal = deriveNextTopicOrdinal(currentTopicRegistry.topics);
	const resolvedTopicIdByTemporaryId = new Map<string, string>();
	const appendedTopics: ExplorationTopic[] = [];
	for (const topicProposal of proposal.topicProposals) {
		const normalizedTitle = normalizeTopicTitleForRegistryLookup(topicProposal.topicTitle);
		const reusedTopicId = topicLookupByNormalizedTitle.get(normalizedTitle);
		if (reusedTopicId !== undefined) {
			resolvedTopicIdByTemporaryId.set(topicProposal.temporaryTopicId, reusedTopicId);
			continue;
		}
		const derivedTopicId = `topic-${nextTopicOrdinal}`;
		nextTopicOrdinal += 1;
		resolvedTopicIdByTemporaryId.set(topicProposal.temporaryTopicId, derivedTopicId);
		topicLookupByNormalizedTitle.set(normalizedTitle, derivedTopicId);
		appendedTopics.push({
			topicId: derivedTopicId,
			topicTitle: topicProposal.topicTitle,
			topicAliases: topicProposal.topicAliases,
			topicSummaryMarkdown: topicProposal.topicSummaryMarkdown,
			supersededByTopicId: null,
			generationSource: "work_branch_maintenance_job",
			createdAt: now,
			updatedAt: now,
		});
	}
	const resolveTopicId = (topicIdReference: string): string =>
		resolvedTopicIdByTemporaryId.get(topicIdReference) ?? topicIdReference;

	// ── 闸 7（thread 修订部分）：user_manual_edit 来源的 thread 不得被作业改动 ──
	// 排在闸 9 之后是必须的：primaryTopicId 要按 **topic** 维度解析，而临时 topic id → 正式 topic id
	// 的映射到闸 9 才建起来。早先这里误用 resolveThreadId，临时 topic id 与临时 thread id 同名时会被
	// 解析成 thread-N，把一条毫无改动的修订误判成冲突。
	const existingThreadById = new Map(currentCollection.threads.map((thread) => [thread.threadId, thread]));
	for (const threadRevision of proposal.threadRevisions) {
		const existingThread = existingThreadById.get(threadRevision.threadId);
		if (existingThread === undefined) return reject("thread_id_unresolvable");
		if (existingThread.generationSource !== "user_manual_edit") continue;
		const revisionWouldChangeThread =
			(threadRevision.threadTitle !== undefined && threadRevision.threadTitle !== existingThread.threadTitle) ||
			(threadRevision.threadLifecycleStatus !== undefined &&
				threadRevision.threadLifecycleStatus !== existingThread.threadLifecycleStatus) ||
			(threadRevision.primaryTopicId !== undefined &&
				resolveTopicId(threadRevision.primaryTopicId) !== existingThread.primaryTopicId);
		if (revisionWouldChangeThread) return reject("user_manual_edit_conflict");
	}

	// ── 落装 ──
	const nextThreads: ExplorationThread[] = currentCollection.threads.map((thread) => {
		const revision = proposal.threadRevisions.find(
			(candidate) => resolveThreadId(candidate.threadId) === thread.threadId,
		);
		if (revision === undefined || thread.generationSource === "user_manual_edit") {
			return thread;
		}
		const revisedThread: ExplorationThread = {
			...thread,
			threadTitle: revision.threadTitle ?? thread.threadTitle,
			threadLifecycleStatus: revision.threadLifecycleStatus ?? thread.threadLifecycleStatus,
			primaryTopicId:
				revision.primaryTopicId !== undefined ? resolveTopicId(revision.primaryTopicId) : thread.primaryTopicId,
			updatedAt: now,
		};
		const unchanged =
			revisedThread.threadTitle === thread.threadTitle &&
			revisedThread.threadLifecycleStatus === thread.threadLifecycleStatus &&
			revisedThread.primaryTopicId === thread.primaryTopicId;
		return unchanged ? thread : revisedThread;
	});
	for (const newThread of proposal.newThreads) {
		const derivedThreadId = resolveThreadId(newThread.temporaryThreadId);
		nextThreads.push({
			threadId: derivedThreadId,
			threadTitle: newThread.threadTitle,
			parentThreadId: newThread.parentThreadId === null ? null : resolveThreadId(newThread.parentThreadId),
			forkedFromTurnRef: newThread.forkedFromTurnRef,
			primaryTopicId: resolveTopicId(newThread.primaryTopicId),
			threadLifecycleStatus: "active",
			concludedAtTurnRef: null,
			generationSource: "work_branch_maintenance_job",
			createdAt: now,
			updatedAt: now,
		});
	}

	const nextPlacementByTurnKey = new Map(existingPlacementByTurnKey);
	for (const [turnKey, proposedPlacement] of proposalPlacementByTurnKey) {
		const existingPlacement = existingPlacementByTurnKey.get(turnKey);
		const resolvedThreadId = resolveThreadId(proposedPlacement.threadId);
		if (
			existingPlacement !== undefined &&
			placementSemanticFieldsEqual(existingPlacement, {
				threadId: resolvedThreadId,
				placementConfidence: proposedPlacement.placementConfidence,
				deviationRationale: proposedPlacement.deviationRationale,
			})
		) {
			continue; // 语义全等：保留原记录（含 user_manual_edit 的章与 createdAt）。
		}
		nextPlacementByTurnKey.set(turnKey, {
			turnRef: proposedPlacement.turnRef,
			threadId: resolvedThreadId,
			placementConfidence: proposedPlacement.placementConfidence,
			deviationRationale: proposedPlacement.deviationRationale,
			placementSource: "work_branch_maintenance_job",
			createdAt: existingPlacement?.createdAt ?? now,
			updatedAt: now,
		});
	}
	const nextPlacements = [...nextPlacementByTurnKey.values()].sort((left, right) => {
		const leftPosition = turnPositionIndex.get(formatExplorationTurnRefKey(left.turnRef));
		const rightPosition = turnPositionIndex.get(formatExplorationTurnRefKey(right.turnRef));
		if (leftPosition === undefined || rightPosition === undefined) {
			return formatExplorationTurnRefKey(left.turnRef).localeCompare(formatExplorationTurnRefKey(right.turnRef));
		}
		return compareTurnPositions(leftPosition, rightPosition);
	});

	// subjectTaggings 与 placement 一样按 turnRef 归并（后写为准：它是分身对同一 turn 的最新陈述）。
	const nextSubjectTaggingByTurnKey = new Map<string, TurnSubjectTagging>(
		currentCollection.turnSubjectTaggings.map((tagging) => [formatExplorationTurnRefKey(tagging.turnRef), tagging]),
	);
	for (const subjectTagging of proposal.subjectTaggings) {
		const turnKey = formatExplorationTurnRefKey(subjectTagging.turnRef);
		const existingTagging = nextSubjectTaggingByTurnKey.get(turnKey);
		if (existingTagging?.taggingSource === "user_manual_edit") continue;
		// 规范化去重：大小写与前后空白不同的标签视为同一个（CONTEXT.md 的 TurnSubjectTags 定义）。
		const normalizedTags: string[] = [];
		const seenNormalizedTags = new Set<string>();
		for (const rawTag of subjectTagging.turnSubjectTags) {
			const trimmedTag = rawTag.trim();
			if (trimmedTag === "") continue;
			const normalizedTag = trimmedTag.toLowerCase();
			if (seenNormalizedTags.has(normalizedTag)) continue;
			seenNormalizedTags.add(normalizedTag);
			normalizedTags.push(trimmedTag);
		}
		nextSubjectTaggingByTurnKey.set(turnKey, {
			turnRef: subjectTagging.turnRef,
			turnSubjectTags: normalizedTags,
			taggingSource: "work_branch_maintenance_job",
			createdAt: existingTagging?.createdAt ?? now,
			updatedAt: now,
		});
	}

	// 边与事件标注按「同 source + 同 kind + 同 target」去重后追加（重跑作业不该长出重复线）。
	const formatEdgeIdentity = (edge: TurnRelationEdge): string =>
		[
			formatExplorationTurnRefKey(edge.sourceTurnRef),
			edge.edgeKind,
			edge.targetTurnRef === null ? "-" : formatExplorationTurnRefKey(edge.targetTurnRef),
			edge.targetThreadId ?? "-",
		].join("|");
	const nextEdgeByIdentity = new Map<string, TurnRelationEdge>(
		currentCollection.turnRelationEdges.map((edge) => [formatEdgeIdentity(edge), edge]),
	);
	for (const edge of proposal.edges) {
		const materializedEdge: TurnRelationEdge = {
			sourceTurnRef: edge.sourceTurnRef,
			edgeKind: edge.edgeKind,
			targetTurnRef: edge.targetTurnRef,
			targetThreadId: edge.targetThreadId === null ? null : resolveThreadId(edge.targetThreadId),
			generationSource: "work_branch_maintenance_job",
			createdAt: now,
		};
		const identity = formatEdgeIdentity(materializedEdge);
		if (!nextEdgeByIdentity.has(identity)) nextEdgeByIdentity.set(identity, materializedEdge);
	}

	const formatEventMarkIdentity = (eventMark: TurnEventMark): string =>
		`${formatExplorationTurnRefKey(eventMark.turnRef)}|${eventMark.mark}`;
	const nextEventMarkByIdentity = new Map<string, TurnEventMark>(
		currentCollection.turnEventMarks.map((eventMark) => [formatEventMarkIdentity(eventMark), eventMark]),
	);
	for (const eventMark of proposal.eventMarks) {
		const identity = `${formatExplorationTurnRefKey(eventMark.turnRef)}|${eventMark.mark}`;
		const existingEventMark = nextEventMarkByIdentity.get(identity);
		if (existingEventMark?.generationSource === "user_manual_edit") continue;
		nextEventMarkByIdentity.set(identity, {
			turnRef: eventMark.turnRef,
			mark: eventMark.mark,
			note: eventMark.note,
			externalReferenceId: eventMark.externalReferenceId,
			generationSource: "work_branch_maintenance_job",
			createdAt: existingEventMark?.createdAt ?? now,
		});
	}

	// frontier 与签名按本次实际读到的快照刷新；还有没归位的 turn 就标 stale。
	const nextLastPlacedTurnNumberBySession: Record<string, number> = {
		...currentCollection.lastPlacedTurnNumberBySession,
	};
	for (const placement of nextPlacements) {
		const sessionId = placement.turnRef.conversationSessionId;
		const currentFrontier = nextLastPlacedTurnNumberBySession[sessionId] ?? 0;
		if (placement.turnRef.turnNumber > currentFrontier) {
			nextLastPlacedTurnNumberBySession[sessionId] = placement.turnRef.turnNumber;
		}
	}
	const nextSourceTurnSequenceSignatureBySession: Record<string, string> = {
		...currentCollection.sourceTurnSequenceSignatureBySession,
	};
	let anySessionHasUnplacedTurns = false;
	for (const [conversationSessionId, snapshot] of turnSnapshotsBySession) {
		nextSourceTurnSequenceSignatureBySession[conversationSessionId] = snapshot.sourceSignature;
		const frontier = nextLastPlacedTurnNumberBySession[conversationSessionId] ?? 0;
		const highestCompletedTurnNumber = snapshot.turns.reduce(
			(highest, turn) => (turn.turnNumber > highest ? turn.turnNumber : highest),
			0,
		);
		if (highestCompletedTurnNumber > frontier) anySessionHasUnplacedTurns = true;
	}
	const nextStaleReason: ExplorationThreadGraphStaleReason | null = anySessionHasUnplacedTurns
		? "new_turns_not_yet_placed"
		: null;

	return {
		outcome: "accepted",
		collection: {
			schemaVersion: EXPLORATION_THREAD_GRAPH_SCHEMA_VERSION,
			explorationId,
			threads: nextThreads,
			turnThreadPlacements: nextPlacements,
			turnSubjectTaggings: [...nextSubjectTaggingByTurnKey.values()],
			turnRelationEdges: [...nextEdgeByIdentity.values()],
			turnEventMarks: [...nextEventMarkByIdentity.values()],
			sourceTurnSequenceSignatureBySession: nextSourceTurnSequenceSignatureBySession,
			lastPlacedTurnNumberBySession: nextLastPlacedTurnNumberBySession,
			staleReason: nextStaleReason,
			lastMaintenanceJobCompletedAt: now,
			lastMaintenanceJobUsage: input.maintenanceJobUsage ?? currentCollection.lastMaintenanceJobUsage,
			updatedAt: now,
		},
		topicRegistry: {
			schemaVersion: EXPLORATION_THREAD_GRAPH_SCHEMA_VERSION,
			topics: [...currentTopicRegistry.topics, ...appendedTopics],
		},
	};
}
