//! 黄金夹具端到端：直接调命令层背后的服务端入口，不需要 IPC。
//! 夹具在 `../examples/java-maven-spring`；改夹具就必须同步改这里的断言。

use prismcode_lib::commands::maven::scan_reactor;
use prismcode_lib::commands::spring::{index as spring_index, SpringIndexRequest};
use prismcode_lib::commands::runconfig::{
    generate_run_configurations, launch_plan, resolve, ToolchainCandidate,
};
use std::fs;
use std::path::{Path, PathBuf};

fn fixture() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../examples/java-maven-spring")
}

fn maven_candidate() -> Vec<ToolchainCandidate> {
    vec![ToolchainCandidate {
        id: "maven:mvn".to_string(),
        kind: "maven".to_string(),
        path: "mvn".to_string(),
        version: "3.9.16".to_string(),
    }]
}

#[test]
fn maven_scan_keeps_two_modules_and_marks_the_root_as_aggregate() {
    let scan = scan_reactor(&fixture(), &[]).expect("扫描夹具");
    let paths: Vec<&str> = scan
        .modules
        .iter()
        .map(|module| module.relative_path.as_str())
        .collect();
    assert_eq!(paths, vec![".", "app"]);
    assert!(scan.diagnostics.is_empty(), "{:?}", scan.diagnostics);
    assert!(scan.modules[0].is_aggregator());
    assert_eq!(scan.modules[0].artifact_id, "prism-demo");
    assert!(scan.modules[1].applies_plugin("spring-boot-maven-plugin"));
    // 根 pom 的 pluginManagement 不算应用：app 是唯一带插件的模块
    assert!(!scan.modules[1].is_aggregator());
}

#[test]
fn generate_reports_spring_boot_run_only_on_the_app_module() {
    let result = generate_run_configurations(&fixture());
    let ids: Vec<&str> = result
        .configurations
        .iter()
        .map(|item| item.id.as_str())
        .collect();
    assert!(ids.contains(&"spring-boot.maven:app"), "{ids:?}");
    assert!(ids.contains(&"maven.module:app:test"), "{ids:?}");
    // 聚合根不产出任何可运行配置
    assert!(!result.configurations.iter().any(|item| item.module == "."));
    assert!(result.diagnostics.is_empty(), "{:?}", result.diagnostics);

    let run = result
        .configurations
        .iter()
        .find(|item| item.kind == "spring-boot.maven")
        .expect("spring-boot 配置");
    assert_eq!(run.args.last().map(String::as_str), Some("spring-boot:run"));
    assert_eq!(run.cwd, ".");
    assert_eq!(run.toolchain.as_deref(), Some("maven"));
}

#[test]
fn resolve_needs_no_local_layer_and_is_clean_with_a_maven_toolchain() {
    let result = resolve(&fixture(), &maven_candidate(), None).expect("解析");
    assert!(result.diagnostics.is_empty(), "{:?}", result.diagnostics);
    assert!(result
        .effective
        .iter()
        .any(|item| item.id == "spring-boot.maven:app"));
}

#[test]
fn debug_plan_injects_jdwp_into_the_spring_boot_goal() {
    let plan = launch_plan(
        &fixture(),
        "spring-boot.maven:app",
        None,
        true,
        Some(5005),
        None,
    )
    .expect("调试计划");
    assert_eq!(plan.debug_port, Some(5005));
    assert_eq!(plan.cwd, fixture().canonicalize().unwrap().display().to_string());
    assert_eq!(
        plan.args,
        vec![
            "-B",
            "-ntp",
            "-pl",
            "app",
            "-Dspring-boot.run.jvmArguments=-agentlib:jdwp=transport=dt_socket,server=y,suspend=y,address=127.0.0.1:5005",
            "spring-boot:run",
        ]
    );
    assert!(plan.env.is_empty());

    // 普通 Maven 目标没有插件参数通道，JDWP 只能走 MAVEN_OPTS
    let plan = launch_plan(
        &fixture(),
        "maven.module:app:test",
        None,
        true,
        Some(5006),
        None,
    )
    .expect("调试计划");
    assert_eq!(
        plan.env.get("MAVEN_OPTS").map(String::as_str),
        Some("-agentlib:jdwp=transport=dt_socket,server=y,suspend=y,address=127.0.0.1:5006")
    );
    assert!(!plan.args.iter().any(|value| value.contains("jdwp")));
}

