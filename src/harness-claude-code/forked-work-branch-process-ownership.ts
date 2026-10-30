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
		const startedAt = Date.parse(`${match[5] ?? ""} GMT`);
		if (!Number.isFinite(startedAt)) throw new Error("原生启动时间不可解析，退出证据未知");
		snapshot.set(processPid, {
			processPid,
			parentProcessPid: Number(match[2]),
			processGroupId: Number(match[3]),
			startIdentity: `${processPid} ${match[3]} ${match[5]}`,
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

export function extendOwnedProcessStartIdentities(
	snapshot: ReadonlyMap<number, NativeOwnedProcessObservation>,
	rootProcessPid: number,
	recordedStartIdentities: Map<number, string>,
): void {
	const root = snapshot.get(rootProcessPid);
	if (!recordedStartIdentities.size && root) recordedStartIdentities.set(rootProcessPid, root.startIdentity);
	const confirmedOwnedProcessPids = new Set(
		[...recordedStartIdentities]
			.filter(([pid, identity]) => snapshot.get(pid)?.startIdentity === identity)
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
		if (snapshot.get(nativeProcess.processPid)?.startIdentity !== nativeProcess.startIdentity) continue;
		if (environments.get(nativeProcess.processPid)?.hasExecutionOwnershipToken === true)
			owned.set(nativeProcess.processPid, nativeProcess.startIdentity);
	}
	// 已登记或 token 可证的后代继续通过父链和进程组补齐，不受环境清空影响。
	for (const [pid, identity] of [...owned]) {
		if (liveSnapshot.get(pid)?.startIdentity === identity)
			extendOwnedProcessStartIdentities(liveSnapshot, pid, owned);
	}
	const potentialOrphans = [...liveSnapshot.values()].filter(
		(nativeProcess) =>
			owned.get(nativeProcess.processPid) !== nativeProcess.startIdentity &&
			nativeProcess.processPid !== process.pid &&
			(nativeProcess.startTimeEpochMs === undefined || nativeProcess.startTimeEpochMs >= startedAtFloor) &&
			(nativeProcess.parentProcessPid <= 1 || !liveSnapshot.has(nativeProcess.parentProcessPid)),
	);
	for (const nativeProcess of potentialOrphans) {
		const origin =
			snapshot.get(nativeProcess.processPid)?.startIdentity === nativeProcess.startIdentity
				? environments.get(nativeProcess.processPid)
				: undefined;
		if (origin?.outsideCurrentUser || origin?.launchedByServiceManager) continue;
		// env -i 的孤儿与归属无法核验的新孤儿不能区分，缺 token 不构成退出证明。
		hasUnprovenOrphanOwnership = true;
	}

	return {
		ownedStartIdentities: new Map(
			[...owned].filter(([pid, identity]) => liveSnapshot.get(pid)?.startIdentity === identity),
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
			if (snapshot.get(pid)?.startIdentity !== identity) continue;
			alive = true;
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
