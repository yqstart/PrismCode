//! 调试适配器的打包契约：清单、JRE 模块与前端调用点必须互相吻合。
//!
//! 这三处分属 JSON 清单、jlink 脚本与 TypeScript，任何一个单独改动都不会报错，
//! 但组合起来就是「点了调试没反应」——所以在这里钉住。

use std::fs;
use std::path::PathBuf;

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..")
}

fn read(relative: &str) -> String {
    let path = repo_root().join(relative);
    fs::read_to_string(&path).unwrap_or_else(|error| {
        panic!("读取 {} 失败: {error}", path.display());
    })
}

fn manifest() -> serde_json::Value {
    serde_json::from_str(&read("third_party/debug-adapter/manifest.json")).expect("清单是合法 JSON")
}

#[test]
fn adapter_manifest_pins_the_upstream_binary() {
    let manifest = manifest();
    assert_eq!(manifest["version"], "0.53.1");
    assert_eq!(
        manifest["jarName"],
        "com.microsoft.java.debug.plugin-0.53.1.jar"
    );
    assert_eq!(
        manifest["archiveURL"],
        "https://repo1.maven.org/maven2/com/microsoft/java/com.microsoft.java.debug.plugin/0.53.1/com.microsoft.java.debug.plugin-0.53.1.jar"
    );
    // Maven Central 只有 .sha1，SHA256 是我们自己算的；两者都钉住，
    // 换版本时不会只改一半
    assert_eq!(
        manifest["archiveSHA256"],
        "4f4778d452a6a0665536f43ce4e32403a24be6593336b80dc85a322912859e24"
    );
    assert_eq!(
        manifest["archiveSHA1"],
        "dfc433d62cbb5bb71cfe87f1ee5363c549dccc92"
    );
    assert_eq!(manifest["archiveSize"].as_u64(), Some(2_960_556));
    assert_eq!(manifest["license"], "EPL-1.0");
}

#[test]
fn jlink_module_list_covers_the_adapter_requirements() {
    let manifest = manifest();
    let script = read("scripts/prepare-jre.mjs");
    let required = manifest["requiredJreModules"]
        .as_array()
        .expect("requiredJreModules 是数组");
    assert!(!required.is_empty());
    for module in required {
        let name = module.as_str().expect("模块名是字符串");
        assert!(
            script.contains(&format!("\"{name}\"")),
            "jlink 模块清单缺少 {name}：java-debug 会以 NoClassDefFoundError 失败"
        );
    }
    // 调试目标侧需要的 agent 也要在镜像里
    assert!(script.contains("\"jdk.jdwp.agent\""));
}

#[test]
fn adapter_contract_matches_the_frontend_call_site() {
    let manifest = manifest();
    // transport 决定 Rust 侧用 socket 还是子进程：改这里必须同时改 dap.rs
    assert_eq!(manifest["transport"], "tcp");
    let start_command = manifest["startCommand"].as_str().expect("启动命令");
    assert_eq!(start_command, "vscode.java.startDebugSession");
    let frontend = read("src/features/java/javaSession.ts");
    assert!(
        frontend.contains(start_command),
        "前端没有向 JDTLS 发 {start_command}，调试链路会拿不到端口"
    );
    // 插件注入方式：jdt.ls 只认 initializationOptions.bundles
    assert_eq!(manifest["pluginInjection"], "initializationOptions.bundles");
    let jdtls = read("src/features/java/jdtls.ts");
    assert!(jdtls.contains("bundles"), "initializationOptions 缺少 bundles");
}

#[test]
fn prepare_script_writes_the_descriptor_the_rust_probe_reads() {
    let script = read("scripts/prepare-debug-adapter.mjs");
    let dap = read("src-tauri/src/commands/dap.rs");
    // Rust 的 dap_probe_adapter 只认 jar 旁边的 adapter.json；脚本必须写它
    assert!(script.contains("adapter.json"));
    assert!(dap.contains("adapter.json"));
    // 打包脚本把版本与 jar 文件名写进描述，两处命名必须同源
    assert!(script.contains("manifest.jarName"));
    assert!(script.contains("manifest.version"));
    // 校验和与大小都必须校验，否则等于没钉版本
    assert!(script.contains("manifest.archiveSHA256"));
    assert!(script.contains("manifest.licenseSHA256"));
    assert!(script.contains("manifest.archiveSize"));
    // 缺 jar 时的救急入口
    assert!(dap.contains("PRISMCODE_JAVA_DEBUG_JAR"));
    assert!(dap.contains("PRISMCODE_JAVA_DEBUG_HOME"));
}

#[test]
fn settings_adapter_path_is_plumbed_end_to_end() {
    // 设置面板 → 前端传参 → Rust 覆盖解析，三段缺一段就等于设置项失效
    let types = read("src/shared/types.ts");
    assert!(types.contains("adapterPath: string"));
    let modal = read("src/features/settings/SettingsModal.vue");
    assert!(modal.contains("java.settings.adapterPath"));
    assert!(modal.contains("patchJava({ adapterPath:"));
    let session = read("src/features/debug/dapSession.ts");
    assert!(session.contains("adapterPath"));
    let dap = read("src-tauri/src/commands/dap.rs");
    assert!(dap.contains("adapter_path: Option<String>"));
    assert!(dap.contains("fn adapter_from_override"));
}
