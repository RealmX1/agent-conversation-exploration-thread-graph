// dsh smoke（handoff A.8）：只验证三处边界对得上，不做 UI。
// 用 dsh 会话日志形状的夹具事件跑一遍纯 fold，并把 executor 与 projection 注册接上假 ctx。

import { describe, expect, it } from "vitest";
import type { ConversationSessionRef, ForkedWorkBranchRequest, ObjectRootedJsonSchema } from "../../src/core/index.js";
import {
	apply,
	buildCompletedTurnSequenceSnapshotFromDshFoldState,
	classifyDshUserMessageOrigin,
	DSH_COMPLETED_TURN_FOLD_INITIAL_STATE,
	DSH_EXPLORATION_THREAD_GRAPH_PROJECTION_KEY,
	type DshCompletedTurnFoldState,
	type DshPluginContext,
	type DshSessionEvent,
	DshSubagentForkedWorkBranchExecutor,
	type DshSubagentRegistry,
	foldDshSessionEventIntoCompletedTurns,
} from "../../src/dsh-plugin/index.js";

const DSH_SESSION_ID = "dsh-session-1";

/** 两个完整 turn + 一个仍打开的 turn，覆盖注入消息与工具调用。 */
function buildDshSessionEventLog(): DshSessionEvent[] {
	return [
		{ type: "turn/start", seq: 1, timestamp: "2026-09-01T10:00:00.000Z", data: { turn: 1 } },
		{
			type: "user/message",
			seq: 2,
			timestamp: "2026-09-01T10:00:01.000Z",
			data: { turn: 1, source: "skill", content: "技能内容，属于注入" },
		},
		{
			type: "user/message",
			seq: 3,
			timestamp: "2026-09-01T10:00:02.000Z",
			data: { turn: 1, source: "user", content: [{ type: "text", text: "帮我看看缓存" }] },
		},
		{ type: "tool/call", seq: 4, timestamp: "2026-09-01T10:00:03.000Z", data: { turn: 1, step: 1 } },
		{
			type: "assistant/message",
			seq: 5,
			timestamp: "2026-09-01T10:00:04.000Z",
			data: { turn: 1, step: 1, message: { content: [{ type: "text", text: "过程叙述" }] } },
		},
		{
			type: "assistant/message",
			seq: 6,
			timestamp: "2026-09-01T10:00:05.000Z",
			data: { turn: 1, step: 2, message: { content: [{ type: "text", text: "结论在最后一段" }] } },
		},
		{ type: "turn/end", seq: 7, timestamp: "2026-09-01T10:00:06.000Z", data: { turn: 1, reason: "success" } },
		{ type: "turn/start", seq: 8, timestamp: "2026-09-01T10:01:00.000Z", data: { turn: 2 } },
		{ type: "user/message", seq: 9, timestamp: "2026-09-01T10:01:01.000Z", data: { turn: 2, content: "换个话题" } },
		{ type: "turn/end", seq: 10, timestamp: "2026-09-01T10:01:30.000Z", data: { turn: 2, reason: "success" } },
		{ type: "turn/start", seq: 11, timestamp: "2026-09-01T10:02:00.000Z", data: { turn: 3 } },
		{
			type: "user/message",
			seq: 12,
			timestamp: "2026-09-01T10:02:01.000Z",
			data: { turn: 3, content: "还没答完的一轮" },
		},
	];
}

function foldAll(events: readonly DshSessionEvent[]): DshCompletedTurnFoldState {
	return events.reduce(foldDshSessionEventIntoCompletedTurns, DSH_COMPLETED_TURN_FOLD_INITIAL_STATE);
}

describe("dsh 会话日志 fold", () => {
	it("turn 编号直接来自 turn/start|end，且是 authoritative", () => {
		const snapshot = buildCompletedTurnSequenceSnapshotFromDshFoldState(
			DSH_SESSION_ID,
			foldAll(buildDshSessionEventLog()),
		);
		expect(snapshot.projectionConfidence).toBe("authoritative");
		expect(snapshot.sourceKind).toBe("dsh_session_log");
		expect(snapshot.turns.map((turn) => turn.turnNumber)).toEqual([1, 2]);
		// 打开但未闭合的 turn 3 不进 turns[]，只报编号。
		expect(snapshot.inProgressTurnNumber).toBe(3);
		expect(snapshot.sourceSignature).toBe("dsh-seq:12");
	});

	it("注入消息不抢摘录，助手摘录取最后一段，工具调用计数", () => {
		const snapshot = buildCompletedTurnSequenceSnapshotFromDshFoldState(
			DSH_SESSION_ID,
			foldAll(buildDshSessionEventLog()),
		);
		const [firstTurn] = snapshot.turns;
		expect(firstTurn?.userPromptExcerpt).toBe("帮我看看缓存");
		expect(firstTurn?.userMessageOrigin).toBe("human_typed");
		expect(firstTurn?.assistantResponseExcerpt).toBe("结论在最后一段");
		expect(firstTurn?.toolCallCount).toBe(1);
		expect(firstTurn?.startedAt).toBe("2026-09-01T10:00:00.000Z");
		expect(firstTurn?.endedAt).toBe("2026-09-01T10:00:06.000Z");
	});

	it("fold 是纯函数：逐条折叠与整批折叠结果一致", () => {
		const events = buildDshSessionEventLog();
		const incremental = events
			.slice(0, 7)
			.reduce(foldDshSessionEventIntoCompletedTurns, DSH_COMPLETED_TURN_FOLD_INITIAL_STATE);
		const continued = events.slice(7).reduce(foldDshSessionEventIntoCompletedTurns, incremental);
		expect(continued).toEqual(foldAll(events));
		// 初始状态没有被就地改写。
		expect(DSH_COMPLETED_TURN_FOLD_INITIAL_STATE.turnsByNumber).toEqual({});
	});

	it("source 认不出来时按人类输入处理（宁可多开 turn 也不吞掉真实提问）", () => {
		expect(classifyDshUserMessageOrigin(undefined)).toBe("human_typed");
		expect(classifyDshUserMessageOrigin("user")).toBe("human_typed");
		expect(classifyDshUserMessageOrigin("某个还没定名的来源")).toBe("human_typed");
		expect(classifyDshUserMessageOrigin("agent-inject")).toBe("harness_injected");
		expect(classifyDshUserMessageOrigin("cron-notification")).toBe("harness_injected");
	});
});

