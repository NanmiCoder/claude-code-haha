import { defineConfig } from 'vitepress'
import { withMermaid } from 'vitepress-plugin-mermaid'

// GitHub-compatible slugify (matches github-slugger algorithm)
// Makes heading anchor IDs consistent between VitePress and GitHub rendering
function slugify(str: string): string {
  return str
    .replace(/<[^>]*>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc}\- ]/gu, '')
    .replace(/ /g, '-')
}

const zhSidebar = [
  {
    text: '快速开始',
    items: [
      { text: '安装与启动', link: '/guide/quick-start' },
      { text: '环境变量', link: '/guide/env-vars' },
      { text: '第三方模型', link: '/guide/third-party-models' },
      { text: '全局使用', link: '/guide/global-usage' },
      { text: '常见问题', link: '/guide/faq' },
      { text: '贡献与质量门禁', link: '/guide/contributing' },
    ],
  },
  {
    text: '记忆系统',
    collapsed: false,
    items: [
      { text: '概览', link: '/memory/' },
      { text: '使用指南', link: '/memory/01-usage-guide' },
      { text: '实现原理', link: '/memory/02-implementation' },
      { text: 'AutoDream 记忆整合', link: '/memory/03-autodream' },
    ],
  },
  {
    text: '多 Agent 系统',
    collapsed: false,
    items: [
      { text: '概览', link: '/agent/' },
      { text: '使用指南', link: '/agent/01-usage-guide' },
      { text: '实现原理', link: '/agent/02-implementation' },
      { text: 'Agent 框架解析', link: '/agent/03-agent-framework' },
    ],
  },
  {
    text: 'Skills 系统',
    collapsed: false,
    items: [
      { text: '使用指南', link: '/skills/01-usage-guide' },
      { text: '实现原理', link: '/skills/02-implementation' },
    ],
  },
  {
    text: 'IM 接入',
    collapsed: false,
    items: [
      { text: '总览', link: '/im/' },
      { text: 'Telegram', link: '/im/telegram' },
      { text: '飞书', link: '/im/feishu' },
    ],
  },
  {
    text: 'Channel 源码研究',
    collapsed: false,
    items: [
      { text: '概览', link: '/channel/' },
      { text: '架构解析', link: '/channel/01-channel-system' },
    ],
  },
  {
    text: 'Computer Use',
    collapsed: false,
    items: [
      { text: '功能指南', link: '/features/computer-use' },
      { text: '架构解析', link: '/features/computer-use-architecture' },
    ],
  },
  {
    text: '参考',
    collapsed: true,
    items: [
      { text: '源码修复记录', link: '/reference/fixes' },
      { text: '项目结构', link: '/reference/project-structure' },
    ],
  },
]

const enSidebar = [
  {
    text: 'Getting Started',
    items: [
      { text: 'Quick Start', link: '/en/guide/quick-start' },
      { text: 'Environment Variables', link: '/en/guide/env-vars' },
      { text: 'Third-Party Models', link: '/en/guide/third-party-models' },
      { text: 'Global Usage', link: '/en/guide/global-usage' },
      { text: 'FAQ', link: '/en/guide/faq' },
      { text: 'Contributing', link: '/en/guide/contributing' },
    ],
  },
  {
    text: 'Memory System',
    collapsed: false,
    items: [
      { text: 'Overview', link: '/en/memory/' },
      { text: 'Usage Guide', link: '/en/memory/01-usage-guide' },
      { text: 'Implementation', link: '/en/memory/02-implementation' },
      { text: 'AutoDream', link: '/en/memory/03-autodream' },
    ],
  },
  {
    text: 'Multi-Agent System',
    collapsed: false,
    items: [
      { text: 'Overview', link: '/en/agent/' },
      { text: 'Usage Guide', link: '/en/agent/01-usage-guide' },
      { text: 'Implementation', link: '/en/agent/02-implementation' },
      { text: 'Framework Deep Dive', link: '/en/agent/03-agent-framework' },
    ],
  },
  {
    text: 'Skills System',
    collapsed: false,
    items: [
      { text: 'Usage Guide', link: '/en/skills/01-usage-guide' },
      { text: 'Implementation', link: '/en/skills/02-implementation' },
    ],
  },
  {
    text: 'Channel System',
    collapsed: false,
    items: [
      { text: 'Overview', link: '/en/channel/' },
      { text: 'Architecture', link: '/en/channel/01-channel-system' },
    ],
  },
  {
    text: 'Computer Use',
    collapsed: false,
    items: [
      { text: 'Guide', link: '/en/features/computer-use' },
      { text: 'Architecture', link: '/en/features/computer-use-architecture' },
    ],
  },
  {
    text: 'Reference',
    collapsed: true,
    items: [
      { text: 'Source Fixes', link: '/en/reference/fixes' },
      { text: 'Project Structure', link: '/en/reference/project-structure' },
    ],
  },
]

export default withMermaid(defineConfig({
  title: 'Claude Code Haha',
  description: '基于 Claude Code 泄露源码修复的本地可运行版本，支持接入任意 Anthropic 兼容 API',
  lastUpdated: true,
  base: '/',

  markdown: {
    anchor: {
      slugify,
    },
  },

  head: [
    ['script', { async: '', src: 'https://www.googletagmanager.com/gtag/js?id=G-D42DM82263' }],
    ['script', {}, `window.dataLayer = window.dataLayer || [];\nfunction gtag(){dataLayer.push(arguments);}\ngtag('js', new Date());\ngtag('config', 'G-D42DM82263');`],
  ],

  locales: {
    root: {
      label: '中文',
      lang: 'zh-CN',
      themeConfig: {
        nav: [
          { text: '首页', link: '/' },
          { text: '快速开始', link: '/guide/quick-start' },
        ],
        sidebar: zhSidebar,
        outline: { label: '页面导航' },
        returnToTopLabel: '返回顶部',
        sidebarMenuLabel: '菜单',
        darkModeSwitchLabel: '主题',
        lastUpdated: { text: '最后更新于' },
        docFooter: { prev: '上一页', next: '下一页' },
      },
    },
    en: {
      label: 'English',
      lang: 'en-US',
      description: 'A locally runnable version repaired from the leaked Claude Code source, with support for any Anthropic-compatible API endpoint.',
      themeConfig: {
        editLink: {
          pattern: 'https://github.com/NanmiCoder/cc-haha/edit/main/docs/:path',
          text: 'Edit this page on GitHub',
        },
        nav: [
          { text: 'Home', link: '/en/' },
          { text: 'Quick Start', link: '/en/guide/quick-start' },
        ],
        sidebar: enSidebar,
      },
    },
  },

  themeConfig: {
    editLink: {
      pattern: 'https://github.com/NanmiCoder/cc-haha/edit/main/docs/:path',
      text: '在 GitHub 上编辑此页',
    },
    search: {
      provider: 'local',
    },
    socialLinks: [
      { icon: 'github', link: 'https://github.com/NanmiCoder/cc-haha' },
    ],
    footer: {
      message: 'Released under the MIT License.',
      copyright: 'Copyright 2026 Claude Code Haha Contributors',
    },
  },
}))
