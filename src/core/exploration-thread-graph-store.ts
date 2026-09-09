// thread graph 的文件 store（handoff A.4 的文件布局）：
//   <storeRoot>/topic-registry.json
//   <storeRoot>/explorations/<explorationId>/exploration-thread-graph.json
//
// 骨架来自 cline-kanban 的 exploratory-session-map-store（串行写队列 / 原子写 / 损坏容错 /
// 路径遍历守卫 / 上限裁剪），实体换成本包的。**代码是复制重写的，不 import 那个仓库任何东西。**
//
// 写入纪律：本模块只提供**写原语**，语义闸全在 apply 漏斗里。原语绝不静默裁剪叙事数据
// （threads / placements / edges / marks 一条都不丢）——只对 topic 注册表做上限裁剪，
// 因为它是可再生的策展索引而不是叙事本身。

import { mkdir, open, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import {
	createEmptyExplorationThreadGraphCollection,
	createEmptyExplorationTopicRegistry,
	type ExplorationThreadGraphCollection,
	type ExplorationTopicRegistry,
	explorationThreadGraphCollectionSchema,
	explorationTopicRegistrySchema,
} from "./exploration-thread-graph-schema.js";

const TOPIC_REGISTRY_FILENAME = "topic-registry.json";
const EXPLORATIONS_DIRECTORY_NAME = "explorations";
const EXPLORATION_THREAD_GRAPH_FILENAME = "exploration-thread-graph.json";

/** topic 注册表的条目上限（每 storeRoot）：超限丢最旧 updatedAt 的 topic。 */
const MAX_TOPICS_PER_TOPIC_REGISTRY = 2000;

/**
 * explorationId 直接参与路径拼接，而它来自宿主（cline-kanban 传的是 workspaceTaskId，
 * 裸 CLI 下更是来自命令行），所以这条守卫是必需的、不是形式主义。
 */
function assertExplorationIdIsSafePathSegment(explorationId: string): void {
	const looksUnsafe =
		explorationId.length === 0 ||
		explorationId.length > 200 ||
		explorationId === "." ||
		explorationId === ".." ||
		explorationId.includes("/") ||
		explorationId.includes("\\") ||
		explorationId.includes("\0");
	if (looksUnsafe) {
		throw new Error(`explorationId 不是合法的单层路径片段，拒绝访问：${JSON.stringify(explorationId)}`);
	}
}

export function resolveExplorationTopicRegistryPath(storeRoot: string): string {
	return join(resolve(storeRoot), TOPIC_REGISTRY_FILENAME);
}

export function resolveExplorationThreadGraphCollectionPath(storeRoot: string, explorationId: string): string {
	assertExplorationIdIsSafePathSegment(explorationId);
	const resolvedStoreRoot = resolve(storeRoot);
	const collectionPath = join(
		resolvedStoreRoot,
		EXPLORATIONS_DIRECTORY_NAME,
		explorationId,
		EXPLORATION_THREAD_GRAPH_FILENAME,
	);
	// 双保险：即便上面的片段检查被将来的改动绕过，也不允许走出 storeRoot。
	if (!collectionPath.startsWith(resolvedStoreRoot + sep)) {
		throw new Error(`拒绝访问 storeRoot 之外的路径：${collectionPath}`);
	}
	return collectionPath;
}

function isFileNotFoundError(error: unknown): boolean {
	return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT";
}

async function readJsonFileAllowingAbsence(filePath: string): Promise<unknown | undefined> {
	let rawText: string;
	try {
		rawText = await readFile(filePath, "utf8");
	} catch (error) {
		if (isFileNotFoundError(error)) {
			return undefined;
		}
		throw error;
	}
	try {
		return JSON.parse(rawText) as unknown;
	} catch {
		// 损坏容错：一份坏文件不该炸掉整个读路径。代价是该 exploration 的图暂时不可见
		// （宿主降级为「尚未维护」），比「把半份坏数据当事实渲染」安全。
		return undefined;
	}
}

/**
 * durable-write-before-ack：先写同目录临时文件并 fsync，再 rename 覆盖。
 * rename 在同一文件系统上是原子的，所以读者永远看到完整的旧值或完整的新值。
 */
async function writeJsonFileAtomically(filePath: string, value: unknown): Promise<void> {
	await mkdir(dirname(filePath), { recursive: true });
	const temporaryFilePath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
	const serialized = `${JSON.stringify(value, null, "\t")}\n`;
	await writeFile(temporaryFilePath, serialized, "utf8");
	const temporaryFileHandle = await open(temporaryFilePath, "r+");
	try {
		await temporaryFileHandle.sync();
	} finally {
		await temporaryFileHandle.close();
	}
	await rename(temporaryFilePath, filePath);
}

// 写队列按 storeRoot 串行化：一个 storeRoot 下的 collection 与 topic 注册表要一起改
// （漏斗会复用 topic），串行化到同一把队列锁上才能保证「读现状 → 校验 → 落装」不被穿插。
const writeQueueByResolvedStoreRoot = new Map<string, Promise<unknown>>();

function enqueueStoreRootWrite<T>(storeRoot: string, operation: () => Promise<T>): Promise<T> {
	const resolvedStoreRoot = resolve(storeRoot);
	const previous = writeQueueByResolvedStoreRoot.get(resolvedStoreRoot) ?? Promise.resolve();
	const next = previous.then(operation, operation);
	writeQueueByResolvedStoreRoot.set(
		resolvedStoreRoot,
		next.catch(() => undefined),
	);
	return next;
}

export async function readExplorationThreadGraphCollection(
	storeRoot: string,
	explorationId: string,
	now: number = Date.now(),
): Promise<ExplorationThreadGraphCollection> {
	const parsedJson = await readJsonFileAllowingAbsence(
		resolveExplorationThreadGraphCollectionPath(storeRoot, explorationId),
	);
	if (parsedJson === undefined) {
		return createEmptyExplorationThreadGraphCollection(explorationId, now);
	}
	const parsed = explorationThreadGraphCollectionSchema.safeParse(parsedJson);
	if (!parsed.success) {
		return createEmptyExplorationThreadGraphCollection(explorationId, now);
	}
	// 文件里的 explorationId 与调用方要的不一致 = 这份文件不是它该在的位置，按缺失处理。
	if (parsed.data.explorationId !== explorationId) {
		return createEmptyExplorationThreadGraphCollection(explorationId, now);
	}
	return parsed.data;
}

export async function readExplorationTopicRegistry(storeRoot: string): Promise<ExplorationTopicRegistry> {
	const parsedJson = await readJsonFileAllowingAbsence(resolveExplorationTopicRegistryPath(storeRoot));
	if (parsedJson === undefined) {
		return createEmptyExplorationTopicRegistry();
	}
	const parsed = explorationTopicRegistrySchema.safeParse(parsedJson);
	return parsed.success ? parsed.data : createEmptyExplorationTopicRegistry();
}

function capTopicRegistry(topicRegistry: ExplorationTopicRegistry): ExplorationTopicRegistry {
	if (topicRegistry.topics.length <= MAX_TOPICS_PER_TOPIC_REGISTRY) {
		return topicRegistry;
	}
	const keptTopics = [...topicRegistry.topics]
		.sort((left, right) => right.updatedAt - left.updatedAt)
		.slice(0, MAX_TOPICS_PER_TOPIC_REGISTRY);
	return { ...topicRegistry, topics: keptTopics };
}

/** 一次 mutate 里同时看到的两份现状；mutator 返回 null 表示无操作（不写盘）。 */
export interface ExplorationThreadGraphStoreSnapshot {
	collection: ExplorationThreadGraphCollection;
	topicRegistry: ExplorationTopicRegistry;
}

export type ExplorationThreadGraphStoreMutator = (
	snapshot: ExplorationThreadGraphStoreSnapshot,
) => ExplorationThreadGraphStoreSnapshot | null;

/**
 * 唯一写原语：读两份现状 → mutator → schema 校验 → topic 上限裁剪 → 原子写。
 * collection 与 topic 注册表在同一把 storeRoot 队列锁内一起落盘，因为漏斗会跨两者派生 id。
 */
export async function mutateExplorationThreadGraph(
	storeRoot: string,
	explorationId: string,
	mutator: ExplorationThreadGraphStoreMutator,
	now: number = Date.now(),
): Promise<ExplorationThreadGraphStoreSnapshot | null> {
	return await enqueueStoreRootWrite(storeRoot, async () => {
		const currentCollection = await readExplorationThreadGraphCollection(storeRoot, explorationId, now);
		const currentTopicRegistry = await readExplorationTopicRegistry(storeRoot);
		const mutated = mutator({ collection: currentCollection, topicRegistry: currentTopicRegistry });
		if (mutated === null) {
			return null;
		}
		const nextCollection = explorationThreadGraphCollectionSchema.parse(mutated.collection);
		const nextTopicRegistry = capTopicRegistry(explorationTopicRegistrySchema.parse(mutated.topicRegistry));
		await writeJsonFileAtomically(
			resolveExplorationThreadGraphCollectionPath(storeRoot, explorationId),
			nextCollection,
		);
		await writeJsonFileAtomically(resolveExplorationTopicRegistryPath(storeRoot), nextTopicRegistry);
		return { collection: nextCollection, topicRegistry: nextTopicRegistry };
	});
}
