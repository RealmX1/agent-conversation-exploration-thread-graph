// Darwin 用原生身份及 NUL 边界环境核验归属；只返回资格事实，不输出任何环境原文。
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdtemp, rm, stat, statfs, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const nativeExecutionOwnershipSource = String.raw`
#include <libproc.h>
#include <sys/proc_info.h>
#include <sys/sysctl.h>
#include <unistd.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
// 与内核 proc_pidinfo flavor 17 的原生布局逐字段对应；长度不符时保留未知。
struct DarwinProcessUniqueIdentity {
 uint8_t executable_uuid[16]; uint64_t unique_process_id; uint64_t parent_unique_process_id;
 int32_t process_id_version; int32_t original_parent_process_id_version;
 uint64_t reserved_two; uint64_t reserved_three;
};
_Static_assert(sizeof(struct DarwinProcessUniqueIdentity)==56,"unexpected native identity layout");
const int DARWIN_PROCESS_UNIQUE_IDENTITY_FLAVOR=17;
// 环境元素必须保持 NUL 边界；别的字段值包含 key 文本不构成归属。
int read_environment_ownership(int pid, const char *token) {
 int limit_query[2]={CTL_KERN,KERN_ARGMAX}, limit=0;
 size_t limit_size=sizeof(limit);
 if(sysctl(limit_query,2,&limit,&limit_size,NULL,0)!=0 || limit<=0)return -1;
 char *bytes=malloc((size_t)limit);
 if(!bytes)return -1;
 int query[3]={CTL_KERN,KERN_PROCARGS2,pid};
 size_t length=(size_t)limit;
 int result=-1;
 if(sysctl(query,3,bytes,&length,NULL,0)!=0 || length<sizeof(int))goto finish;
 int argument_count=0;
 memcpy(&argument_count,bytes,sizeof(argument_count));
 if(argument_count<1)goto finish;
 char *cursor=bytes+sizeof(argument_count), *end=bytes+length;
 char *boundary=memchr(cursor,0,(size_t)(end-cursor));
 if(!boundary)goto finish;
 cursor=boundary+1;
 while(cursor<end && *cursor==0)cursor++;
 for(int index=0;index<argument_count;index++) {
  if(cursor>=end)goto finish;
  boundary=memchr(cursor,0,(size_t)(end-cursor));
  if(!boundary)goto finish;
  cursor=boundary+1;
 }
 result=0;
 const char *key="AGENT_CONVERSATION_EXPLORATION_WORK_BRANCH_EXECUTION_OWNERSHIP_TOKENS=";
 size_t key_length=strlen(key), token_length=strlen(token);
 while(cursor<end && *cursor!=0) {
  boundary=memchr(cursor,0,(size_t)(end-cursor));
  if(!boundary){result=-1;goto finish;}
  if((size_t)(boundary-cursor)>=key_length && memcmp(cursor,key,key_length)==0) {
   char *value=cursor+key_length;
   while(value<=boundary) {
    char *separator=memchr(value,':',(size_t)(boundary-value));
    char *value_end=separator?separator:boundary;
    if((size_t)(value_end-value)==token_length && memcmp(value,token,token_length)==0){result=1;goto finish;}
    if(!separator)break;
    value=separator+1;
   }
  }
  cursor=boundary+1;
 }
 finish: free(bytes);return result;
}
int main(int argc, char **argv) {
 if(argc<2)return 1;
 const char *token=argv[1];
 struct DarwinProcessUniqueIdentity launchd;
 memset(&launchd,0,sizeof(launchd));
 int launchd_known=proc_pidinfo(1,DARWIN_PROCESS_UNIQUE_IDENTITY_FLAVOR,0,&launchd,sizeof(launchd))==sizeof(launchd);
 printf("[");
 for(int index=2;index<argc;index++) {
  int pid=atoi(argv[index]);
  struct proc_bsdinfo process;
  struct DarwinProcessUniqueIdentity unique;
  memset(&process,0,sizeof(process)); memset(&unique,0,sizeof(unique));
  int process_known=proc_pidinfo(pid,PROC_PIDTBSDINFO,0,&process,sizeof(process))==sizeof(process);
  int unique_known=proc_pidinfo(pid,DARWIN_PROCESS_UNIQUE_IDENTITY_FLAVOR,0,&unique,sizeof(unique))==sizeof(unique);
  if(index>2)printf(",");
  int environment_ownership=read_environment_ownership(pid,token);
  printf("{\"pid\":%d,\"outsideCurrentUser\":%s,\"launchedByServiceManager\":%s,\"hasExecutionOwnershipToken\":%s}",pid,
   process_known && process.pbi_uid!=getuid()?"true":"false",
   unique_known && launchd_known && unique.original_parent_process_id_version==launchd.process_id_version?"true":"false",
   environment_ownership<0?"null":environment_ownership?"true":"false");
 }
 printf("]\n"); return 0;
}
`;
let compiledHelper: { identity: string; executable: Promise<string>; failedStorageIdentity?: string } | null = null;

