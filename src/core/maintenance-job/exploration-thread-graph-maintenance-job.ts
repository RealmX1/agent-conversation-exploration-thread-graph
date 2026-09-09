// 维护作业的编排（handoff A.5）：模式选择 → 组 prompt → fork 分身 → 校验 → 经漏斗落盘。
//
// 本模块**不自己写盘**：它把漏斗的产物交给 store 的 mutate 原语，且「读现状 → 漏斗 → 落装」
// 全在同一把 storeRoot 队列锁内完成——否则两次并发作业会互相覆盖。

import type {
	CompletedTurnSequenceSnapshot,
	CompletedTurnSequenceSource,
	ConversationSessionRef,
} from "../completed-turn-sequence-source.js";
import {
	applyExplorationThreadGraphMaintenanceProposal,
	DEFAULT_PLACEMENT_REVISION_WINDOW_TURN_COUNT,
	type ExplorationThreadGraphApplyRejectionReason,
} from "../exploration-thread-graph-apply-funnel.js";
import type { ExplorationThreadGraphMaintenanceJobUsage } from "../exploration-thread-graph-schema.js";
import { formatExplorationTurnRefKey } from "../exploration-thread-graph-schema.js";
import {
	mutateExplorationThreadGraph,
	readExplorationThreadGraphCollection,
	readExplorationTopicRegistry,
} from "../exploration-thread-graph-store.js";
import type { ForkedWorkBranchExecutor } from "../forked-work-branch-executor.js";
import { buildExplorationThreadGraphMaintenanceProposalJsonSchema } from "./maintenance-job-output-json-schema.js";
import {
	assembleExplorationThreadGraphMaintenanceJobPrompt,
	type ExplorationThreadGraphMaintenanceJobMode,
} from "./maintenance-job-prompt-assembly.js";

/** 单次作业最多判多少个 turn；backfill 超出时分批，由调用方按返回的 remaining 再跑。 */
export const DEFAULT_MAINTENANCE_JOB_BATCH_SIZE = 40;
export const DEFAULT_MAINTENANCE_JOB_TIMEOUT_MILLISECONDS = 300_000;

export interface RunExplorationThreadGraphMaintenanceJobInput {
	explorationId: string;
	/** 主会话必须在 `sessions[0]`——fork 的就是它。 */
	sessions: readonly ConversationSessionRef[];
	turnSource: CompletedTurnSequenceSource;
	executor: ForkedWorkBranchExecutor;
	storeRoot: string;
	mode: ExplorationThreadGraphMaintenanceJobMode;
	revisionWindowTurnCount?: number;
	batchSize?: number;
	timeoutMs?: number;
	signal?: AbortSignal;
	now?: number;
}

export type RunExplorationThreadGraphMaintenanceJobResult =
	| {
			outcome: "accepted";
			placedTurnCount: number;
			remainingTurnCount: number;
			usage: ExplorationThreadGraphMaintenanceJobUsage | null;
	  }
	| {
			outcome: "rejected";
			rejectionReason: ExplorationThreadGraphApplyRejectionReason;
			usage: ExplorationThreadGraphMaintenanceJobUsage | null;
	  }
	| { outcome: "skipped"; skipReason: "no_turns_under_judgement" | "no_sessions" }
	| { outcome: "fork_failed"; stopReason: string; outputTextExcerpt: string };

function toMaintenanceJobUsage(
	usage: { inputTokens: number; cacheReadInputTokens: number; outputTokens: number; costUsd?: number } | undefined,
): ExplorationThreadGraphMaintenanceJobUsage | null {
	if (usage === undefined) return null;
	return {
		inputTokens: usage.inputTokens,
		cacheReadInputTokens: usage.cacheReadInputTokens,
		outputTokens: usage.outputTokens,
		costUsd: usage.costUsd ?? null,
	};
}

/**
 * 算出本次要判哪些 turn。
 * - `initial_backfill`：所有尚未归位的 turn；
 * - `incremental`：frontier 之后的新 turn + 修订窗口内的已归位 turn。
 */
function selectTurnsUnderJudgement(
	mode: ExplorationThreadGraphMaintenanceJobMode,
	turnSnapshotsBySession: ReadonlyMap<string, CompletedTurnSequenceSnapshot>,
	placedTurnKeys: ReadonlySet<string>,
	frontierTurnNumberBySession: ReadonlyMap<string, number>,
	revisionWindowTurnCount: number,
): { conversationSessionId: string; turnNumber: number }[] {
	const selected: { conversationSessionId: string; turnNumber: number }[] = [];
	for (const [conversationSessionId, snapshot] of turnSnapshotsBySession) {
		const frontier = frontierTurnNumberBySession.get(conversationSessionId) ?? 0;
		for (const turn of snapshot.turns) {
			const turnKey = formatExplorationTurnRefKey({ conversationSessionId, turnNumber: turn.turnNumber });
			const alreadyPlaced = placedTurnKeys.has(turnKey);
			if (mode === "initial_backfill") {
				if (!alreadyPlaced) selected.push({ conversationSessionId, turnNumber: turn.turnNumber });
				continue;
			}
			// incremental：新 turn 一定判；已归位的只在修订窗口内重判。
			if (!alreadyPlaced || turn.turnNumber > frontier - revisionWindowTurnCount) {
				selected.push({ conversationSessionId, turnNumber: turn.turnNumber });
			}
		}
	}
	return selected;
}

