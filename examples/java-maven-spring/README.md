# Java 运行/调试夹具（Maven 聚合 + Spring Boot）

Prism Code 的 Maven 反应堆扫描、运行配置生成与 Spring 索引都拿这个工程做黄金夹具，
`src-tauri/tests/java_maven_spring_fixture.rs` 直接读取本目录断言结果。

- 根 `pom.xml`：`packaging=pom` 的聚合器，**不产可运行构件**，必须不出现在运行配置与芯片里。
- `app/pom.xml`：唯一子模块，在 `<build><plugins>` 里直接声明 `spring-boot-maven-plugin`，
  因此是 `spring-boot.maven`（`spring-boot:run`）。
- `app/src/main/java/com/example/app/Application.java`：`@RestController` + `@Value("${app.greeting}")`，
  提供 `GET /hello`。
- `app/src/main/resources/application.properties`：`server.port=8081`、`app.greeting=hello`。

## 手工验收

```bash
# 1. 先跑一次构建（首次会从 Maven 中央仓下载依赖；离线环境请跳过）
cd examples/java-maven-spring && mvn -B -ntp package

# 2. 在 Prism Code 里打开本目录，底部终端面板顶栏应出现 app 组的芯片：
#    测试 / 打包 / 清理 / 运行 / 调试
# 3. 点「运行」→ 终端里出现 Spring Boot 启动日志，访问 http://127.0.0.1:8081/hello
# 4. 在 Application.java 的 hello() 首行下断点，点「调试」→ 命中后变量区应有 name 与 message
```

## 损坏用例

把 `app/pom.xml` 里任意一对标签写坏（例如删掉一个 `</artifactI` 的斜杠），
`maven_scan` 应当只返回 `pom.xml 解析失败` 诊断，不崩溃、不抛异常。