async function storageRecoveryIdentity(): Promise<string> {
	const directory = await stat(tmpdir()).catch(() => null);
	const space = await statfs(tmpdir()).catch(() => null);
	return JSON.stringify({
		path: tmpdir(),
		inode: directory?.ino,
		mode: directory?.mode,
		availableBlocks: space?.bavail,
	});
}

async function helperExecutable(): Promise<string> {
	const compilerMetadata = await stat("/usr/bin/cc").catch(() => null);
	const developerToolsMetadata = await stat("/Library/Developer/CommandLineTools/usr/bin/cc").catch(() => null);
	const identity = createHash("sha256")
		.update(
			JSON.stringify({
				compiler: [compilerMetadata?.mtimeMs, compilerMetadata?.ctimeMs, compilerMetadata?.mode],
				developerTools: [
					developerToolsMetadata?.mtimeMs,
					developerToolsMetadata?.ctimeMs,
					developerToolsMetadata?.mode,
				],
				developerDirectory: process.env.DEVELOPER_DIR,
				source: nativeExecutionOwnershipSource,
			}),
		)
		.digest("hex");
	if (compiledHelper?.identity === identity) {
		try {
			const executable = await compiledHelper.executable;
			if (
				await access(executable).then(
					() => true,
					() => false,
				)
			)
				return executable;
		} catch (error) {
			if (compiledHelper.failedStorageIdentity === (await storageRecoveryIdentity())) throw error;
		}
		compiledHelper = null;
	}

	const executable = (async () => {
		let directory: string | undefined;
		try {
			// 临时文件仅是可再生的本机原生缓存；交接所需源码始终在本模块中。
			directory = await mkdtemp(join(tmpdir(), "exploration-fork-process-execution-ownership-"));
			const source = join(directory, "darwin-process-execution-ownership.c");
			const target = join(directory, "darwin-process-execution-ownership");
			await writeFile(source, nativeExecutionOwnershipSource, { mode: 0o600 });
			await execFileAsync("/usr/bin/cc", ["-O2", source, "-o", target], { timeout: 15_000 });
			return target;
		} catch (error) {
			if (directory) await rm(directory, { recursive: true, force: true }).catch(() => {});
			if (compiledHelper?.identity === identity)
				compiledHelper.failedStorageIdentity = await storageRecoveryIdentity();
			throw error;
		}
	})();
	compiledHelper = { identity, executable };
	return await executable;
}

export interface NativeProcessExecutionOwnershipObservation {
	outsideCurrentUser: boolean;
	launchedByServiceManager: boolean;
	hasExecutionOwnershipToken: boolean | null;
}

export async function readDarwinProcessExecutionOwnershipObservations(
	processPids: number[],
	executionOwnershipToken: string,
): Promise<Map<number, NativeProcessExecutionOwnershipObservation>> {
	if (process.platform !== "darwin" || processPids.length === 0) return new Map();
	try {
		const { stdout } = await execFileAsync(
			await helperExecutable(),
			[executionOwnershipToken, ...processPids.map(String)],
			{
				timeout: 1_000,
				maxBuffer: 1024 * 1024,
			},
		);
		const records: unknown = JSON.parse(stdout);
		if (!Array.isArray(records)) return new Map();
		return new Map(
			records
				.filter(
					(entry): entry is { pid: number } & NativeProcessExecutionOwnershipObservation =>
						typeof entry === "object" &&
						entry !== null &&
						Number.isSafeInteger(entry.pid) &&
						entry.pid > 0 &&
						typeof entry.outsideCurrentUser === "boolean" &&
						typeof entry.launchedByServiceManager === "boolean" &&
						(typeof entry.hasExecutionOwnershipToken === "boolean" || entry.hasExecutionOwnershipToken === null),
				)
				.map(({ pid, ...origin }) => [pid, origin]),
		);
	} catch {
		// 编译或原生查询不可用时不排除任何未知孤儿，后续工具或进程证据变化后重验。
		return new Map();
	}
}
