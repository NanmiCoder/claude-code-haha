import { feature } from 'bun:bundle'
import { z } from 'zod/v4'
import { getKairosActive, setUserMsgOptIn } from '../bootstrap/state.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../services/analytics/growthbook.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../services/analytics/index.js'
import type { ToolUseContext } from '../Tool.js'
import { isBriefEntitled } from '../tools/BriefTool/BriefTool.js'
import { BRIEF_TOOL_NAME } from '../tools/BriefTool/prompt.js'
import type {
  Command,
  LocalJSXCommandContext,
  LocalJSXCommandOnDone,
} from '../types/command.js'
import { lazySchema } from '../utils/lazySchema.js'

// Zod 用于防止 GB 配置被手滑推错（与 pollConfig.ts /
// cronScheduler.ts 相同模式）。畸形配置会完全回退到 DEFAULT_BRIEF_CONFIG，
// 而不是部分信任其中内容。
const briefConfigSchema = lazySchema(() =>
  z.object({
    enable_slash_command: z.boolean(),
  }),
)
type BriefConfig = z.infer<ReturnType<typeof briefConfigSchema>>

const DEFAULT_BRIEF_CONFIG: BriefConfig = {
  enable_slash_command: false,
}

// 不设置 TTL，这个开关控制的是 slash-command 的可见性，不是 kill switch。
// CACHED_MAY_BE_STALE 仍会发生一次后台更新翻转（第一次调用触发
// fetch；第二次调用看到新值），之后不会再翻转。
// tool-availability 开关（isBriefEnabled 中的 tengu_kairos_brief）保留
// 5 分钟 TTL，因为那个才是真正的 kill switch。
function getBriefConfig(): BriefConfig {
  const raw = getFeatureValue_CACHED_MAY_BE_STALE<unknown>(
    'tengu_kairos_brief_config',
    DEFAULT_BRIEF_CONFIG,
  )
  const parsed = briefConfigSchema().safeParse(raw)
  return parsed.success ? parsed.data : DEFAULT_BRIEF_CONFIG
}

const brief = {
  type: 'local-jsx',
  name: 'brief',
  description: 'Toggle brief-only mode',
  isEnabled: () => {
    if (feature('KAIROS') || feature('KAIROS_BRIEF')) {
      return getBriefConfig().enable_slash_command
    }
    return false
  },
  immediate: true,
  load: () =>
    Promise.resolve({
      async call(
        onDone: LocalJSXCommandOnDone,
        context: ToolUseContext & LocalJSXCommandContext,
      ): Promise<React.ReactNode> {
        const current = context.getAppState().isBriefOnly
        const newState = !current

        // entitlement 检查只限制开启过程，关闭始终
        // 允许，这样中途 GB 开关变化的用户不会被卡住。
        if (newState && !isBriefEntitled()) {
          logEvent('tengu_brief_mode_toggled', {
            enabled: false,
            gated: true,
            source:
              'slash_command' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          })
          onDone('Brief tool is not enabled for your account', {
            display: 'system',
          })
          return null
        }

        // 双向同步：userMsgOptIn 跟踪 isBriefOnly，使该 tool
        // 只在 brief mode 开启时可用。这会在每次切换时使 prompt cache 失效
        // （因为 tool 列表变化），但 tool 列表陈旧更糟，
        // 启用 /brief 时，model 否则仍可能没有该 tool，
        // 从而输出会被过滤器隐藏的纯文本。
        setUserMsgOptIn(newState)

        context.setAppState(prev => {
          if (prev.isBriefOnly === newState) return prev
          return { ...prev, isBriefOnly: newState }
        })

        logEvent('tengu_brief_mode_toggled', {
          enabled: newState,
          gated: false,
          source:
            'slash_command' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        })

        // 仅靠 tool 列表变化，在会话中途还不足以形成强信号
        // （model 可能因惯性继续输出纯文本，或继续调用
        // 刚刚消失的 tool）。把显式提醒注入下一轮
        // 的上下文，让切换没有歧义。
        // Kairos 激活时跳过：isBriefEnabled() 会在
        // getKairosActive() 上短路，所以该 tool 实际上不会离开列表，
        // 而且 Kairos system prompt 已经强制要求 SendUserMessage。
        // 内联 <system-reminder> 包装，避免从
        // utils/messages.ts 导入 wrapInSystemReminder 时经由本模块的导入链
        // 把 constants/xml.ts 拉进 bridge SDK bundle，
        // 从而触发 excluded-strings 检查。
        const metaMessages = getKairosActive()
          ? undefined
          : [
              `<system-reminder>\n${
                newState
                  ? `Brief mode is now enabled. Use the ${BRIEF_TOOL_NAME} tool for all user-facing output — plain text outside it is hidden from the user's view.`
                  : `Brief mode is now disabled. The ${BRIEF_TOOL_NAME} tool is no longer available — reply with plain text.`
              }\n</system-reminder>`,
            ]

        onDone(
          newState ? 'Brief-only mode enabled' : 'Brief-only mode disabled',
          { display: 'system', metaMessages },
        )
        return null
      },
    }),
} satisfies Command

export default brief
