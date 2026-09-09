// thread graph 的文件 store（handoff A.4 的文件布局）：
//   <storeRoot>/topic-registry.json
//   <storeRoot>/explorations/<explorationId>/exploration-thread-graph.json
//
// 骨架来自 cline-kanban 的 exploratory-session-map-store（串行写队列 / 原子写 / 损坏容错 /
// 路径遍历守卫 / 上限裁剪），实体换成本包的。**代码是复制重写的，不 import 那个仓库任何东西。**
//
// 并发纪律：写路径有**两层**互斥——进程内按 storeRoot 串行的写队列，以及 storeRoot 下的
// 跨进程锁文件（`O_CREAT|O_EXCL` + 陈旧回收）。两层缺一不可：裸用法把 maintain 挂在 Stop hook 上，
// 每次触发都是一个新的 CLI 进程，宿主进程也可能与 CLI 并存，光靠进程内队列会互相整份覆盖。
//
// 写入纪律：本模块只提供**写原语**，语义闸全在 apply 漏斗里。原语绝不静默裁剪叙事数据
// （threads / placements / edges / marks 一条都不丢）——只对 topic 注册表做上限裁剪，
// 因为它是可再生的策展索引而不是叙事本身。

import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { setTimeout as delayMilliseconds } from "node:timers/promises";
import {
	createEmptyExplorationThreadGraphCollection,
	createEmptyExplorationTopicRegistry,
	type ExplorationThreadGraphCollection,
	type ExplorationTopicRegistry,
	explorationThreadGraphCollectionSchema,
	explorationTopicRegistrySchema,
} from "./exploration-thread-graph-schema.js";

const TOPIC_REGISTRY_FILENAME = "topic-registry.json";
/** 跨进程写锁的文件名（每 storeRoot 一把，与进程内写队列同粒度）。 */
const STORE_WRITE_LOCK_FILENAME = "exploration-thread-graph-store-write.lock";
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

