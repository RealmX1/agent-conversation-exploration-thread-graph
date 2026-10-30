// 假 CLI 使用真实进程验证健康执行和显式取消；不会调用模型。
import { existsSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	mutateExplorationThreadGraph,
	resolveExplorationThreadGraphCollectionPath,
	resolveExplorationTopicRegistryPath,
} from "../../src/core/exploration-thread-graph-store.js";
import type {
	ForkedWorkBranchProcessObservation,
	ForkedWorkBranchRequest,
	ForkedWorkBranchResult,
} from "../../src/core/index.js";
import { runExplorationThreadGraphMaintenanceJob } from "../../src/core/index.js";
import * as nativeProcessOwnership from "../../src/harness-claude-code/forked-work-branch-process-ownership.js";
import { ClaudeCodeForkedSessionWorkBranchExecutor } from "../../src/harness-claude-code/index.js";
import {
	buildCompletedTurnSequenceSnapshot,
	buildProposal,
	buildTurnRef,
} from "../fixtures/exploration-thread-graph-test-doubles.js";

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

	it.each(["resolve", "reject"])("派发屏障未释放也及时取消，随后 %s 不得启动 CLI", async (completion) => {
		const { executor, request, directory } = await fakeCli(
			'require("node:fs").writeFileSync("forbidden-model-start", "started");',
		);
		const controller = new AbortController();
		let releaseBarrier!: () => void;
		let rejectBarrier!: (error: Error) => void;
		let result: ForkedWorkBranchResult | undefined;
		const pending = executor.start({
			...request,
			signal: controller.signal,
			beforeProcessSpawn: () =>
				new Promise<void>((resolve, reject) => {
					releaseBarrier = resolve;
					rejectBarrier = reject;
				}),
		});
		void pending.then((value) => {
			result = value;
		});
		try {
			controller.abort();
			await vi.waitFor(() =>
				expect(result).toMatchObject({
					stopReason: "cancelled",
					cancellationConfirmation: "not_started",
					localProcessLaunchStatus: "not_started",
				}),
			);
		} finally {
			if (completion === "resolve") releaseBarrier();
			else rejectBarrier(new Error("取消后的屏障迟到失败"));
			await pending;
		}
		await Promise.resolve();
		expect(existsSync(join(directory, "forbidden-model-start"))).toBe(false);
	});

	it("没有取消信号时等待派发屏障，释放后正常执行", async () => {
		const { executor, request, directory } = await fakeCli(
			'require("node:fs").writeFileSync("model-start", "started"); console.log(JSON.stringify({result:"完成"}));',
		);
		let releaseBarrier!: () => void;
		const pending = executor.start({
			...request,
			beforeProcessSpawn: () =>
				new Promise<void>((resolve) => {
					releaseBarrier = resolve;
				}),
		});
		await Promise.resolve();
		expect(existsSync(join(directory, "model-start"))).toBe(false);
		releaseBarrier();
		expect(await pending).toMatchObject({ stopReason: "completed" });
		expect(existsSync(join(directory, "model-start"))).toBe(true);
	});

	// 子进程的延迟派生及 TERM 宽限使用真实时钟，不能用父进程假时钟替代。
	it("取消持续发现晚生 detached token 孤儿，不等待其继承输出的 close", async () => {
		const { executor, request, directory } = await fakeCli(`const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");
process.once("SIGTERM", () => {
  setTimeout(() => {
    const child = spawn(process.execPath, ["-e", 'process.on("SIGTERM", () => {}); setInterval(() => process.stdout.write("late-output\\\\n"), 100);'], { detached: true, stdio: "inherit" });
    writeFileSync("late-orphan-pid", String(child.pid));
    child.unref();
    process.exit(0);
  }, 650);
});
writeFileSync("root-ready", String(process.pid));
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
		let rootPid = 0;
		try {
			await vi.waitFor(async () => {
				rootPid = Number(await readFile(join(directory, "root-ready"), "utf8"));
				expect(rootPid).toBeGreaterThan(0);
			});
			controller.abort();
			await vi.waitFor(
				async () => {
					descendantPid = Number(await readFile(join(directory, "late-orphan-pid"), "utf8"));
					expect(descendantPid).toBeGreaterThan(0);
				},
				{ timeout: 2_000 },
			);
			expect(await pending).toMatchObject({ stopReason: "cancelled" });
			expect(observation?.ownedDescendantStartIdentities[String(descendantPid)]).toBeDefined();
			await vi.waitFor(async () => {
				const snapshot = await nativeProcessOwnership.readNativeProcessOwnershipSnapshot();
				expect(snapshot.has(rootPid)).toBe(false);
				expect(snapshot.has(descendantPid)).toBe(false);
			});
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

	it("根提前 close 后，后代 once TERM handler 仍有 500ms 写入 graceful 标记", async () => {
		const { executor, request, directory } = await fakeCli(`const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");
const child = spawn(process.execPath, ["-e", 'const fs=require("node:fs"); process.once("SIGTERM",()=>{setTimeout(()=>{fs.writeFileSync("graceful-marker","完成");process.exit(0)},500)});fs.writeFileSync("descendant-ready","ready");setInterval(()=>{},100);'], { detached: true, stdio: "ignore" });
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
				expect(existsSync(join(directory, "descendant-ready"))).toBe(true);
				expect(observation?.ownedDescendantStartIdentities[String(descendantPid)]).toBeDefined();
			});
			controller.abort();
			expect(await pending).toMatchObject({ stopReason: "cancelled" });
			expect(await readFile(join(directory, "graceful-marker"), "utf8")).toBe("完成");
			const snapshot = await nativeProcessOwnership.readNativeProcessOwnershipSnapshot();
			expect(snapshot.has(descendantPid)).toBe(false);
			expect(snapshot.has(observation?.processPid ?? 0)).toBe(false);
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
			// 同宿主的其他新生进程可能缺证；本回归验证可证归属的根和后代实际退出。
			const snapshot = await nativeProcessOwnership.readNativeProcessOwnershipSnapshot();
			expect(snapshot.has(descendantPid)).toBe(false);
			expect(snapshot.has(observation?.processPid ?? 0)).toBe(false);
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

	it.each(["unproven_orphan", "native_query_failed"])(
		"取消时归属补查 %s，不能确认全体停止",
		async (evidence) => {
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
		},
		10_000,
	);
});

