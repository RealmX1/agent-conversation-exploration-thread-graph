// 文件 store：路径守卫、缺失/损坏容错、原子写、串行写队列、topic 上限裁剪。

import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delayMilliseconds } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	mutateExplorationThreadGraph,
	readExplorationThreadGraphCollection,
	readExplorationTopicRegistry,
	resolveExplorationThreadGraphCollectionPath,
	resolveExplorationThreadGraphStoreWriteLockPath,
	resolveExplorationTopicRegistryPath,
} from "../../src/core/index.js";
import { buildThread, buildTopic, TEST_NOW_MILLISECONDS } from "../fixtures/exploration-thread-graph-test-doubles.js";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const storeModulePath = join(testDirectory, "..", "..", "src", "core", "exploration-thread-graph-store.ts");
const testDoublesModulePath = join(testDirectory, "..", "fixtures", "exploration-thread-graph-test-doubles.ts");

/**
 * 跨进程复现脚本：一个**独立 Node 进程**跑一次 mutate。
 * mutator 里先落「我已经读到现状」的标记文件，再同步停 holdMilliseconds 才返回新值——
 * 两个进程的「读现状 → 落盘」窗口因此必然重叠，进程内写队列对此毫无办法。
 */
function buildSingleMutateChildProcessScriptSource(): string {
	return [
		'import { writeFileSync } from "node:fs";',
		`import { mutateExplorationThreadGraph } from ${JSON.stringify(storeModulePath)};`,
		`import { buildThread } from ${JSON.stringify(testDoublesModulePath)};`,
		"const [storeRoot, explorationId, threadIdToAppend, enteredMutatorMarkerPath, holdMilliseconds] =",
		"\tprocess.argv.slice(2);",
		"await mutateExplorationThreadGraph(storeRoot, explorationId, (snapshot) => {",
		'\twriteFileSync(enteredMutatorMarkerPath, "已经读到现状", "utf8");',
		"\tAtomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(holdMilliseconds));",
		"\treturn {",
		"\t\tcollection: {",
		"\t\t\t...snapshot.collection,",
		"\t\t\tthreads: [...snapshot.collection.threads, buildThread(threadIdToAppend)],",
		"\t\t},",
		"\t\ttopicRegistry: snapshot.topicRegistry,",
		"\t};",
		"});",
		"",
	].join("\n");
}

/** 起一个跑 tsx 的子进程做一次 mutate；返回它的退出码与 stderr，好把子进程的失败照实报出来。 */
function spawnSingleMutateChildProcess(
	scriptPath: string,
	scriptArguments: readonly string[],
): Promise<{ exitCode: number | null; standardErrorText: string }> {
	const child = spawn(process.execPath, ["--import", "tsx", scriptPath, ...scriptArguments], {
		stdio: ["ignore", "ignore", "pipe"],
	});
	let standardErrorText = "";
	child.stderr.on("data", (chunk: Buffer) => {
		standardErrorText += chunk.toString("utf8");
	});
	return new Promise((resolvePromise) => {
		child.on("close", (exitCode) => resolvePromise({ exitCode, standardErrorText }));
	});
}

async function waitUntilFileExists(filePath: string, timeoutMilliseconds: number): Promise<void> {
	const deadline = Date.now() + timeoutMilliseconds;
	while (Date.now() < deadline) {
		try {
			await access(filePath);
			return;
		} catch {
			await delayMilliseconds(10);
		}
	}
	throw new Error(`等不到标记文件出现：${filePath}`);
}

let storeRoot = "";

beforeEach(async () => {
	storeRoot = await mkdtemp(join(tmpdir(), "exploration-thread-graph-store-test-"));
});

afterEach(async () => {
	await rm(storeRoot, { recursive: true, force: true });
});

