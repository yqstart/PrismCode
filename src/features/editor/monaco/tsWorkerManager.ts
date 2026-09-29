// ==================== Monaco TS/JS WorkerManager（本地替换） ====================
// 复制 monaco-editor 0.57 的 languages/features/typescript/workerManager.js，
// 由 vite.config.ts 的插件在解析时替换回 Monaco（dev 预构建与生产构建都覆盖）。
// 与上游只有三处差异：
// 1. keepIdleModels:false —— 空闲 model 一分钟内未被使用时停止同步，worker 不再长期留着它们；
// 2. 实例登记 —— 失焦或切换语言时能停掉指定 worker（上游只在配置变化时重启）；
// 3. 挂起开关 —— 挂起期间不创建 worker，语言服务调用返回空结果。
import type { LanguageServiceDefaults } from "monaco-editor/languages/features/typescript/register";
import { editor } from "monaco-editor/editor/editor.api.js";
import { createWebWorker, type WebWorkerClient } from "monaco-editor/internal/common/workers.js";
import { emptyLanguageResult, type LanguageWorkerMode } from "./languageBudget";

/** 语言服务客户端：方法按名调用，返回值交给 Monaco 的适配器 */
type LanguageServiceClient = Record<string, (...args: never[]) => unknown>;

/**
 * 跨模块实例共享的 worker 注册表。
 * dev 下 Monaco 走 optimizeDeps 预构建（本文件的代码被内联进 deps chunk），而应用与
 * 自检导入的是源码模块——两份模块实例必须共享状态，否则统计与挂起操作看不到
 * 预构建里创建的那些 worker（表现为计数恒为 0、失焦挂起无效）。
 */
interface WorkerRegistry {
 managers: Set<WorkerManager>;
 suspended: boolean;
}

const REGISTRY_KEY = "__prismCodeLanguageWorkers";

const workerRegistry: WorkerRegistry = (() => {
 const scope = globalThis as unknown as Record<string, WorkerRegistry | undefined>;
 const existing = scope[REGISTRY_KEY];
 if (existing) return existing;
 const created: WorkerRegistry = { managers: new Set(), suspended: false };
 scope[REGISTRY_KEY] = created;
 return created;
})();

/** 挂起期间的空代理：任何方法都解析为空结果，then 必须为 undefined 以免被当 thenable */
function createSuspendedClient(): LanguageServiceClient {
 return new Proxy({} as LanguageServiceClient, {
  get(_target, property) {
   if (property === "then") return undefined;
   return () => Promise.resolve(emptyLanguageResult(String(property)));
  },
 });
}

export class WorkerManager {
 private readonly _modeId: LanguageWorkerMode;
 private readonly _defaults: LanguageServiceDefaults;
 private _worker: WebWorkerClient | null = null;
 private _client: Promise<LanguageServiceClient> | null = null;
 private readonly _configChangeListener: { dispose(): void };
 private readonly _extraLibsChangeListener: { dispose(): void };
 private _updateExtraLibsToken = 0;

 constructor(modeId: LanguageWorkerMode, defaults: LanguageServiceDefaults) {
  this._modeId = modeId;
  this._defaults = defaults;
  this._configChangeListener = defaults.onDidChange(() => this._stopWorker());
  this._extraLibsChangeListener = defaults.onDidExtraLibsChange(() => {
   void this._updateExtraLibs();
  });
  workerRegistry.managers.add(this);
 }

 get modeId(): LanguageWorkerMode {
  return this._modeId;
 }

 get hasWorker(): boolean {
  return this._worker !== null;
 }

 /** 释放当前 worker（失焦挂起 / 切换语言时由外部调用；下次请求会按需重建） */
 stop(): void {
  this._stopWorker();
 }

 dispose(): void {
  workerRegistry.managers.delete(this);
  this._configChangeListener.dispose();
  this._extraLibsChangeListener.dispose();
  this._stopWorker();
 }

 private _stopWorker(): void {
  if (this._worker) {
   this._worker.dispose();
   this._worker = null;
  }
  this._client = null;
 }

 private async _updateExtraLibs(): Promise<void> {
  const worker = this._worker;
  if (!worker) return;
  const myToken = ++this._updateExtraLibsToken;
  const proxy = await worker.getProxy();
  if (this._updateExtraLibsToken !== myToken) return;
  const update = proxy.updateExtraLibs;
  if (typeof update === "function") {
   await (update as (libs: unknown) => Promise<void>)(this._defaults.getExtraLibs());
  }
 }

 private _getClient(): Promise<LanguageServiceClient> {
  if (workerRegistry.suspended) return Promise.resolve(createSuspendedClient());
  if (!this._client) {
   this._client = (async () => {
    const worker = createWebWorker({
     moduleId: "vs/language/typescript/tsWorker",
     // MonacoEnvironment.getWorker 始终存在（setup.ts 装配），走不到这里；
     // 真走到说明装配缺失，直接报错而不是静默降级。
     createWorker: () => {
      throw new Error("ts.worker 未装配：MonacoEnvironment.getWorker 缺失");
     },
     label: this._modeId,
     keepIdleModels: false,
     createData: {
      compilerOptions: this._defaults.getCompilerOptions(),
      extraLibs: this._defaults.getExtraLibs(),
      customWorkerPath: this._defaults.workerOptions.customWorkerPath,
      inlayHintsOptions: this._defaults.inlayHintsOptions,
     },
    });
    this._worker = worker;
    if (this._defaults.getEagerModelSync()) {
     return await worker.withSyncedResources(
      editor
       .getModels()
       .filter((model) => model.getLanguageId() === this._modeId)
       .map((model) => model.uri),
     );
    }
    return await worker.getProxy();
   })();
   // 创建失败（worker 脚本加载异常等）：清掉缓存，下次请求重试
   void this._client.catch(() => {
    this._client = null;
   });
  }
  return this._client;
 }

 async getLanguageServiceWorker(...resources: unknown[]): Promise<LanguageServiceClient> {
  const client = await this._getClient();
  if (this._worker) {
   await this._worker.withSyncedResources(resources);
  }
  return client;
 }
}

/** 挂起 / 恢复语言服务：挂起会立刻释放全部 worker，恢复不主动创建（等下次请求） */
export function setLanguageWorkersSuspended(next: boolean): void {
 workerRegistry.suspended = next;
 if (next) {
  for (const manager of workerRegistry.managers) manager.stop();
 }
}

/** 只保留指定语言模式的 worker，其余停掉（切换标签时避免 TS 与 JS 两套编译器并存） */
export function stopLanguageWorkersExcept(mode: LanguageWorkerMode | null): void {
 for (const manager of workerRegistry.managers) {
  if (mode === null || manager.modeId !== mode) manager.stop();
 }
}

/** 当前存活的语言服务 worker 数量（自检与调试用；挂起期间应为 0） */
export function languageWorkerCount(): number {
 let count = 0;
 for (const manager of workerRegistry.managers) {
  if (manager.hasWorker) count += 1;
 }
 return count;
}