function createBarrier(): { promise: Promise<void>; release: () => void } {
	let release!: () => void;
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { promise, release };
}

describe("fork 完成后的维护取消", () => {
	async function scenario() {
		const { request, directory } = await fakeCli('throw new Error("不得启动模型");');
		const session = request.parentSession;
		const snapshot = buildCompletedTurnSequenceSnapshot(session.nativeSessionId, 1);
		const proposal = buildProposal({
			topicProposals: [
				{ temporaryTopicId: "topic", topicTitle: "取消回归", topicAliases: [], topicSummaryMarkdown: null },
			],
			newThreads: [
				{
					temporaryThreadId: "thread",
					threadTitle: "取消回归",
					parentThreadId: null,
					forkedFromTurnRef: null,
					primaryTopicId: "topic",
				},
			],
			placements: [
				{
					turnRef: buildTurnRef(session.nativeSessionId, 1),
					threadId: "thread",
					placementConfidence: "high",
					deviationRationale: null,
				},
			],
		});
		return { session, snapshot, proposal, storeRoot: join(directory, "store") };
	}

	async function expectNoGraphOrTopicWritten(storeRoot: string): Promise<void> {
		await expect(
			readFile(resolveExplorationThreadGraphCollectionPath(storeRoot, "cancelled-job")),
		).rejects.toMatchObject({ code: "ENOENT" });
		await expect(readFile(resolveExplorationTopicRegistryPath(storeRoot))).rejects.toMatchObject({ code: "ENOENT" });
	}

	it("fork 完成后等 store 写锁期间取消，不接受提案或写图/topic", async () => {
		const { session, snapshot, proposal, storeRoot } = await scenario();
		const lockAcquired = createBarrier();
		const releaseLock = createBarrier();
		const forkCompleted = createBarrier();
		const controller = new AbortController();
		const lock = mutateExplorationThreadGraph(storeRoot, "cancelled-job", async () => {
			lockAcquired.release();
			await releaseLock.promise;
			return null;
		});
		await lockAcquired.promise;
		const pending = runExplorationThreadGraphMaintenanceJob({
			explorationId: "cancelled-job",
			sessions: [session],
			storeRoot,
			mode: "initial_backfill",
			signal: controller.signal,
			turnSource: {
				async readCompletedTurnSequence() {
					return snapshot;
				},
			},
			executor: {
				async start() {
					forkCompleted.release();
					return { stopReason: "completed", structured: proposal, outputText: "完成" };
				},
			},
		});
		try {
			await forkCompleted.promise;
			await new Promise<void>((resolve) => setImmediate(resolve));
			controller.abort();
		} finally {
			releaseLock.release();
			await lock;
		}
		expect(await pending).toMatchObject({ outcome: "fork_failed", stopReason: "cancelled" });
		await expectNoGraphOrTopicWritten(storeRoot);
	});

	it.each(["fork_return", "turn_reread", "stale_turn_reread"] as const)(
		"在 %s 取消后不写提案或 stale 标记",
		async (cancellationPoint) => {
			const { session, snapshot, proposal, storeRoot } = await scenario();
			const controller = new AbortController();
			let readCount = 0;
			const result = await runExplorationThreadGraphMaintenanceJob({
				explorationId: "cancelled-job",
				sessions: [session],
				storeRoot,
				mode: "initial_backfill",
				signal: controller.signal,
				turnSource: {
					async readCompletedTurnSequence() {
						readCount += 1;
						if (readCount === 2) {
							controller.abort();
							if (cancellationPoint === "stale_turn_reread") {
								return { ...snapshot, sourceSignature: "changed-after-fork" };
							}
						}
						return snapshot;
					},
				},
				executor: {
					async start() {
						if (cancellationPoint === "fork_return") controller.abort();
						return { stopReason: "completed", structured: proposal, outputText: "完成" };
					},
				},
			});
			expect(result).toMatchObject({ outcome: "fork_failed", stopReason: "cancelled" });
			await expectNoGraphOrTopicWritten(storeRoot);
		},
	);
});
