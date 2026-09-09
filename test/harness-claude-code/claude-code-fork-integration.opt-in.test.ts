// **opt-in** 集成测试：真的调用本机 `claude` fork 一个真实会话（A.11）。
//
// 默认不跑——它要花真钱、要本机登录、且依赖一个存在的会话。开启方式：
//   AGENT_CONVERSATION_EXPLORATION_THREAD_GRAPH_INTEGRATION_CLAUDE=1 \
//   AGENT_CONVERSATION_EXPLORATION_THREAD_GRAPH_INTEGRATION_SESSION_ID=<父会话 id> \
//   AGENT_CONVERSATION_EXPLORATION_THREAD_GRAPH_INTEGRATION_TRANSCRIPT=<transcript 路径> \
//   npx vitest run test/harness-claude-code/claude-code-fork-integration.opt-in.test.ts
//
// 它断言两件事：① `--json-schema` 的结构化输出真能拿到；② 如实打印 cacheReadInputTokens。
// **不**断言 cacheReadInputTokens > 0：上游 open bug #77306 让 `--fork-session` 拿不到父会话
// 对话 cache（2026-09-10 在 2.1.266 实测 read=0）。等它修好后这里可以收紧成硬断言。

import { describe, expect, it } from "vitest";
import type { ConversationSessionRef, ObjectRootedJsonSchema } from "../../src/core/index.js";
import { ClaudeCodeForkedSessionWorkBranchExecutor } from "../../src/harness-claude-code/index.js";

const integrationIsEnabled = process.env.AGENT_CONVERSATION_EXPLORATION_THREAD_GRAPH_INTEGRATION_CLAUDE === "1";
const parentNativeSessionId = process.env.AGENT_CONVERSATION_EXPLORATION_THREAD_GRAPH_INTEGRATION_SESSION_ID ?? "";
const parentTranscriptPath = process.env.AGENT_CONVERSATION_EXPLORATION_THREAD_GRAPH_INTEGRATION_TRANSCRIPT ?? "";

const OUTPUT_SCHEMA: ObjectRootedJsonSchema = {
	type: "object",
	properties: { observedTurnCount: { type: "integer" } },
	required: ["observedTurnCount"],
	additionalProperties: false,
};

describe.skipIf(!integrationIsEnabled || parentNativeSessionId === "")("真实 claude fork（opt-in）", () => {
	it("结构化输出满足 schema，并如实回报 cache 读量", async () => {
		const sessionRef: ConversationSessionRef = {
			harnessKind: "claude_code",
			nativeSessionId: parentNativeSessionId,
			transcriptPath: parentTranscriptPath,
			workingDirectory: process.cwd(),
			launchArgvTemplate: {
				model: "default",
				appendSystemPrompt: null,
				settingsPath: null,
				extraArgs: ["--dangerously-skip-permissions"],
			},
		};
		const result = await new ClaudeCodeForkedSessionWorkBranchExecutor().start({
			parentSession: sessionRef,
			promptText:
				"你是本会话的分身，只输出 JSON，不要执行任何工具。数一下本会话到目前为止有多少个由真实用户输入开启的 turn。",
			outputSchema: OUTPUT_SCHEMA,
			timeoutMs: 300_000,
		});

		expect(result.stopReason).toBe("completed");
		expect(result.structured).toMatchObject({ observedTurnCount: expect.any(Number) });
		expect(result.forkedNativeSessionId).toBeTypeOf("string");
		expect(result.usage).toBeDefined();
		// D5 的核心指标：如实打印，供人工核对本机当前版本是否已修复 #77306。
		console.log(
			`[集成] cacheReadInputTokens=${result.usage?.cacheReadInputTokens} inputTokens=${result.usage?.inputTokens} costUsd=${result.usage?.costUsd}`,
		);
	}, 320_000);
});
