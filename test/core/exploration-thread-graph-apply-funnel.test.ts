// apply 漏斗每道闸各来一发（handoff A.11 的验证清单）。
// 漏斗是本包唯一写点，闸漏了就等于让分身的错判直接落盘，所以这里逐闸钉死。

import { describe, expect, it } from "vitest";
import {
	type ApplyExplorationThreadGraphMaintenanceProposalInput,
	applyExplorationThreadGraphMaintenanceProposal,
} from "../../src/core/index.js";
import {
	buildCollection,
	buildCompletedTurnSequenceSnapshot,
	buildPlacement,
	buildProposal,
	buildSignatureBySession,
	buildThread,
	buildTopic,
	buildTopicRegistry,
	buildTurnRef,
	buildTurnSnapshotsBySession,
	TEST_NOW_MILLISECONDS,
} from "../fixtures/exploration-thread-graph-test-doubles.js";

const SESSION_ID = "session-main";

function buildFunnelInput(
	overrides: Partial<ApplyExplorationThreadGraphMaintenanceProposalInput> = {},
): ApplyExplorationThreadGraphMaintenanceProposalInput {
	const snapshot = buildCompletedTurnSequenceSnapshot(SESSION_ID, 6);
	return {
		explorationId: "exploration-1",
		proposal: buildProposal(),
		turnSnapshotsBySession: buildTurnSnapshotsBySession([snapshot]),
		proposalSourceTurnSequenceSignatureBySession: buildSignatureBySession([snapshot]),
		currentCollection: buildCollection("exploration-1"),
		currentTopicRegistry: buildTopicRegistry(),
		// 默认空：闸 6 之前就被拦下的用例用不到它，走到闸 6 之后的用例各自显式给出本次待判范围。
		turnsUnderJudgement: [],
		now: TEST_NOW_MILLISECONDS,
		...overrides,
	};
}

/** 大多数用例都要「新建一条 thread + 一个 topic」，抽出来免得每处重抄。 */
function buildNewThreadAndTopicProposalParts(): { newThreads: unknown[]; topicProposals: unknown[] } {
	return {
		topicProposals: [
			{
				temporaryTopicId: "tmp-topic",
				topicTitle: "缓存命中调查",
				topicAliases: [],
				topicSummaryMarkdown: null,
			},
		],
		newThreads: [
			{
				temporaryThreadId: "tmp-thread",
				threadTitle: "缓存命中调查",
				parentThreadId: null,
				forkedFromTurnRef: null,
				primaryTopicId: "tmp-topic",
			},
		],
	};
}