#[test]
fn demo_run_plan_matches_the_readme_commands() {
    let plan = launch_plan(&fixture(), "maven.module:app:package", None, false, None, None)
        .expect("运行计划");
    assert_eq!(plan.command, "mvn");
    assert_eq!(plan.args, vec!["-B", "-ntp", "-pl", "app", "-DskipTests", "package"]);
}

/// Spring 索引默认会扫 `~/.m2`；夹具断言只关心项目内的事实，用空仓库保持确定性。
fn spring_request(root: &Path, empty_repository: &Path) -> SpringIndexRequest {
    SpringIndexRequest {
        root: root.display().to_string(),
        metadata_repositories: vec![empty_repository.display().to_string()],
        ..SpringIndexRequest::default()
    }
}

#[test]
fn spring_index_finds_the_hello_endpoint_and_the_value_reference() {
    let empty_repository = tempfile::tempdir().expect("空仓库");
    let result = spring_index(spring_request(&fixture(), empty_repository.path())).expect("索引");
    assert!(result.diagnostics.is_empty(), "{:?}", result.diagnostics);

    assert_eq!(result.endpoints.len(), 1, "{:?}", result.endpoints);
    let endpoint = &result.endpoints[0];
    assert_eq!(endpoint.method, "GET");
    assert_eq!(endpoint.route, "/hello");
    assert_eq!(endpoint.path, "app/src/main/java/com/example/app/Application.java");

    let values: Vec<(&str, &str)> = result
        .values
        .iter()
        .map(|value| (value.name.as_str(), value.value.as_str()))
        .collect();
    assert_eq!(values, vec![("app.greeting", "hello"), ("server.port", "8081")]);

    assert!(result
        .beans
        .iter()
        .any(|bean| bean.name == "application" && bean.type_name == "Application"));
}

#[test]
fn spring_index_reports_the_value_reference_once_the_property_is_gone() {
    // 去掉 app.greeting：唯一能报出这条诊断的依据就是夹具里那处 @Value 引用
    let dir = tempfile::tempdir().expect("临时目录");
    for relative in [
        "app/src/main/resources/application.properties",
        "app/src/main/java/com/example/app/Application.java",
    ] {
        let target = dir.path().join(relative);
        fs::create_dir_all(target.parent().expect("父目录")).expect("建目录");
        let content = fs::read_to_string(fixture().join(relative)).expect("读夹具");
        fs::write(&target, content.replace("app.greeting=hello", "app.other=hello"))
            .expect("写文件");
    }
    let empty_repository = tempfile::tempdir().expect("空仓库");
    let result = spring_index(spring_request(dir.path(), empty_repository.path())).expect("索引");
    assert_eq!(result.diagnostics.len(), 1, "{:?}", result.diagnostics);
    assert_eq!(result.diagnostics[0].message, "未找到配置项 app.greeting");
    assert_eq!(
        result.diagnostics[0].path,
        "app/src/main/java/com/example/app/Application.java"
    );
    assert_eq!(result.diagnostics[0].line, 18);
}

fn copy_fixture(destination: &Path) {
    for relative in ["pom.xml", "app/pom.xml"] {
        let target = destination.join(relative);
        fs::create_dir_all(target.parent().expect("父目录")).expect("建目录");
        fs::copy(fixture().join(relative), &target).expect("复制夹具");
    }
}

#[test]
fn broken_module_pom_yields_diagnostics_instead_of_a_crash() {
    let dir = tempfile::tempdir().expect("临时目录");
    copy_fixture(dir.path());
    // 删一个尖括号：标签错配，解析必须失败
    fs::write(
        dir.path().join("app/pom.xml"),
        "<project><artifactId>app</item></project>",
    )
    .expect("写坏 pom");

    let scan = scan_reactor(dir.path(), &[]).expect("扫描不报错");
    assert_eq!(
        scan.modules
            .iter()
            .map(|module| module.relative_path.as_str())
            .collect::<Vec<_>>(),
        vec!["."]
    );
    assert_eq!(scan.diagnostics.len(), 1);
    assert_eq!(scan.diagnostics[0].path, "app/pom.xml");
    assert_eq!(scan.diagnostics[0].message, "pom.xml 解析失败");

    // 模块图残缺不等于单文件项目：不能给出「运行当前文件」
    let result = generate_run_configurations(dir.path());
    assert!(result.configurations.is_empty(), "{:?}", result.configurations);
    assert_eq!(result.diagnostics.len(), 1);
    assert_eq!(result.diagnostics[0].path, "app/pom.xml");
}
