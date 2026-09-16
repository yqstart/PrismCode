//! macOS Overlay 标题栏：底色 + 红绿灯垂直居中

use tauri::WebviewWindow;

#[cfg(target_os = "macos")]
struct MainThreadSafe<T>(T);

#[cfg(target_os = "macos")]
// SAFETY: 该包装值只会被投递到 GCD 主队列，并只在那里访问。
unsafe impl<T> Send for MainThreadSafe<T> {}

#[cfg(target_os = "macos")]
fn close_main_thread_window(window: MainThreadSafe<objc2::rc::Retained<objc2_app_kit::NSWindow>>) {
    window.0.close();
}

/// CSS 端 `--titlebar-height: 38px`；macOS 上 1 CSS px = 1 逻辑点（pt），
/// 与 backingScaleFactor 无关（Retina 屏 1pt = 2×2 物理像素，但 NSView 坐标始终用逻辑点）。
const TITLEBAR_HEIGHT: f64 = 38.0;
/// 红绿灯左侧边距（逻辑点）
const TRAFFIC_LIGHT_X: f64 = 14.0;
const SPACE_BETWEEN: f64 = 20.0;
const BUTTON_SIZE: f64 = 14.0;

/// AppKit 默认不会让失焦窗口里的标题栏按钮响应首次鼠标事件，
/// 表现为第一次点击只激活窗口、第二次点击才真正关闭。
#[cfg(target_os = "macos")]
unsafe extern "C-unwind" fn traffic_light_accepts_first_mouse(
    _this: *mut objc2::runtime::AnyObject,
    _cmd: objc2::runtime::Sel,
    _event: *mut objc2::runtime::AnyObject,
) -> bool {
    true
}

/// 只给当前窗口的原生红绿灯按钮增加首次点击响应，不改 WebView 内的按钮行为。
#[cfg(target_os = "macos")]
fn enable_traffic_light_first_mouse(button: &objc2_app_kit::NSButton) {
    use objc2::ffi::{class_replaceMethod, object_getClass};
    use objc2::runtime::{AnyClass, AnyObject, Imp};
    use std::mem;

    unsafe {
        let class = object_getClass((button as *const objc2_app_kit::NSButton).cast::<AnyObject>());
        if class.is_null() {
            return;
        }

        let imp: Imp = mem::transmute(traffic_light_accepts_first_mouse as *const ());
        // 直接覆盖按钮所属类的方法，确保私有标题栏按钮子类也能生效。
        let _ = class_replaceMethod(
            class as *mut AnyClass,
            objc2::sel!(acceptsFirstMouse:),
            imp,
            b"B@:@\0".as_ptr() as *const i8,
        );
    }
}

/// 设置 macOS 原生标题栏底色（r/g/b：0–255）。非 macOS 为空操作。
///
/// ⚠️ 主线程约定：Tauri 2 所有 command（含同步 command）都 spawn 到 tokio
/// 异步线程池执行，而 NSWindow/NSView 的 UI 方法与 method swizzle 必须在
/// 主线程调用。此处统一经 `run_on_main_thread` 切回主线程（与
/// lib.rs 中 set_dock_menu 同一范式），否则存在崩溃/竞态/布局异常风险。
#[tauri::command]
pub fn set_titlebar_background(
    window: WebviewWindow,
    r: f64,
    g: f64,
    b: f64,
) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let win = window.clone();
        window
            .run_on_main_thread(move || {
                let _ = apply_titlebar_background(&win, r, g, b);
                // 改底色会触发 AppKit 重排，立刻补一次红绿灯位置
                let _ = apply_traffic_lights(&win);
            })
            .map_err(|e| format!("无法在主线程更新标题栏底色：{e}"))?;
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (window, r, g, b);
    }
    Ok(())
}

/// 将红绿灯垂直居中到 Overlay 标题栏。非 macOS 为空操作。
/// 主线程约定同 `set_titlebar_background`。
#[tauri::command]
pub fn sync_traffic_lights(window: WebviewWindow) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let win = window.clone();
        window
            .run_on_main_thread(move || {
                let _ = apply_traffic_lights(&win);
            })
            .map_err(|e| format!("无法在主线程同步红绿灯：{e}"))?;
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = window;
    }
    Ok(())
}

