// JSONL 的**有界 / 增量**读取原语（移植自 cline-kanban 的 bounded-agent-transcript-reader，
// 代码重写，不 import 那个仓库）。与「读它干什么」无关，只负责把字节还原成完整的 JSON 行。
//
// 「只推进到完整换行」是这里的全部要点：transcript 是实时追加的，任何时刻文件末尾都可能是半行。
// 把半行当成完整记录去解析，轻则丢一条 turn，重则把 turn 编号错位——而 turn 编号是本包的地基。

import { open, stat } from "node:fs/promises";

export interface BoundedJsonLinesReadResult {
	/** 本次读到的完整行（不含末尾那条尚未写完的半行）。 */
	completeLines: string[];
	/** 下次该从哪个字节开始读；恒指向某个换行符之后。 */
	nextByteOffset: number;
	fileSizeBytes: number;
	fileModifiedAtMilliseconds: number;
	/** 文件变小 = 被重写/截断，调用方必须丢弃已累积的状态从头再来。 */
	fileWasTruncated: boolean;
}

/** 单次增量读取的字节上限：挡住「离开一整天回来一次读 200MB」。 */
export const DEFAULT_MAX_INCREMENTAL_READ_BYTES = 32 * 1024 * 1024;

export async function readAppendedCompleteJsonLines(
	filePath: string,
	previousByteOffset: number,
	maxIncrementalReadBytes: number = DEFAULT_MAX_INCREMENTAL_READ_BYTES,
): Promise<BoundedJsonLinesReadResult> {
	const fileStats = await stat(filePath);
	const fileSizeBytes = fileStats.size;
	const fileModifiedAtMilliseconds = fileStats.mtimeMs;
	const fileWasTruncated = fileSizeBytes < previousByteOffset;
	const startByteOffset = fileWasTruncated ? 0 : previousByteOffset;

	if (fileSizeBytes <= startByteOffset) {
		return {
			completeLines: [],
			nextByteOffset: startByteOffset,
			fileSizeBytes,
			fileModifiedAtMilliseconds,
			fileWasTruncated,
		};
	}

	// 超预算时只读尾部，并把 offset 直接跳到读取起点——中间那段就此丢失，
	// 调用方据 fileWasTruncated / offset 跳变自行决定要不要整份重算。
	const availableByteCount = fileSizeBytes - startByteOffset;
	const readStartByteOffset =
		availableByteCount > maxIncrementalReadBytes ? fileSizeBytes - maxIncrementalReadBytes : startByteOffset;
	const readByteCount = fileSizeBytes - readStartByteOffset;

	const fileHandle = await open(filePath, "r");
	let buffer: Buffer;
	try {
		buffer = Buffer.allocUnsafe(readByteCount);
		const { bytesRead } = await fileHandle.read(buffer, 0, readByteCount, readStartByteOffset);
		buffer = buffer.subarray(0, bytesRead);
	} finally {
		await fileHandle.close();
	}

	// 只认最后一个换行符之前的内容；其后是尚未写完的半行，留给下次。
	const lastNewlineIndex = buffer.lastIndexOf(0x0a);
	if (lastNewlineIndex < 0) {
		return {
			completeLines: [],
			nextByteOffset: readStartByteOffset,
			fileSizeBytes,
			fileModifiedAtMilliseconds,
			fileWasTruncated,
		};
	}
	const completeText = buffer.subarray(0, lastNewlineIndex + 1).toString("utf8");
	return {
		completeLines: completeText.split(/\r?\n/u).filter((line) => line !== ""),
		nextByteOffset: readStartByteOffset + lastNewlineIndex + 1,
		fileSizeBytes,
		fileModifiedAtMilliseconds,
		fileWasTruncated,
	};
}

/** 一行 JSON → 记录对象；解析不了就跳过（transcript 格式漂移时降级而不是炸）。 */
export function parseTranscriptJsonRecord(line: string): Record<string, unknown> | null {
	try {
		const parsed = JSON.parse(line) as unknown;
		return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: null;
	} catch {
		return null;
	}
}

/**
 * Claude Code 写盘用的工作目录编码：`/Users/me/repo` → `-Users-me-repo`（**前导短横保留**）。
 * 要按工作目录定位 `~/.claude/projects/<这个名字>/` 时必须用它。
 */
export function encodeClaudeCodeProjectDirectoryName(workingDirectory: string): string {
	return workingDirectory.replace(/[^a-zA-Z0-9]/gu, "-");
}