describe("thread graph 文件 store", () => {
	it("explorationId 想走出 storeRoot 时直接拒绝", () => {
		for (const maliciousExplorationId of ["../escape", "a/b", "..", ".", "", "with\0null"]) {
			expect(() => resolveExplorationThreadGraphCollectionPath(storeRoot, maliciousExplorationId)).toThrow();
		}
		expect(resolveExplorationThreadGraphCollectionPath(storeRoot, "task-1")).toBe(
			join(storeRoot, "explorations", "task-1", "exploration-thread-graph.json"),
		);
	});

	it("文件不存在时返回空集合而不是抛错", async () => {
		const collection = await readExplorationThreadGraphCollection(storeRoot, "task-1", TEST_NOW_MILLISECONDS);
		expect(collection.explorationId).toBe("task-1");
		expect(collection.threads).toEqual([]);
		expect(await readExplorationTopicRegistry(storeRoot)).toMatchObject({ topics: [] });
	});

	it("文件损坏时降级为空集合，读路径不炸", async () => {
		const collectionPath = resolveExplorationThreadGraphCollectionPath(storeRoot, "task-1");
		await mkdir(join(storeRoot, "explorations", "task-1"), { recursive: true });
		await writeFile(collectionPath, "{ 这不是 JSON", "utf8");
		await writeFile(resolveExplorationTopicRegistryPath(storeRoot), '{"schemaVersion":1}', "utf8");
		expect((await readExplorationThreadGraphCollection(storeRoot, "task-1")).threads).toEqual([]);
		expect((await readExplorationTopicRegistry(storeRoot)).topics).toEqual([]);
	});

	it("文件里的 explorationId 与请求的不一致时按缺失处理", async () => {
		await mutateExplorationThreadGraph(storeRoot, "task-1", (snapshot) => snapshot, TEST_NOW_MILLISECONDS);
		const collectionPath = resolveExplorationThreadGraphCollectionPath(storeRoot, "task-1");
		const persisted = JSON.parse(await readFile(collectionPath, "utf8")) as Record<string, unknown>;
		await writeFile(collectionPath, JSON.stringify({ ...persisted, explorationId: "别的卡片" }), "utf8");
		expect((await readExplorationThreadGraphCollection(storeRoot, "task-1")).explorationId).toBe("task-1");
	});

	it("mutate 落盘后可读回，返回 null 表示无操作不写盘", async () => {
		const written = await mutateExplorationThreadGraph(
			storeRoot,
			"task-1",
			(snapshot) => ({
				collection: { ...snapshot.collection, threads: [buildThread("thread-1")] },
				topicRegistry: { ...snapshot.topicRegistry, topics: [buildTopic("topic-1", "起点")] },
			}),
			TEST_NOW_MILLISECONDS,
		);
		expect(written?.collection.threads).toHaveLength(1);
		expect((await readExplorationThreadGraphCollection(storeRoot, "task-1")).threads[0]?.threadId).toBe("thread-1");
		expect((await readExplorationTopicRegistry(storeRoot)).topics[0]?.topicId).toBe("topic-1");

		const noOperationResult = await mutateExplorationThreadGraph(storeRoot, "task-1", () => null);
		expect(noOperationResult).toBeNull();
		expect((await readExplorationThreadGraphCollection(storeRoot, "task-1")).threads).toHaveLength(1);
	});

	it("并发 mutate 被串行化，不会互相丢写", async () => {
		await Promise.all(
			Array.from({ length: 12 }, (_unused, index) =>
				mutateExplorationThreadGraph(
					storeRoot,
					"task-1",
					(snapshot) => ({
						collection: {
							...snapshot.collection,
							threads: [...snapshot.collection.threads, buildThread(`thread-${index + 1}`)],
						},
						topicRegistry: snapshot.topicRegistry,
					}),
					TEST_NOW_MILLISECONDS,
				),
			),
		);
		const collection = await readExplorationThreadGraphCollection(storeRoot, "task-1");
		expect(collection.threads).toHaveLength(12);
		expect(new Set(collection.threads.map((thread) => thread.threadId)).size).toBe(12);
	});

	it("两个进程并发 mutate 同一 storeRoot 时不丢写", async () => {
		const scriptPath = join(storeRoot, "single-mutate-child-process.mjs");
		await writeFile(scriptPath, buildSingleMutateChildProcessScriptSource(), "utf8");
		const firstProcessEnteredMutatorMarkerPath = join(storeRoot, "first-process-entered-mutator.marker");

		// 先起的进程在 mutator 里赖着 800ms 不返回；后起的进程要等它**读完现状**才出发，
		// 这样「两个进程都基于同一份旧值算新值」在没有跨进程锁时是必然发生、而不是碰运气。
		const firstProcess = spawnSingleMutateChildProcess(scriptPath, [
			storeRoot,
			"task-1",
			"thread-1",
			firstProcessEnteredMutatorMarkerPath,
			"800",
		]);
		await waitUntilFileExists(firstProcessEnteredMutatorMarkerPath, 10_000);
		const secondProcess = spawnSingleMutateChildProcess(scriptPath, [
			storeRoot,
			"task-1",
			"thread-2",
			join(storeRoot, "second-process-entered-mutator.marker"),
			"0",
		]);

		const [firstResult, secondResult] = await Promise.all([firstProcess, secondProcess]);
		expect(firstResult, firstResult.standardErrorText).toMatchObject({ exitCode: 0 });
		expect(secondResult, secondResult.standardErrorText).toMatchObject({ exitCode: 0 });

		const collection = await readExplorationThreadGraphCollection(storeRoot, "task-1");
		expect(collection.threads.map((thread) => thread.threadId).sort()).toEqual(["thread-1", "thread-2"]);
		// 两个进程都正常收尾 ⇒ 锁文件不该留在 storeRoot 里。
		await expect(access(resolveExplorationThreadGraphStoreWriteLockPath(storeRoot))).rejects.toThrow();
	}, 30_000);

	it("陈旧锁被回收，持有者崩掉不会把 storeRoot 永久锁死", async () => {
		const storeWriteLockPath = resolveExplorationThreadGraphStoreWriteLockPath(storeRoot);
		await writeFile(
			storeWriteLockPath,
			JSON.stringify({ storeWriteLockOwnerToken: "已经死掉的进程", ownerProcessId: 1, acquiredAtMilliseconds: 0 }),
			"utf8",
		);
		// 把 mtime 拨回一小时前：陈旧判定看的是文件 mtime，不是锁文件里写的时间戳。
		const oneHourAgoSeconds = Date.now() / 1000 - 3600;
		await utimes(storeWriteLockPath, oneHourAgoSeconds, oneHourAgoSeconds);

		const written = await mutateExplorationThreadGraph(storeRoot, "task-1", (snapshot) => ({
			collection: { ...snapshot.collection, threads: [buildThread("thread-1")] },
			topicRegistry: snapshot.topicRegistry,
		}));
		expect(written?.collection.threads).toHaveLength(1);
		await expect(access(storeWriteLockPath)).rejects.toThrow();
	});

	it("mutator 抛错时锁照样释放，后续 mutate 不被挡住", async () => {
		await expect(
			mutateExplorationThreadGraph(storeRoot, "task-1", () => {
				throw new Error("mutator 自己炸了");
			}),
		).rejects.toThrow("mutator 自己炸了");
		await expect(access(resolveExplorationThreadGraphStoreWriteLockPath(storeRoot))).rejects.toThrow();

		const written = await mutateExplorationThreadGraph(storeRoot, "task-1", (snapshot) => ({
			collection: { ...snapshot.collection, threads: [buildThread("thread-1")] },
			topicRegistry: snapshot.topicRegistry,
		}));
		expect(written?.collection.threads).toHaveLength(1);
	});

	it("落盘内容不合 schema 时 mutate 抛错，坏值进不了文件", async () => {
		await expect(
			mutateExplorationThreadGraph(storeRoot, "task-1", (snapshot) => ({
				collection: {
					...snapshot.collection,
					threads: [buildThread("这不是合法的 threadId 形状")],
				},
				topicRegistry: snapshot.topicRegistry,
			})),
		).rejects.toThrow();
		expect((await readExplorationThreadGraphCollection(storeRoot, "task-1")).threads).toEqual([]);
	});

	it("topic 注册表超过上限时丢最旧的 updatedAt", async () => {
		const overCapTopicCount = 2001;
		const written = await mutateExplorationThreadGraph(
			storeRoot,
			"task-1",
			(snapshot) => ({
				collection: snapshot.collection,
				topicRegistry: {
					...snapshot.topicRegistry,
					topics: Array.from({ length: overCapTopicCount }, (_unused, index) => ({
						...buildTopic(`topic-${index + 1}`, `题 ${index + 1}`),
						updatedAt: index,
					})),
				},
			}),
			TEST_NOW_MILLISECONDS,
		);
		expect(written?.topicRegistry.topics).toHaveLength(2000);
		// updatedAt 最小的那条（index 0）被裁掉。
		expect(written?.topicRegistry.topics.some((topic) => topic.topicId === "topic-1")).toBe(false);
		expect(written?.topicRegistry.topics.some((topic) => topic.topicId === "topic-2001")).toBe(true);
	});
});
