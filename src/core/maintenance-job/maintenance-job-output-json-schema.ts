// proposal 的 JSON Schema（结构化输出契约）：由 zod 单向生成，**不手写第二份**。
// 手写会立刻与 maintenance-job-proposal-schema.ts 漂移，而漂移的表现是分身输出恒被闸 1 拒绝——
// 一个很难查的静默失败。生成器钉死用 zod v4 自带的 `z.toJSONSchema`（本包 zod 已是 ^4.3）。

import { z } from "zod";
import type { ObjectRootedJsonSchema } from "../forked-work-branch-executor.js";
import { explorationThreadGraphMaintenanceProposalSchema } from "./maintenance-job-proposal-schema.js";

/**
 * 生成分身要满足的 object-rooted JSON Schema。
 * 每次调用重新生成（schema 不大，且避免模块级缓存在测试间串味）。
 */
export function buildExplorationThreadGraphMaintenanceProposalJsonSchema(): ObjectRootedJsonSchema {
	const generated = z.toJSONSchema(explorationThreadGraphMaintenanceProposalSchema, {
		target: "draft-2020-12",
	}) as Record<string, unknown>;
	if (generated.type !== "object" || typeof generated.properties !== "object" || generated.properties === null) {
		throw new Error("proposal 的 JSON Schema 根类型必须是 object——执行器契约要求 object-rooted");
	}
	return generated as unknown as ObjectRootedJsonSchema;
}
