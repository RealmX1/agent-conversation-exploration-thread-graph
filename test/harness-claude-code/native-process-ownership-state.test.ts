// ps 的真实列顺序与状态过滤是取消和回收的资格证据，不允许把缺列当退出。
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	extendOwnedProcessStartIdentities,
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

async function installProcessSnapshotFixture(malformed = false): Promise<string> {
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
	return directory;
}

describe("原生进程状态与身份", () => {
	it("完整保留 S/R 的启动身份，并排除 Z/X", async () => {
		await installProcessSnapshotFixture();
		const snapshot = await readNativeProcessOwnershipSnapshot();
		expect([...snapshot.keys()]).toEqual([870101, 870102]);
	});

	it.each([
		{ startTime: "20:00:00", matchingBirth: true },
		{ startTime: "20:00:01", matchingBirth: false },
	])("PGID 改变不影响出生身份；出生相同=$matchingBirth", async ({ startTime, matchingBirth }) => {
		const fixtureDirectory = await installProcessSnapshotFixture();
		const snapshot = await readNativeProcessOwnershipSnapshot();
		const recorded = new Map([...snapshot].map(([pid, observation]) => [pid, observation.startIdentity]));
		await writeFile(
			join(fixtureDirectory, "ps"),
			`#!${process.execPath}
console.log("870101 1 870999 S Thu Oct 29 ${startTime} 2026 changed-process-group");
`,
			{ mode: 0o700 },
		);
		const signal = vi.spyOn(process, "kill").mockReturnValue(true);
		expect(await signalMatchingOwnedProcesses(recorded, "SIGTERM")).toBe(matchingBirth ? "unknown" : "confirmed");
		if (matchingBirth) expect(signal).toHaveBeenCalledExactlyOnceWith(870101, "SIGTERM");
		else expect(signal).not.toHaveBeenCalled();
	});

	it.each([
		{ processGroupId: 870101, startTime: "20:00:00", recordedPid: 870101, matches: true },
		{ processGroupId: 870999, startTime: "20:00:00", recordedPid: 870101, matches: true },
		{ processGroupId: 870999, startTime: "20:00:01", recordedPid: 870101, matches: false },
		{ processGroupId: 870999, startTime: "20:00:00", recordedPid: 870999, matches: false },
	])(
		"旧版记录：PGID=$processGroupId，出生时间=$startTime，记录 PID=$recordedPid，匹配=$matches",
		async ({ processGroupId, startTime, recordedPid, matches }) => {
			const fixtureDirectory = await installProcessSnapshotFixture();
			await writeFile(
				join(fixtureDirectory, "ps"),
				`#!${process.execPath}
console.log("870101 1 ${processGroupId} S Thu Oct 29 ${startTime} 2026 legacy-record-process");
`,
				{ mode: 0o700 },
			);
			const recorded = new Map([[870101, `${recordedPid} 870101 Thu Oct 29 20:00:00 2026`]]);
			const signal = vi.spyOn(process, "kill").mockReturnValue(true);
			expect(await signalMatchingOwnedProcesses(recorded, "SIGTERM")).toBe(matches ? "unknown" : "confirmed");
			if (matches) expect(signal).toHaveBeenCalledExactlyOnceWith(870101, "SIGTERM");
			else expect(signal).not.toHaveBeenCalled();
		},
	);

	it("token 缺席时旧版根和逃逸后代的已确认身份仍扩展父链和进程组", async () => {
		const fixtureDirectory = await installProcessSnapshotFixture();
		await writeFile(
			join(fixtureDirectory, "ps"),
			`#!${process.execPath}
console.log("870101 1 870999 S Thu Oct 29 20:00:00 2026 registered-root");
console.log("870102 1 870888 S Thu Oct 29 20:00:00 2026 registered-descendant");
console.log("870103 870101 870999 S Thu Oct 29 20:00:00 2026 root-child");
console.log("870104 1 870101 S Thu Oct 29 20:00:00 2026 root-process-group");
console.log("870105 870102 870888 S Thu Oct 29 20:00:00 2026 descendant-child");
console.log("870106 1 870102 S Thu Oct 29 20:00:00 2026 descendant-process-group");
`,
			{ mode: 0o700 },
		);
		vi.spyOn(nativeEnvironmentOwnership, "readNativeProcessExecutionEnvironmentOwnership").mockResolvedValue(
			new Map(),
		);
		const recorded = new Map([
			[870101, "870101 870101 Thu Oct 29 20:00:00 2026"],
			[870102, "870102 870101 Thu Oct 29 20:00:00 2026"],
		]);
		const extended = new Map(recorded);
		const snapshot = await readNativeProcessOwnershipSnapshot();
		extendOwnedProcessStartIdentities(snapshot, 870101, extended);
		expect([...extended.keys()]).toEqual([870101, 870102, 870103, 870104, 870105]);
		extendOwnedProcessStartIdentities(snapshot, 870102, extended);
		expect([...extended.keys()]).toEqual([870101, 870102, 870103, 870104, 870105, 870106]);
		const result = await observeExecutionOwnedProcesses({
			executionOwnershipToken: "11111111-1111-4111-8111-111111111111",
			executionStartedAtEpochMs: Date.parse("2026-10-29T20:00:00Z"),
			recordedStartIdentities: recorded,
		});
		expect([...result.ownedStartIdentities.keys()]).toEqual([870101, 870102, 870103, 870104, 870105, 870106]);
		expect(result.hasUnprovenOrphanOwnership).toBe(false);
		const signal = vi.spyOn(process, "kill").mockReturnValue(true);
		expect(await signalMatchingOwnedProcesses(result.ownedStartIdentities, "SIGTERM")).toBe("unknown");
		expect(signal.mock.calls).toEqual([
			[870101, "SIGTERM"],
			[870102, "SIGTERM"],
			[870103, "SIGTERM"],
			[870104, "SIGTERM"],
			[870105, "SIGTERM"],
			[870106, "SIGTERM"],
		]);
	});

	it.each([
		{ identity: "870101 870101 Thu Oct 29 20:00:01 2026", unknown: false },
		{ identity: "无法核对的旧版身份", unknown: true },
	])("不能从出生变化或无法识别的记录扩展归属：$identity", async ({ identity, unknown }) => {
		const fixtureDirectory = await installProcessSnapshotFixture();
		await writeFile(
			join(fixtureDirectory, "ps"),
			`#!${process.execPath}
console.log("870101 1 870101 S Thu Oct 29 20:00:00 2026 registered-process");
console.log("870102 870101 870101 S Thu Oct 29 20:00:00 2026 unproven-child");
`,
			{ mode: 0o700 },
		);
		vi.spyOn(nativeEnvironmentOwnership, "readNativeProcessExecutionEnvironmentOwnership").mockResolvedValue(
			new Map(),
		);
		const recorded = new Map([[870101, identity]]);
		const snapshot = await readNativeProcessOwnershipSnapshot();
		extendOwnedProcessStartIdentities(snapshot, 870101, recorded);
		expect([...recorded.keys()]).toEqual([870101]);
		const signal = vi.spyOn(process, "kill").mockReturnValue(true);
		expect(await signalMatchingOwnedProcesses(recorded, "SIGKILL")).toBe(unknown ? "unknown" : "confirmed");
		expect(signal).not.toHaveBeenCalled();
		const result = await observeExecutionOwnedProcesses({
			executionOwnershipToken: "11111111-1111-4111-8111-111111111111",
			executionStartedAtEpochMs: Date.parse("2026-10-29T20:00:02Z"),
			recordedStartIdentities: recorded,
		});
		expect(result.ownedStartIdentities.size).toBe(0);
		expect(result.hasUnprovenOrphanOwnership).toBe(unknown);
	});

	it("首次观察只看到复用的根 PID 时不能登记或向无关进程发信号", async () => {
		await installProcessSnapshotFixture();
		const recorded = new Map<number, string>();
		extendOwnedProcessStartIdentities(await readNativeProcessOwnershipSnapshot(), 870101, recorded);
		const signal = vi.spyOn(process, "kill").mockReturnValue(true);
		expect(recorded.size).toBe(0);
		expect(await signalMatchingOwnedProcesses(recorded, "SIGKILL")).toBe("confirmed");
		expect(signal).not.toHaveBeenCalled();
	});

	it("已退出但尚未回收的 zombie 可以确认停止且不发信号", async () => {
		await installProcessSnapshotFixture();
		const signal = vi.spyOn(process, "kill");
		expect(
			await signalMatchingOwnedProcesses(new Map([[870103, "870103 Thu Oct 29 20:00:00 2026"]]), "SIGTERM"),
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
			`#!/bin/sh
if [ "$TZ" = "UTC" ]; then time="06:30:00"; else time="01:30:00"; fi
printf '870301 1 870301 S Sun Nov 1 %s 2026 environment-cleared-orphan\\n' "$time"
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
console.log("870202 "+process.ppid+" 870202 S Thu Oct 29 20:00:00 2015 argv-decoy "+marker+"=${token}");
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

	it.each([
		{ parentProcessPid: 1, outsideCurrentUser: false, launchedByServiceManager: false, unknown: true },
		{ parentProcessPid: 870204, outsideCurrentUser: false, launchedByServiceManager: false, unknown: true },
		{ parentProcessPid: 870205, outsideCurrentUser: false, launchedByServiceManager: false, unknown: true },
		{ parentProcessPid: 870204, outsideCurrentUser: true, launchedByServiceManager: false, unknown: false },
		{ parentProcessPid: 870204, outsideCurrentUser: false, launchedByServiceManager: true, unknown: false },
	])(
		"新生进程父 PID=$parentProcessPid、其他用户=$outsideCurrentUser、服务来源=$launchedByServiceManager 时未知归属=$unknown",
		async ({ parentProcessPid, outsideCurrentUser, launchedByServiceManager, unknown }) => {
			directory = await mkdtemp(join(tmpdir(), "native-process-subreaper-"));
			vi.spyOn(nativeEnvironmentOwnership, "readNativeProcessExecutionEnvironmentOwnership").mockResolvedValue(
				new Map([[870203, { outsideCurrentUser, launchedByServiceManager, hasExecutionOwnershipToken: false }]]),
			);
			await writeFile(
				join(directory, "ps"),
				`#!${process.execPath}
console.log("870204 1 870204 S Thu Oct 29 20:00:00 2015 isolated-subreaper");
console.log("870203 ${parentProcessPid} 870203 S Thu Oct 29 20:00:00 2026 ps");
`,
				{ mode: 0o700 },
			);
			vi.stubEnv("PATH", directory);
			const result = await observeExecutionOwnedProcesses({
				executionOwnershipToken: "11111111-1111-4111-8111-111111111111",
				executionStartedAtEpochMs: Date.parse("2026-10-29T20:00:00Z") + 500,
				recordedStartIdentities: new Map(),
			});
			expect(result.hasUnprovenOrphanOwnership).toBe(unknown);
			expect(result.ownedStartIdentities.size).toBe(0);
			const signal = vi.spyOn(process, "kill").mockReturnValue(true);
			expect(await signalMatchingOwnedProcesses(result.ownedStartIdentities, "SIGTERM")).toBe("confirmed");
			expect(signal).not.toHaveBeenCalled();
		},
	);

	it("只排除本次 ps 的精确子进程 PID，不按命令名排除其他新生进程", async () => {
		directory = await mkdtemp(join(tmpdir(), "native-process-query-child-"));
		vi.spyOn(nativeEnvironmentOwnership, "readNativeProcessExecutionEnvironmentOwnership").mockResolvedValue(
			new Map(),
		);
		await writeFile(
			join(directory, "ps"),
			`#!${process.execPath}
console.log(process.pid+" "+process.ppid+" "+process.pid+" S Thu Oct 29 20:00:00 2026 ps");
console.log("870206 1 870206 S Thu Oct 29 20:00:00 2026 ps");
`,
			{ mode: 0o700 },
		);
		vi.stubEnv("PATH", directory);
		expect([...(await readNativeProcessOwnershipSnapshot()).keys()]).toEqual([870206]);
		const result = await observeExecutionOwnedProcesses({
			executionOwnershipToken: "11111111-1111-4111-8111-111111111111",
			executionStartedAtEpochMs: Date.parse("2026-10-29T20:00:00Z") + 500,
			recordedStartIdentities: new Map(),
		});
		expect(result.hasUnprovenOrphanOwnership).toBe(true);
		expect(result.ownedStartIdentities.size).toBe(0);
	});
});
