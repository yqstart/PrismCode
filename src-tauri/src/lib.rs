use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem, Submenu},
    AppHandle, Emitter, Manager, RunEvent, Runtime, State,
};
use std::{
    collections::HashMap,
    ffi::OsString,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
};

pub mod commands;
pub mod cli;
pub mod external_open;
pub mod user_data;

#[derive(Default)]
struct AppLifecycleState {
    quitting: AtomicBool,
    /// 前端已处理完 light 模式未保存文件（落盘或用户确认放弃），允许退出。
    exit_confirmed: AtomicBool,
    /// 各窗口上报的「存在未保存的独立文件（light 模式）」标记，key 为窗口 label。
    /// 窗口销毁时清除，避免已关闭窗口的陈旧标记把退出流程卡住。
    light_unsaved: Mutex<HashMap<String, bool>>,
}

impl AppLifecycleState {
    fn has_unsaved_light(&self) -> bool {
        self.light_unsaved
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .values()
            .any(|dirty| *dirty)
    }

    fn clear_window(&self, label: &str) {
        self.light_unsaved
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(label);
    }
}

struct NativeMenuLabels {
    // 顶级菜单（对齐 IDEA：File / Edit / View / Navigate / Code / Run / VCS / Window / Help）
    file: &'static str,
    edit: &'static str,
    view: &'static str,
    navigate: &'static str,
    code: &'static str,
    run: &'static str,
    vcs: &'static str,
    window: &'static str,
    help: &'static str,
    // 文件
    open_folder: &'static str,
    save: &'static str,
    save_all: &'static str,
    close_editor: &'static str,
    settings: &'static str,
    quit: &'static str,
    // 编辑
    undo: &'static str,
    redo: &'static str,
    cut: &'static str,
    copy: &'static str,
    paste: &'static str,
    select_all: &'static str,
    find_in_editor: &'static str,
    search: &'static str,
    find_in_files: &'static str,
    replace_in_files: &'static str,
    // 视图
    panel_project: &'static str,
    panel_commit: &'static str,
    panel_gitlog: &'static str,
    panel_problems: &'static str,
    panel_terminal: &'static str,
    terminal: &'static str,
    sidebar: &'static str,
    // 导航
    goto_file: &'static str,
    find_file: &'static str,
    goto_symbol: &'static str,
    recent_files: &'static str,
    back: &'static str,
    forward: &'static str,
    last_edit_location: &'static str,
    goto_line: &'static str,
    reveal: &'static str,
    // 代码
    reformat_code: &'static str,
    toggle_line_comment: &'static str,
    fold_all: &'static str,
    unfold_all: &'static str,
    toggle_wrap: &'static str,
    // 运行
    toggle_breakpoint: &'static str,
    // 版本控制
    git_commit: &'static str,
    git_update: &'static str,
    git_push: &'static str,
    git_fetch: &'static str,
    git_branches: &'static str,
    // 窗口
    minimize: &'static str,
    maximize: &'static str,
    // 帮助
    about: &'static str,
}

