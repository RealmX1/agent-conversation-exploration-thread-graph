// 启动身份与继承归属用于原生补证；缺证或归属不明时不能推断全体后代退出。
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

import { readNativeProcessExecutionEnvironmentOwnership } from "./native-process-execution-environment-ownership.js";

export { FORKED_WORK_BRANCH_EXECUTION_OWNERSHIP_ENVIRONMENT_KEY } from "./native-process-execution-environment-ownership.js";

const execFileAsync = promisify(execFile);

export interface NativeOwnedProcessObservation {
	processPid: number;
	parentProcessPid: number;
	processGroupId: number;
	startIdentity: string;
	startTimeEpochMs?: number;
	commandArgumentsText?: string;
}

export async function readNativeProcessOwnershipSnapshot(): Promise<Map<number, NativeOwnedProcessObservation>> {
	const queryArguments = ["-ww", "-axo", "pid=,ppid=,pgid=,stat=,lstart=,command="];
	const query = execFileAsync("ps", queryArguments, {
		timeout: 1_000,
		maxBuffer: 32 * 1024 * 1024,
		env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
	});
	const { stdout } = await query;
	const snapshot = new Map<number, NativeOwnedProcessObservation>();
	for (const line of stdout.split("\n")) {
		if (!line.trim()) continue;
		const match = line
			.trim()
			.match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+\s+\S+\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})(?:\s+(.*))?$/u);
		if (!match) throw new Error("原生进程表格式不完整，退出证据未知");
		if (/^[ZX]/u.test(match[4] ?? "")) continue;
		const processPid = Number(match[1]);
		// 本次只读查询自身不是执行期间遗留的后代；只按精确子进程 PID 排除。
		if (processPid === query.child.pid) continue;
		const startedAt = Date.parse(`${match[5] ?? ""} GMT`);
		if (!Number.isFinite(startedAt)) throw new Error("原生启动时间不可解析，退出证据未知");
		snapshot.set(processPid, {
			processPid,
			parentProcessPid: Number(match[2]),
			processGroupId: Number(match[3]),
			startIdentity: `${processPid} ${match[5]}`,
			startTimeEpochMs: startedAt,
			commandArgumentsText: match[6] ?? "",
		});
	}
	return snapshot;
}

export async function readNativeSystemBootIdentity(): Promise<string | null> {
	try {
		if (process.platform === "linux") return (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
		if (process.platform === "darwin")
			return (await execFileAsync("sysctl", ["-n", "kern.bootsessionuuid"], { timeout: 1_000 })).stdout.trim();
	} catch {
		/* 不能用墙钟推算开机代际；不可查询时保留未知。 */
	}
	return null;
}

/**
 * 比较不透明启动身份，兼容含可变 PGID 的旧持久记录；无法核对时保留 unknown。
 * observedIdentity 缺失只表示成功、完整快照中的进程缺席，查询失败不可转换为此输入。
 */
export function compareNativeProcessStartIdentities(
	observedIdentity: string | undefined,
	recordedIdentity: string | undefined,
): "same" | "different" | "unknown" {
	if (observedIdentity === undefined) return "different";
	if (recordedIdentity === undefined) return "unknown";
	if (observedIdentity === recordedIdentity) return "same";
	const identityPattern = /^(\d+)\s+(?:\d+\s+)?(\S+\s+\S+\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})$/u;
	const observed = observedIdentity.match(identityPattern);
	const recorded = recordedIdentity.match(identityPattern);
	if (!observed || !recorded) return "unknown";
	const observedStartedAt = Date.parse(`${observed[2]} GMT`);
	const recordedStartedAt = Date.parse(`${recorded[2]} GMT`);
	if (!Number.isFinite(observedStartedAt) || !Number.isFinite(recordedStartedAt)) return "unknown";
	return observed[1] === recorded[1] && observedStartedAt === recordedStartedAt ? "same" : "different";
}

export function extendOwnedProcessStartIdentities(
	snapshot: ReadonlyMap<number, NativeOwnedProcessObservation>,
	rootProcessPid: number,
	recordedStartIdentities: Map<number, string>,
): void {
	// 根 PID 本身不构成归属证据，只能从 token 或既有启动身份扩展。
	const confirmedOwnedProcessPids = new Set(
		[...recordedStartIdentities]
			.filter(
				([pid, identity]) =>
					compareNativeProcessStartIdentities(snapshot.get(pid)?.startIdentity, identity) === "same",
			)
			.map(([pid]) => pid),
	);
	let added = true;
	while (added) {
		added = false;
		for (const process of snapshot.values()) {
			if (confirmedOwnedProcessPids.has(process.processPid)) continue;
			if (
				confirmedOwnedProcessPids.has(process.parentProcessPid) ||
				(confirmedOwnedProcessPids.size > 0 && process.processGroupId === rootProcessPid)
			) {
				recordedStartIdentities.set(process.processPid, process.startIdentity);
				confirmedOwnedProcessPids.add(process.processPid);
				added = true;
			}
		}
	}
}

