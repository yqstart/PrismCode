/**
 * 外部编辑器打开请求：由 Rust 端统一接收 CLI / macOS Launch Services，
 * 再通过 `app://open-external` 事件交给当前主窗口。主窗口收到后用
 * `shared/externalOpenRoute` 按工作区归属分流：已在工作区的文件留在
 * 本窗口，工作区外的文件按父目录分组新开窗口展示。
 */
export interface ExternalOpenTarget {
  path: string;
  line?: number;
  column?: number;
  isDir: boolean;
}
export interface ExternalOpenRequest {
  targets: ExternalOpenTarget[];
}