fn menu_labels(locale: &str) -> NativeMenuLabels {
    if locale == "en-US" || locale.starts_with("en") {
        NativeMenuLabels {
            file: "File",
            edit: "Edit",
            view: "View",
            navigate: "Navigate",
            code: "Code",
            run: "Run",
            vcs: "VCS",
            window: "Window",
            help: "Help",
            open_folder: "Open Folder…",
            save: "Save",
            save_all: "Save All",
            close_editor: "Close Editor",
            settings: "Settings…",
            quit: "Quit Prism Code",
            undo: "Undo",
            redo: "Redo",
            cut: "Cut",
            copy: "Copy",
            paste: "Paste",
            select_all: "Select All",
            find_in_editor: "Find…",
            search: "Find in Files…",
            find_in_files: "Find in Files…",
            replace_in_files: "Replace in Files…",
            panel_project: "Project",
            panel_commit: "Commit",
            panel_gitlog: "Git Log",
            panel_problems: "Problems",
            panel_terminal: "Terminal",
            terminal: "Toggle Terminal",
            sidebar: "Toggle Sidebar",
            goto_file: "Go to File…",
            find_file: "Find File…",
            goto_symbol: "Go to Symbol…",
            recent_files: "Recent Files",
            back: "Back",
            forward: "Forward",
            last_edit_location: "Last Edit Location",
            goto_line: "Go to Line/Column…",
            reveal: "Reveal in Explorer",
            reformat_code: "Reformat Code",
            toggle_line_comment: "Comment with Line Comment",
            fold_all: "Collapse All",
            unfold_all: "Expand All",
            toggle_wrap: "Soft-Wrap",
            toggle_breakpoint: "Toggle Breakpoint",
            git_commit: "Commit…",
            git_update: "Update Project…",
            git_push: "Push…",
            git_fetch: "Fetch",
            git_branches: "Branches…",
            minimize: "Minimize",
            maximize: "Zoom",
            about: "About Prism Code",
        }
    } else {
        NativeMenuLabels {
            file: "文件",
            edit: "编辑",
            view: "视图",
            navigate: "导航",
            code: "代码",
            run: "运行",
            vcs: "版本控制",
            window: "窗口",
            help: "帮助",
            open_folder: "打开文件夹…",
            save: "保存",
            save_all: "全部保存",
            close_editor: "关闭编辑器",
            settings: "设置…",
            quit: "退出 Prism Code",
            undo: "撤销",
            redo: "重做",
            cut: "剪切",
            copy: "复制",
            paste: "粘贴",
            select_all: "全选",
            find_in_editor: "查找…",
            search: "在文件中查找…",
            find_in_files: "在文件中查找…",
            replace_in_files: "在文件中替换…",
            panel_project: "项目",
            panel_commit: "提交",
            panel_gitlog: "Git 日志",
            panel_problems: "问题",
            panel_terminal: "终端",
            terminal: "切换终端",
            sidebar: "切换侧边栏",
            goto_file: "转到文件…",
            find_file: "查找文件…",
            goto_symbol: "转到符号…",
            recent_files: "最近文件",
            back: "后退",
            forward: "前进",
            last_edit_location: "上次编辑位置",
            goto_line: "转到行/列…",
            reveal: "在资源管理器中显示",
            reformat_code: "重新格式化代码",
            toggle_line_comment: "注释行",
            fold_all: "全部折叠",
            unfold_all: "全部展开",
            toggle_wrap: "自动换行",
            toggle_breakpoint: "切换断点",
            git_commit: "提交…",
            git_update: "更新项目",
            git_push: "推送…",
            git_fetch: "拉取",
            git_branches: "分支",
            minimize: "最小化",
            maximize: "缩放",
            about: "关于 Prism Code",
        }
    }
}

