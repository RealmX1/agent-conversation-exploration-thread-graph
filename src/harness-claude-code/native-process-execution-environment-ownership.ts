// 只接受原生 NUL 边界中的独立环境键；不可读取时保留未知，不采用 ps 展示文本。
import { readFile } from "node:fs/promises";
import {
	type NativeProcessExecutionOwnershipObservation,
	readDarwinProcessExecutionOwnershipObservations,
} from "./darwin-process-execution-ownership-observation.js";

export const FORKED_WORK_BRANCH_EXECUTION_OWNERSHIP_ENVIRONMENT_KEY =
	"AGENT_CONVERSATION_EXPLORATION_WORK_BRANCH_EXECUTION_OWNERSHIP_TOKENS";

export async function readNativeProcessExecutionEnvironmentOwnership(
	processPids: number[],
	executionOwnershipToken: string,
): Promise<Map<number, NativeProcessExecutionOwnershipObservation>> {
	if (process.platform === "darwin")
		return await readDarwinProcessExecutionOwnershipObservations(processPids, executionOwnershipToken);
	if (process.platform !== "linux") return new Map();
	return new Map(
		await Promise.all(
			processPids.map(async (pid): Promise<[number, NativeProcessExecutionOwnershipObservation]> => {
				let hasExecutionOwnershipToken: boolean | null = null;
				try {
					const environment = await readFile(`/proc/${pid}/environ`);
					const prefix = `${FORKED_WORK_BRANCH_EXECUTION_OWNERSHIP_ENVIRONMENT_KEY}=`;
					hasExecutionOwnershipToken = environment
						.toString("utf8")
						.split("\0")
						.some(
							(entry) =>
								entry.startsWith(prefix) &&
								entry.slice(prefix.length).split(":").includes(executionOwnershipToken),
						);
				} catch {
					/* 权限、进程变化或查询失败均不能作为退出证明。 */
				}
				return [pid, { outsideCurrentUser: false, launchedByServiceManager: false, hasExecutionOwnershipToken }];
			}),
		),
	);
}