export async function observeExecutionOwnedProcesses(input: {
	executionOwnershipToken: string;
	executionStartedAtEpochMs: number;
	recordedStartIdentities: ReadonlyMap<number, string>;
}): Promise<{ ownedStartIdentities: Map<number, string>; hasUnprovenOrphanOwnership: boolean }> {
	const snapshot = await readNativeProcessOwnershipSnapshot();
	const startedAtFloor = Math.floor(input.executionStartedAtEpochMs / 1_000) * 1_000;
	const environmentCandidates = [...snapshot.values()].filter(
		(nativeProcess) =>
			input.recordedStartIdentities.has(nativeProcess.processPid) ||
			nativeProcess.startTimeEpochMs === undefined ||
			nativeProcess.startTimeEpochMs >= startedAtFloor,
	);
	const environments = await readNativeProcessExecutionEnvironmentOwnership(
		environmentCandidates.map((nativeProcess) => nativeProcess.processPid),
		input.executionOwnershipToken,
	);
	// 查询环境前后必须是同一启动身份，不能把 PID 变化时的环境归给旧进程。
	const liveSnapshot = await readNativeProcessOwnershipSnapshot();
	const owned = new Map(input.recordedStartIdentities);
	let hasUnprovenOrphanOwnership = false;
	for (const nativeProcess of liveSnapshot.values()) {
		if (
			compareNativeProcessStartIdentities(
				nativeProcess.startIdentity,
				snapshot.get(nativeProcess.processPid)?.startIdentity,
			) !== "same"
		)
			continue;
		if (environments.get(nativeProcess.processPid)?.hasExecutionOwnershipToken === true)
			owned.set(nativeProcess.processPid, nativeProcess.startIdentity);
	}
	// 已登记或 token 可证的后代继续通过父链和进程组补齐，不受环境清空影响。
	for (const [pid, identity] of [...owned]) {
		const identityComparison = compareNativeProcessStartIdentities(liveSnapshot.get(pid)?.startIdentity, identity);
		if (identityComparison === "same") extendOwnedProcessStartIdentities(liveSnapshot, pid, owned);
		else if (identityComparison === "unknown") hasUnprovenOrphanOwnership = true;
	}
	const potentialOrphans = [...liveSnapshot.values()].filter(
		(nativeProcess) =>
			compareNativeProcessStartIdentities(nativeProcess.startIdentity, owned.get(nativeProcess.processPid)) !==
				"same" &&
			nativeProcess.processPid !== process.pid &&
			(nativeProcess.startTimeEpochMs === undefined || nativeProcess.startTimeEpochMs >= startedAtFloor),
	);
	for (const nativeProcess of potentialOrphans) {
		const origin =
			compareNativeProcessStartIdentities(
				nativeProcess.startIdentity,
				snapshot.get(nativeProcess.processPid)?.startIdentity,
			) === "same"
				? environments.get(nativeProcess.processPid)
				: undefined;
		if (origin?.outsideCurrentUser || origin?.launchedByServiceManager) continue;
		// subreaper 可收养孤儿；父 PID 仍存在也不能排除清空环境、未被采样的后代。
		hasUnprovenOrphanOwnership = true;
	}

	return {
		ownedStartIdentities: new Map(
			[...owned].filter(
				([pid, identity]) =>
					compareNativeProcessStartIdentities(liveSnapshot.get(pid)?.startIdentity, identity) === "same",
			),
		),
		hasUnprovenOrphanOwnership,
	};
}

export async function signalMatchingOwnedProcesses(
	recordedStartIdentities: ReadonlyMap<number, string>,
	signal: NodeJS.Signals,
): Promise<"confirmed" | "unknown"> {
	try {
		const snapshot = await readNativeProcessOwnershipSnapshot();
		let alive = false;
		for (const [pid, identity] of recordedStartIdentities) {
			const identityComparison = compareNativeProcessStartIdentities(snapshot.get(pid)?.startIdentity, identity);
			if (identityComparison === "different") continue;
			alive = true;
			if (identityComparison === "unknown") continue;
			try {
				process.kill(pid, signal);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ESRCH") return "unknown";
			}
		}
		return alive ? "unknown" : "confirmed";
	} catch {
		return "unknown";
	}
}

export async function confirmOwnedProcessCancellation(
	recordedStartIdentities: ReadonlyMap<number, string>,
): Promise<"confirmed" | "unknown"> {
	for (let attempt = 0; attempt < 20; attempt += 1) {
		if ((await signalMatchingOwnedProcesses(recordedStartIdentities, "SIGKILL")) === "confirmed") return "confirmed";
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	return "unknown";
}