function isFileAlreadyExistsError(error: unknown): boolean {
	return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "EEXIST";
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

/**
 * 超过这个年龄的锁文件认定为「持有者已经死了」，可被回收。
 * 正常临界区只有两次读 + 两次原子写（毫秒级），这里留了三个数量级的余量。
 */
const STALE_STORE_WRITE_LOCK_RECLAIM_AFTER_MILLISECONDS = 15_000;
/** 等锁总时限。**故意比陈旧回收阈值长**，好让「持有者崩了」这种情形一定能在一次等待里自愈。 */
const STORE_WRITE_LOCK_ACQUIRE_TIMEOUT_MILLISECONDS = 20_000;
const STORE_WRITE_LOCK_ACQUIRE_RETRY_INTERVAL_MILLISECONDS = 20;

/** 锁文件的内容：只用来证明「这把锁是谁的」，陈旧判定走文件 mtime 而不是这里的时间戳。 */
interface StoreWriteLockOwnerDescriptor {
	storeWriteLockOwnerToken: string;
	ownerProcessId: number;
	acquiredAtMilliseconds: number;
}

/**
 * 跨进程写锁文件的位置。导出是给宿主用的：备份 / 体检 / 清理 storeRoot 时得认得这个文件，
 * 别把它当成图数据的一部分复制走。
 */
export function resolveExplorationThreadGraphStoreWriteLockPath(storeRoot: string): string {
	return join(resolve(storeRoot), STORE_WRITE_LOCK_FILENAME);
}

async function statFileAllowingAbsence(filePath: string) {
	try {
		return await stat(filePath);
	} catch {
		return undefined;
	}
}

async function readStoreWriteLockOwnerDescriptor(
	storeWriteLockPath: string,
): Promise<StoreWriteLockOwnerDescriptor | undefined> {
	let rawText: string;
	try {
		rawText = await readFile(storeWriteLockPath, "utf8");
	} catch {
		return undefined;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(rawText) as unknown;
	} catch {
		// 半写的锁文件（持有者在 open 与 write 之间被杀）：认不出主人就当不是自己的，交给陈旧回收。
		return undefined;
	}
	if (typeof parsed !== "object" || parsed === null) return undefined;
	const candidate = parsed as Partial<StoreWriteLockOwnerDescriptor>;
	if (typeof candidate.storeWriteLockOwnerToken !== "string") return undefined;
	if (typeof candidate.ownerProcessId !== "number" || typeof candidate.acquiredAtMilliseconds !== "number") {
		return undefined;
	}
	return {
		storeWriteLockOwnerToken: candidate.storeWriteLockOwnerToken,
		ownerProcessId: candidate.ownerProcessId,
		acquiredAtMilliseconds: candidate.acquiredAtMilliseconds,
	};
}

/** 回收陈旧锁：删之前再 stat 一次确认还是同一份，别把别人刚拿到的新锁删掉。 */
async function reclaimStoreWriteLockIfStale(storeWriteLockPath: string): Promise<void> {
	const observedStats = await statFileAllowingAbsence(storeWriteLockPath);
	if (observedStats === undefined) return;
	if (Date.now() - observedStats.mtimeMs <= STALE_STORE_WRITE_LOCK_RECLAIM_AFTER_MILLISECONDS) return;
	const confirmedStats = await statFileAllowingAbsence(storeWriteLockPath);
	if (confirmedStats === undefined || confirmedStats.mtimeMs !== observedStats.mtimeMs) return;
	try {
		await rm(storeWriteLockPath, { force: true });
	} catch {
		// 回收失败（别人先删了 / 权限不足）不是致命错，下一轮继续等。
	}
}

/**
 * 取跨进程写锁：`O_CREAT|O_EXCL` 建锁文件，抢不到就退避重试，遇到陈旧锁先回收。
 * 进程内写队列挡不住多进程——README 的裸用法每次 Stop hook 都是一个**新的 CLI 进程**，
 * 宿主也可能与 CLI 并存，没有这把锁就会两个进程各读旧值、后写的整份覆盖先写的。
 */
async function acquireCrossProcessStoreWriteLock(resolvedStoreRoot: string): Promise<string> {
	await mkdir(resolvedStoreRoot, { recursive: true });
	const storeWriteLockPath = resolveExplorationThreadGraphStoreWriteLockPath(resolvedStoreRoot);
	const storeWriteLockOwnerToken = `${process.pid}-${randomUUID()}`;
	const acquireDeadlineMilliseconds = Date.now() + STORE_WRITE_LOCK_ACQUIRE_TIMEOUT_MILLISECONDS;
	for (;;) {
		try {
			const lockFileHandle = await open(storeWriteLockPath, "wx");
			try {
				const ownerDescriptor: StoreWriteLockOwnerDescriptor = {
					storeWriteLockOwnerToken,
					ownerProcessId: process.pid,
					acquiredAtMilliseconds: Date.now(),
				};
				await lockFileHandle.writeFile(JSON.stringify(ownerDescriptor), "utf8");
			} finally {
				await lockFileHandle.close();
			}
			return storeWriteLockOwnerToken;
		} catch (error) {
			if (!isFileAlreadyExistsError(error)) throw error;
		}
		await reclaimStoreWriteLockIfStale(storeWriteLockPath);
		if (Date.now() >= acquireDeadlineMilliseconds) {
			throw new Error(
				`等不到 storeRoot 的跨进程写锁（已等 ${STORE_WRITE_LOCK_ACQUIRE_TIMEOUT_MILLISECONDS}ms）：${storeWriteLockPath}`,
			);
		}
		await delayMilliseconds(STORE_WRITE_LOCK_ACQUIRE_RETRY_INTERVAL_MILLISECONDS);
	}
}

/** 放锁：**只删自己的那把**。本进程的锁若已被别人当陈旧锁回收，此刻文件属于新持有者，删了就是拆别人的台。 */
async function releaseCrossProcessStoreWriteLock(
	resolvedStoreRoot: string,
	storeWriteLockOwnerToken: string,
): Promise<void> {
	const storeWriteLockPath = resolveExplorationThreadGraphStoreWriteLockPath(resolvedStoreRoot);
	const ownerDescriptor = await readStoreWriteLockOwnerDescriptor(storeWriteLockPath);
	if (ownerDescriptor?.storeWriteLockOwnerToken !== storeWriteLockOwnerToken) return;
	try {
		await rm(storeWriteLockPath, { force: true });
	} catch {
		// 删不掉只会让别人多等一个陈旧回收周期，不该让一次成功的写变成失败。
	}
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

/**
 * mutator 允许返回 Promise：调用方需要在**写锁内**重读外部来源（如 turn 序列来源）再决定写什么时，
 * 只有异步 mutator 才能把「重读 → 对账 → 落装」关进同一把 storeRoot 队列锁里。
 */
export type ExplorationThreadGraphStoreMutator = (
	snapshot: ExplorationThreadGraphStoreSnapshot,
) => ExplorationThreadGraphStoreSnapshot | null | Promise<ExplorationThreadGraphStoreSnapshot | null>;

/**
 * 唯一写原语：取跨进程写锁 → 读两份现状 → mutator → schema 校验 → topic 上限裁剪 → 原子写 → 放锁。
 * collection 与 topic 注册表在同一把 storeRoot 锁内一起落盘，因为漏斗会跨两者派生 id。
 *
 * 抢不到跨进程锁（默认等 20s）时**抛错**而不是硬写：宁可让调用方看到一次失败的 maintain，
 * 也不能悄悄把别的进程刚写下的整份图覆盖掉。读路径不受这把锁影响，依旧永不抛。
 */
export async function mutateExplorationThreadGraph(
	storeRoot: string,
	explorationId: string,
	mutator: ExplorationThreadGraphStoreMutator,
	now: number = Date.now(),
): Promise<ExplorationThreadGraphStoreSnapshot | null> {
	return await enqueueStoreRootWrite(storeRoot, async () => {
		const resolvedStoreRoot = resolve(storeRoot);
		const storeWriteLockOwnerToken = await acquireCrossProcessStoreWriteLock(resolvedStoreRoot);
		try {
			const currentCollection = await readExplorationThreadGraphCollection(storeRoot, explorationId, now);
			const currentTopicRegistry = await readExplorationTopicRegistry(storeRoot);
			const mutated = await mutator({ collection: currentCollection, topicRegistry: currentTopicRegistry });
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
		} finally {
			await releaseCrossProcessStoreWriteLock(resolvedStoreRoot, storeWriteLockOwnerToken);
		}
	});
}
