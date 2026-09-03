# 部署

不用 Docker，不装任何 npm 包，只要 **Node 18+**。实测常驻内存 **12MB**，
适合塞进已经跑满东西的小机器。

- [1. 传文件](#1-传文件)
- [2. 配置](#2-配置)
  - [模式 A：`proxy`（前面已有 IdP）](#模式-aproxy前面已有-idp)
  - [模式 B：`oidc`（应用自己登录）](#模式-boidc应用自己登录)
  - [模式 C：`none`（只调试）](#模式-cnone只调试)
- [3. 开机自启](#3-开机自启)
- [4. 反向代理](#4-反向代理)
- [5. 迁入数据](#5-迁入数据)
- [6. 加人](#6-加人)
- [7. 备份](#7-备份)
- [接口](#接口)
- [排查](#排查)

---

## 1. 传文件

服务器上只需要 `server/` 这个目录，里面已经有构建好的 `public/index.html`：

```bash
rsync -av --exclude data server/ user@host:/opt/finance-dashboard/server/
```

或者直接在服务器上 `git clone` 然后 `node src/build.js`。两种都行 ——
构建不需要任何依赖，`private/seed-real.json` 不存在时会自动跳过本地版。

以后更新：

```bash
tar czf - server/server.js server/public \
  | ssh host "tar xzf - -C /opt/finance-dashboard"
ssh host "systemctl restart finance-dashboard"
```

## 2. 配置

```bash
cd /opt/finance-dashboard/server
cp config.example.json config.json
```

也可以完全不写 `config.json`，只用环境变量（systemd 场景更方便）：
`PORT` `HOST` `AUTH_MODE` `DATA_DIR` `STATIC_DIR` `OIDC_CLIENT_SECRET`。
环境变量优先级高于配置文件，启动日志里会打印实际生效的来源。

### 模式 A：`proxy`（前面已有 IdP）

适用于 **Authelia / Authentik 已经作为 forward-auth 挡在反向代理前面**的情况。
应用自己不做登录，身份完全来自反代注入的请求头。

```jsonc
{
  "authMode": "proxy",
  "host": "127.0.0.1",
  "port": 8788,
  "allowedEmails": [],            // 空 = 只要 IdP 放行就行；填了就只有名单内能用
  "proxy": {
    "trustedIps": ["127.0.0.1", "::1", "::ffff:127.0.0.1"],
    "idHeader": "remote-user",         // Authelia
    "emailHeader": "remote-email",
    "nameHeader": "remote-name",
    "fallbackIdHeader": "x-authentik-uid",     // Authentik
    "fallbackEmailHeader": "x-authentik-email",
    "fallbackNameHeader": "x-authentik-name"
  }
}
```

> ### ⚠️ 这个模式下端口必须绑回环
>
> 应用**无条件信任**那几个身份头。**一旦对公网监听，任何人自带一个
> `Remote-User: 张三` 的头就是张三。**
>
> 所以：`host` 必须是 `127.0.0.1`，防火墙**不要**放行这个端口，
> `trustedIps` 只填反代的地址。这和 frp 面板、很多自托管应用是同一套信任模型。
>
> 反代那一侧也要注意：**必须由反代覆盖掉客户端传来的同名头**，不能透传。
> Caddy 的 `forward_auth` + `copy_headers` 默认就是覆盖，是安全的（下面有验证方法）。

中文显示名如果被反代做了百分号编码（HTTP 头只能放 Latin-1），应用会自动解码。

### 模式 B：`oidc`（应用自己登录）

在你的 IdP 里新建一个 OAuth2/OIDC Provider，回调地址填 `https://你的域名/auth/callback`。

```jsonc
{
  "authMode": "oidc",
  "allowedEmails": ["you@example.com"],
  "oidc": {
    "issuer": "https://auth.example.com/application/o/finance/",
    "clientId": "你的 client id",
    "clientSecret": "",                                  // 用环境变量传，别写这里
    "redirectUri": "https://money.example.com/auth/callback",
    "scope": "openid profile email"
  }
}
```

```bash
echo 'OIDC_CLIENT_SECRET=xxxxx' | sudo tee /etc/finance-dashboard.env
sudo chmod 600 /etc/finance-dashboard.env
```

走的是**授权码 + PKCE**。`id_token` 的签名、`iss`、`aud`、`nonce`、`exp` 全部校验，
会话是 HMAC 签名的 HttpOnly + SameSite=Lax cookie。

### 模式 C：`none`（只调试）

不认证，所有请求都是同一个用户。**只在 `127.0.0.1` 上用。**

## 3. 开机自启

仓库里的 [`server/finance-dashboard.service`](server/finance-dashboard.service) 可以直接用，
它用 `DynamicUser` + `StateDirectory`，不需要你手工建用户和数据目录：

```bash
sudo cp server/finance-dashboard.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now finance-dashboard
systemctl status finance-dashboard
```

内存紧的机器上单元里已经设了 `MemoryMax=150M`，别让它挤掉别的服务。

## 4. 反向代理

Caddy + Authelia（`proxy` 模式）：

```caddyfile
(protected) {
	forward_auth 127.0.0.1:9091 {
		uri /api/authz/auth-request
		header_up X-Original-URL "https://{http.request.host}{http.request.uri}"
		header_up -Authorization
		copy_headers Remote-User Remote-Groups Remote-Name Remote-Email
		@denied status 401 403
		handle_response @denied {
			redir https://auth.example.com/?rd=https://{http.request.host}{http.request.uri} 302
		}
	}
}

money.example.com {
	route {          # 必须用 route 包起来，保证「先鉴权、再转后端」
		import protected
		reverse_proxy 127.0.0.1:8788
	}
}
```

然后在 Authelia 的 `access_control.rules` 里加一条：

```yaml
    - domain: 'money.example.com'
      subject:
        - 'group:admins'
        - 'group:finance'
      policy: 'two_factor'
```

**验证伪造头进不来**（应该返回 302 而不是 200）：

```bash
curl -s -o /dev/null -w "%{http_code}\n" \
  -H "Remote-User: someone" https://money.example.com/api/me
```

## 5. 迁入数据

第一次登录会看到引导页。两个选择：

- **用账户模板开始** —— 从内置的账户模板起步，自己改；
- **导入备份 JSON** —— 把本地版 `⋯ → 导出备份` 出来的文件传上去。

也可以从服务器侧走接口灌进去（`proxy` 模式下从本机发，带上身份头）：

```bash
curl -s -X PUT http://127.0.0.1:8788/api/data \
  -H "Content-Type: application/json" \
  -H "Remote-User: 你的用户名" \
  -d @备份.json
```

> ⚠️ 用了 `DynamicUser` 的话，数据实际落在 `/var/lib/private/finance-dashboard`，
> `/var/lib/finance-dashboard` 是指向它的符号链接。
> **别手工往里面塞文件**，属主很容易搞错 —— 走上面的接口，让应用自己写。

## 6. 加人

数据按登录身份**物理分文件**存，用户之间互相看不到 ——
不是靠查询条件过滤，所以不存在「漏一个条件就串号」的风险。

加人只要两步，**应用不用改**：

1. 在你的 IdP 里把那个人加进放行的组（比如 Authelia 的 `users_database.yml` 里加一行 `- 'finance'`）；
2. 重启 IdP。

对方登录后会看到一个属于自己的空引导页。

## 7. 备份

数据是纯 JSON 文件，没有数据库，直接打包就行（不像 sqlite 有 WAL 一致性问题）：

```bash
ssh host 'tar czf - -C /var/lib/finance-dashboard users' > finance-$(date +%F).tar.gz
```

恢复就是解回去再 `systemctl restart finance-dashboard`。

## 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/me` | 当前用户、认证模式、是否已有数据 |
| `GET` | `/api/data` | 该用户的全部数据，含版本号 `rev`；没有数据时 404 |
| `PUT` | `/api/data` | 提交 `{rev, data}`。`rev` 对不上返回 **409** 并带回服务器版本；`{force:true}` 可强制覆盖 |
| `GET` | `/auth/login` `/auth/callback` `/auth/logout` | 仅 `oidc` 模式 |

`rev` 是乐观锁：两台设备同时改，后提交的会收到 409，页面右上角显示「别处已改动」。
可以刷新拿服务器版本，或者 `⋯ → 强制同步到服务器` 用本机的覆盖。

## 排查

| 现象 | 多半是 |
| --- | --- |
| 登录后无限跳转 | 反代把 `Authorization` 头带进了鉴权子请求。Caddy 里加 `header_up -Authorization` |
| 页面显示「本地」而不是用户名 | 前端探测 `api/me` 失败，退回了本地模式。看看反代路径和后端是否活着 |
| 换了认证模式后数据不见了 | 用户 id 变了：`proxy` 是 `proxy:<uid>`，`oidc` 是 `oidc:<issuer>\|<sub>`，数据文件名由它哈希而来。**换模式前先导出备份，换完再导入** |
| 右上角一直「离线·未同步」 | `PUT /api/data` 失败。`journalctl -u finance-dashboard` 看日志 |
| 启动日志说 `authMode=none` 但你配的是 proxy | 旧版本的日志顺序问题，升级即可；现在日志会打印「配置来源」和实际生效的环境变量 |
