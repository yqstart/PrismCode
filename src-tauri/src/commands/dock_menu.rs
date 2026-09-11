//! macOS Dock 菜单：接管右键 Dock 图标弹出的菜单。
//!
//! 之前的实现（`lib.rs::set_dock_menu_macos`）有两个严重问题：
//! 1. 给 NSMenuItem 设的 `action: null`，**所有项点不开**——同时 Tauri 2 的
//!    `on_menu_event` 只覆盖 muda 构造的菜单，**完全不覆盖 NSApp.dockMenu**
//!    （muda 0.19.3 / Tauri 2.11.5 / tao 0.35.3 整条 tree 都没有 dockMenu 监听入口）。
//! 2. 末尾 `msg_send![NSApp, setDockMenu: menu]` 给 NSApplication 发**不存在的
//!    selector**（macOS 15 SDK NSApplication.h 只有 `applicationDockMenu:`
//!    delegate 方法，没有 `setDockMenu:` setter），objc runtime 静默 no-op，
//!    Rust 端菜单从未设上——macOS 退回到 `applicationDockMenu:` 返回值
//!    （tao 的 TaoAppDelegate 未实现该方法返回 nil）→ **macOS 自动渲染
//!    当前所有打开的窗口列表**（这就是用户截图里看到的 `Prism Code` +
//!    `Prism Code — PrismCode` 多窗口残留）。
//!
//! 修复策略：
//! - 用 `class_addMethod` 给 NSApp.delegate.class（即 TaoAppDelegate）
//!   注入 `applicationDockMenu:` 实现，让 AppKit 调我们这个 IMP 拿菜单。
//! - 用 `define_class!` 声明 `DockMenuTarget: NSObject` 子类，ivar 持有
//!   Tauri AppHandle，method `dockItemClicked:` 读 NSMenuItem.representedObject
//!   并 `app.emit("menu://dock", ...)` 给前端。
//! - 菜单对象放全局 `DOCK_MENU`，每次右键 dock AppKit 都会重新调
//!   `applicationDockMenu:` 取最新值，无需主动 setDockMenu。

use serde::Deserialize;

/// 触发重建 Dock 菜单的状态。
#[derive(Debug, Clone, Deserialize)]
pub struct DockStatePayload {
    pub recent: Vec<String>,
    #[serde(rename = "currentFile")]
    pub current_file: Option<String>,
}

#[cfg(target_os = "macos")]
mod macos {
    use super::DockStatePayload;
    use objc2::ffi::{class_addMethod, object_getClass};
    use objc2::msg_send;
    use objc2::runtime::{AnyClass, AnyObject, Imp};
    use objc2::{define_class, AnyThread};
    use objc2_foundation::{MainThreadMarker, NSObject, NSString};
    use std::ffi::c_void;
    use std::mem;
    use std::sync::atomic::{AtomicPtr, Ordering};
    use std::sync::OnceLock;
    use tauri::AppHandle;
    use tauri::Emitter;

    /// 全局 Dock 菜单对象（裸指针）。
    /// NSMenu/NSMenuItem 在 `objc2-app-kit` 的 `NSMenu` feature 下，本项目未启用，
    /// 所以全程用 `*mut AnyObject` 操作。DOCK_MENU 槽持 retain 后的指针。
    /// macOS 每次右键 dock 都会重新调 `applicationDockMenu:` 取最新值。
    /// 只在主线程读写（IMP 主线程保证），用 AtomicPtr 而非 Mutex。
    static DOCK_MENU: AtomicPtr<AnyObject> = AtomicPtr::new(std::ptr::null_mut());

    /// DockMenuTarget 单例，长存。NSMenuItem action 全部 target 指向它。
    /// AppHandle 通过 `APP_HANDLE_RAW` 间接访问。target 与 App 同生命周期，
    /// App 退出时 OS 回收整个堆。
    /// 用 `AllocAnyThread`（objc2 0.6 默认 thread_kind）确保 Retained Send + Sync，
    /// 满足 OnceLock<Retained<...>> 的 Sync 约束。dockItemClicked: 实际只在主线程被调。
    static DOCK_TARGET: OnceLock<objc2::rc::Retained<DockMenuTarget>> = OnceLock::new();

    /// 存 AppHandle 的 Box::into_raw 指针，dockItemClicked: 读它来 emit。
    /// AtomicPtr 提供 Sync；不释放（OS 进程退出时回收整个堆）。
    static APP_HANDLE_RAW: AtomicPtr<c_void> = AtomicPtr::new(std::ptr::null_mut());

