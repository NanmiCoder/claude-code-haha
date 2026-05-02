---
name: wx-backup-decrypt
description: "Decrypt and extract WeChat backup database (.xb files) from NAS/Android backups. Handles XOR-encrypted content fields, friend/group metadata, and exports all messages. | 解密和提取微信备份数据库（.xb文件），处理加密内容字段，导出全部消息。"
argument-hint: "[database-path] [--imei IMEI] [--output OUTPUT_DIR]"
version: "1.0.0"
user-invocable: true
allowed-tools: Read, Write, Edit, Bash
---

> **Language / 语言**: This skill supports both English and Chinese. Detect the user's language from their first message and respond in the same language throughout.

# WeChat Backup Database Decryptor

## Overview

WeChat backup databases (`.xb` files) on NAS devices or Android backup tools contain encrypted message content. This skill provides a complete pipeline to:

1. **Identify** the database structure and encryption method
2. **Decrypt** all message content using known-plaintext attack
3. **Export** messages, friends, and groups in multiple formats
4. **Filter** out unwanted sessions (e.g., gaming service groups)

## Trigger Conditions

Activate when the user says any of the following:
- `/wx-backup-decrypt`
- "解密微信备份数据"
- "decrypt wechat backup"
- "微信聊天记录解密"
- Points to a `.xb` file or directory containing WeChat backup data

---

## Step 1: Database Discovery & Schema Analysis

### 1.1 Locate the database

Search for `.xb` files in the user-provided path:

```bash
find {path} -name "*.xb" -type f 2>/dev/null
```

### 1.2 Analyze schema

```python
import sqlite3

conn = sqlite3.connect(db_path)
cursor = conn.cursor()

# List tables
cursor.execute("SELECT name FROM sqlite_master WHERE type='table'")
tables = cursor.fetchall()

# Get table schemas
for table in tables:
    cursor.execute(f"PRAGMA table_info([{table[0]}])")
    columns = cursor.fetchall()
    # Print column info

# Count rows per table
for table in tables:
    cursor.execute(f"SELECT COUNT(*) FROM [{table[0]}]")
    count = cursor.fetchone()[0]
```

### 1.3 Identify key tables

Standard WeChat backup schema:
- `wx_chat` — Messages (content field typically encrypted)
- `wx_friend` — Contact list (nickname/remark may or may not be encrypted)
- `wx_group` — Group chats
- `wx_group_member` — Group members
- `wx_backup_history` — Backup records (display field may be plaintext!)
- `wx_config` — Configuration
- `wx_stat` / `wx_session_stat` — Statistics

---

## Step 2: Encryption Method Identification

### 2.1 Check if content is encrypted

```python
# Sample content from wx_chat
cursor.execute("SELECT content FROM wx_chat WHERE msg_type=1 LIMIT 5")
for row in cursor.fetchall():
    content = row[0]
    # If content is hex-encoded bytes, it's likely encrypted
    # If content is readable text, it's plaintext
```

**Signs of encrypted content**:
- Content is hex-encoded (only 0-9a-fA-F characters)
- Content length is even (each byte = 2 hex chars)
- Decoded bytes don't form valid UTF-8

### 2.2 Check which fields are encrypted

Test each text field:
- `wx_chat.content` — Usually encrypted
- `wx_friend.nickname` — MAY be plaintext (check first!)
- `wx_friend.remark` — MAY be plaintext
- `wx_group.nickName` — MAY be plaintext
- `wx_backup_history.display` — Often plaintext (key insight!)

**Critical**: Don't assume all fields use the same encryption. Some fields may be XOR-encrypted while others remain plaintext — always check before attempting decryption.

---

## Step 3: Known-Plaintext Attack (Primary Decryption Method)

### 3.1 Why this works

The `wx_backup_history.display` field often contains the LAST message text of each session in PLAINTEXT. By matching these with the encrypted `wx_chat.content` at the same timestamp and session, we can recover the encryption key.

### 3.2 Match plaintext to ciphertext

```python
# Get known plaintext from backup_history
cursor.execute("""
    SELECT display, talkerId, endTime
    FROM wx_backup_history
    WHERE display IS NOT NULL AND display != ''
    AND length(display) > 2 AND length(display) < 30
""")

for display, talker, endtime in cursor.fetchall():
    # Find matching encrypted message
    cursor.execute("""
        SELECT content FROM wx_chat
        WHERE session=? AND create_time=? AND msg_type=1
    """, (talker, endtime))
    result = cursor.fetchone()
    if result and result[0]:
        # We have a plaintext-ciphertext pair!
        plaintext = display.encode('utf-8')
        ciphertext = bytes.fromhex(result[0])
```

### 3.3 Derive the XOR key

```python
if len(plaintext) == len(ciphertext):
    for i, (p, c) in enumerate(zip(plaintext, ciphertext)):
        key_byte = p ^ c
        print(f"pos {i}: xor_key = 0x{key_byte:02x}")
```

