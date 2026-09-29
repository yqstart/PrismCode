// ==================== monaco-editor 内部模块类型补齐 ====================
// monaco-editor 0.57 的 package exports 暴露 esm/vs/**，但只为公开入口配了 .d.ts；
// languages/features/typescript/workerManager.js 与 internal/common/workers.js 没有声明文件。
// tsWorkerManager.ts 需要按源码签名使用后者，这里补上最小可用类型。

declare module "monaco-editor/internal/common/workers.js" {
  /** 上游 createWebWorker 的入参（workerManager 只用到这几个字段） */
  export interface WebWorkerOptions {
    moduleId?: string;
    createWorker?: () => Worker;
    host?: unknown;
    label?: string;
    keepIdleModels?: boolean;
    createData?: unknown;
  }

  /** Monaco 的 worker 客户端代理：语言服务方法按名调用，返回 Promise */
  export interface WebWorkerClient {
    dispose(): void;
    getProxy(): Promise<Record<string, (...args: never[]) => unknown>>;
    withSyncedResources(
      resources: readonly unknown[],
    ): Promise<Record<string, (...args: never[]) => unknown>>;
  }

  export function createWebWorker(options: WebWorkerOptions): WebWorkerClient;
}
