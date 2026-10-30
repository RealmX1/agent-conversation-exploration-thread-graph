// Claude Code 的 fork 执行器（handoff A.6）：`claude -p --resume <父会话> --fork-session`。
//
// argv 由**本包完全控制**（AGENTS.md 铁律）：
//   - env 必含 `AGENT_CONVERSATION_EXPLORATION_WORK_BRANCH_JOB=1`（宿主 hooks 据此整体短路 + PreToolUse deny）；
//   - env 必须**删掉**宿主注入的 `CLAUDE_CODE_*` / `CLAUDECODE`——继承 `CLAUDE_CODE_CHILD_SESSION=1`
//     会让分身完全不落盘 transcript，`forkedNativeSessionId` 的审计价值随之归零（实测）；
//   - **绝不**出现 `--bare` / `--safe-mode`：它们会跳过 hooks，让分身的事件被宿主当成主任务事件。
//     宿主传来的 extraArgs 里若混进这两个，本执行器直接拒绝而不是悄悄剔除——那是宿主配置有问题，要让它响。
//
// prompt cache 实测（2.1.266）：因上游 open bug #77306（session id 被嵌进 system prompt 的 scratchpad 路径），
// fork 拿不到主会话的对话 cache，`cacheReadInputTokens` 常为 0。仍照 D5 原样 fork + 同 model：
// 该 bug 修复后自动变便宜，且 dsh 的 fork-in-process 本就不受影响。usage 照实回报，不粉饰。

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	AGENT_CONVERSATION_EXPLORATION_WORK_BRANCH_JOB_ENV_VARIABLE_NAME,
	type ForkedWorkBranchExecutor,
	type ForkedWorkBranchRequest,
	type ForkedWorkBranchResult,
	type ForkedWorkBranchStopReason,
	type ForkedWorkBranchUsage,
	INHERITED_HOST_CLAUDE_CODE_ENV_VARIABLE_NAMES,
} from "../core/index.js";
import {
	FORKED_WORK_BRANCH_EXECUTION_OWNERSHIP_ENVIRONMENT_KEY,
	observeExecutionOwnedProcesses,
	signalMatchingOwnedProcesses,
} from "./forked-work-branch-process-ownership.js";

/** 会绕过宿主 hooks 的参数：出现即拒绝执行（契约 A.13-3 的前提）。 */
const FORBIDDEN_LAUNCH_ARGUMENTS = ["--bare", "--safe-mode"];

/**
 * 未指定时 spawn 哪个 `claude`：裸名字，交给 PATH 解析。
 * CLI `doctor` 探测的必须是**同一个**目标，否则 doctor 报通过而 maintain 在 spawn 处才失败。
 */
export const DEFAULT_CLAUDE_EXECUTABLE_PATH = "claude";

export interface ClaudeCodeForkedSessionWorkBranchExecutorOptions {
	/** `claude` 可执行文件路径；默认走 PATH。 */
	claudeExecutablePath?: string;
	/** 覆盖宿主模板里的 model（成本旋钮 `useCheaperModelForkWithoutCache`）。默认原样回传宿主模板。 */
	overrideModel?: string;
}

interface ClaudeCodePrintModeResultEnvelope {
	structured_output?: unknown;
	result?: unknown;
	session_id?: unknown;
	is_error?: unknown;
	subtype?: unknown;
	total_cost_usd?: unknown;
	usage?: {
		input_tokens?: unknown;
		cache_read_input_tokens?: unknown;
		output_tokens?: unknown;
	};
}

function readNonNegativeInteger(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function parsePrintModeResultEnvelope(stdoutText: string): ClaudeCodePrintModeResultEnvelope | null {
	try {
		const parsed = JSON.parse(stdoutText) as unknown;
		return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
			? (parsed as ClaudeCodePrintModeResultEnvelope)
			: null;
	} catch {
		return null;
	}
}

/**
 * 分身可能把 JSON 包在 markdown 代码块里回来（不带 `--json-schema` 的退路形态）。
 * 只在 `structured_output` 缺席时才走这条，宁可多一层容错也不要整份作业白跑。
 */
function extractJsonObjectFromOutputText(outputText: string): unknown {
	const fencedMatch = outputText.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/u);
	const candidateText = fencedMatch?.[1] ?? outputText.trim();
	if (!candidateText.startsWith("{")) return undefined;
	try {
		return JSON.parse(candidateText) as unknown;
	} catch {
		return undefined;
	}
}

