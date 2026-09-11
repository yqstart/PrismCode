# tauri-plugin-pty（Prism Code 本地补丁）

此目录基于 `tauri-plugin-pty` 0.3.1，保留原有命令和前端 API。

Prism Code 的本地补丁仅将 PTY 的创建、读写、尺寸调整、结束等待和终止操作
派发到 Tauri 的 blocking 线程池，避免同步 IO 占用异步运行时线程。

原项目：<https://github.com/Tnze/tauri-plugin-pty>