describe("dsh subagent 执行器", () => {
	const outputSchema: ObjectRootedJsonSchema = { type: "object", properties: {}, additionalProperties: false };
	const dshSessionRef: ConversationSessionRef = { harnessKind: "dsh", nativeSessionId: DSH_SESSION_ID };

	function buildRequest(): ForkedWorkBranchRequest {
		return { parentSession: dshSessionRef, promptText: "判定归属", outputSchema, timeoutMs: 1000 };
	}

	it("用 provider=fork 起子代理，并把 structured / usage 映射回本包形状", async () => {
		let observedRequest: Parameters<DshSubagentRegistry["start"]>[0] | null = null;
		const subagents: DshSubagentRegistry = {
			async start(request) {
				observedRequest = request;
				return {
					structured: { placements: [] },
					output: [{ type: "text", text: "好了" }],
					stopReason: "completed",
					usage: { inputTokens: 5, cacheReadInputTokens: 574953, outputTokens: 7 },
					id: "child-session",
				};
			},
		};
		const result = await new DshSubagentForkedWorkBranchExecutor(subagents).start(buildRequest());
		expect(observedRequest).toMatchObject({ provider: "fork", parent: DSH_SESSION_ID, outputSchema });
		expect(result.stopReason).toBe("completed");
		expect(result.structured).toEqual({ placements: [] });
		expect(result.outputText).toBe("好了");
		// dsh 的 fork-in-process 不受 Claude Code 那条 cache bug 影响，读量要如实回报。
		expect(result.usage?.cacheReadInputTokens).toBe(574953);
		expect(result.forkedNativeSessionId).toBe("child-session");
	});

	it("认不出来的 stopReason 一律按 error，不猜", async () => {
		const subagents: DshSubagentRegistry = {
			async start() {
				return { stopReason: "某种新的终止原因", output: "" };
			},
		};
		const result = await new DshSubagentForkedWorkBranchExecutor(subagents).start(buildRequest());
		expect(result.stopReason).toBe("error");
	});

	it("非 dsh 会话直接拒绝", async () => {
		const subagents: DshSubagentRegistry = {
			async start() {
				return { stopReason: "completed" };
			},
		};
		await expect(
			new DshSubagentForkedWorkBranchExecutor(subagents).start({
				...buildRequest(),
				parentSession: {
					harnessKind: "claude_code",
					nativeSessionId: "x",
					transcriptPath: "/x",
					workingDirectory: "/x",
					launchArgvTemplate: { model: "default", appendSystemPrompt: null, settingsPath: null, extraArgs: [] },
				},
			}),
		).rejects.toThrow(/只处理 dsh/u);
	});
});

describe("Cordis 插件 apply(ctx)", () => {
	it("注册 explorationThreadGraph projection，dispose 后注销", () => {
		const registeredKeys: string[] = [];
		let disposeWasCalled = false;
		const ctx: DshPluginContext = {
			sessionProjections: {
				register(definition) {
					registeredKeys.push(definition.key);
					// 注册进来的 apply/view 必须真能跑，否则「注册成功」毫无意义。
					const foldedState = buildDshSessionEventLog().reduce(definition.apply, definition.init);
					const view = definition.view(foldedState) as { completedTurnSequence: { turns: unknown[] } };
					expect(view.completedTurnSequence.turns).toHaveLength(2);
					return () => {
						disposeWasCalled = true;
					};
				},
			},
		};
		const dispose = apply(ctx);
		expect(registeredKeys).toEqual([DSH_EXPLORATION_THREAD_GRAPH_PROJECTION_KEY]);
		dispose();
		expect(disposeWasCalled).toBe(true);
	});

	it("headless 装配（没有 projection 注册表）也能起得来", () => {
		expect(() => apply({})()).not.toThrow();
	});
});