    // ==================== DockMenuTarget NSObject 子类 ====================
    // 接 NSMenuItem action。从 sender.representedObject 读 "recent::<path>" /
    // "open_folder" 等结构化 id，emit "menu://dock" 给前端。

    define_class!(
        #[unsafe(super(NSObject))]
        struct DockMenuTarget;

        impl DockMenuTarget {
            // -(void)dockItemClicked:(id)sender
            #[unsafe(method(dockItemClicked:))]
            fn dock_item_clicked(&self, sender: &AnyObject) {
                unsafe {
                    let repr: *mut AnyObject = msg_send![sender, representedObject];
                    if repr.is_null() {
                        return;
                    }
                    let cstr: *const i8 = msg_send![repr, UTF8String];
                    if cstr.is_null() {
                        return;
                    }
                    let repr_str = match std::ffi::CStr::from_ptr(cstr).to_str() {
                        Ok(s) => s.to_owned(),
                        Err(_) => return,
                    };

                    // 解析结构化 id
                    let (id, path) = if let Some(p) = repr_str.strip_prefix("recent::") {
                        ("recent", Some(p.to_string()))
                    } else if repr_str == "open_folder" {
                        ("open_folder", None)
                    } else {
                        return; // "current::<path>" 等不可点击项
                    };

                    // 读 AppHandle 并 emit
                    let raw = APP_HANDLE_RAW.load(Ordering::Acquire);
                    if !raw.is_null() {
                        let app: &AppHandle = &*(raw as *const AppHandle);
                        let payload = serde_json::json!({
                            "id": id,
                            "path": path,
                        });
                        let _ = app.emit("menu://dock", payload);
                    }
                }
            }
        }
    );

    impl DockMenuTarget {
        fn install(app: &AppHandle) -> objc2::rc::Retained<Self> {
            let this = <Self as AnyThread>::alloc().set_ivars(());
            let obj: objc2::rc::Retained<Self> = unsafe { msg_send![super(this), init] };

            // 把 AppHandle 装进 Box 存到全局 AtomicPtr。永不释放（OS 进程退出回收）。
            let raw = Box::into_raw(Box::new(app.clone())) as *mut c_void;
            APP_HANDLE_RAW.store(raw, Ordering::Release);

            obj
        }

        fn shared() -> objc2::rc::Retained<Self> {
            DOCK_TARGET
                .get()
                .expect("DockMenuTarget 未初始化：必须先调 install_dock_menu_hook")
                .clone()
        }
    }

    // ==================== applicationDockMenu: 协议实现 ====================

