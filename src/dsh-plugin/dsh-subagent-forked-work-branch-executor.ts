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
		if (request.signal?.aborted) {
			return { outputText: "派发前已取消", stopReason: "cancelled", cancellationConfirmation: "not_started" };
		}
		const subagentAbortController = new AbortController();
		let cancellationGraceTimer: ReturnType<typeof setTimeout> | undefined;
		let resolveUnconfirmedCancellation: (result: ForkedWorkBranchResult) => void = () => {};
		const cancellationPromise = new Promise<ForkedWorkBranchResult>((resolve) => {
			resolveUnconfirmedCancellation = resolve;
		});
		const forwardCallerAbortToSubagent = (): void => {
			subagentAbortController.abort();
			// 只限制取消确认的等待；provider 没确认时明确保留未知。
			cancellationGraceTimer = setTimeout(
				() =>
					resolveUnconfirmedCancellation({
						outputText: "已向 provider 请求取消，尚未取得停止确认",
						stopReason: "cancelled",
						cancellationConfirmation: "unknown",
					}),
				5_000,
			);
		};
		request.signal?.addEventListener("abort", forwardCallerAbortToSubagent, { once: true });
		try {
			return await Promise.race([
				this.startSubagentAndMapResult(request, subagentAbortController.signal)
					.then((result) =>
						subagentAbortController.signal.aborted
							? {
									outputText: result.outputText,
									stopReason: "cancelled" as const,
									cancellationConfirmation: "confirmed" as const,
									...(result.forkedNativeSessionId
										? { forkedNativeSessionId: result.forkedNativeSessionId }
										: {}),
								}
							: result,
					)
					.catch(
						(error: unknown): ForkedWorkBranchResult => ({
							outputText: error instanceof Error ? error.message : String(error),
							stopReason: subagentAbortController.signal.aborted ? "cancelled" : "error",
							...(subagentAbortController.signal.aborted
								? { cancellationConfirmation: "unknown" as const }
								: {}),
						}),
					),
				cancellationPromise,
			]);
		} finally {
			clearTimeout(cancellationGraceTimer);
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
