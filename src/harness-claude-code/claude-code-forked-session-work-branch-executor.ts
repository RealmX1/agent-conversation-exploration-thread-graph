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
		const forkedSessionId = randomUUID();
		const launchArguments = this.buildLaunchArguments(request, forkedSessionId);

		return await new Promise<ForkedWorkBranchResult>((resolve) => {
			const child = spawn(this.claudeExecutablePath, launchArguments, {
				cwd: parentSession.workingDirectory,
				env: this.buildChildProcessEnvironment(process.env),
				stdio: ["ignore", "pipe", "pipe"],
			});

			let stdoutText = "";
			let stderrText = "";
			let stopReasonOverride: ForkedWorkBranchStopReason | null = null;
			let settled = false;

			const timeoutHandle = setTimeout(() => {
				stopReasonOverride = "timeout";
				child.kill("SIGTERM");
			}, request.timeoutMs);

			const onAbort = (): void => {
				stopReasonOverride = "cancelled";
				child.kill("SIGTERM");
			};
			request.signal?.addEventListener("abort", onAbort, { once: true });

			const settle = (result: ForkedWorkBranchResult): void => {
				if (settled) return;
				settled = true;
				clearTimeout(timeoutHandle);
				request.signal?.removeEventListener("abort", onAbort);
				resolve(result);
			};

			child.stdout.on("data", (chunk: Buffer) => {
				stdoutText += chunk.toString("utf8");
			});
			child.stderr.on("data", (chunk: Buffer) => {
				stderrText += chunk.toString("utf8");
			});

			child.on("error", (spawnError: Error) => {
				settle({
					outputText: `启动 ${this.claudeExecutablePath} 失败：${spawnError.message}`,
					stopReason: "error",
				});
			});

			child.on("close", (exitCode) => {
				if (stopReasonOverride !== null) {
					settle({
						outputText: stderrText.trim() === "" ? stdoutText : stderrText,
						stopReason: stopReasonOverride,
						forkedNativeSessionId: forkedSessionId,
					});
					return;
				}
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
				const failed = envelope.is_error === true || (exitCode !== 0 && exitCode !== null);
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