    /// TaoAppDelegate 上的 `applicationDockMenu:` IMP（C-unwind ABI）。
    /// 返回当前 DOCK_MENU（retained return 约定：caller 负责 release）。
    /// 必须 `extern "C-unwind"` 才能喂给 class_addMethod（objc2::runtime::Imp 定义）。
    /// 内部用 catch_unwind 防 panic 跨 objc 边界 abort。
    unsafe extern "C-unwind" fn dock_menu_provider(
        _this: *mut AnyObject,
        _cmd: objc2::runtime::Sel,
        _sender: *mut AnyObject,
    ) -> *mut AnyObject {
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| -> *mut AnyObject {
            let ptr = DOCK_MENU.load(Ordering::Acquire);
            if !ptr.is_null() {
                // retained return：caller (AppKit) 拿到后 release。我们 retain 一次给 caller。
                let _: *mut AnyObject = msg_send![ptr, retain];
                ptr
            } else {
                std::ptr::null_mut()
            }
        }));
        match result {
            Ok(ptr) => ptr,
            Err(_) => {
                eprintln!("[dock_menu] applicationDockMenu: panic 已被吞掉");
                std::ptr::null_mut()
            }
        }
    }

    /// 给 NSApp.delegate.class 注入 `applicationDockMenu:` method。
    /// 必须在主线程、且 NSApp 已设好 delegate 之后调。
    pub fn install_dock_menu_hook(app: &AppHandle) {
        let _mtm = MainThreadMarker::new().expect("install_dock_menu_hook 必须在主线程");

        unsafe {
            // 拿 NSApplication class
            let nsapp_class = AnyClass::get(c"NSApplication").expect("NSApplication class");
            let nsapp: *mut AnyObject = msg_send![nsapp_class, sharedApplication];
            if nsapp.is_null() {
                eprintln!("[dock_menu] NSApplication 为 null，跳过 dock 菜单注入");
                return;
            }

            // 拿 NSApp.delegate（tao 已设好的 TaoAppDelegate 实例）
            let delegate: *mut AnyObject = msg_send![nsapp, delegate];
            if delegate.is_null() {
                eprintln!("[dock_menu] NSApp.delegate 为 null，跳过 dock 菜单注入");
                return;
            }
            let cls: *const AnyClass = object_getClass(delegate);
            if cls.is_null() {
                eprintln!("[dock_menu] 无法获取 delegate.class，跳过");
                return;
            }

            let sel = objc2::sel!(applicationDockMenu:);
            // 类型编码：@@:@ — 返回 NSMenu*（@）、self（@）、_cmd（:）、sender（@）
            let types = b"@@:@\0".as_ptr() as *const i8;
            // dock_menu_provider 满足 MethodImplementation（extern "C-unwind" fn(...)），
            // 用 mem::transmute 转 Imp（zero-arg 函数指针，C-ABI 兼容）。
            let imp: Imp = mem::transmute(dock_menu_provider as *const ());
            // class_addMethod 已存在方法不会被替换（返回 false），安全
            let added = class_addMethod(cls as *mut AnyClass, sel, imp, types);
            if !added.as_bool() {
                // 已存在：TaoAppDelegate 不可能实现此方法，所以理论上不会进这里。
                // 若进了说明某处已注入，后续会读 DOCK_MENU 的最新值，仍 OK。
                eprintln!("[dock_menu] applicationDockMenu: 已存在，未替换");
            }
        }

        // 初始化 DockMenuTarget 单例（构造 + 存 AppHandle raw）
        let _ = DOCK_TARGET.get_or_init(|| DockMenuTarget::install(app));
    }

    /// 重建 dock 菜单并存到全局。
    /// 每次前端 invoke("set_dock_menu") 都会调一次。
    pub fn rebuild_dock_menu(app: &AppHandle, state: &DockStatePayload) {
        let _mtm = MainThreadMarker::new().expect("rebuild_dock_menu 必须在主线程");
        let _ = app; // 暂未使用（target 已持有 AppHandle）；保留供未来扩展

        // 确保 DockMenuTarget 已初始化
        let target = DockMenuTarget::shared();
        let target_obj: *mut AnyObject = objc2::rc::Retained::as_ptr(&target) as *mut AnyObject;

        unsafe {
            let nsmenu_class = AnyClass::get(c"NSMenu").expect("NSMenu class");
            let nsmenuitem_class = AnyClass::get(c"NSMenuItem").expect("NSMenuItem class");
            let action_sel = objc2::sel!(dockItemClicked:);

            // ==================== 打开文件夹 ====================
            let open_label = NSString::from_str("打开文件夹…");
            let open_item: *mut AnyObject = msg_send![
                nsmenuitem_class,
                alloc
            ];
            let open_item: *mut AnyObject = msg_send![
                open_item,
                initWithTitle: &*open_label,
                action: action_sel,
                keyEquivalent: &*NSString::from_str("")
            ];
            // alloc+init 的 +1 交给 autorelease pool：对象生命周期由 menu 持有
            // 关系决定，否则每次 rebuild 都泄漏 N 个 NSMenuItem 的初始引用
            let _: *mut AnyObject = msg_send![open_item, autorelease];
            let repr = NSString::from_str("open_folder");
            let _: () = msg_send![open_item, setRepresentedObject: &*repr];
            let _: () = msg_send![open_item, setTarget: target_obj];

            // ==================== 分隔线 ====================
            let sep: *mut AnyObject = msg_send![nsmenuitem_class, separatorItem];

            // ==================== 最近项目子菜单 ====================
            let recent_label = NSString::from_str("最近项目");
            let recent_parent: *mut AnyObject = msg_send![nsmenuitem_class, alloc];
            let recent_parent: *mut AnyObject = msg_send![
                recent_parent,
                initWithTitle: &*recent_label,
                action: std::ptr::null::<AnyObject>(),
                keyEquivalent: &*NSString::from_str("")
            ];
            let _: *mut AnyObject = msg_send![recent_parent, autorelease];

            let recent_sub: *mut AnyObject = msg_send![nsmenu_class, alloc];
            let recent_sub: *mut AnyObject = msg_send![recent_sub, initWithTitle: &*recent_label];
            let _: *mut AnyObject = msg_send![recent_sub, autorelease];

            if state.recent.is_empty() {
                let empty_label = NSString::from_str("（无）");
                let empty_item: *mut AnyObject = msg_send![nsmenuitem_class, alloc];
                let empty_item: *mut AnyObject = msg_send![
                    empty_item,
                    initWithTitle: &*empty_label,
                    action: std::ptr::null::<AnyObject>(),
                    keyEquivalent: &*NSString::from_str("")
                ];
                let _: *mut AnyObject = msg_send![empty_item, autorelease];
                let _: () = msg_send![empty_item, setEnabled: false];
                let _: () = msg_send![recent_sub, addItem: empty_item];
            } else {
                for path in state.recent.iter().take(8) {
                    let basename = std::path::Path::new(path)
                        .file_name()
                        .and_then(|n| n.to_str())
                        .unwrap_or(path);
                    let display = if path.len() > 60 {
                        format!(
                            "{}…  {}",
                            truncate_chars(basename, 20),
                            truncate_chars(path, 50)
                        )
                    } else {
                        format!("{}  {}", basename, path)
                    };
                    let label = NSString::from_str(&display);
                    let item: *mut AnyObject = msg_send![nsmenuitem_class, alloc];
                    let item: *mut AnyObject = msg_send![
                        item,
                        initWithTitle: &*label,
                        action: action_sel,
                        keyEquivalent: &*NSString::from_str("")
                    ];
                    let _: *mut AnyObject = msg_send![item, autorelease];
                    let id_str = format!("recent::{}", path);
                    let repr = NSString::from_str(&id_str);
                    let _: () = msg_send![item, setRepresentedObject: &*repr];
                    let _: () = msg_send![item, setTarget: target_obj];
                    let _: () = msg_send![item, setEnabled: true];
                    let _: () = msg_send![recent_sub, addItem: item];
                }
            }
            let _: () = msg_send![recent_parent, setSubmenu: recent_sub];

            // ==================== 当前文件（不可点） ====================
            let mut current_item_ptr: *mut AnyObject = std::ptr::null_mut();
            if let Some(path) = state.current_file.as_deref() {
                let basename = std::path::Path::new(path)
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or(path);
                let display = if path.len() > 60 {
                    format!("当前：{}…", truncate_chars(basename, 40))
                } else {
                    format!("当前：{}", basename)
                };
                let label = NSString::from_str(&display);
                let item: *mut AnyObject = msg_send![nsmenuitem_class, alloc];
                let item: *mut AnyObject = msg_send![
                    item,
                    initWithTitle: &*label,
                    action: std::ptr::null::<AnyObject>(),
                    keyEquivalent: &*NSString::from_str("")
                ];
                let _: *mut AnyObject = msg_send![item, autorelease];
                let _: () = msg_send![item, setEnabled: false];
                current_item_ptr = item;
            }

            // ==================== 拼成顶级 NSMenu ====================
            // menu 的 +1 由 DOCK_MENU 指针持有（下次 rebuild 时 release 平衡），
            // 不能 autorelease；item 的初始引用才交给 pool
            let menu: *mut AnyObject = msg_send![nsmenu_class, alloc];
            let menu: *mut AnyObject = msg_send![menu, init];
            let title = NSString::from_str("Prism Code");
            let _: () = msg_send![menu, setTitle: &*title];

            let _: () = msg_send![menu, addItem: open_item];
            let _: () = msg_send![menu, addItem: sep];
            let _: () = msg_send![menu, addItem: recent_parent];
            if !current_item_ptr.is_null() {
                let _: () = msg_send![menu, addItem: current_item_ptr];
            }

            // 旧 menu release 一次（AtomicPtr swap 后旧的引用计数 -1）。
            let old = DOCK_MENU.swap(menu, Ordering::AcqRel);
            if !old.is_null() {
                let _: *mut AnyObject = msg_send![old, release];
            }
        }
    }

    /// 按字符数截断字符串（多字节安全；字节切片会落在 UTF-8 字符中间 panic）
    fn truncate_chars(s: &str, n: usize) -> String {
        s.chars().take(n).collect()
    }
}

// 把 macOS 实现 re-export 出去，lib.rs 直接调 `dock_menu::install_dock_menu_hook`。
#[cfg(target_os = "macos")]
pub use macos::{install_dock_menu_hook, rebuild_dock_menu};

#[cfg(not(target_os = "macos"))]
pub fn install_dock_menu_hook(_app:&tauri::AppHandle) {}
#[cfg(not(target_os = "macos"))]
pub fn rebuild_dock_menu(_app: &tauri::AppHandle, _state: &DockStatePayload) {}
