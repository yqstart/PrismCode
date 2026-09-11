# 安全政策

## 支持范围

当前维护版本：

| 版本 | 支持 |
|---|---|
| `0.1.x`（默认分支） | ✅ 接受安全报告 |
| 更早 / 未发布的实验分支 | ❌ 仅尽力处理 |

## 报告漏洞

请**不要**在公开 Issue 中披露可利用的安全漏洞。

优先使用 GitHub 私有漏洞报告：

1. 打开仓库 **Security → Advisories → Report a vulnerability**
2. 或访问：https://github.com/yqstart/PrismCode/security/advisories/new

若无法使用上述渠道，可通过仓库维护者 GitHub 主页私信，主题注明「Prism Code Security」。

报告请尽量包含：

- 影响版本 / 提交
- 复现步骤或 PoC（概念验证）
- 预期影响（本地文件越权、命令注入、凭据泄露等）
- 是否已有公开讨论或利用

## 处理承诺

- 收到报告后，维护者会尽快确认（通常数个工作日内）
- 确认有效后会私下协调修复与披露时间
- 修复发布后，可在 Release / Advisory 中致谢（除非你要求匿名）

## 安全相关约定

- 不在仓库中提交密钥、Token、私钥、签名证书
- SSH 主机密码不落盘（仅会话内存）；密钥路径由用户本机配置
- 示例环境变量使用占位符，见 `examples/playground/.env.example`