fn build_app_menu<R: Runtime>(
    handle: &AppHandle<R>,
    locale: &str,
) -> tauri::Result<Menu<R>> {
    let l = menu_labels(locale);

    // 现有菜单项 id 与快捷键保持不变；新增项一律不设 accelerator，快捷键统一由前端处理。

    // 文件
    let open_folder =
        MenuItem::with_id(handle, "open_folder", l.open_folder, true, Some("CmdOrCtrl+O"))?;
    let save = MenuItem::with_id(handle, "save", l.save, true, Some("CmdOrCtrl+S"))?;
    let save_all = MenuItem::with_id(handle, "save_all", l.save_all, true, None::<&str>)?;
    let close_editor = MenuItem::with_id(handle, "close_editor", l.close_editor, true, None::<&str>)?;
    let settings = MenuItem::with_id(handle, "settings", l.settings, true, Some("CmdOrCtrl+,"))?;
    let quit = PredefinedMenuItem::quit(handle, Some(l.quit))?;

    // 编辑
    let find_in_editor = MenuItem::with_id(
        handle,
        "find_in_editor",
        l.find_in_editor,
        true,
        Some("CmdOrCtrl+F"),
    )?;
    let search =
        MenuItem::with_id(handle, "search", l.search, true, Some("CmdOrCtrl+Shift+F"))?;
    let find_in_files = MenuItem::with_id(handle, "find_in_files", l.find_in_files, true, None::<&str>)?;
    let replace_in_files =
        MenuItem::with_id(handle, "replace_in_files", l.replace_in_files, true, None::<&str>)?;

    // 视图
    let panel_project = MenuItem::with_id(handle, "panel_project", l.panel_project, true, None::<&str>)?;
    let panel_commit = MenuItem::with_id(handle, "panel_commit", l.panel_commit, true, None::<&str>)?;
    let panel_gitlog = MenuItem::with_id(handle, "panel_gitlog", l.panel_gitlog, true, None::<&str>)?;
    let panel_problems =
        MenuItem::with_id(handle, "panel_problems", l.panel_problems, true, None::<&str>)?;
    let panel_terminal =
        MenuItem::with_id(handle, "panel_terminal", l.panel_terminal, true, None::<&str>)?;
    let terminal =
        MenuItem::with_id(handle, "terminal", l.terminal, true, Some("CmdOrCtrl+J"))?;
    let toggle_sidebar = MenuItem::with_id(
        handle,
        "toggle_sidebar",
        l.sidebar,
        true,
        Some("CmdOrCtrl+B"),
    )?;

    // 导航
    let goto_file = MenuItem::with_id(handle, "goto_file", l.goto_file, true, None::<&str>)?;
    let find_file =
        MenuItem::with_id(handle, "find_file", l.find_file, true, Some("CmdOrCtrl+P"))?;
    let goto_symbol = MenuItem::with_id(handle, "goto_symbol", l.goto_symbol, true, None::<&str>)?;
    let recent_files = MenuItem::with_id(handle, "recent_files", l.recent_files, true, None::<&str>)?;
    let back = MenuItem::with_id(handle, "back", l.back, true, None::<&str>)?;
    let forward = MenuItem::with_id(handle, "forward", l.forward, true, None::<&str>)?;
    let last_edit_location =
        MenuItem::with_id(handle, "last_edit_location", l.last_edit_location, true, None::<&str>)?;
    let goto_line = MenuItem::with_id(handle, "goto_line", l.goto_line, true, None::<&str>)?;
    let reveal_in_explorer = MenuItem::with_id(
        handle,
        "reveal_in_explorer",
        l.reveal,
        true,
        Some("Alt+F1"),
    )?;

    // 代码
    let reformat_code = MenuItem::with_id(handle, "reformat_code", l.reformat_code, true, None::<&str>)?;
    let toggle_line_comment = MenuItem::with_id(
        handle,
        "toggle_line_comment",
        l.toggle_line_comment,
        true,
        None::<&str>,
    )?;
    let fold_all = MenuItem::with_id(handle, "fold_all", l.fold_all, true, None::<&str>)?;
    let unfold_all = MenuItem::with_id(handle, "unfold_all", l.unfold_all, true, None::<&str>)?;
    let toggle_wrap = MenuItem::with_id(handle, "toggle_wrap", l.toggle_wrap, true, None::<&str>)?;

    // 运行
    let toggle_breakpoint =
        MenuItem::with_id(handle, "toggle_breakpoint", l.toggle_breakpoint, true, None::<&str>)?;

    // 版本控制
    let git_commit = MenuItem::with_id(handle, "git_commit", l.git_commit, true, None::<&str>)?;
    let git_update = MenuItem::with_id(handle, "git_update", l.git_update, true, None::<&str>)?;
    let git_push = MenuItem::with_id(handle, "git_push", l.git_push, true, None::<&str>)?;
    let git_fetch = MenuItem::with_id(handle, "git_fetch", l.git_fetch, true, None::<&str>)?;
    let git_branches = MenuItem::with_id(handle, "git_branches", l.git_branches, true, None::<&str>)?;

    // 窗口：minimize 自带 macOS 原生 ⌘M，maximize 映射 Zoom。
    // 刻意不使用 close_window：其原生键位 ⌘W 会抢占前端「关闭当前标签」，
    // 与「新增项不设 accelerator、快捷键由前端统一处理」的约定冲突。
    let minimize = PredefinedMenuItem::minimize(handle, Some(l.minimize))?;
    let maximize = PredefinedMenuItem::maximize(handle, Some(l.maximize))?;

    // 帮助
    let about = MenuItem::with_id(handle, "about", l.about, true, None::<&str>)?;

    let file_menu = Submenu::with_items(
        handle,
        l.file,
        true,
        &[
            &open_folder,
            &save,
            &save_all,
            &close_editor,
            &PredefinedMenuItem::separator(handle)?,
            &settings,
            &quit,
        ],
    )?;

    // macOS WKWebView：自定义菜单会替换系统默认「编辑」菜单，
    // 必须显式加入剪切/复制/粘贴，否则 Cmd+X/C/V 无法路由到 Web 内容。
    // 预定义项传入显式文案，跟随应用语言，而非 macOS 系统语言。
    let edit_menu = Submenu::with_items(
        handle,
        l.edit,
        true,
        &[
            &PredefinedMenuItem::undo(handle, Some(l.undo))?,
            &PredefinedMenuItem::redo(handle, Some(l.redo))?,
            &PredefinedMenuItem::separator(handle)?,
            &PredefinedMenuItem::cut(handle, Some(l.cut))?,
            &PredefinedMenuItem::copy(handle, Some(l.copy))?,
            &PredefinedMenuItem::paste(handle, Some(l.paste))?,
            &PredefinedMenuItem::select_all(handle, Some(l.select_all))?,
            &PredefinedMenuItem::separator(handle)?,
            &find_in_editor,
            &search,
            &find_in_files,
            &replace_in_files,
        ],
    )?;

    let view_menu = Submenu::with_items(
        handle,
        l.view,
        true,
        &[
            &panel_project,
            &panel_commit,
            &panel_gitlog,
            &panel_problems,
            &PredefinedMenuItem::separator(handle)?,
            &panel_terminal,
            &terminal,
            &toggle_sidebar,
        ],
    )?;

    let navigate_menu = Submenu::with_items(
        handle,
        l.navigate,
        true,
        &[
            &goto_file,
            &find_file,
            &goto_symbol,
            &recent_files,
            &PredefinedMenuItem::separator(handle)?,
            &back,
            &forward,
            &last_edit_location,
            &goto_line,
            &reveal_in_explorer,
        ],
    )?;

    let code_menu = Submenu::with_items(
        handle,
        l.code,
        true,
        &[
            &reformat_code,
            &toggle_line_comment,
            &fold_all,
            &unfold_all,
            &toggle_wrap,
        ],
    )?;

    let run_menu = Submenu::with_items(
        handle,
        l.run,
        true,
        &[&toggle_breakpoint],
    )?;

    let vcs_menu = Submenu::with_items(
        handle,
        l.vcs,
        true,
        &[
            &git_commit,
            &git_update,
            &git_push,
            &git_fetch,
            &PredefinedMenuItem::separator(handle)?,
            &git_branches,
        ],
    )?;

    let window_menu = Submenu::with_items(handle, l.window, true, &[&minimize, &maximize])?;

    let help_menu = Submenu::with_items(handle, l.help, true, &[&about])?;

    Menu::with_items(
        handle,
        &[
            &file_menu,
            &edit_menu,
            &view_menu,
            &navigate_menu,
            &code_menu,
            &run_menu,
            &vcs_menu,
            &window_menu,
            &help_menu,
        ],
    )
}

