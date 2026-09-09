// fork 执行器：argv 组装与 env 洗净是契约（A.13-3）的落点，必须逐条钉死。
// 真实 `claude` 调用属集成测试，见本文件末尾的 opt-in 用例。

import { describe, expect, it } from "vitest";
import {
	AGENT_CONVERSATION_EXPLORATION_WORK_BRANCH_JOB_ENV_VARIABLE_NAME,
	type ConversationSessionRef,
	type ForkedWorkBranchRequest,
	INHERITED_HOST_CLAUDE_CODE_ENV_VARIABLE_NAMES,
	type ObjectRootedJsonSchema,
} from "../../src/core/index.js";
import { ClaudeCodeForkedSessionWorkBranchExecutor } from "../../src/harness-claude-code/index.js";

const OUTPUT_SCHEMA: ObjectRootedJsonSchema = {
	type: "object",
	properties: { answer: { type: "string" } },
	required: ["answer"],
	additionalProperties: false,
};

function buildSessionRef(
	launchArgvTemplateOverrides: Partial<
		Extract<ConversationSessionRef, { harnessKind: "claude_code" }>["launchArgvTemplate"]
	> = {},
): ConversationSessionRef {
	return {
		harnessKind: "claude_code",
		nativeSessionId: "parent-session-id",
		transcriptPath: "/workspace/transcript.jsonl",
		workingDirectory: "/workspace/repo",
		launchArgvTemplate: {
			model: "default",
			appendSystemPrompt: "宿主逐字提供的附加系统提示",
			settingsPath: "/host/settings.json",
			extraArgs: ["--dangerously-skip-permissions"],
			...launchArgvTemplateOverrides,
		},
	};
}

function buildRequest(sessionRef: ConversationSessionRef = buildSessionRef()): ForkedWorkBranchRequest {
	return {
		parentSession: sessionRef,
		promptText: "判定归属并只输出 JSON",
		outputSchema: OUTPUT_SCHEMA,
		timeoutMs: 1000,
	};
}

describe("fork 执行器的 argv 组装", () => {
	it("原样回传宿主模板，并带齐 fork 所需参数", () => {
		const executor = new ClaudeCodeForkedSessionWorkBranchExecutor();
		const launchArguments = executor.buildLaunchArguments(buildRequest(), "forked-session-id");
		expect(launchArguments).toEqual([
			"-p",
			"--resume",
			"parent-session-id",
			"--fork-session",
			"--session-id",
			"forked-session-id",
			"--output-format",
			"json",
			"--json-schema",
			JSON.stringify(OUTPUT_SCHEMA),
			"--model",
			"default",
			"--append-system-prompt",
			"宿主逐字提供的附加系统提示",
			"--settings",
			"/host/settings.json",
			"--dangerously-skip-permissions",
			"判定归属并只输出 JSON",
		]);
	});

	it("绝不出现 --bare / --safe-mode；宿主模板混进来时直接拒绝而不是悄悄剔除", () => {
		const executor = new ClaudeCodeForkedSessionWorkBranchExecutor();
		expect(executor.buildLaunchArguments(buildRequest(), "f")).not.toContain("--bare");
		expect(executor.buildLaunchArguments(buildRequest(), "f")).not.toContain("--safe-mode");
		for (const forbiddenArgument of ["--bare", "--safe-mode"]) {
			expect(() =>
				executor.buildLaunchArguments(buildRequest(buildSessionRef({ extraArgs: [forbiddenArgument] })), "f"),
			).toThrow(/绕过宿主 hooks/u);
		}
	});

	it("模板里的可选项缺席时不产生空参数", () => {
		const executor = new ClaudeCodeForkedSessionWorkBranchExecutor();
		const launchArguments = executor.buildLaunchArguments(
			buildRequest(buildSessionRef({ appendSystemPrompt: null, settingsPath: null, extraArgs: [] })),
			"f",
		);
		expect(launchArguments).not.toContain("--append-system-prompt");
		expect(launchArguments).not.toContain("--settings");
	});

	it("成本旋钮可覆盖 model（cache 反正不命中，同 model 不再是前提）", () => {
		const executor = new ClaudeCodeForkedSessionWorkBranchExecutor({ overrideModel: "sonnet" });
		const launchArguments = executor.buildLaunchArguments(buildRequest(), "f");
		expect(launchArguments[launchArguments.indexOf("--model") + 1]).toBe("sonnet");
	});

	it("非 claude_code 会话直接拒绝", () => {
		const executor = new ClaudeCodeForkedSessionWorkBranchExecutor();
		expect(() =>
			executor.buildLaunchArguments(buildRequest({ harnessKind: "dsh", nativeSessionId: "x" }), "f"),
		).toThrow(/只处理 claude_code/u);
	});
});

describe("fork 执行器的 env 洗净", () => {
	it("加作业标记，并删掉宿主注入的全部内部变量", () => {
		const executor = new ClaudeCodeForkedSessionWorkBranchExecutor();
		const pollutedParentEnvironment: NodeJS.ProcessEnv = {
			PATH: "/usr/bin",
			ANTHROPIC_BASE_URL: "http://127.0.0.1:8080",
		};
		for (const inheritedVariableName of INHERITED_HOST_CLAUDE_CODE_ENV_VARIABLE_NAMES) {
			pollutedParentEnvironment[inheritedVariableName] = "宿主注入值";
		}
		const childEnvironment = executor.buildChildProcessEnvironment(pollutedParentEnvironment);

		expect(childEnvironment[AGENT_CONVERSATION_EXPLORATION_WORK_BRANCH_JOB_ENV_VARIABLE_NAME]).toBe("1");
		for (const inheritedVariableName of INHERITED_HOST_CLAUDE_CODE_ENV_VARIABLE_NAMES) {
			expect(childEnvironment[inheritedVariableName]).toBeUndefined();
		}
		// 与 Claude Code 无关的变量必须原样保留（代理地址丢了就连不上了）。
		expect(childEnvironment.PATH).toBe("/usr/bin");
		expect(childEnvironment.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:8080");
	});

	it("CLAUDE_CODE_CHILD_SESSION 必须在洗净清单里（继承它分身就不落盘 transcript）", () => {
		expect(INHERITED_HOST_CLAUDE_CODE_ENV_VARIABLE_NAMES).toContain("CLAUDE_CODE_CHILD_SESSION");
	});
});

describe("fork 执行器的失败路径", () => {
	it("可执行文件不存在时回 error 而不是抛", async () => {
		const executor = new ClaudeCodeForkedSessionWorkBranchExecutor({
			claudeExecutablePath: "/nonexistent/claude-binary-for-test",
		});
		const result = await executor.start(buildRequest());
		expect(result.stopReason).toBe("error");
		expect(result.structured).toBeUndefined();
	});
});
