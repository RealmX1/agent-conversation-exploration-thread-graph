import { describe, expect, it } from "vitest";
import { compareNativeProcessStartIdentities } from "../../src/harness-claude-code/index.js";

const observedIdentity = "870101 Thu Oct 29 20:00:00 2026";
const legacyRecordedIdentity = "870101 870999 Thu Oct 29 20:00:00 2026";

describe("宿主共享的进程出生身份比较接口", () => {
	it.each([
		{ scenario: "同一不透明值", observed: "opaque-identity", recorded: "opaque-identity", expected: "same" },
		{ scenario: "旧记录含不同 PGID", observed: observedIdentity, recorded: legacyRecordedIdentity, expected: "same" },
		{ scenario: "反向比较新旧格式", observed: legacyRecordedIdentity, recorded: observedIdentity, expected: "same" },
		{
			scenario: "PID 相同但出生时间变化",
			observed: "870101 Thu Oct 29 20:00:01 2026",
			recorded: legacyRecordedIdentity,
			expected: "different",
		},
		{
			scenario: "出生时间相同但 PID 变化",
			observed: "870102 Thu Oct 29 20:00:00 2026",
			recorded: legacyRecordedIdentity,
			expected: "different",
		},
		{ scenario: "完整快照中进程缺席", observed: undefined, recorded: legacyRecordedIdentity, expected: "different" },
		{ scenario: "持久身份缺失", observed: observedIdentity, recorded: undefined, expected: "unknown" },
		{ scenario: "不同值无法解析", observed: observedIdentity, recorded: "unrecognized-record", expected: "unknown" },
	])("$scenario 返回 $expected", ({ observed, recorded, expected }) => {
		expect(compareNativeProcessStartIdentities(observed, recorded)).toBe(expected);
	});
});
