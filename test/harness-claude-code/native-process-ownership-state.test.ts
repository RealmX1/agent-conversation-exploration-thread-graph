// ps 的真实列顺序与状态过滤是取消和回收的资格证据，不允许把缺列当退出。
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	FORKED_WORK_BRANCH_EXECUTION_OWNERSHIP_ENVIRONMENT_KEY,
	observeExecutionOwnedProcesses,
	readNativeProcessOwnershipSnapshot,
	signalMatchingOwnedProcesses,
} from "../../src/harness-claude-code/forked-work-branch-process-ownership.js";
import * as nativeEnvironmentOwnership from "../../src/harness-claude-code/native-process-execution-environment-ownership.js";

let directory: string | undefined;
afterEach(async () => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
	if (directory) await rm(directory, { recursive: true, force: true });
	directory = undefined;
});

async function installProcessSnapshotFixture(malformed = false): Promise<void> {
	directory = await mkdtemp(join(tmpdir(), "native-process-state-fixture-"));
	await writeFile(
		join(directory, "ps"),
		`#!${process.execPath}
const withState=process.argv.some(argument=>argument.includes("stat="));
for(const [pid,state] of [[870101,"S"],[870102,"R"],[870103,"Z"],[870104,"X"]]) {
 console.log(${malformed ? '"无法核验的缺列输出"' : 'String(pid)+" 1 "+pid+" "+(withState ? state+" " : "")+"Thu Oct 29 20:00:00 2026 isolated-process"'});
}
`,
		{ mode: 0o700 },
	);
	vi.stubEnv("PATH", directory);
}

describe("原生进程状态与身份", () => {
	it("完整保留 S/R 的启动身份，并排除 Z/X", async () => {
		await installProcessSnapshotFixture();
		const snapshot = await readNativeProcessOwnershipSnapshot();
		expect([...snapshot.keys()]).toEqual([870101, 870102]);
		expect(snapshot.get(870101)?.startIdentity).toBe("870101 870101 Thu Oct 29 20:00:00 2026");
	});

	it("已退出但尚未回收的 zombie 可以确认停止且不发信号", async () => {
		await installProcessSnapshotFixture();
		const signal = vi.spyOn(process, "kill");
		expect(
			await signalMatchingOwnedProcesses(new Map([[870103, "870103 870103 Thu Oct 29 20:00:00 2026"]]), "SIGTERM"),
		).toBe("confirmed");
		expect(signal).not.toHaveBeenCalled();
	});

	it("不完整进程表是未知，不是全体退出", async () => {
		await installProcessSnapshotFixture(true);
		await expect(readNativeProcessOwnershipSnapshot()).rejects.toThrow("格式不完整");
		expect(await signalMatchingOwnedProcesses(new Map([[870101, "old-start"]]), "SIGTERM")).toBe("unknown");
	});
});

describe("跨 session 归属与同秒孤儿补证", () => {
	it("夏令时回拨的重复小时不会把新孤儿误判为执行前进程", async () => {
		directory = await mkdtemp(join(tmpdir(), "native-process-start-time-utc-"));
		await writeFile(
			join(directory, "ps"),
			`#!${process.execPath}
const time=process.env.TZ==="UTC"?"06:30:00":"01:30:00";
console.log("870301 1 870301 S Sun Nov 1 "+time+" 2026 environment-cleared-orphan");
`,
			{ mode: 0o700 },
		);
		vi.stubEnv("PATH", directory);
		vi.stubEnv("TZ", "America/New_York");
		const result = await observeExecutionOwnedProcesses({
			executionOwnershipToken: "31111111-1111-4111-8111-111111111111",
			executionStartedAtEpochMs: Date.parse("2026-11-01T06:20:00Z"),
			recordedStartIdentities: new Map(),
		});
		expect(result.hasUnprovenOrphanOwnership).toBe(true);
	});

	it("其他环境变量值里的 token 文本不是执行归属", async () => {
		const token = "21111111-1111-4111-8111-111111111111";
		const key = FORKED_WORK_BRANCH_EXECUTION_OWNERSHIP_ENVIRONMENT_KEY;
		const startedAt = Date.now();
		const children = [
			spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
				env: { PATH: "/usr/bin:/bin", UNRELATED_VALUE: `reference ${key}=${token} trailing` },
				stdio: "ignore",
			}),
			spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
				env: { PATH: "/usr/bin:/bin", [key]: `ancestor:${token}:nested` },
				stdio: "ignore",
			}),
		];
		try {
			await Promise.all(children.map((child) => once(child, "spawn")));
			const observation = await observeExecutionOwnedProcesses({
				executionOwnershipToken: token,
				executionStartedAtEpochMs: startedAt,
				recordedStartIdentities: new Map(),
			});
			expect(observation.ownedStartIdentities.has(children[0]?.pid ?? 0)).toBe(false);
			expect(observation.ownedStartIdentities.has(children[1]?.pid ?? 0)).toBe(true);
		} finally {
			await Promise.all(
				children.map(async (child) => {
					const exited = once(child, "exit");
					child.kill("SIGKILL");
					await exited;
				}),
			);
		}
	});

	it.each([false, true])("真实环境归属和 argv 文本分离，清空环境的孤儿=%s", async (unprovenOrphan) => {
		directory = await mkdtemp(join(tmpdir(), "native-process-ownership-environment-"));
		const token = "11111111-1111-4111-8111-111111111111";
		vi.spyOn(nativeEnvironmentOwnership, "readNativeProcessExecutionEnvironmentOwnership").mockResolvedValue(
			new Map([
				[870201, { outsideCurrentUser: false, launchedByServiceManager: false, hasExecutionOwnershipToken: true }],
				[870202, { outsideCurrentUser: false, launchedByServiceManager: false, hasExecutionOwnershipToken: false }],
			]),
		);
		await writeFile(
			join(directory, "ps"),
			`#!${process.execPath}
const marker = "AGENT_CONVERSATION_EXPLORATION_WORK_BRANCH_EXECUTION_OWNERSHIP_TOKENS";
const started = "Thu Oct 29 20:00:00 2026";
console.log(process.ppid+" 1 "+process.ppid+" S Thu Oct 29 20:00:00 2015 isolated-controller");
console.log("870201 1 870201 S "+started+" owned-orphan");
console.log("870202 "+process.ppid+" 870202 S "+started+" argv-decoy "+marker+"=${token}");
if(${unprovenOrphan}) console.log("870203 1 870203 S "+started+" environment-cleared-orphan");
`,
			{ mode: 0o700 },
		);
		vi.stubEnv("PATH", directory);
		const result = await observeExecutionOwnedProcesses({
			executionOwnershipToken: token,
			executionStartedAtEpochMs: Date.parse("Thu Oct 29 20:00:00 2026 GMT") + 500,
			recordedStartIdentities: new Map(),
		});
		expect([...result.ownedStartIdentities.keys()]).toEqual([870201]);
		expect(result.hasUnprovenOrphanOwnership).toBe(unprovenOrphan);
	});
});
