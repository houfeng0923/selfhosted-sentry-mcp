# sentry-mcp

Sentry MCP 服务，支持自托管 Sentry，自动读取配置，省心省力！

## 亮点

- 自动读取 `~/.sentryclirc`（兼容 sentry-cli 配置），不用手动 export 环境变量
- 环境变量优先，没配就用 rc 文件
- 支持 Sentry 项目/issue/event 查询、状态修改、评论等常用操作

## 配置方法

### 推荐：直接用 `~/.sentryclirc`

```ini
[auth]
token=你的SentryToken

[defaults]
url=https://你的sentry地址/
org=你的组织slug
```

### 也支持环境变量（优先级更高）

- SENTRY_URL
- SENTRY_AUTH_TOKEN
- SENTRY_ORG_SLUG

## 安装 & 启动

```bash
npm install
npm run build
node build/index.js
```

## MCP 客户端配置示例

```json
"sentry-mcp": {
  "command": "node",
  "args": [
    "<全路径>/sentry-mcp/build/index.js"
  ],
  "env": {},
  "disabled": false,
  "autoApprove": [],
  "transportType": "stdio"
}
```

## 支持的工具

- get_sentry_issue
- list_sentry_projects
- list_sentry_issues
- get_sentry_event_details
- update_sentry_issue_status
- create_sentry_issue_comment