If the XOR key is constant (all bytes are the same), then it's a simple single-byte XOR cipher. Verify with multiple pairs.

### 3.4 If key is NOT constant

If the key varies per byte, try:
- **Repeating key XOR**: Check if key repeats with period N
- **IMEI-based key derivation**: `key = MD5(IMEI + UIN)[:7]` (traditional WeChat method)
- **Multi-byte key**: Try `key = MD5(IMEI)[:N]` for various N

---

## Step 4: Bulk Decryption

### 4.1 Decrypt messages

```python
XOR_KEY = discovered_key  # Auto-discovered via known-plaintext attack

def decrypt_content(content_hex):
    if not content_hex or len(content_hex) % 2 != 0:
        return None
    try:
        cipher_bytes = bytes.fromhex(content_hex)
        plain_bytes = bytes(b ^ XOR_KEY for b in cipher_bytes)
        return plain_bytes.decode('utf-8', errors='replace')
    except:
        return None
```

### 4.2 Validate decryption quality

```python
# Sample 5000 messages and check for replacement characters
valid = 0
replacement_chars = 0
total = 0

for row in cursor.execute("SELECT content FROM wx_chat WHERE msg_type=1 ORDER BY RANDOM() LIMIT 5000"):
    text = decrypt_content(row[0])
    if text is not None:
        valid += 1
        if '\ufffd' in text:  # Unicode replacement character
            replacement_chars += 1
    total += 1

print(f"Valid: {valid}/{total}, With replacement chars: {replacement_chars}")
# Target: 100% valid, 0% replacement chars
```

### 4.3 Decrypt ALL data

```python
# User messages (where speak = user's wxid)
cursor.execute("""
    SELECT id, session, speak, content, create_time, msg_type
    FROM wx_chat
    WHERE speak=?
""", (user_wxid,))

# All messages
cursor.execute("""
    SELECT id, session, speak, content, create_time, msg_type
    FROM wx_chat
    WHERE msg_type=1
""")
```

---

## Step 5: Export & Filtering

### 5.1 Identify and filter unwanted sessions

Common groups to filter out:
- Gaming/service groups: user provides keywords to match
- Spam/notification accounts: `@openim` service accounts

```python
exclude_sessions = set()
for gid, info in groups.items():
    name = info.get('name', '')
    if any(k in name for k in user_provided_keywords):
        exclude_sessions.add(gid)
```

### 5.2 Export formats

| Format | File | Content |
|--------|------|---------|
| JSON | `user_messages_filtered.json` | User's text messages (excl. filtered groups) |
| JSON | `all_text_messages_filtered.json` | All text messages (both sides, excl. filtered) |
| JSON | `friends.json` | Friend list with decrypted/plaintext names |
| JSON | `groups.json` | Group list with decrypted/plaintext names |
| TXT | `user_messages.txt` | Plain text: `[timestamp] message` per line |

---

## Step 6: Persona Building Support

The exported data can feed directly into the `create-yourself` skill. Key data points:

### For Self Memory
- Personal timeline (from message timestamps and content)
- Friend network (from session counts and friend list)
- Life events (from keyword extraction: school, exam, travel, relationships)
- Values and habits (from message pattern analysis)

### For Persona
- Speech patterns (message length distribution, catchphrases)
- Emoji/emoji usage frequency
- Emotional valence (positive vs negative word counts)
- Communication style per relationship type (family, close friends, classmates, teachers)
- Active hours and weekly patterns

---

## Troubleshooting

### "Content appears garbled after decryption"
- Check if the field is actually encrypted (nicknames may be plaintext!)
- Try different XOR keys
- Check for multi-byte XOR keys

### "Can't find matching plaintext-ciphertext pairs"
- The `backup_history.display` field might be empty
- Try matching by session + approximate timestamp (within ±5 seconds)
- Some databases use IMEI+UIN based key derivation instead of simple XOR

### "Only some messages decrypt correctly"
- Different message types may use different encryption
- System messages (type 10000, 10002) may not be encrypted the same way
- Image/video messages (type 3, 43) have XML content, not simple text

### "pywxdump won't install on Linux"
- pywxdump has a hard dependency on pywin32 (Windows-only)
- Use the known-plaintext approach instead
- The XOR method is simpler and doesn't need pywxdump

---

## Encryption Methods Found

| Source | Encryption | Key Derivation | Content Field |
|--------|-----------|---------------|---------------|
| NAS WeChat Backup (.xb) | Single-byte XOR | Auto-discovered via known-plaintext | `wx_chat.content` |
| Android EnMicroMsg.db | SQLCipher | IMEI + UIN → MD5[:7] | Various |
| iTunes Backup | AES | Device key | Various |

This skill primarily targets the NAS backup format.