/// 按应用内语言重建原生菜单栏（无需重启）
#[tauri::command]
fn set_app_menu_locale(app: AppHandle, locale: String) -> Result<(), String> {
    let menu = build_app_menu(&app, &locale).map_err(|e| e.to_string())?;
    app.set_menu(menu).map_err(|e| e.to_string())?;
    Ok(())
}

/// 前端关闭处理器查询应用是否正在整体退出，避免把正常退出前的窗口索引误删。
#[tauri::command]
fn is_app_quitting(state: State<'_, AppLifecycleState>) -> bool {
    state.quitting.load(Ordering::SeqCst)
}

/// light 模式（无工作区）窗口上报是否存在未保存的独立文件。
/// 应用整体退出前会据此先让前端落盘或向用户确认，避免静默丢改。
#[tauri::command]
fn set_light_unsaved(
    window: tauri::WebviewWindow,
    state: State<'_, AppLifecycleState>,
    dirty: bool,
) {
    let mut map = state
        .light_unsaved
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if dirty {
        map.insert(window.label().to_string(), true);
    } else {
        map.remove(window.label());
    }
}

/// 前端处理完未保存的独立文件后调用：放行应用退出。
#[tauri::command]
fn confirm_app_exit(app: AppHandle, state: State<'_, AppLifecycleState>) {
    state.exit_confirmed.store(true, Ordering::SeqCst);
    app.exit(0);
}