describe("apply 漏斗", () => {
	it("闸 1：形状不合法整份拒绝", () => {
		const result = applyExplorationThreadGraphMaintenanceProposal(
			buildFunnelInput({ proposal: { placements: "不是数组" } }),
		);
		expect(result).toMatchObject({ outcome: "rejected", rejectionReason: "proposal_shape_invalid" });
	});

	it("闸 3：turnRef 指向不存在的 turn 时拒绝", () => {
		const result = applyExplorationThreadGraphMaintenanceProposal(
			buildFunnelInput({
				proposal: buildProposal({
					...buildNewThreadAndTopicProposalParts(),
					placements: [
						{
							turnRef: buildTurnRef(SESSION_ID, 99),
							threadId: "tmp-thread",
							placementConfidence: "high",
							deviationRationale: null,
						},
					],
				}),
			}),
		);
		expect(result).toMatchObject({ outcome: "rejected", rejectionReason: "turn_ref_unresolvable" });
	});

	it("闸 3：指向进行中的末 turn 时拒绝", () => {
		const snapshot = buildCompletedTurnSequenceSnapshot(SESSION_ID, 3, { inProgressTurnNumber: 4 });
		const result = applyExplorationThreadGraphMaintenanceProposal(
			buildFunnelInput({
				turnSnapshotsBySession: buildTurnSnapshotsBySession([snapshot]),
				proposalSourceTurnSequenceSignatureBySession: buildSignatureBySession([snapshot]),
				proposal: buildProposal({
					...buildNewThreadAndTopicProposalParts(),
					placements: [
						{
							turnRef: buildTurnRef(SESSION_ID, 4),
							threadId: "tmp-thread",
							placementConfidence: "high",
							deviationRationale: null,
						},
					],
				}),
			}),
		);
		expect(result).toMatchObject({ outcome: "rejected", rejectionReason: "turn_ref_is_in_progress_turn" });
	});

	it("闸 4：引用不存在的 threadId 时拒绝", () => {
		const result = applyExplorationThreadGraphMaintenanceProposal(
			buildFunnelInput({
				proposal: buildProposal({
					placements: [
						{
							turnRef: buildTurnRef(SESSION_ID, 1),
							threadId: "thread-404",
							placementConfidence: "high",
							deviationRationale: null,
						},
					],
				}),
			}),
		);
		expect(result).toMatchObject({ outcome: "rejected", rejectionReason: "thread_id_unresolvable" });
	});

	it("闸 5：边指向未来时拒绝", () => {
		const result = applyExplorationThreadGraphMaintenanceProposal(
			buildFunnelInput({
				proposal: buildProposal({
					...buildNewThreadAndTopicProposalParts(),
					placements: [
						{
							turnRef: buildTurnRef(SESSION_ID, 1),
							threadId: "tmp-thread",
							placementConfidence: "high",
							deviationRationale: null,
						},
					],
					edges: [
						{
							sourceTurnRef: buildTurnRef(SESSION_ID, 2),
							edgeKind: "draws_from",
							targetTurnRef: buildTurnRef(SESSION_ID, 5),
							targetThreadId: null,
						},
					],
				}),
			}),
		);
		expect(result).toMatchObject({ outcome: "rejected", rejectionReason: "edge_target_not_in_past" });
	});

	it("闸 5：非 concludes 边却指向 thread 时拒绝", () => {
		const result = applyExplorationThreadGraphMaintenanceProposal(
			buildFunnelInput({
				currentCollection: buildCollection("exploration-1", { threads: [buildThread("thread-1")] }),
				currentTopicRegistry: buildTopicRegistry([buildTopic("topic-1", "起点")]),
				proposal: buildProposal({
					edges: [
						{
							sourceTurnRef: buildTurnRef(SESSION_ID, 2),
							edgeKind: "returns_to",
							targetTurnRef: null,
							targetThreadId: "thread-1",
						},
					],
				}),
			}),
		);
		expect(result).toMatchObject({ outcome: "rejected", rejectionReason: "edge_target_shape_invalid" });
	});

	it("闸 6：同一个 turn 出现两行 placement 时拒绝", () => {
		const placementForTurnOne = {
			turnRef: buildTurnRef(SESSION_ID, 1),
			threadId: "tmp-thread",
			placementConfidence: "high",
			deviationRationale: null,
		};
		const result = applyExplorationThreadGraphMaintenanceProposal(
			buildFunnelInput({
				proposal: buildProposal({
					...buildNewThreadAndTopicProposalParts(),
					placements: [placementForTurnOne, { ...placementForTurnOne, placementConfidence: "low" }],
				}),
			}),
		);
		expect(result).toMatchObject({ outcome: "rejected", rejectionReason: "duplicate_placement_for_turn" });
	});

	it("闸 6：待判 turn 没有 placement 时整份拒绝", () => {
		// 分身整体或局部漏判必须当场拒绝：frontier 只看最大 turn 号，中间漏掉的 turn 连 stale 都标不出来。
		const result = applyExplorationThreadGraphMaintenanceProposal(
			buildFunnelInput({
				turnsUnderJudgement: [1, 2].map((turnNumber) => buildTurnRef(SESSION_ID, turnNumber)),
				proposal: buildProposal({
					...buildNewThreadAndTopicProposalParts(),
					placements: [
						{
							turnRef: buildTurnRef(SESSION_ID, 2),
							threadId: "tmp-thread",
							placementConfidence: "high",
							deviationRationale: null,
						},
					],
				}),
			}),
		);
		expect(result).toMatchObject({
			outcome: "rejected",
			rejectionReason: "placement_missing_for_turn_under_judgement",
		});
	});

	it("闸 6：placement 落在待判范围之外时整份拒绝", () => {
		const result = applyExplorationThreadGraphMaintenanceProposal(
			buildFunnelInput({
				turnsUnderJudgement: [buildTurnRef(SESSION_ID, 1)],
				proposal: buildProposal({
					...buildNewThreadAndTopicProposalParts(),
					placements: [1, 4].map((turnNumber) => ({
						turnRef: buildTurnRef(SESSION_ID, turnNumber),
						threadId: "tmp-thread",
						placementConfidence: "high",
						deviationRationale: null,
					})),
				}),
			}),
		);
		expect(result).toMatchObject({
			outcome: "rejected",
			rejectionReason: "placement_outside_turns_under_judgement",
		});
	});

	it("闸 8：修订窗口之外的既有 placement 不得改动", () => {
		const currentCollection = buildCollection("exploration-1", {
			threads: [buildThread("thread-1"), buildThread("thread-2")],
			// frontier = 6，窗口 k=3 ⇒ turn 1/2/3 冻结，turn 4/5/6 可改。
			turnThreadPlacements: [1, 2, 3, 4, 5, 6].map((turnNumber) =>
				buildPlacement(SESSION_ID, turnNumber, "thread-1"),
			),
		});
		const currentTopicRegistry = buildTopicRegistry([buildTopic("topic-1", "起点")]);
		const buildMoveProposal = (turnNumber: number) =>
			buildProposal({
				placements: [
					{
						turnRef: buildTurnRef(SESSION_ID, turnNumber),
						threadId: "thread-2",
						placementConfidence: "high",
						deviationRationale: "换线",
					},
				],
			});

		expect(
			applyExplorationThreadGraphMaintenanceProposal(
				buildFunnelInput({
					currentCollection,
					currentTopicRegistry,
					proposal: buildMoveProposal(2),
					turnsUnderJudgement: [buildTurnRef(SESSION_ID, 2)],
				}),
			),
		).toMatchObject({ outcome: "rejected", rejectionReason: "frozen_placement_outside_revision_window" });

		expect(
			applyExplorationThreadGraphMaintenanceProposal(
				buildFunnelInput({
					currentCollection,
					currentTopicRegistry,
					proposal: buildMoveProposal(5),
					turnsUnderJudgement: [buildTurnRef(SESSION_ID, 5)],
				}),
			),
		).toMatchObject({ outcome: "accepted" });
	});

	it("闸 7：user_manual_edit 的 placement 不得被作业改动，但幂等重放放行", () => {
		const currentCollection = buildCollection("exploration-1", {
			threads: [buildThread("thread-1"), buildThread("thread-2")],
			turnThreadPlacements: [buildPlacement(SESSION_ID, 6, "thread-1", { placementSource: "user_manual_edit" })],
		});
		const currentTopicRegistry = buildTopicRegistry([buildTopic("topic-1", "起点")]);

		expect(
			applyExplorationThreadGraphMaintenanceProposal(
				buildFunnelInput({
					currentCollection,
					currentTopicRegistry,
					turnsUnderJudgement: [buildTurnRef(SESSION_ID, 6)],
					proposal: buildProposal({
						placements: [
							{
								turnRef: buildTurnRef(SESSION_ID, 6),
								threadId: "thread-2",
								placementConfidence: "high",
								deviationRationale: null,
							},
						],
					}),
				}),
			),
		).toMatchObject({ outcome: "rejected", rejectionReason: "user_manual_edit_conflict" });

		const idempotentResult = applyExplorationThreadGraphMaintenanceProposal(
			buildFunnelInput({
				currentCollection,
				currentTopicRegistry,
				turnsUnderJudgement: [buildTurnRef(SESSION_ID, 6)],
				proposal: buildProposal({
					placements: [
						{
							turnRef: buildTurnRef(SESSION_ID, 6),
							threadId: "thread-1",
							placementConfidence: "high",
							deviationRationale: null,
						},
					],
				}),
			}),
		);
		expect(idempotentResult.outcome).toBe("accepted");
		if (idempotentResult.outcome !== "accepted") throw new Error("上一行已断言 accepted");
		// 章必须原样保留：一旦被改成作业来源，闸 7 的保护就永久失效了。
		expect(idempotentResult.collection.turnThreadPlacements[0]?.placementSource).toBe("user_manual_edit");
	});

	it("闸 7：user_manual_edit thread 的 primaryTopicId 按 topic 维度解析", () => {
		// 同一个字符串同时当临时 topic id 与临时 thread id 是合法的；解析错维度会把
		// 「复用回同一个 topic、其实没改动」的修订误判成冲突，也可能漏判真正的改动。
		const currentCollection = buildCollection("exploration-1", {
			threads: [buildThread("thread-1", { generationSource: "user_manual_edit", primaryTopicId: "topic-7" })],
		});
		const currentTopicRegistry = buildTopicRegistry([buildTopic("topic-7", "Prompt Cache 命中")]);
		const buildRevisionProposal = (topicTitle: string) =>
			buildProposal({
				topicProposals: [{ temporaryTopicId: "tmp-1", topicTitle, topicAliases: [], topicSummaryMarkdown: null }],
				newThreads: [
					{
						temporaryThreadId: "tmp-1",
						threadTitle: "另一条线",
						parentThreadId: null,
						forkedFromTurnRef: null,
						primaryTopicId: "tmp-1",
					},
				],
				threadRevisions: [{ threadId: "thread-1", primaryTopicId: "tmp-1" }],
			});

		// 标题规范化后撞上 topic-7 ⇒ 修订解析回同一个 topic，等于没改动，必须放行。
		expect(
			applyExplorationThreadGraphMaintenanceProposal(
				buildFunnelInput({
					currentCollection,
					currentTopicRegistry,
					proposal: buildRevisionProposal("prompt cache 命中"),
				}),
			),
		).toMatchObject({ outcome: "accepted" });

		// 换成另一个 topic ⇒ 真改动，闸 7 仍然要整份拒绝。
		expect(
			applyExplorationThreadGraphMaintenanceProposal(
				buildFunnelInput({
					currentCollection,
					currentTopicRegistry,
					proposal: buildRevisionProposal("作业编排"),
				}),
			),
		).toMatchObject({ outcome: "rejected", rejectionReason: "user_manual_edit_conflict" });
	});

	it("闸 2：签名对不上时拒绝，并回一份只改 staleReason 的集合", () => {
		const snapshot = buildCompletedTurnSequenceSnapshot(SESSION_ID, 6);
		const result = applyExplorationThreadGraphMaintenanceProposal(
			buildFunnelInput({
				turnSnapshotsBySession: buildTurnSnapshotsBySession([snapshot]),
				proposalSourceTurnSequenceSignatureBySession: { [SESSION_ID]: "作业读到的是另一个签名" },
			}),
		);
		expect(result).toMatchObject({ outcome: "rejected", rejectionReason: "turn_source_signature_mismatch" });
		if (result.outcome !== "rejected") throw new Error("上一行已断言 rejected");
		expect(result.collectionStaleMarkUpdate?.staleReason).toBe("turn_source_signature_changed");
		expect(result.collectionStaleMarkUpdate?.turnThreadPlacements).toEqual([]);
	});

	it("闸 9：派生正式 threadId / topicId，并按规范化标题复用既有 topic", () => {
		const result = applyExplorationThreadGraphMaintenanceProposal(
			buildFunnelInput({
				currentCollection: buildCollection("exploration-1", { threads: [buildThread("thread-1")] }),
				currentTopicRegistry: buildTopicRegistry([buildTopic("topic-7", "Prompt Cache 命中")]),
				turnsUnderJudgement: [buildTurnRef(SESSION_ID, 3)],
				proposal: buildProposal({
					topicProposals: [
						// 与既有 topic 仅大小写/标点/空白之差 ⇒ 必须复用 topic-7 而不是长出新条目。
						{
							temporaryTopicId: "tmp-topic-reuse",
							topicTitle: "prompt cache 命中",
							topicAliases: [],
							topicSummaryMarkdown: null,
						},
						{
							temporaryTopicId: "tmp-topic-new",
							topicTitle: "作业编排",
							topicAliases: ["job orchestration"],
							topicSummaryMarkdown: "维护作业怎么排",
						},
					],
					newThreads: [
						{
							temporaryThreadId: "tmp-a",
							threadTitle: "缓存线",
							parentThreadId: null,
							forkedFromTurnRef: null,
							primaryTopicId: "tmp-topic-reuse",
						},
						{
							temporaryThreadId: "tmp-b",
							threadTitle: "编排线",
							parentThreadId: "tmp-a",
							forkedFromTurnRef: buildTurnRef(SESSION_ID, 2),
							primaryTopicId: "tmp-topic-new",
						},
					],
					placements: [
						{
							turnRef: buildTurnRef(SESSION_ID, 3),
							threadId: "tmp-b",
							placementConfidence: "high",
							deviationRationale: "转向作业编排",
						},
					],
				}),
			}),
		);
		expect(result.outcome).toBe("accepted");
		if (result.outcome !== "accepted") throw new Error("上一行已断言 accepted");
		const [, threadA, threadB] = result.collection.threads;
		expect(threadA?.threadId).toBe("thread-2");
		expect(threadB?.threadId).toBe("thread-3");
		expect(threadB?.parentThreadId).toBe("thread-2");
		expect(threadA?.primaryTopicId).toBe("topic-7");
		expect(threadB?.primaryTopicId).toBe("topic-8");
		expect(result.topicRegistry.topics.map((topic) => topic.topicId)).toEqual(["topic-7", "topic-8"]);
		expect(result.collection.turnThreadPlacements[0]?.threadId).toBe("thread-3");
	});

	it("闸 4：临时 id 与既有 id 撞名时拒绝", () => {
		const result = applyExplorationThreadGraphMaintenanceProposal(
			buildFunnelInput({
				currentCollection: buildCollection("exploration-1", { threads: [buildThread("thread-1")] }),
				currentTopicRegistry: buildTopicRegistry([buildTopic("topic-1", "起点")]),
				proposal: buildProposal({
					topicProposals: [
						{ temporaryTopicId: "tmp", topicTitle: "新题", topicAliases: [], topicSummaryMarkdown: null },
					],
					newThreads: [
						{
							temporaryThreadId: "thread-1",
							threadTitle: "撞名",
							parentThreadId: null,
							forkedFromTurnRef: null,
							primaryTopicId: "tmp",
						},
					],
				}),
			}),
		);
		expect(result).toMatchObject({
			outcome: "rejected",
			rejectionReason: "temporary_id_collides_with_existing_id",
		});
	});

	it("闸 4：提案内两个 newThread 共用同一个 temporaryThreadId 时拒绝", () => {
		// 不拦就会被闸 9 的「后写覆盖」映射赋成同一个正式 threadId，重复 id 直接进事实层。
		const result = applyExplorationThreadGraphMaintenanceProposal(
			buildFunnelInput({
				currentCollection: buildCollection("exploration-1", { threads: [buildThread("thread-1")] }),
				currentTopicRegistry: buildTopicRegistry([buildTopic("topic-1", "起点")]),
				proposal: buildProposal({
					topicProposals: [
						{ temporaryTopicId: "tmp-topic", topicTitle: "新题", topicAliases: [], topicSummaryMarkdown: null },
					],
					newThreads: ["线甲", "线乙"].map((threadTitle) => ({
						temporaryThreadId: "tmp-same",
						threadTitle,
						parentThreadId: null,
						forkedFromTurnRef: null,
						primaryTopicId: "tmp-topic",
					})),
					placements: [
						{
							turnRef: buildTurnRef(SESSION_ID, 1),
							threadId: "tmp-same",
							placementConfidence: "high",
							deviationRationale: null,
						},
					],
				}),
			}),
		);
		expect(result).toMatchObject({
			outcome: "rejected",
			rejectionReason: "duplicate_temporary_id_within_proposal",
		});
	});

	it("闸 4：提案内两个 topicProposal 共用同一个 temporaryTopicId 时拒绝", () => {
		const result = applyExplorationThreadGraphMaintenanceProposal(
			buildFunnelInput({
				proposal: buildProposal({
					topicProposals: ["缓存命中调查", "作业编排"].map((topicTitle) => ({
						temporaryTopicId: "tmp-topic-same",
						topicTitle,
						topicAliases: [],
						topicSummaryMarkdown: null,
					})),
				}),
			}),
		);
		expect(result).toMatchObject({
			outcome: "rejected",
			rejectionReason: "duplicate_temporary_id_within_proposal",
		});
	});

	it("落装后刷新 frontier 与签名，并在仍有未归位 turn 时标 stale", () => {
		const result = applyExplorationThreadGraphMaintenanceProposal(
			buildFunnelInput({
				turnsUnderJudgement: [1, 2].map((turnNumber) => buildTurnRef(SESSION_ID, turnNumber)),
				proposal: buildProposal({
					...buildNewThreadAndTopicProposalParts(),
					placements: [1, 2].map((turnNumber) => ({
						turnRef: buildTurnRef(SESSION_ID, turnNumber),
						threadId: "tmp-thread",
						placementConfidence: "high",
						deviationRationale: null,
					})),
				}),
			}),
		);
		expect(result.outcome).toBe("accepted");
		if (result.outcome !== "accepted") throw new Error("上一行已断言 accepted");
		expect(result.collection.lastPlacedTurnNumberBySession[SESSION_ID]).toBe(2);
		expect(result.collection.sourceTurnSequenceSignatureBySession[SESSION_ID]).toBe(`signature-${SESSION_ID}-6`);
		// 快照里有 6 个 turn、只归位了 2 个 ⇒ 还差 4 个。
		expect(result.collection.staleReason).toBe("new_turns_not_yet_placed");
	});
});
