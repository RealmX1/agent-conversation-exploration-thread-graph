// projection view：跨会话按时间合并、parentIds 派生（隐式续接 + 分叉锚点 + 显式边）、stale 计数。

import { describe, expect, it } from "vitest";
import { buildExplorationThreadGraphProjectionView } from "../../src/core/index.js";
import {
	buildCollection,
	buildCompletedTurnSequenceSnapshot,
	buildPlacement,
	buildThread,
	buildTopic,
	buildTopicRegistry,
	buildTurnRef,
	buildTurnSnapshotsBySession,
} from "../fixtures/exploration-thread-graph-test-doubles.js";

const MAIN_SESSION_ID = "session-main";
const BY_THE_WAY_SESSION_ID = "session-by-the-way";

describe("projection view", () => {
	it("跨会话按时间合并成一条新→旧的行序", () => {
		// 主会话 turn 1..3 在第 1/2/3 分钟；by-the-way 会话的 turn 1 偏移到第 2.5 分钟之后。
		const mainSnapshot = buildCompletedTurnSequenceSnapshot(MAIN_SESSION_ID, 3);
		const byTheWaySnapshot = buildCompletedTurnSequenceSnapshot(BY_THE_WAY_SESSION_ID, 1, {}, 1.5);
		const view = buildExplorationThreadGraphProjectionView(
			buildCollection("exploration-1"),
			buildTurnSnapshotsBySession([mainSnapshot, byTheWaySnapshot]),
			buildTopicRegistry(),
		);
		expect(view.turnRows.map((row) => row.turnRowId)).toEqual([
			`${MAIN_SESSION_ID}#3`,
			`${BY_THE_WAY_SESSION_ID}#1`,
			`${MAIN_SESSION_ID}#2`,
			`${MAIN_SESSION_ID}#1`,
		]);
	});

	it("未归位的 turn 仍出现在图上，只是没有 lane 身份，并计入 unplaced", () => {
		const snapshot = buildCompletedTurnSequenceSnapshot(MAIN_SESSION_ID, 3);
		const view = buildExplorationThreadGraphProjectionView(
			buildCollection("exploration-1", {
				threads: [buildThread("thread-1")],
				turnThreadPlacements: [buildPlacement(MAIN_SESSION_ID, 1, "thread-1")],
			}),
			buildTurnSnapshotsBySession([snapshot]),
			buildTopicRegistry([buildTopic("topic-1", "起点")]),
		);
		expect(view.turnRows).toHaveLength(3);
		expect(view.turnRows.filter((row) => row.threadId === null)).toHaveLength(2);
		expect(view.unplacedTurnCountBySession[MAIN_SESSION_ID]).toBe(2);
		expect(view.anyTurnSourceIsTranscriptReconstructed).toBe(true);
	});

	it("同 thread 内隐式续接上一 turn；新 thread 的首 turn 接到分叉锚点", () => {
		const snapshot = buildCompletedTurnSequenceSnapshot(MAIN_SESSION_ID, 4);
		const view = buildExplorationThreadGraphProjectionView(
			buildCollection("exploration-1", {
				threads: [
					buildThread("thread-1"),
					buildThread("thread-2", {
						parentThreadId: "thread-1",
						forkedFromTurnRef: buildTurnRef(MAIN_SESSION_ID, 2),
					}),
				],
				turnThreadPlacements: [
					buildPlacement(MAIN_SESSION_ID, 1, "thread-1"),
					buildPlacement(MAIN_SESSION_ID, 2, "thread-1"),
					buildPlacement(MAIN_SESSION_ID, 3, "thread-2"),
					buildPlacement(MAIN_SESSION_ID, 4, "thread-2"),
				],
			}),
			buildTurnSnapshotsBySession([snapshot]),
			buildTopicRegistry([buildTopic("topic-1", "起点")]),
		);
		const parentsByRowId = new Map(view.turnRows.map((row) => [row.turnRowId, row.parentTurnRowIds]));
		expect(parentsByRowId.get(`${MAIN_SESSION_ID}#1`)).toEqual([]);
		expect(parentsByRowId.get(`${MAIN_SESSION_ID}#2`)).toEqual([`${MAIN_SESSION_ID}#1`]);
		// thread-2 的第一个 turn 没有同线前驱，接到分叉锚点 turn 2。
		expect(parentsByRowId.get(`${MAIN_SESSION_ID}#3`)).toEqual([`${MAIN_SESSION_ID}#2`]);
		expect(parentsByRowId.get(`${MAIN_SESSION_ID}#4`)).toEqual([`${MAIN_SESSION_ID}#3`]);
		expect(view.laneCount).toBeGreaterThanOrEqual(1);
	});

	it("分叉锚点指向未来时被丢弃，parent 只向过去", () => {
		// thread-2 的首个 turn 是 #1，但它的分叉锚点被写成了更晚的 #3：
		// 派生层必须像显式边那样丢掉这个指向未来的 parent，而不是照单全收。
		const snapshot = buildCompletedTurnSequenceSnapshot(MAIN_SESSION_ID, 3);
		const view = buildExplorationThreadGraphProjectionView(
			buildCollection("exploration-1", {
				threads: [
					buildThread("thread-1"),
					buildThread("thread-2", {
						parentThreadId: "thread-1",
						forkedFromTurnRef: buildTurnRef(MAIN_SESSION_ID, 3),
					}),
				],
				turnThreadPlacements: [
					buildPlacement(MAIN_SESSION_ID, 1, "thread-2"),
					buildPlacement(MAIN_SESSION_ID, 2, "thread-1"),
					buildPlacement(MAIN_SESSION_ID, 3, "thread-1"),
				],
			}),
			buildTurnSnapshotsBySession([snapshot]),
			buildTopicRegistry([buildTopic("topic-1", "起点")]),
		);
		const parentsByRowId = new Map(view.turnRows.map((row) => [row.turnRowId, row.parentTurnRowIds]));
		expect(parentsByRowId.get(`${MAIN_SESSION_ID}#1`)).toEqual([]);
		// 全图不得出现任何指向更晚行的 parent。
		const chronologicalIndexByRowId = new Map(
			[...view.turnRows].reverse().map((row, index) => [row.turnRowId, index]),
		);
		for (const row of view.turnRows) {
			const ownIndex = chronologicalIndexByRowId.get(row.turnRowId) ?? -1;
			for (const parentTurnRowId of row.parentTurnRowIds) {
				expect(chronologicalIndexByRowId.get(parentTurnRowId) ?? -1).toBeLessThan(ownIndex);
			}
		}
	});

	it("concludes 边落到目标 thread 的最后一个 turn，形成合流线", () => {
		const snapshot = buildCompletedTurnSequenceSnapshot(MAIN_SESSION_ID, 4);
		const view = buildExplorationThreadGraphProjectionView(
			buildCollection("exploration-1", {
				threads: [buildThread("thread-1"), buildThread("thread-2")],
				turnThreadPlacements: [
					buildPlacement(MAIN_SESSION_ID, 1, "thread-1"),
					buildPlacement(MAIN_SESSION_ID, 2, "thread-2"),
					buildPlacement(MAIN_SESSION_ID, 3, "thread-2"),
					buildPlacement(MAIN_SESSION_ID, 4, "thread-1"),
				],
				turnRelationEdges: [
					{
						sourceTurnRef: buildTurnRef(MAIN_SESSION_ID, 4),
						edgeKind: "concludes",
						targetTurnRef: null,
						targetThreadId: "thread-2",
						generationSource: "work_branch_maintenance_job",
						createdAt: 0,
					},
				],
			}),
			buildTurnSnapshotsBySession([snapshot]),
			buildTopicRegistry([buildTopic("topic-1", "起点")]),
		);
		const turnFourParents = view.turnRows.find((row) => row.turnRowId === `${MAIN_SESSION_ID}#4`)?.parentTurnRowIds;
		// 隐式续接 thread-1 的 turn 1，外加收口 thread-2 的最后一个 turn 3。
		expect(turnFourParents).toEqual([`${MAIN_SESSION_ID}#1`, `${MAIN_SESSION_ID}#3`]);
		expect(view.laneCount).toBe(2);
	});

	it("thread 带出解析后的 topic 与 turn 计数", () => {
		const snapshot = buildCompletedTurnSequenceSnapshot(MAIN_SESSION_ID, 2);
		const view = buildExplorationThreadGraphProjectionView(
			buildCollection("exploration-1", {
				threads: [buildThread("thread-1", { primaryTopicId: "topic-9" })],
				turnThreadPlacements: [
					buildPlacement(MAIN_SESSION_ID, 1, "thread-1"),
					buildPlacement(MAIN_SESSION_ID, 2, "thread-1"),
				],
			}),
			buildTurnSnapshotsBySession([snapshot]),
			buildTopicRegistry([buildTopic("topic-9", "命中率调查")]),
		);
		expect(view.threads[0]?.primaryTopic?.topicTitle).toBe("命中率调查");
		expect(view.threads[0]?.turnCount).toBe(2);
	});
});