/// Tauri command：前端 invoke 时重建 Dock 菜单。
/// 实际逻辑在 `commands/dock_menu::rebuild_dock_menu`（macOS only；
/// 非 macOS 是 no-op）。catch_unwind 防 NSMenu/NSMenuItem 调用链上的 objc
/// 异常（已被 NSException 接住前先拦下 Rust 边界 panic），避免 release profile
/// 的 panic = "abort" 路径把整个 App 干掉。AppKit 对 NSMenu/NSMenuItem
/// 要求主线程访问，因此即使 Tauri command 在后台线程执行，也统一切回主线程，
/// 避免 `MainThreadMarker::new()` 在非主线程 panic。
#[tauri::command]
fn set_dock_menu(app: AppHandle, state: DockStatePayload) -> Result<(), String> {
    let handle = app.clone();
    app.run_on_main_thread(move || {
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            commands::dock_menu::rebuild_dock_menu(&handle, &state);
        }));
        if let Err(e) = result {
            let msg = e
                .downcast_ref::<String>()
                .cloned()
                .or_else(|| e.downcast_ref::<&str>().map(|s| s.to_string()))
                .unwrap_or_else(|| "未知 panic".to_string());
            eprintln!("[set_dock_menu] panic 已被吞掉: {msg}");
        }
    })
    .map_err(|e| format!("无法在主线程更新 Dock 菜单：{e}"))
}

// ==================== macOS 启动拉前 ====================
// 之前尝试在 setup 闭包里直接调 NSApp.setActivationPolicy()，
// 会跟 tao 0.35 的 did_finish_launching 内部 AppState::launched 第二次设
// activation policy 时序冲突，触发 MainThreadMarker::new().unwrap() 跨
// extern "C" 边界 panic，被 abort 转成 "panic in a function that cannot unwind"。
// 拉前动作改由前端 AppShell mount 时调 getCurrentWindow().setFocus() 实现。