/// 在清理完前端会话后，从 AppKit 主线程直接关闭当前窗口。
///
/// 红绿灯的 close-requested 事件可能仍处于 Tauri IPC 事件链中，此时再从
/// WebView 调用 `Window.close/destroy` 会排在同一条链后面，导致窗口只完成
/// 前端清理却没有真正消失。直接调用 NSWindow.close 绕过这条等待链；前端
/// 已先把 allowNativeClose 置为 true，因此由此产生的关闭事件会正常放行。
#[tauri::command]
pub fn close_window(window: WebviewWindow) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        use dispatch2::DispatchQueue;
        use objc2::rc::Retained;
        use objc2_app_kit::NSWindow;

        let ns_window_ptr = window
            .ns_window()
            .map_err(|e| format!("无法获取 NSWindow：{e}"))?
            as *mut NSWindow;
        if ns_window_ptr.is_null() {
            return Err("无法获取 NSWindow".into());
        }

        // Tauri 的 run_on_main_thread 依赖同一条事件循环消息队列；红叉关闭
        // 事件处于等待状态时，该任务可能排在当前事件之后。改用 GCD 主队列，
        // 并额外 retain 窗口，确保异步执行时原生对象仍然有效。
        let ns_window = unsafe { Retained::retain(ns_window_ptr) }
            .ok_or_else(|| "无法保留 NSWindow".to_string())?;
        let ns_window = MainThreadSafe(ns_window);
        DispatchQueue::main().exec_async(move || close_main_thread_window(ns_window));
    }
    #[cfg(not(target_os = "macos"))]
    {
        window.destroy().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(target_os = "macos")]
pub fn apply_titlebar_background(
    window: &WebviewWindow,
    r: f64,
    g: f64,
    b: f64,
) -> Result<(), String> {
    use objc2_app_kit::{NSColor, NSWindow};

    let ns_window_ptr = window.ns_window().map_err(|e| e.to_string())? as *mut NSWindow;
    if ns_window_ptr.is_null() {
        return Err("无法获取 NSWindow".into());
    }
    // SAFETY: ns_window 由 Tauri 持有，窗口存活期内指针有效
    let ns_window = unsafe { &*ns_window_ptr };
    let bg = NSColor::colorWithRed_green_blue_alpha(r / 255.0, g / 255.0, b / 255.0, 1.0);
    ns_window.setBackgroundColor(Some(&bg));
    Ok(())
}

