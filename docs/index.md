---
layout: home

hero:
  name: Claude Code Haha
  text: 本地可运行的 Claude Code
  tagline: 基于泄露源码修复，支持接入任意 Anthropic 兼容 API（MiniMax、OpenRouter 等）
  image:
    src: /images/logo-horizontal.png
    alt: Claude Code Haha
  actions:
    - theme: brand
      text: 快速开始
      link: /guide/quick-start
    - theme: alt
      text: GitHub
      link: https://github.com/NanmiCoder/cc-haha

features:
  - icon: "\U0001F5A5"
    title: 完整 TUI 交互
    details: 与官方 Claude Code 一致的 Ink 终端界面，支持 --print 无头模式
  - icon: "\U0001F9E0"
    title: 记忆系统
    details: 跨会话持久化记忆，自动提取、智能检索、AutoDream 做梦整合
    link: /memory/
  - icon: "\U0001F916"
    title: 多 Agent 系统
    details: 多代理编排、并行任务执行、Teams 协作、Worktree 隔离
    link: /agent/
  - icon: "\U0001F9E9"
    title: Skills 系统
    details: 可扩展能力插件、自定义工作流、条件激活
    link: /skills/01-usage-guide
  - icon: "\U0001F310"
    title: 第三方模型支持
    details: 接入 OpenAI、DeepSeek、Ollama 等任意兼容模型
    link: /guide/third-party-models
  - icon: "\U0001F4AC"
    title: IM 接入
    details: 通过独立 adapter 进程远程对话 Claude Code
    link: /im/
  - icon: "\U0001F4BB"
    title: Computer Use
    details: 桌面控制功能 — 截屏、鼠标、键盘操作（Python Bridge 实现）
    link: /features/computer-use
---
