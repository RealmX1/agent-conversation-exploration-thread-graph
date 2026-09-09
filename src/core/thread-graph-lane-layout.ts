// 纯 lane 布局（handoff A.3）：把「行 + parentIds」摊成 git-graph 的泳道占位。
//
// 算法移植自 cline-kanban 的 git-commit-list-panel `buildGraph`（**代码重写，不 import 那个仓库**）；
// 那边的 `GraphSvg` 是 React 渲染，不搬——本模块只出几何数据，画线交给宿主 UI。
//
// 行序约定：**必须新→旧**（与 `git log` 一致），因为算法用「lane 记着自己还在等哪个 id」向下推进。
// projection view 会把按时间升序的 turn 反过来再喂进来。

/** 一行的输入：id 唯一，parentIds 指向更早的行（可多条 = 合流）。 */
export interface ThreadGraphLaneLayoutInputRow {
	id: string;
	parentIds: string[];
}

export interface ThreadGraphLaneLayoutRow {
	id: string;
	/** 本行的节点画在第几条泳道上。 */
	rowLane: number;
	/** 本行绘制时刻各泳道正在等待的行 id（下标即泳道号）。 */
	laneWaitingForIds: string[];
	/** 需要从这些泳道画合流线到本行节点（多 parent）。 */
	mergeFromLanes: number[];
	/** 本行是某条泳道的分叉起点时，分叉自哪条泳道。 */
	splitFromLane: number | null;
	/** 本行是否开启了一条新泳道（此前没有泳道在等它）。 */
	rowStartsLane: boolean;
	isFirstRow: boolean;
}

export function layoutThreadGraphLanes(rows: readonly ThreadGraphLaneLayoutInputRow[]): ThreadGraphLaneLayoutRow[] {
	const layoutRows: ThreadGraphLaneLayoutRow[] = [];
	let laneWaitingForIds: string[] = [];

	for (const [rowIndex, row] of rows.entries()) {
		let rowStartsLane = false;
		let rowLane = laneWaitingForIds.indexOf(row.id);
		if (rowLane === -1) {
			// 没有泳道在等它 ⇒ 它是某条线的最新一行，开一条新泳道。
			rowStartsLane = true;
			rowLane = laneWaitingForIds.length;
			laneWaitingForIds.push(row.id);
		}

		const laneWaitingForIdsAtThisRow = [...laneWaitingForIds];
		const mergeFromLanes: number[] = [];

		const [firstParentId, ...otherParentIds] = row.parentIds;
		let splitFromLane: number | null = null;
		const firstParentLane = firstParentId === undefined ? -1 : laneWaitingForIdsAtThisRow.indexOf(firstParentId);
		if (rowLane === laneWaitingForIdsAtThisRow.length - 1 && firstParentLane !== -1 && firstParentLane !== rowLane) {
			// 本行占的是最右侧泳道，而它的第一 parent 已在别的泳道上 ⇒ 画一条分叉线过去。
			splitFromLane = firstParentLane;
		}

		if (firstParentId !== undefined) {
			laneWaitingForIds[rowLane] = firstParentId;
		} else {
			// 没有 parent ⇒ 这条线到此为止，泳道回收。
			laneWaitingForIds = laneWaitingForIds.filter((_, laneIndex) => laneIndex !== rowLane);
		}

		for (const otherParentId of otherParentIds) {
			const existingLane = laneWaitingForIds.indexOf(otherParentId);
			if (existingLane !== -1) {
				mergeFromLanes.push(existingLane);
			} else {
				mergeFromLanes.push(laneWaitingForIds.length);
				laneWaitingForIds.push(otherParentId);
			}
		}

		// 同一个 parent 被多条泳道等待时只留最左一条，避免泳道无限增生。
		// 注：移植源还带一个 `convergingLanes`（同 id 的其余泳道），但正因为有这一步去重，
		// 任何时刻都不会有两条泳道等同一个 id，那个字段恒为空——所以本移植直接不导出它。
		laneWaitingForIds = laneWaitingForIds.filter(
			(waitingForId, laneIndex, currentLanes) => currentLanes.indexOf(waitingForId) === laneIndex,
		);

		layoutRows.push({
			id: row.id,
			rowLane,
			laneWaitingForIds: laneWaitingForIdsAtThisRow,
			mergeFromLanes,
			splitFromLane,
			rowStartsLane,
			isFirstRow: rowIndex === 0,
		});
	}

	return layoutRows;
}

/** 渲染层要预留多宽：所有行里出现过的最大泳道号 + 1。 */
export function countThreadGraphLanes(layoutRows: readonly ThreadGraphLaneLayoutRow[]): number {
	let widestLaneCount = 0;
	for (const layoutRow of layoutRows) {
		const rightmostLane = Math.max(
			layoutRow.rowLane,
			layoutRow.laneWaitingForIds.length - 1,
			...layoutRow.mergeFromLanes,
		);
		if (rightmostLane + 1 > widestLaneCount) widestLaneCount = rightmostLane + 1;
	}
	return widestLaneCount;
}