/// 按 TITLEBAR_HEIGHT 重排红绿灯，使其与前端 TitleBar 折叠按钮垂直对齐。
///
/// 关键：title_bar_container（NSTitlebarContainerView）必须同时设置
/// size.height 和 origin.y——
/// - size.height: 拉高容器到 38pt（默认是 32pt，AppKit 标准值；旧注释写的
///   28pt 是过时数据）
/// - origin.y: 把容器底边对齐窗口顶（容器底 y = window.height，容器顶 y = window.height - 38）
/// 之后再用 setFrameOrigin 摆按钮，按钮 origin_y 用**相对容器底**算：
/// `origin_y = (TITLEBAR_HEIGHT - button_h) / 2`。
/// 注意坐标系：按钮是 NSTitlebarView（parent1）的子视图，origin_y 相对的是
/// parent1 的左下角；本函数同时把 NSTitlebarView 高度拉到 38pt，
/// 所以相对 parent1 底算出的 12pt 同样居中（按钮中心距顶 19pt）。
/// 实测层级：按钮（_NSThemeCloseWidget）→ NSTitlebarView → NSTitlebarContainerView → NSThemeFrame。
///
/// ⚠️ 绝不能配置 tauri.conf.json / WebviewWindow 的 `trafficLightPosition`：
/// tao 0.35 的 `view.rs draw_rect` 每次窗口重绘都会调 `inset_traffic_lights`，
/// 把容器高度重置为 `button_h + traffic_light_inset.y`（≈24pt）并重设容器 origin，
/// 本函数设的按钮 origin_y=12 在 24pt 容器下变成中心距顶 6pt → 红绿灯贴顶被裁。
/// 删除该配置后 tao 不再插手，位置完全由本函数（setup 一次 + 窗口事件钩子）接管。
/// （历史注：这里原本写 tao 每次重绘都会重置——已证伪。tao 仅在配置了
/// trafficLightPosition 时才在 drawRect 里调用 inset_traffic_lights；
/// 未配置时 drawRect 是空操作，罪魁祸首是 AppKit 自身，见下。）
///
/// AppKit 重置布局的触发点（macOS 26 + Xcode 26 实测）：
/// - 窗口 resize / 移动到另一块屏（ScaleFactorChanged）：NSThemeFrame layout
///   把 container 高度压回 32pt、按钮 origin 打回 (x, 9)。此时按钮中心距顶
///   = 38 - (9+7) = 22pt，比居中的 19pt 低 3pt——视觉上灯整体偏下，
///   与折叠按钮错位约 3pt。
/// - 进出原生全屏：AppKit 接管按钮布局（container 被挪到屏外），本函数全程跳过。
/// - 单纯失焦/获焦、最小化/还原、拖动窗口：不重置，可放心监听 Focused 做兜底。
///
/// 全屏时跳过，避免与系统全屏过渡动画抢布局。
#[cfg(target_os = "macos")]
pub fn apply_traffic_lights(window: &WebviewWindow) -> Result<(), String> {
    use objc2_app_kit::{NSView, NSWindow, NSWindowButton, NSWindowStyleMask};
    use objc2_foundation::NSPoint;

    let ns_window_ptr = window.ns_window().map_err(|e| e.to_string())? as *mut NSWindow;
    if ns_window_ptr.is_null() {
        return Err("无法获取 NSWindow".into());
    }
    // SAFETY: ns_window 由 Tauri 持有，窗口存活期内指针有效
    let ns_window = unsafe { &*ns_window_ptr };

    // 全屏过渡中 AppKit 接管按钮布局，强行 setFrame 会造成跳动
    if ns_window
        .styleMask()
        .contains(NSWindowStyleMask::FullScreen)
    {
        return Ok(());
    }

    let close = ns_window
        .standardWindowButton(NSWindowButton::CloseButton)
        .ok_or_else(|| "无关闭按钮".to_string())?;
    let miniaturize = ns_window
        .standardWindowButton(NSWindowButton::MiniaturizeButton)
        .ok_or_else(|| "无最小化按钮".to_string())?;
    let zoom = ns_window
        .standardWindowButton(NSWindowButton::ZoomButton)
        .ok_or_else(|| "无缩放按钮".to_string())?;

    enable_traffic_light_first_mouse(&close);
    enable_traffic_light_first_mouse(&miniaturize);
    enable_traffic_light_first_mouse(&zoom);

    // 标题栏容器：用 setFrame 同时设 size.height + origin.y。
    // 容器底 = 窗口顶（y = window.frame.height），容器顶 = window.height - 38。
    // 这一步必须做——少 setFrame 只 setFrameSize 的话，origin.y 没对齐，
    // 后面按钮 origin_y 相对容器底算出来的位置是错的（按钮会消失或偏到窗口外）。
    // 层级实测（macOS 26）：按钮.superview() = NSTitlebarView（parent1），
    // parent1.superview() = NSTitlebarContainerView（parent2）。
    // 按钮 origin 相对的是 parent1 的左下角，不是 parent2 的——
    // 所以两个层级都要拉高到 38pt（AppKit 默认都是 32pt），
    // 按钮 origin_y = (38 - button_h) / 2 = 12 相对 parent1 底，
    // 按钮中心距窗口顶 = 38 - (12+7) = 19pt，正好与前端 38px 标题栏居中对齐。
    let title_bar_view = unsafe {
        close
            .superview()
            .ok_or_else(|| "无标题栏视图".to_string())?
    };
    let title_bar_container = unsafe {
        title_bar_view
            .superview()
            .ok_or_else(|| "无标题栏容器".to_string())?
    };
    let win_h = ns_window.frame().size.height;
    let mut container_rect = NSView::frame(&*title_bar_container);
    container_rect.size.height = TITLEBAR_HEIGHT;
    container_rect.origin.y = win_h - TITLEBAR_HEIGHT;
    title_bar_container.setFrame(container_rect);
    // NSTitlebarView 与 container 等高（默认 32pt 也要拉到 38pt），
    // 按钮 origin 相对它算，基准才与 container 一致。
    let mut title_view_rect = NSView::frame(&*title_bar_view);
    title_view_rect.size.height = TITLEBAR_HEIGHT;
    title_view_rect.origin.x = 0.0;
    title_view_rect.origin.y = 0.0;
    title_bar_view.setFrame(title_view_rect);

    // 按钮居中：origin_y 相对 NSTitlebarView（parent1）底部算。
    // 按钮中心距窗口顶 = TITLEBAR_HEIGHT - (origin_y + button_h / 2) = 19pt，
    // 与前端 38px 标题栏的折叠按钮（align-items:center → 中线 19px）对齐。
    // origin_y = (TITLEBAR_HEIGHT - button_h) / 2。
    let close_rect = NSView::frame(&*close);
    let button_h = if close_rect.size.height > 0.0 {
        close_rect.size.height
    } else {
        BUTTON_SIZE
    };
    let origin_y = ((TITLEBAR_HEIGHT - button_h) / 2.0).round().max(0.0);

    // 实测按钮间距，未就绪时用兜底值
    let live_space_between = NSView::frame(&*miniaturize).origin.x - close_rect.origin.x;
    let space_between = if live_space_between > 0.0 {
        live_space_between
    } else {
        SPACE_BETWEEN
    };
    let buttons = [close, miniaturize, zoom];
    for (i, button) in buttons.iter().enumerate() {
        let origin = NSPoint::new(TRAFFIC_LIGHT_X + (i as f64 * space_between), origin_y);
        button.setFrameOrigin(origin);
    }

    Ok(())
}

