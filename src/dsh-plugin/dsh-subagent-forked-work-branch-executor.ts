// dsh 侧的 ForkedWorkBranchExecutor（handoff A.8 的 ②）：`ctx.subagents.start({ provider: "fork" })`。
//
// 这条路径正是 D5 想要的东西的原生形态——进程内 fork、以父会话已完成 turn 前缀为种子、
// 字节一致地复用 KV cache。Claude Code 那边因上游 bug #77306 拿不到 cache，dsh 这边不受影响。

import type {
	ForkedWorkBranchExecutor,
	ForkedWorkBranchRequest,
	ForkedWorkBranchResult,
	ForkedWorkBranchStopReason,
} from "../core/index.js";
import { readDshMessageText } from "./dsh-session-log-completed-turn-source.js";
import type { DshSubagentRegistry } from "./dsh-session-seam-contracts.js";

/** dsh 的 stopReason 词表与本包的四态对齐；认不出来的一律按 error，不猜。 */
function mapDshStopReason(dshStopReason: string): ForkedWorkBranchStopReason {
	switch (dshStopReason) {
		case "completed":
		case "end_turn":
		case "stop":
			return "completed";
		case "timeout":
			return "timeout";
		case "cancelled":
		case "canceled":
		case "aborted":
			return "cancelled";
		default:
			return "error";
	}
}

export interface DshSubagentForkedWorkBranchExecutorOptions {
	/** dsh 的 fork provider 名；默认 `fork`（即 subagent-fork-in-process）。 */
	subagentProviderName?: string;
}

export class DshSubagentForkedWorkBranchExecutor implements ForkedWorkBranchExecutor {
	private readonly subagentProviderName: string;

	constructor(
		private readonly subagents: DshSubagentRegistry,
		options: DshSubagentForkedWorkBranchExecutorOptions = {},
	) {
		this.subagentProviderName = options.subagentProviderName ?? "fork";
	}

	async start(request: ForkedWorkBranchRequest): Promise<ForkedWorkBranchResult> {
		if (request.parentSession.harnessKind !== "dsh") {
			throw new Error(
				`DshSubagentForkedWorkBranchExecutor 只处理 dsh 会话，收到 ${request.parentSession.harnessKind}`,
			);
		}
		// timeoutMs 是 ForkedWorkBranchRequest 对**所有** harness 的承诺（Claude Code 那侧靠 SIGTERM 兑现）。
		// dsh 的 provider 只是一个 Promise：它若永不 settle，维护作业就永久挂住，
		// 所以这里既要自己竞速兜底回 timeout，也要把取消信号真的送到 provider（而不是丢下它继续跑）。
		const subagentAbortController = new AbortController();
		const forwardCallerAbortToSubagent = (): void => {
			subagentAbortController.abort();
		};
		if (request.signal !== undefined) {
			if (request.signal.aborted) subagentAbortController.abort();
			else request.signal.addEventListener("abort", forwardCallerAbortToSubagent, { once: true });
		}

		let subagentStartTimeoutHandle: ReturnType<typeof setTimeout> | undefined;
		const subagentStartPromise = this.startSubagentAndMapResult(request, subagentAbortController.signal);
		// 超时先 settle 之后 provider 才失败时，这条 rejection 已经没人接：先接住，免得炸成 unhandledRejection。
		subagentStartPromise.catch(() => {});
		const timeoutFallbackPromise = new Promise<ForkedWorkBranchResult>((resolve) => {
			subagentStartTimeoutHandle = setTimeout(() => {
				subagentAbortController.abort();
				resolve({
					outputText: `dsh 子代理在 ${request.timeoutMs}ms 内没有回结果，已按超时终止并向 provider 发出取消信号`,
					stopReason: "timeout",
				});
			}, request.timeoutMs);
		});

		try {
			return await Promise.race([subagentStartPromise, timeoutFallbackPromise]);
		} finally {
			clearTimeout(subagentStartTimeoutHandle);
			request.signal?.removeEventListener("abort", forwardCallerAbortToSubagent);
		}
	}

	private async startSubagentAndMapResult(
		request: ForkedWorkBranchRequest,
		subagentAbortSignal: AbortSignal,
	): Promise<ForkedWorkBranchResult> {
		const subagentResult = await this.subagents.start({
			provider: this.subagentProviderName,
			parent: request.parentSession.nativeSessionId,
			prompt: request.promptText,
			outputSchema: request.outputSchema,
			signal: subagentAbortSignal,
		});
		const outputText = readDshMessageText(subagentResult.output);
		return {
			...(subagentResult.structured !== undefined ? { structured: subagentResult.structured } : {}),
			outputText,
			stopReason: mapDshStopReason(subagentResult.stopReason),
			usage: {
				inputTokens: subagentResult.usage?.inputTokens ?? 0,
				cacheReadInputTokens: subagentResult.usage?.cacheReadInputTokens ?? 0,
				outputTokens: subagentResult.usage?.outputTokens ?? 0,
			},
			...(subagentResult.id !== undefined ? { forkedNativeSessionId: subagentResult.id } : {}),
		};
	}
}
