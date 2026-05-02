# wx-backup-decrypt

微信备份数据库（.xb）解密工具，适用于 Claude Code。

通过已知明文攻击自动发现加密密钥，解密和提取 NAS/Android 微信备份数据库中的聊天数据。

## 安装

```bash
# 在你的 Claude Code 项目目录下
claude skill add https://github.com/duyufansh2008/wx-backup-decrypt
```

或手动安装：
1. 将此仓库克隆到 `.claude/skills/wx-backup-decrypt/`
2. 完成 — Claude Code 会自动识别

## 快速开始

```
/wx-backup-decrypt /path/to/wxid_xxx.xb
```

工具会自动：
1. 分析数据库结构
2. 通过已知明文攻击发现加密密钥
3. 解密所有消息、好友和群聊
4. 导出为 JSON/TXT 格式

## 独立使用

```bash
python tools/decrypt.py --db /path/to/database.xb --output ./decrypted
```

### 参数

| 参数 | 说明 |
|------|------|
| `--db` | .xb 数据库文件路径（必填） |
| `--imei` | 手机 IMEI 号（用于 IMEI 密钥推导） |
| `--uin` | 微信 UIN（与 IMEI 配合使用） |
| `--output` | 输出目录（默认：`./wx_decrypted`） |
| `--exclude-keywords` | 要排除的群聊名称关键词（如 `--exclude-keywords 关键词1 关键词2`） |

## 工作原理

### 加密密钥发现

微信 NAS 备份数据库（`.xb` 文件）对 `wx_chat.content` 字段使用了简单的 XOR 加密。密钥发现过程：

1. **已知明文攻击**：`wx_backup_history.display` 字段通常以**明文**存储每个会话的最后一条消息
2. 将明文与同一时间戳和会话的加密内容匹配
3. 逐字节 XOR 恢复密钥
4. 用多组数据验证 — 密钥通常是单字节常量

### 注意事项

- **并非所有字段都加密了！** `wx_friend.nickname`、`wx_group.nickName` 等字段可能是明文，而 `wx_chat.content` 是 XOR 加密的
- 不要盲目对所有字段解密 — 先检测每个字段
- IMEI 推导方法（`MD5(IMEI + UIN)[:7]`）作为备用方案可用

### 数据库结构

| 表 | 内容 | 加密情况 |
|---|------|---------|
| `wx_chat` | 消息 | content：XOR 加密 |
| `wx_friend` | 联系人 | nickname/remark：视情况（通常明文） |
| `wx_group` | 群聊 | nickName：视情况（通常明文） |
| `wx_backup_history` | 备份记录 | display：**明文**（攻击的关键！） |
| `wx_config` | 配置 | 明文 |
| `wx_stat` | 统计 | 明文 |

### 消息类型

| msg_type | 说明 |
|----------|------|
| 1 | 文本消息 |
| 3 | 图片 |
| 34 | 语音 |
| 43 | 视频 |
| 47 | 表情 |
| 49 | 链接/小程序 |
| 50 | 视频通话 |
| 10000 | 系统消息 |
| 10002 | 系统通知 |

## 输出文件

| 文件 | 内容 |
|------|------|
| `user_messages.json` | 用户发送的文本消息（已过滤） |
| `user_messages.txt` | 纯文本格式：`[时间戳] 消息内容` |
| `all_user_messages.json` | 用户所有类型消息（已过滤） |
| `all_text_messages.json` | 所有人发的文本消息（已过滤） |
| `friends.json` | 好友列表 |
| `groups.json` | 群聊列表 |
| `decrypt_stats.json` | 解密统计 |

## 兼容性

- 测试环境：群晖/QNAP NAS 微信备份（.xb）格式
- Python：3.7+
- 无外部依赖（仅使用标准库：sqlite3, hashlib, json, os, argparse, collections, datetime）

## 许可证

MIT
