use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem, Submenu},
    AppHandle, Emitter, Manager, RunEvent, Runtime, State,
};
use std::{
    ffi::OsString,
    path::PathBuf,
    sync::atomic::{AtomicBool, Ordering},
};

pub mod commands;
pub mod cli;
pub mod external_open;
pub mod user_data;

#[derive(Default)]
struct AppLifecycleState {
    quitting: AtomicBool,
}

struct NativeMenuLabels {
    file: &'static str,
    edit: &'static str,
    open_folder: &'static str,
    save: &'static str,
    find_file: &'static str,
    search: &'static str,
    reveal: &'static str,
    terminal: &'static str,
    sidebar: &'static str,
    settings: &'static str,
    quit: &'static str,
    undo: &'static str,
    redo: &'static str,
    cut: &'static str,
    copy: &'static str,
    paste: &'static str,
    select_all: &'static str,
    find_in_editor: &'static str,
}

fn menu_labels(locale: &str) -> NativeMenuLabels {
    if locale == "en-US" || locale.starts_with("en") {
        NativeMenuLabels {
            file: "File",
            edit: "Edit",
            open_folder: "Open Folder…",
            save: "Save",
            find_file: "Find File…",
            search: "Find in Files…",
            reveal: "Reveal in Explorer",
            terminal: "Toggle Terminal",
            sidebar: "Toggle Sidebar",
            settings: "Settings…",
            quit: "Quit Prism Code",
            undo: "Undo",
            redo: "Redo",
            cut: "Cut",
            copy: "Copy",
            paste: "Paste",
            select_all: "Select All",
            find_in_editor: "Find…",
        }
    } else {
        NativeMenuLabels {
            file: "文件",
            edit: "编辑",
            open_folder: "打开文件夹…",
            save: "保存",
            find_file: "查找文件…",
            search: "在文件中查找…",
            reveal: "在资源管理器中显示",
            terminal: "切换终端",
            sidebar: "切换侧边栏",
            settings: "设置…",
            quit: "退出 Prism Code",
            undo: "撤销",
            redo: "重做",
            cut: "剪切",
            copy: "复制",
            paste: "粘贴",
            select_all: "全选",
            find_in_editor: "查找…",
        }
    }
}

fn build_app_menu<R: Runtime>(
    handle: &AppHandle<R>,
    locale: &str,
) -> tauri::Result<Menu<R>> {
    let l = menu_labels(locale);

    let open_folder =
        MenuItem::with_id(handle, "open_folder", l.open_folder, true, Some("CmdOrCtrl+O"))?;
    let save = MenuItem::with_id(handle, "save", l.save, true, Some("CmdOrCtrl+S"))?;
    let find_file =
        MenuItem::with_id(handle, "find_file", l.find_file, true, Some("CmdOrCtrl+P"))?;
    let search =
        MenuItem::with_id(handle, "search", l.search, true, Some("CmdOrCtrl+Shift+F"))?;
    let reveal_in_explorer = MenuItem::with_id(
        handle,
        "reveal_in_explorer",
        l.reveal,
        true,
        Some("Alt+F1"),
    )?;
    let terminal =
        MenuItem::with_id(handle, "terminal", l.terminal, true, Some("CmdOrCtrl+J"))?;
    let toggle_sidebar = MenuItem::with_id(
        handle,
        "toggle_sidebar",
        l.sidebar,
        true,
        Some("CmdOrCtrl+B"),
    )?;
    let settings = MenuItem::with_id(handle, "settings", l.settings, true, Some("CmdOrCtrl+,"))?;
    let find_in_editor = MenuItem::with_id(
        handle,
        "find_in_editor",
        l.find_in_editor,
        true,
        Some("CmdOrCtrl+F"),
    )?;
    let separator = PredefinedMenuItem::separator(handle)?;
    let quit = PredefinedMenuItem::quit(handle, Some(l.quit))?;

    let file_menu = Submenu::with_items(
        handle,
        l.file,
        true,
        &[
            &open_folder,
            &save,
            &separator,
            &find_file,
            &search,
            &reveal_in_explorer,
            &terminal,
            &toggle_sidebar,
            &separator,
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
            &separator,
            &find_in_editor,
        ],
    )?;

    Menu::with_items(handle, &[&file_menu, &edit_menu])
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
            #[cfg(target_os = "macos")]
            if let Some(window) = app.get_webview_window("main") {
                let _ = commands::window_chrome::apply_titlebar_background(
                    &window, 232.0, 234.0, 239.0,
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
            commands::security_scoped::create_security_scoped_bookmarks,
            commands::security_scoped::resolve_security_scoped_bookmarks,
            commands::security_scoped::release_security_scoped_bookmarks,
            commands::window_chrome::set_titlebar_background,
            commands::window_chrome::sync_traffic_lights,
            commands::window_chrome::close_window,
            // dev-only：模拟"push 卡住 N ms"，让 __ipcSelfCheck 在真机
            // 量化"卡住期间并发 IPC 的最大耗时"。release 构建下函数立即返回错误。
            commands::git::dev_fake_block,
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
            if matches!(event, RunEvent::ExitRequested { .. }) {
                app.state::<AppLifecycleState>()
                    .quitting
                    .store(true, Ordering::SeqCst);
                let _ = app.emit("app://will-exit", ());
            }
        });
}
