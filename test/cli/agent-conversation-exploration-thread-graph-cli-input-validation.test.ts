// CLI 的输入校验：外部传入的 `--session` JSON 结构不合法时，必须按 CLI 约定返回
// exitCode 2 + JSON 错误对象，而不是让 TypeError 穿透到 doctor / maintain 内部（RVF-007）。

import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runAgentConversationExplorationThreadGraphCli } from "../../src/cli/agent-conversation-exploration-thread-graph-cli.js";

const repositoryRootDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const desensitizedTranscriptFixturePath = path.join(
	repositoryRootDirectory,
	"test/fixtures/claude-code-transcript-desensitized.jsonl",
);

function parseCliJsonOutput(output: string): Record<string, unknown> {
	return JSON.parse(output) as Record<string, unknown>;
}

async function runDoctorWithSessionJson(
	sessionValue: unknown,
): ReturnType<typeof runAgentConversationExplorationThreadGraphCli> {
	return await runAgentConversationExplorationThreadGraphCli(["doctor", "--session", JSON.stringify(sessionValue)]);
}

describe("CLI 的 --session 结构校验（RVF-007）", () => {
	it("claude_code 会话缺 launchArgvTemplate 时返回 exit 2 而不是抛 TypeError", async () => {
		const result = await runDoctorWithSessionJson({
			harnessKind: "claude_code",
			nativeSessionId: "session-without-launch-argv-template",
			transcriptPath: desensitizedTranscriptFixturePath,
			workingDirectory: "/tmp",
		});
		expect(result.exitCode).toBe(2);
		const failurePayload = parseCliJsonOutput(result.output);
		expect(failurePayload.ok).toBe(false);
		expect(String(failurePayload.error)).toContain("launchArgvTemplate");
	});

	it("launchArgvTemplate 字段类型不对时返回 exit 2 并指出具体字段", async () => {
		const result = await runDoctorWithSessionJson({
			harnessKind: "claude_code",
			nativeSessionId: "session-with-broken-extra-args",
			transcriptPath: desensitizedTranscriptFixturePath,
			workingDirectory: "/tmp",
			launchArgvTemplate: { model: "default", appendSystemPrompt: null, settingsPath: null, extraArgs: [7] },
		});
		expect(result.exitCode).toBe(2);
		expect(String(parseCliJsonOutput(result.output).error)).toContain("launchArgvTemplate.extraArgs");
	});

	it("缺 nativeSessionId / transcriptPath 等必填字段时返回 exit 2", async () => {
		const missingNativeSessionId = await runDoctorWithSessionJson({ harnessKind: "dsh" });
		expect(missingNativeSessionId.exitCode).toBe(2);
		expect(String(parseCliJsonOutput(missingNativeSessionId.output).error)).toContain("nativeSessionId");

		const missingTranscriptPath = await runDoctorWithSessionJson({
			harnessKind: "claude_code",
			nativeSessionId: "session-without-transcript-path",
			workingDirectory: "/tmp",
			launchArgvTemplate: { model: "default", appendSystemPrompt: null, settingsPath: null, extraArgs: [] },
		});
		expect(missingTranscriptPath.exitCode).toBe(2);
		expect(String(parseCliJsonOutput(missingTranscriptPath.output).error)).toContain("transcriptPath");
	});

	it("forkedFromParentSessionTurnNumber 不是正整数时返回 exit 2", async () => {
		const result = await runDoctorWithSessionJson({
			harnessKind: "dsh",
			nativeSessionId: "session-with-broken-fork-anchor",
			forkedFromParentSessionTurnNumber: "3",
		});
		expect(result.exitCode).toBe(2);
		expect(String(parseCliJsonOutput(result.output).error)).toContain("forkedFromParentSessionTurnNumber");
	});

	it("结构完整的会话仍照常通过校验", async () => {
		const result = await runDoctorWithSessionJson({
			harnessKind: "claude_code",
			nativeSessionId: "session-with-complete-shape",
			transcriptPath: desensitizedTranscriptFixturePath,
			workingDirectory: "/tmp",
			launchArgvTemplate: {
				model: "default",
				appendSystemPrompt: "逐字模板",
				settingsPath: null,
				extraArgs: ["--verbose"],
			},
			forkedFromParentSessionTurnNumber: 3,
		});
		expect(result.exitCode).toBe(0);
		expect(parseCliJsonOutput(result.output).ok).toBe(true);
	});
});
