// CLI 的数值参数校验（RVF-009）：`--batch-size` / `--timeout-ms` 解析不出正整数时必须返回 exit 2，
// 而不是把垃圾值交给作业——实测 batchSize=NaN 会让判定列表空掉却照样烧一次全价 fork，
// timeoutMs=NaN 会让 setTimeout 在 1ms 内触发、把刚起来的分身 SIGTERM 秒杀。

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

describe("CLI 的 --batch-size / --timeout-ms 校验（RVF-009）", () => {
	it.each(["abc", "12abc", "0", "-3", "1.5", ""])("--batch-size %j 被挡在作业之前", async (rawValue) => {
		const failurePayload = await runMaintainWithNumericFlag("--batch-size", rawValue);
		expect(String(failurePayload.error)).toContain("--batch-size");
	});

	it.each(["abc", "0", "-3", "2.5"])("--timeout-ms %j 被挡在作业之前", async (rawValue) => {
		const failurePayload = await runMaintainWithNumericFlag("--timeout-ms", rawValue);
		expect(String(failurePayload.error)).toContain("--timeout-ms");
	});

	it("--timeout-ms 超过 setTimeout 的 32 位上限时也被拒（否则延时被压回 1ms，症状同 NaN）", async () => {
		const failurePayload = await runMaintainWithNumericFlag("--timeout-ms", "2147483648");
		expect(String(failurePayload.error)).toContain("--timeout-ms");
	});

	it("合法正整数照常放行，继续走到后续的会话解析", async () => {
		const result = await runAgentConversationExplorationThreadGraphCli([
			"maintain",
			"--exploration-id",
			"exploration-under-test",
			"--batch-size",
			"5",
			"--timeout-ms",
			"60000",
		]);
		expect(result.exitCode).toBe(2);
		const failurePayload = parseCliJsonOutput(result.output);
		expect(String(failurePayload.error)).toContain("--session");
		expect(String(failurePayload.error)).not.toContain("--batch-size");
	});
});
