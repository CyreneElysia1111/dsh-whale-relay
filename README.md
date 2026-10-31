# dsh-whale-relay

把 **QQ 私聊接进 DSH 的主会话**——不是另开一个 agent、不是分身，是你正在用的那条会话里，多进来一条消息。

```
你的手机 QQ
   │  私聊
   ▼
NapCat（OneBot 11 实现，跑在本地）
   │  httpClients → POST http://127.0.0.1:18080/qq
   ▼
这个插件  ──sessionController.prompt({ mode:'steer' })──▶  主会话（你正在看的那个窗口）
   │                                                           │
   └────────── whale_relay_send ───────────────────────────────┘
                （回程：NapCat HTTP → send_private_msg → 你的 QQ）
```

## 它要解决什么

大多数 QQ 接入方式是「**给每个 chat 新开一个 agent**」。那样接出来的，是一个读得到你消息、但没有同一份记忆和人格的「另一个人」。
这个插件的做法相反：**QQ 只是投递口**，消息进你正在跑的那条会话，回答也从那条会话出去。

关键的一行是 `mode: 'steer'`（不是 `'queue'`）：

- `queue`：消息排队，等当前这轮跑完才出现——如果这轮要跑几十分钟，用户看着就像「没收到」；
- `steer`：插进正在跑的轮次。

## 前置条件

1. **NapCat**（或任何 OneBot 11 实现）已在本地登录，并且开了 HTTP 服务端与 HTTP 客户端：

```jsonc
// NapCat 的 onebot11_<QQ号>.json
"network": {
  "httpServers": [{ "name":"dsh-api", "enable":true, "host":"127.0.0.1", "port":3001, "token":"<本地随意一串>" }],
  "httpClients": [{ "name":"dsh-relay", "enable":true, "url":"http://127.0.0.1:18080/qq", "token":"<另一串>" }]
}
```

2. **DSH** 里有 `sessionController` 服务（宿主自带）。

## 安装与配置

```yaml
# cordis.patch.yml
- insert:
    - id: whale-relay
      name: '@local/whale-relay'
```

```jsonc
// ~/.dsh/whale-relay.json
{
  "listenPort": 18080,
  "listenPath": "/qq",
  "apiBase": "http://127.0.0.1:3001",   // 回程用：NapCat 的 HTTP servers
  "apiToken": "<和上面 httpServers 的 token 一致>",
  "ownerId": "你的QQ号",                 // 只处理这个号发来的私聊
  "sessionId": "",                      // 留空则读 ~/.dsh/whale-window.json 的 sessionId
  "privateOnly": true
}
```

`sessionId` 留空是有意的：会话 id 通常由图形界面随机生成，写死会指到一个不存在的会话。让它去读 `whale-window.json`（一个记录「当前窗口是谁」的小文件），换窗口时只改那一个文件。

## 工具

```
whale_relay_send   text="…"  [userId="…"]
```

从主会话里回一条消息到 QQ。`userId` 省略时发给 `ownerId`。

## 状态码与日志

- `HTTP 200 ok`：已投递；
- `503`：拿不到 `sessionController`（插件比宿主早一步 apply，属于正常竞态，下一次请求会重试——所以 controller 是**懒取**的，不是 apply 时取一次就永久放弃）；
- 日志：`~/.dsh/whale-relay.log`，一行一次请求。

## 踩过的三个坑（都写进代码了）

1. `prompt()` 内部会无条件调 `signal.throwIfAborted()`，不传 `AbortController.signal` 直接崩；
2. `SessionPromptRequest` 必须带 `requestId` 和 `mode`；
3. `apply` 时 `ctx.get('tools')` 可能还没就绪——所以 `export const inject = ['tools']`（数组形式），不要写 `{ optional: [...] }`，这个 Cordis 版本不认 optional 键，会让插件一直 `pending`。

## 安全

- 只监听 `127.0.0.1`；
- 两边各用一串本地 token（`httpClients.token` 与 `httpServers.token`），互相校验；
- 只处理 `ownerId` 的私聊，群聊默认不碰；
- 这把 token **不要进版本库**。如果还有另一个插件在备份 `whale-relay.json`，让它入库前把 token 换成 `<local-only>`。

## License

MIT，见 [LICENSE](./LICENSE)。
