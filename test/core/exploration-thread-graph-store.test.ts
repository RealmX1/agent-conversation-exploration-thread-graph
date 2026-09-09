// 文件 store：路径守卫、缺失/损坏容错、原子写、串行写队列、topic 上限裁剪。

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	mutateExplorationThreadGraph,
	readExplorationThreadGraphCollection,
	readExplorationTopicRegistry,
	resolveExplorationThreadGraphCollectionPath,
	resolveExplorationTopicRegistryPath,
} from "../../src/core/index.js";
import { buildThread, buildTopic, TEST_NOW_MILLISECONDS } from "../fixtures/exploration-thread-graph-test-doubles.js";

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
