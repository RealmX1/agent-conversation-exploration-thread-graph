// lane 布局：行序恒为新→旧（git log 语义），断言分叉、合流与多 parent。

import { describe, expect, it } from "vitest";
import { countThreadGraphLanes, layoutThreadGraphLanes } from "../../src/core/index.js";

describe("lane 布局", () => {
	it("线性历史全部落在 0 号泳道", () => {
		const layoutRows = layoutThreadGraphLanes([
			{ id: "t3", parentIds: ["t2"] },
			{ id: "t2", parentIds: ["t1"] },
			{ id: "t1", parentIds: [] },
		]);
		expect(layoutRows.map((row) => row.rowLane)).toEqual([0, 0, 0]);
		expect(countThreadGraphLanes(layoutRows)).toBe(1);
		expect(layoutRows[0]?.isFirstRow).toBe(true);
		expect(layoutRows[0]?.rowStartsLane).toBe(true);
	});

	it("两条并行分支各占一条泳道，合流点记下 mergeFromLanes", () => {
		// t4 合并了 t3（主线）与 t2b（旁支）；t2b 从 t1 分出来。
		const layoutRows = layoutThreadGraphLanes([
			{ id: "t4", parentIds: ["t3", "t2b"] },
			{ id: "t3", parentIds: ["t1"] },
			{ id: "t2b", parentIds: ["t1"] },
			{ id: "t1", parentIds: [] },
		]);
		const mergeRow = layoutRows[0];
		expect(mergeRow?.id).toBe("t4");
		expect(mergeRow?.mergeFromLanes.length).toBe(1);
		expect(countThreadGraphLanes(layoutRows)).toBe(2);
		// 旁支行独占第 1 条泳道，主线仍在 0。
		expect(layoutRows.find((row) => row.id === "t3")?.rowLane).toBe(0);
		expect(layoutRows.find((row) => row.id === "t2b")?.rowLane).toBe(1);
		// 合流之后旁支泳道被回收：根行重新回到单泳道。
		expect(layoutRows.find((row) => row.id === "t1")?.laneWaitingForIds).toEqual(["t1"]);
	});

	it("一个 turn 指向三个更早 turn（D4 的多对一）时泳道不重复增生", () => {
		const layoutRows = layoutThreadGraphLanes([
			{ id: "t5", parentIds: ["t4", "t3", "t2"] },
			{ id: "t4", parentIds: ["t1"] },
			{ id: "t3", parentIds: ["t1"] },
			{ id: "t2", parentIds: ["t1"] },
			{ id: "t1", parentIds: [] },
		]);
		expect(layoutRows[0]?.mergeFromLanes).toEqual([1, 2]);
		expect(countThreadGraphLanes(layoutRows)).toBe(3);
		// 三条支线都以 t1 为 parent，去重后根行只剩一条泳道。
		expect(layoutRows.find((row) => row.id === "t1")?.laneWaitingForIds).toEqual(["t1"]);
	});

	it("空输入不炸", () => {
		expect(layoutThreadGraphLanes([])).toEqual([]);
		expect(countThreadGraphLanes([])).toBe(0);
	});
});