/// 在窗口上安装红绿灯同步：启动时及布局实际变化时重排。
#[cfg(target_os = "macos")]
pub fn install_traffic_light_hooks(window: &WebviewWindow) {
    use tauri::WindowEvent;

    // 立即调一次：button_h 已兜底 14 逻辑点，setup 阶段能拿到按钮 frame → 摆到正确位置
    let _ = apply_traffic_lights(window);
    // 后续仅在 Resized/Moved/ThemeChanged/ScaleFactorChanged/Focused 等真实布局
    // 事件触发时重排：
    // - Resized：窗口尺寸变化必重置 container（实测）→ 立刻重排。
    // - Moved：跨屏拖动会换 backingScaleFactor，但 ScaleFactorChanged 只在 DPI
    //   真变时才发；同 DPI 跨屏也可能重置主题帧。Moved 高频但本函数开销小
    //   （几次 setFrame），直接重排即可。
    // - Focused(true)：原生全屏进出 / 系统重置布局后没有 Resized 事件，
    //   获焦是最后的兜底机会。点击守卫保证键鼠按下期间不重排——失焦窗口点
    //   红绿灯时聚焦与鼠标事件相邻，此时 setFrame 会抢在鼠标处理期间挪走按钮、
    //   导致首次点击失效（旧注释的历史教训），所以聚焦重排前先查鼠标状态。
    // —— 不用 80/250/700/1600ms 延迟补排，避免与 AppKit 持续 layout 反复
    // setFrame 导致视觉抖动。

    let win = window.clone();
    window.on_window_event(move |event| {
        match event {
            WindowEvent::Resized(_)
            | WindowEvent::Moved(_)
            | WindowEvent::ThemeChanged(_)
            | WindowEvent::ScaleFactorChanged { .. } => {
                let _ = apply_traffic_lights(&win);
            }
            WindowEvent::Focused(true) => {
                if mouse_button_pressed() {
                    // 用户正按着键鼠（大概率是点红绿灯），跳过这次，等下次事件
                    return;
                }
                let _ = apply_traffic_lights(&win);
            }
            _ => {}
        }
    });
}

/// 当前是否有鼠标按键处于按下状态（左/右/中任一）。
/// 用于 Focused(true) 兜底重排前的点击守卫：失焦窗口点红绿灯时，
/// AppKit 会先发聚焦事件再派发鼠标点击；若在两次事件之间 setFrame 挪走按钮，
/// 本次点击会落空（表现为“第一次点只聚焦不关窗”）。有键按下时跳过重排。
#[cfg(target_os = "macos")]
fn mouse_button_pressed() -> bool {
    use objc2_app_kit::NSEvent;
    NSEvent::pressedMouseButtons() != 0
}