// Dock 菜单的 payload 类型 + 实现全部迁到 commands/dock_menu.rs（macOS only）。
// 旧版本在这里用 msg_send![NSApp, setDockMenu:] 给 NSApplication 发不存在的
// selector，objc runtime 静默 no-op，菜单从未设上——macOS 退回到默认的
// 「应用名 + 窗口列表」渲染。详见 commands/dock_menu.rs 顶部注释。
use commands::dock_menu::DockStatePayload;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let action = cli::parse_args(std::env::args_os().skip(1), &cwd);
    let initial_targets = match action {
        Ok(cli::CliAction::Run(targets)) => targets,
        Ok(cli::CliAction::Help) => {
            println!("{}", cli::help_text());
            return;
        }
        Ok(cli::CliAction::Version) => {
            println!("Prism Code {}", env!("CARGO_PKG_VERSION"));
            return;
        }
        Err(error) => {
            eprintln!("prismcode: {error}");
            std::process::exit(2);
        }
    };

    let mut builder = tauri::Builder::default();

    // 必须最先注册：CLI 第二次调用由插件转发给现有实例，避免重复创建 GUI。
    // debug 构建（`pnpm tauri:dev`）不启用：开发版使用独立 identifier，需与已安装
    // 正式版并行运行，互不抢焦点、不转发 argv。
    #[cfg(all(desktop, not(debug_assertions)))]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
            let invocation_cwd = if cwd.trim().is_empty() {
                std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
            } else {
                PathBuf::from(cwd)
            };
            let args = argv.into_iter().skip(1).map(OsString::from);
            match cli::parse_args(args, &invocation_cwd) {
                Ok(cli::CliAction::Run(targets)) => {
                    external_open::enqueue_targets(app, targets);
                    external_open::focus_primary_window(app);
                }
                Ok(cli::CliAction::Help | cli::CliAction::Version) => {}
                Err(error) => eprintln!("prismcode: {error}"),
            }
        }));
    }

    builder
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_pty::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        // 窗口最大化/全屏/可见性/装饰状态自动恢复（多窗口）。
        // 故意不记 SIZE 和 POSITION：
        // - SIZE：宽高始终走 tauri.conf.json 默认值（1440x900），与 Cursor/VSCode
        //   「每次给固定默认尺寸」一致；旧版拖小后被持久化、下次启动仍窄的 bug 不再出现
        // - POSITION：旧版记着 1280 宽时的 x，新版改 1440 宽后右侧溢出屏幕；
        //   去掉后让 tauri.conf.json 的 center:true 把窗口居中，每次启动都居中
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::MAXIMIZED
                        | tauri_plugin_window_state::StateFlags::VISIBLE
                        | tauri_plugin_window_state::StateFlags::DECORATIONS
                        | tauri_plugin_window_state::StateFlags::FULLSCREEN,
                )
                .build(),
        )
        .manage(AppLifecycleState::default())
        .manage(external_open::ExternalOpenState::with_pending(
            initial_targets,
        ))
        .manage(commands::ssh::SshState::default())
        .manage(commands::lsp::LspState::default())
        .manage(commands::dap::DapState::default())
        .setup(|app| {
            let handle = app.handle();

            // 启动默认中文菜单；前端读到 settings.locale 后会再同步一次
            let menu = build_app_menu(handle, "zh-CN")?;
            app.set_menu(menu)?;

            app.on_menu_event(|app, event| {
                let _ = app.emit("menu://action", event.id().as_ref());
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.set_focus();
                }
            });

            // macOS：Overlay 标题栏底色 + 红绿灯同步（主题切换时前端会再同步底色）
            // 启动默认对齐默认主题 IntelliJ Dark（--bg-app #1e1f22）
            #[cfg(target_os = "macos")]
            if let Some(window) = app.get_webview_window("main") {
                let _ = commands::window_chrome::apply_titlebar_background(
                    &window, 30.0, 31.0, 34.0,
                );
                commands::window_chrome::install_traffic_light_hooks(&window);
            }

            // 启动后立即把 App 拉到最前（解决自动更新后需手动点 dock 才能前置的体验问题）。
            // 注意：不能在 setup 闭包里调 NSApp.setActivationPolicy() —— tao 0.35 的
            // did_finish_launching -> AppState::launched 内部还有 apply_activation_policy()
            // 会再设一次，setup 阶段手动 set 跟 tao 内部第二次设的时序会触发
            // `MainThreadMarker::new().unwrap()` 跨 extern "C" 边界 panic，
            // 被 abort 转成 "panic in a function that cannot unwind"。
            // 拉前动作改由前端 AppShell mount 时调 getCurrentWindow().setFocus() 实现。
            #[cfg(target_os = "macos")]
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_focus();
            }

            // macOS Dock 菜单接管：给 NSApp.delegate（TaoAppDelegate）注入
            // applicationDockMenu: IMP，让 AppKit 调我们提供的菜单。
            // 必须放在 set_menu 之后、首次右键 dock 之前。
            // 详见 commands/dock_menu.rs 顶部注释。
            commands::dock_menu::install_dock_menu_hook(handle);

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            set_app_menu_locale,
            is_app_quitting,
            set_light_unsaved,
            confirm_app_exit,
            set_dock_menu,
            external_open::take_pending_external_opens,
            commands::fs::list_dir,
            commands::fs::read_text_file,
            commands::fs::read_file_base64,
            commands::fs::write_text_file,
            commands::fs::create_entry,
            commands::fs::rename_entry,
            commands::fs::delete_entry,
            commands::fs::copy_entry,
            commands::fs::path_exists,
            commands::clipboard::read_system_clipboard_files,
            commands::clipboard::copy_external_entries,
            commands::fs::snippets_read_global,
            commands::search::search_files,
            commands::search::search_content,
            commands::search::replace_in_files,
            commands::git::git_status,
            commands::git::git_init,
            commands::git::git_set_remote,
            commands::git::git_stage,
            commands::git::git_unstage,
            commands::git::git_commit,
            commands::git::git_branches,
            commands::git::git_checkout,
            commands::git::git_create_branch,
            commands::git::git_delete_branch,
            commands::git::git_rename_branch,
            commands::git::git_log,
            commands::git::git_tags,
            commands::git::git_commit_files,
            commands::git::git_create_tag,
            commands::git::git_delete_tag,
            commands::git::git_push_tag,
            commands::git::git_diff,
            commands::git::git_file_sides,
            commands::git::git_head_text,
            commands::git::git_conflict_sides,
            commands::git::git_pull,
            commands::git::git_push,
            commands::git::git_stored_username,
            commands::git::git_fetch,
            commands::git::git_update_project,
            commands::git::git_rebase_branch,
            commands::git::git_rebase_status,
            commands::git::git_rebase_continue,
            commands::git::git_rebase_abort,
            commands::git::git_rebase_skip,
            commands::git::git_rebase_plan,
            commands::git::git_rebase_interactive,
            commands::git::git_cherry_pick,
            commands::git::git_reset,
            commands::git::git_blame,
            commands::git::git_remotes,
            commands::git::git_unpushed_commits,
            commands::git::git_set_upstream,
            commands::git::git_checkout_remote,
            commands::git::git_checkout_commit,
            commands::git::git_create_branch_at,
            commands::git::git_delete_remote_branch,
            commands::git::git_branch_sides,
            commands::git::git_stash,
            commands::git::git_stash_list,
            commands::git::git_stash_pop,
            commands::git::git_stash_apply,
            commands::git::git_stash_drop,
            commands::git::git_discard_paths,
            commands::git::git_reset_hard,
            commands::git::git_undo_commit,
            commands::git::git_revert_to,
            commands::git::git_revert_commit,
            commands::git::git_merge_branch,
            commands::git::git_merge_abort,
            commands::git::git_conflict_files,
            commands::git::git_resolve_conflict,
            commands::ssh::ssh_shell_open,
            commands::ssh::ssh_shell_write,
            commands::ssh::ssh_shell_resize,
            commands::ssh::ssh_shell_close,
            commands::ssh::ssh_profiles_load,
            commands::ssh::ssh_profiles_save,
            commands::ssh::ssh_secret_get,
            commands::ssh::ssh_secret_set,
            commands::ssh::ssh_secret_remove,
            commands::tooling::format_with_prettier,
            commands::tooling::lint_with_eslint,
            commands::security_scoped::create_security_scoped_bookmarks,
            commands::security_scoped::resolve_security_scoped_bookmarks,
            commands::security_scoped::release_security_scoped_bookmarks,
            commands::window_chrome::set_titlebar_background,
            commands::window_chrome::sync_traffic_lights,
            commands::window_chrome::close_window,
            // dev-only：模拟"push 卡住 N ms"，让 __ipcSelfCheck 在真机
            // 量化"卡住期间并发 IPC 的最大耗时"。release 构建下函数立即返回错误。
            commands::git::dev_fake_block,
            commands::lsp::lsp_start,
            commands::lsp::lsp_send,
            commands::lsp::lsp_stop,
            commands::lsp::lsp_logs,
            commands::java::java_probe_runtime,
            commands::java::java_launch_plan,
            commands::java::java_rebuild_index,
            commands::maven::maven_scan,
            commands::maven::maven_diagnostics,
            commands::runconfig::runconfig_generate,
            commands::runconfig::runconfig_resolve,
            commands::runconfig::runconfig_launch_plan,
            commands::runconfig::runconfig_toolchains,
            commands::spring::spring_index,
            commands::dap::dap_connect,
            commands::dap::dap_send,
            commands::dap::dap_stop,
            commands::dap::dap_logs,
            commands::dap::dap_probe_adapter,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            #[cfg(target_os = "macos")]
            if let RunEvent::Opened { urls } = &event {
                let targets = external_open::targets_from_urls(urls.clone());
                if !targets.is_empty() {
                    external_open::enqueue_targets(app, targets);
                    external_open::focus_primary_window(app);
                }
                return;
            }

            // 让所有 WebView 在应用整体退出前先保存各自的窗口、编辑器和终端
            // 快照；单独关闭某个窗口不会收到这条应用级通知，因此仍会被移出
            // 前端窗口索引。
            if let RunEvent::ExitRequested { api, .. } = &event {
                let state = app.state::<AppLifecycleState>();
                state.quitting.store(true, Ordering::SeqCst);
                // light 模式没有按工作区持久化的会话快照：还有未保存的独立
                // 文件时先拦住退出，等前端落盘或用户确认后再走 confirm_app_exit。
                if state.has_unsaved_light() && !state.exit_confirmed.load(Ordering::SeqCst) {
                    api.prevent_exit();
                } else {
                    commands::lsp::stop_all_sessions(app);
                    // 调试会话没有「保留到下次启动」的语义：真退出时一律收掉。
                    // 退出被拦下时不能停，否则用户还没保存文件就把调试器拆了。
                    commands::dap::stop_all_sessions(app);
                }
                let _ = app.emit("app://will-exit", ());
            }

            // 窗口销毁后清掉它的未保存标记：否则已关闭窗口会把后续退出卡住。
            if let RunEvent::WindowEvent {
                label,
                event: tauri::WindowEvent::Destroyed,
                ..
            } = &event
            {
                app.state::<AppLifecycleState>().clear_window(label);
                commands::lsp::stop_window_sessions(app, label);
                commands::dap::stop_window_sessions(app, label);
            }
        });
}