export class ClaudeCodeForkedSessionWorkBranchExecutor implements ForkedWorkBranchExecutor {
	private readonly claudeExecutablePath: string;
	private readonly overrideModel: string | null;

	constructor(options: ClaudeCodeForkedSessionWorkBranchExecutorOptions = {}) {
		this.claudeExecutablePath = options.claudeExecutablePath ?? DEFAULT_CLAUDE_EXECUTABLE_PATH;
		this.overrideModel = options.overrideModel ?? null;
	}

	/** 单独导出便于测试与 CLI `doctor` 复核：这份 argv 就是真正会被 spawn 的那份。 */
	buildLaunchArguments(request: ForkedWorkBranchRequest, forkedSessionId: string): string[] {
		const { parentSession } = request;
		if (parentSession.harnessKind !== "claude_code") {
			throw new Error(
				`ClaudeCodeForkedSessionWorkBranchExecutor 只处理 claude_code 会话，收到 ${parentSession.harnessKind}`,
			);
		}
		const { launchArgvTemplate } = parentSession;
		for (const extraArgument of launchArgvTemplate.extraArgs) {
			if (FORBIDDEN_LAUNCH_ARGUMENTS.includes(extraArgument)) {
				throw new Error(
					`宿主的 launchArgvTemplate.extraArgs 含 ${extraArgument}，它会绕过宿主 hooks，拒绝以此启动作业分身`,
				);
			}
		}
		const launchArguments = [
			"-p",
			"--resume",
			parentSession.nativeSessionId,
			"--fork-session",
			"--session-id",
			forkedSessionId,
			"--output-format",
			"json",
			"--json-schema",
			JSON.stringify(request.outputSchema),
			"--model",
			this.overrideModel ?? launchArgvTemplate.model,
		];
		if (launchArgvTemplate.appendSystemPrompt !== null) {
			launchArguments.push("--append-system-prompt", launchArgvTemplate.appendSystemPrompt);
		}
		if (launchArgvTemplate.settingsPath !== null) {
			launchArguments.push("--settings", launchArgvTemplate.settingsPath);
		}
		launchArguments.push(...launchArgvTemplate.extraArgs);
		launchArguments.push(request.promptText);
		return launchArguments;
	}

	/** 分身进程的 env：加作业标记，删宿主注入的内部变量。 */
	buildChildProcessEnvironment(parentEnvironment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
		const childEnvironment: NodeJS.ProcessEnv = { ...parentEnvironment };
		for (const inheritedVariableName of INHERITED_HOST_CLAUDE_CODE_ENV_VARIABLE_NAMES) {
			delete childEnvironment[inheritedVariableName];
		}
		childEnvironment[AGENT_CONVERSATION_EXPLORATION_WORK_BRANCH_JOB_ENV_VARIABLE_NAME] = "1";
		return childEnvironment;
	}

