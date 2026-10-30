// 假 CLI 使用真实进程验证健康执行和显式取消；不会调用模型。
import { existsSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ForkedWorkBranchProcessObservation, ForkedWorkBranchRequest } from "../../src/core/index.js";
import * as nativeProcessOwnership from "../../src/harness-claude-code/forked-work-branch-process-ownership.js";
import { signalMatchingOwnedProcesses } from "../../src/harness-claude-code/forked-work-branch-process-ownership.js";
import { ClaudeCodeForkedSessionWorkBranchExecutor } from "../../src/harness-claude-code/index.js";

const artifactDirectories: string[] = [];
afterEach(async () => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	for (const directory of artifactDirectories.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function fakeCli(program: string): Promise<{
	executor: ClaudeCodeForkedSessionWorkBranchExecutor;
	request: ForkedWorkBranchRequest;
	directory: string;
}> {
	const directory = await mkdtemp(join(tmpdir(), "unlimited-forked-agent-"));
	artifactDirectories.push(directory);
	const executable = join(directory, "fake-claude.cjs");
	await writeFile(executable, `#!${process.execPath}\n${program}`, { mode: 0o700 });
	return {
		directory,
		executor: new ClaudeCodeForkedSessionWorkBranchExecutor({ claudeExecutablePath: executable }),
		request: {
			parentSession: {
				harnessKind: "claude_code",
				nativeSessionId: "isolated-parent",
				transcriptPath: join(directory, "parent.jsonl"),
				workingDirectory: directory,
				launchArgvTemplate: { model: "test", appendSystemPrompt: null, settingsPath: null, extraArgs: [] },
			},
			promptText: "只运行隔离假 CLI",
			outputSchema: { type: "object", properties: {} },
		},
	};
}

describe("分身没有总运行时限", () => {
	it.each([false, true])("健康 CLI 跨旧 120/300 秒阈值后完成；心跳=%s", async (heartbeats) => {
		const { executor, request } =
			await fakeCli(`${heartbeats ? 'setInterval(() => process.stderr.write("活动\\n"), 30);' : ""}
setTimeout(() => { console.log(JSON.stringify({ result: "完成", structured_output: { completed: true } })); process.exit(0); }, 200);`);
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const pending = executor.start(request);
		await vi.advanceTimersByTimeAsync(300_001);
		expect(await pending).toMatchObject({ stopReason: "completed", structured: { completed: true } });
	});

	it("派发前取消不启动 CLI", async () => {
		const { executor, request } = await fakeCli('throw new Error("不得运行");');
		const controller = new AbortController();
		controller.abort();
		expect(await executor.start({ ...request, signal: controller.signal })).toMatchObject({
			stopReason: "cancelled",
			cancellationConfirmation: "not_started",
		});
	});

	it("持久派发屏障等待期间取消，不能在屏障结束后启动 CLI", async () => {
		const { executor, request, directory } = await fakeCli(
			'require("node:fs").writeFileSync("forbidden-model-start", "started");',
		);
		const controller = new AbortController();
		let releaseBarrier: (() => void) | undefined;
		const pending = executor.start({
			...request,
			signal: controller.signal,
			beforeProcessSpawn: () =>
				new Promise<void>((resolve) => {
					releaseBarrier = resolve;
				}),
		});
		controller.abort();
		releaseBarrier?.();
		expect(await pending).toMatchObject({ stopReason: "cancelled", cancellationConfirmation: "not_started" });
		expect(existsSync(join(directory, "forbidden-model-start"))).toBe(false);
	});

	it("显式取消会升级清理忽略 SIGTERM 的 CLI 及后代", async () => {
		const { executor, request, directory } = await fakeCli(`const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");
process.on("SIGTERM", () => {});
const child = spawn(process.execPath, ["-e", 'process.on("SIGTERM", () => {}); setInterval(() => {}, 100);'], { detached: true, stdio: "ignore" });
writeFileSync("owned-child-pid", String(child.pid));
setInterval(() => {}, 100);`);
		const controller = new AbortController();
		let observation: ForkedWorkBranchProcessObservation | undefined;
		const pending = executor.start({
			...request,
			signal: controller.signal,
			onProcessObservation: (value) => {
				observation = value;
			},
		});
		let descendantPid = 0;
		try {
			await vi.waitFor(async () => {
				descendantPid = Number(await readFile(join(directory, "owned-child-pid"), "utf8"));
				expect(observation?.ownedDescendantStartIdentities[String(descendantPid)]).toBeDefined();
			});
			controller.abort();
			const result = await pending;
			expect(result.stopReason).toBe("cancelled");
			expect(result.cancellationConfirmation).toBe("confirmed");
		} finally {
			controller.abort();
			await pending;
			if (descendantPid) {
				try {
					process.kill(descendantPid, "SIGKILL");
				} catch {}
			}
		}
	}, 10_000);

	it("正常退出后的归属补查中取消，不能发布 completed 结果", async () => {
		const { executor, request, directory } = await fakeCli(`const { existsSync, writeFileSync } = require("node:fs");
const observation = setInterval(() => {
  if (!existsSync("initial-observation")) return;
  clearInterval(observation);
  writeFileSync("completed-before-close-observation", "ready");
  console.log(JSON.stringify({result: "完成", structured_output: {completed: true}}));
  process.exit(0);
}, 5);`);
		const controller = new AbortController();
		const result = await executor.start({
			...request,
			signal: controller.signal,
			onProcessObservation: () => {
				if (existsSync(join(directory, "completed-before-close-observation"))) controller.abort();
				else writeFileSync(join(directory, "initial-observation"), "ready");
			},
		});
		expect(controller.signal.aborted).toBe(true);
		expect(result.stopReason).toBe("cancelled");
		expect(result.structured).toBeUndefined();
	});

	it("PID 身份变化时不发送取消信号", async () => {
		const sendSignal = vi.spyOn(process, "kill");
		expect(await signalMatchingOwnedProcesses(new Map([[process.pid, "不同的启动身份"]]), "SIGKILL")).toBe(
			"confirmed",
		);
		expect(sendSignal).not.toHaveBeenCalled();
	});

	it.each(["unproven_orphan", "native_query_failed"])("取消时归属补查 %s，不能确认全体停止", async (evidence) => {
		vi.spyOn(nativeProcessOwnership, "observeExecutionOwnedProcesses").mockImplementation(async () => {
			if (evidence === "native_query_failed") throw new Error("模拟原生归属补查缺证");
			return { ownedStartIdentities: new Map(), hasUnprovenOrphanOwnership: true };
		});
		const { executor, request, directory } = await fakeCli(`const fs=require("node:fs");
const readiness=setInterval(()=>{
 if(!fs.existsSync("root-observed"))return;
 clearInterval(readiness);
 fs.writeFileSync("root-finished","ready");
 console.log(JSON.stringify({structured_output:{completed:true},result:"完成"}));
 process.exit(0);
},5);`);
		const controller = new AbortController();
		const result = await executor.start({
			...request,
			signal: controller.signal,
			onProcessObservation: () => {
				if (existsSync(join(directory, "root-finished"))) controller.abort();
				else writeFileSync(join(directory, "root-observed"), "ready");
			},
		});
		expect(result).toMatchObject({ stopReason: "cancelled", cancellationConfirmation: "unknown" });
		expect(result.structured).toBeUndefined();
	});
});
