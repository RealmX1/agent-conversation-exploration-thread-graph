// 批量大小保留数值校验；已移除的总运行预算参数一律拒绝。

import { describe, expect, it } from "vitest";
import { runAgentConversationExplorationThreadGraphCli } from "../../src/cli/agent-conversation-exploration-thread-graph-cli.js";

function parseCliJsonOutput(output: string): Record<string, unknown> {
	return JSON.parse(output) as Record<string, unknown>;
}

/** 只带数值参数跑 maintain：合法值会继续走到「缺 --session」，非法值必须先被数值校验挡下。 */
async function runMaintainWithNumericFlag(flagName: string, rawValue: string): Promise<Record<string, unknown>> {
	const result = await runAgentConversationExplorationThreadGraphCli([
		"maintain",
		"--exploration-id",
		"exploration-under-test",
		flagName,
		rawValue,
	]);
	expect(result.exitCode).toBe(2);
	return parseCliJsonOutput(result.output);
}

describe("CLI 的批量大小与已移除总时限参数校验", () => {
	it.each(["abc", "12abc", "0", "-3", "1.5", ""])("--batch-size %j 被挡在作业之前", async (rawValue) => {
		const failurePayload = await runMaintainWithNumericFlag("--batch-size", rawValue);
		expect(String(failurePayload.error)).toContain("--batch-size");
	});

	it.each(["abc", "0", "-3", "2.5"])("已移除的 --timeout-ms %j 不再接受", async (rawValue) => {
		const failurePayload = await runMaintainWithNumericFlag("--timeout-ms", rawValue);
		expect(String(failurePayload.error)).toContain("--timeout-ms 已移除");
	});

	it("已移除的 --timeout-ms 不再因数值大小形成可用配置", async () => {
		const failurePayload = await runMaintainWithNumericFlag("--timeout-ms", "2147483648");
		expect(String(failurePayload.error)).toContain("--timeout-ms 已移除");
	});

	it("合法正整数照常放行，继续走到后续的会话解析", async () => {
		const result = await runAgentConversationExplorationThreadGraphCli([
			"maintain",
			"--exploration-id",
			"exploration-under-test",
			"--batch-size",
			"5",
		]);
		expect(result.exitCode).toBe(2);
		const failurePayload = parseCliJsonOutput(result.output);
		expect(String(failurePayload.error)).toContain("--session");
		expect(String(failurePayload.error)).not.toContain("--batch-size");
	});
});