	async start(request: ForkedWorkBranchRequest): Promise<ForkedWorkBranchResult> {
		const { parentSession } = request;
		if (parentSession.harnessKind !== "claude_code") {
			throw new Error(
				`ClaudeCodeForkedSessionWorkBranchExecutor 只处理 claude_code 会话，收到 ${parentSession.harnessKind}`,
			);
		}
		if (request.signal?.aborted) {
			return {
				outputText: "派发前已取消",
				stopReason: "cancelled",
				cancellationConfirmation: "not_started",
				localProcessLaunchStatus: "not_started",
			};
		}
		const forkedSessionId = randomUUID();
		const launchArguments = this.buildLaunchArguments(request, forkedSessionId);
		const executionOwnershipToken = request.executionOwnershipToken ?? randomUUID();
		if (!/^[a-zA-Z0-9-]{32,128}$/u.test(executionOwnershipToken)) throw new Error("执行归属 token 格式无效");
		if (request.signal) {
			const signal = request.signal;
			let onBarrierAbort!: () => void;
			const aborted = new Promise<void>((resolveAbort) => {
				onBarrierAbort = resolveAbort;
			});
			signal.addEventListener("abort", onBarrierAbort, { once: true });
			try {
				if (!signal.aborted) await Promise.race([Promise.resolve(request.beforeProcessSpawn?.()), aborted]);
			} finally {
				signal.removeEventListener("abort", onBarrierAbort);
			}
		} else {
			await request.beforeProcessSpawn?.();
		}
		if (request.signal?.aborted)
			return {
				outputText: "派发屏障等待期间已取消",
				stopReason: "cancelled",
				cancellationConfirmation: "not_started",
				localProcessLaunchStatus: "not_started",
			};
		const environment = this.buildChildProcessEnvironment(process.env);
		environment[FORKED_WORK_BRANCH_EXECUTION_OWNERSHIP_ENVIRONMENT_KEY] = [
			environment[FORKED_WORK_BRANCH_EXECUTION_OWNERSHIP_ENVIRONMENT_KEY],
			executionOwnershipToken,
		]
			.filter(Boolean)
			.join(":");
		const executionStartedAtEpochMs = Date.now();

		return await new Promise<ForkedWorkBranchResult>((resolve) => {
			const child = spawn(this.claudeExecutablePath, launchArguments, {
				cwd: parentSession.workingDirectory,
				env: environment,
				stdio: ["ignore", "pipe", "pipe"],
				detached: process.platform !== "win32",
			});

			let stdoutText = "";
			let stderrText = "";
			let stopReasonOverride: ForkedWorkBranchStopReason | null = null;
			let settled = false;

			const ownedProcessStartIdentities = new Map<number, string>();
			let lastOutputActivityAtEpochMs: number | null = null;
			let processExitConfirmed = false;
			let cancellationEscalationTimer: ReturnType<typeof setTimeout> | undefined;
			let cancellationConfirmationTimer: ReturnType<typeof setTimeout> | undefined;
			let cancellationRequestedAtEpochMs: number | null = null;
			const terminatedProcessStartIdentities = new Map<number, string>();
			const signalOwnedProcessesForCancellation = async (signal: NodeJS.Signals): Promise<void> => {
				if (settled) return;
				let processesToSignal = ownedProcessStartIdentities;
				if (signal === "SIGTERM") {
					processesToSignal = new Map<number, string>();
					for (const [pid, identity] of ownedProcessStartIdentities) {
						// 根进程已由 ChildProcess 句柄接收一次 TERM，不再从归属表重复发送。
						if (pid === child.pid || terminatedProcessStartIdentities.get(pid) === identity) continue;
						processesToSignal.set(pid, identity);
						terminatedProcessStartIdentities.set(pid, identity);
					}
				}
				// 重复 TERM 可打断 once handler 的优雅释放；缺证只能留待升级或最终 unknown。
				if (processesToSignal.size > 0) await signalMatchingOwnedProcesses(processesToSignal, signal);
			};
			const recoverOwnedDescendants = async () => {
				try {
					const recovered = await observeExecutionOwnedProcesses({
						executionOwnershipToken,
						executionStartedAtEpochMs,
						recordedStartIdentities: ownedProcessStartIdentities,
					});
					for (const [pid, identity] of recovered.ownedStartIdentities)
						ownedProcessStartIdentities.set(pid, identity);
					return recovered;
				} catch {
					return { ownedStartIdentities: new Map<number, string>(), hasUnprovenOrphanOwnership: true };
				}
			};
			let observationInFlight: Promise<void> | null = null;
			const observeOwnership = (): Promise<void> => {
				if (settled) return Promise.resolve();
				if (observationInFlight) return observationInFlight;
				observationInFlight = (async () => {
					if (!child.pid) return;
					// 首次身份由 token 正向证明；后续也持续恢复新生、已脱离父链的后代。
					await recoverOwnedDescendants();
					if (settled) return;
					try {
						request.onProcessObservation?.({
							executionOwnershipToken,
							processPid: child.pid,
							processStartIdentity: ownedProcessStartIdentities.get(child.pid) ?? null,
							ownedDescendantStartIdentities: Object.fromEntries(
								[...ownedProcessStartIdentities].filter(([pid]) => pid !== child.pid),
							),
							observedAtEpochMs: Date.now(),
							lastOutputActivityAtEpochMs,
						});
					} catch {
						// 宿主观察出口失败不终止角色；持久缺证由宿主下一次观察补齐。
					}
					if (settled || cancellationRequestedAtEpochMs === null) return;
					const signal = Date.now() - cancellationRequestedAtEpochMs >= 2_000 ? "SIGKILL" : "SIGTERM";
					await signalOwnedProcessesForCancellation(signal);
					if (settled || !processExitConfirmed) return;
					const finalOwnership = await recoverOwnedDescendants();
					if (
						!settled &&
						!finalOwnership.hasUnprovenOrphanOwnership &&
						finalOwnership.ownedStartIdentities.size === 0
					) {
						settle({
							outputText: stderrText.trim() === "" ? stdoutText : stderrText,
							stopReason: "cancelled",
							forkedNativeSessionId: forkedSessionId,
							cancellationConfirmation: "confirmed",
						});
					}
				})().finally(() => {
					observationInFlight = null;
				});
				return observationInFlight;
			};
			const ownershipObservationTimer = setInterval(() => {
				void observeOwnership();
			}, 250);
			const onAbort = (): void => {
				if (stopReasonOverride === "cancelled" || settled) return;
				stopReasonOverride = "cancelled";
				cancellationRequestedAtEpochMs = Date.now();
				if (!processExitConfirmed) child.kill("SIGTERM");
				void signalOwnedProcessesForCancellation("SIGTERM");
				void observeOwnership();
				cancellationEscalationTimer = setTimeout(() => {
					if (!processExitConfirmed) child.kill("SIGKILL");
					void signalOwnedProcessesForCancellation("SIGKILL");
					void observeOwnership();
				}, 2_000);
				cancellationConfirmationTimer = setTimeout(() => {
					// 清理窗口到点不代表全树退出；完整归属核验未完成时一律未知。
					settle({
						outputText: stderrText || stdoutText,
						stopReason: "cancelled",
						forkedNativeSessionId: forkedSessionId,
						cancellationConfirmation: "unknown",
					});
					child.stdout.destroy();
					child.stderr.destroy();
					child.unref();
				}, 5_000);
			};
			request.signal?.addEventListener("abort", onAbort, { once: true });
			if (request.signal?.aborted) onAbort();
			child.once("spawn", () => {
				void observeOwnership();
			});
			child.once("exit", () => {
				processExitConfirmed = true;
				if (cancellationRequestedAtEpochMs !== null) void observeOwnership();
			});

			const settle = (result: ForkedWorkBranchResult): void => {
				if (settled) return;
				settled = true;
				clearInterval(ownershipObservationTimer);
				clearTimeout(cancellationEscalationTimer);
				clearTimeout(cancellationConfirmationTimer);
				request.signal?.removeEventListener("abort", onAbort);
				resolve(result);
			};

			child.stdout.on("data", (chunk: Buffer) => {
				stdoutText += chunk.toString("utf8");
				lastOutputActivityAtEpochMs = Date.now();
			});
			child.stderr.on("data", (chunk: Buffer) => {
				stderrText += chunk.toString("utf8");
				lastOutputActivityAtEpochMs = Date.now();
			});

			child.on("error", (spawnError: Error) => {
				settle({
					outputText: `启动 ${this.claudeExecutablePath} 失败：${spawnError.message}`,
					stopReason: "error",
					localProcessLaunchStatus: child.pid ? "started" : "not_started",
				});
			});

			child.on("close", async (exitCode) => {
				// 补查归属会让出执行权，取消资格必须在最后一次等待后重新核验。
				await observeOwnership();
				// 取消清理不依赖 close，根提前 close 也不能跳过后代的 TERM 宽限期。
				if (settled || stopReasonOverride !== null) return;
				const envelope = parsePrintModeResultEnvelope(stdoutText);
				if (envelope === null) {
					settle({
						outputText: stdoutText === "" ? stderrText : stdoutText,
						stopReason: "error",
						forkedNativeSessionId: forkedSessionId,
					});
					return;
				}
				const outputText = typeof envelope.result === "string" ? envelope.result : stdoutText;
				const usage: ForkedWorkBranchUsage = {
					inputTokens: readNonNegativeInteger(envelope.usage?.input_tokens),
					cacheReadInputTokens: readNonNegativeInteger(envelope.usage?.cache_read_input_tokens),
					outputTokens: readNonNegativeInteger(envelope.usage?.output_tokens),
					...(typeof envelope.total_cost_usd === "number" ? { costUsd: envelope.total_cost_usd } : {}),
				};
				const structured =
					envelope.structured_output !== undefined
						? envelope.structured_output
						: extractJsonObjectFromOutputText(outputText);
				const failed = envelope.is_error === true || exitCode !== 0;
				settle({
					...(structured !== undefined ? { structured } : {}),
					outputText,
					stopReason: failed ? "error" : "completed",
					usage,
					forkedNativeSessionId: typeof envelope.session_id === "string" ? envelope.session_id : forkedSessionId,
				});
			});
		});
	}
}