export async function runExplorationThreadGraphMaintenanceJob(
	input: RunExplorationThreadGraphMaintenanceJobInput,
): Promise<RunExplorationThreadGraphMaintenanceJobResult> {
	const primarySession = input.sessions[0];
	if (primarySession === undefined) {
		return { outcome: "skipped", skipReason: "no_sessions" };
	}
	const now = input.now ?? Date.now();
	const revisionWindowTurnCount = input.revisionWindowTurnCount ?? DEFAULT_PLACEMENT_REVISION_WINDOW_TURN_COUNT;
	const batchSize = input.batchSize ?? DEFAULT_MAINTENANCE_JOB_BATCH_SIZE;

	// 1. 读各会话的 turn 快照。
	const turnSnapshotsBySession = new Map<string, CompletedTurnSequenceSnapshot>();
	const forkedFromParentSessionTurnNumberBySession: Record<string, number> = {};
	for (const sessionRef of input.sessions) {
		const snapshot = await input.turnSource.readCompletedTurnSequence(sessionRef);
		turnSnapshotsBySession.set(snapshot.conversationSessionId, snapshot);
		if (sessionRef.forkedFromParentSessionTurnNumber !== undefined) {
			forkedFromParentSessionTurnNumberBySession[snapshot.conversationSessionId] =
				sessionRef.forkedFromParentSessionTurnNumber;
		}
	}

	// 2. 读现状并算待判范围。这里读一次只为组 prompt；落盘时会在锁内**重读**并对账。
	const currentCollection = await readExplorationThreadGraphCollection(input.storeRoot, input.explorationId, now);
	const currentTopicRegistry = await readExplorationTopicRegistry(input.storeRoot);

	const placedTurnKeys = new Set(
		currentCollection.turnThreadPlacements.map((placement) => formatExplorationTurnRefKey(placement.turnRef)),
	);
	const frontierTurnNumberBySession = new Map(Object.entries(currentCollection.lastPlacedTurnNumberBySession));
	const allTurnsUnderJudgement = selectTurnsUnderJudgement(
		input.mode,
		turnSnapshotsBySession,
		placedTurnKeys,
		frontierTurnNumberBySession,
		revisionWindowTurnCount,
	);
	if (allTurnsUnderJudgement.length === 0) {
		return { outcome: "skipped", skipReason: "no_turns_under_judgement" };
	}
	const turnsUnderJudgement = allTurnsUnderJudgement.slice(0, batchSize);
	const remainingTurnCount = allTurnsUnderJudgement.length - turnsUnderJudgement.length;

	// 3. 组 prompt、fork 分身。
	const promptText = assembleExplorationThreadGraphMaintenanceJobPrompt({
		mode: input.mode,
		turnSnapshotsBySession,
		primaryConversationSessionId: primarySession.nativeSessionId,
		forkedFromParentSessionTurnNumberBySession,
		currentCollection,
		currentTopicRegistry,
		turnsUnderJudgement,
		revisionWindowTurnCount,
	});
	const forkResult = await input.executor.start({
		parentSession: primarySession,
		promptText,
		outputSchema: buildExplorationThreadGraphMaintenanceProposalJsonSchema(),
		timeoutMs: input.timeoutMs ?? DEFAULT_MAINTENANCE_JOB_TIMEOUT_MILLISECONDS,
		...(input.signal !== undefined ? { signal: input.signal } : {}),
	});
	const usage = toMaintenanceJobUsage(forkResult.usage);
	if (forkResult.stopReason !== "completed" || forkResult.structured === undefined) {
		return {
			outcome: "fork_failed",
			stopReason: forkResult.stopReason,
			outputTextExcerpt: forkResult.outputText.slice(0, 400),
		};
	}

	// 4. 经漏斗落盘。签名对账用的是**作业发起时**读到的签名，作业期间来了新 turn 就会被闸 8 拦下。
	const proposalSourceTurnSequenceSignatureBySession = Object.fromEntries(
		[...turnSnapshotsBySession].map(([sessionId, snapshot]) => [sessionId, snapshot.sourceSignature]),
	);
	let applyRejectionReason: ExplorationThreadGraphApplyRejectionReason | null = null;
	let placedTurnCount = 0;

	await mutateExplorationThreadGraph(
		input.storeRoot,
		input.explorationId,
		(snapshot) => {
			const applyResult = applyExplorationThreadGraphMaintenanceProposal({
				explorationId: input.explorationId,
				proposal: forkResult.structured,
				turnSnapshotsBySession,
				proposalSourceTurnSequenceSignatureBySession,
				currentCollection: snapshot.collection,
				currentTopicRegistry: snapshot.topicRegistry,
				revisionWindowTurnCount,
				maintenanceJobUsage: usage,
				now,
			});
			if (applyResult.outcome === "rejected") {
				applyRejectionReason = applyResult.rejectionReason;
				return applyResult.collectionStaleMarkUpdate === null
					? null
					: { collection: applyResult.collectionStaleMarkUpdate, topicRegistry: snapshot.topicRegistry };
			}
			placedTurnCount = applyResult.collection.turnThreadPlacements.length;
			return { collection: applyResult.collection, topicRegistry: applyResult.topicRegistry };
		},
		now,
	);

	if (applyRejectionReason !== null) {
		return { outcome: "rejected", rejectionReason: applyRejectionReason, usage };
	}
	return { outcome: "accepted", placedTurnCount, remainingTurnCount, usage };
}
