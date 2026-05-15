import { getFeatureValue_CACHED_MAY_BE_STALE } from 'src/services/analytics/growthbook.js'
import { splitCommand_DEPRECATED } from '../../utils/bash/commands.js'
import { SandboxManager } from '../../utils/sandbox/sandbox-adapter.js'
import { getSettings_DEPRECATED } from '../../utils/settings/settings.js'
import {
  BINARY_HIJACK_VARS,
  bashPermissionRule,
  matchWildcardPattern,
  stripAllLeadingEnvVars,
  stripSafeWrappers,
} from './commandMatching.js'

type SandboxInput = {
  command?: string
  dangerouslyDisableSandbox?: boolean
}

// 注意：excludedCommands 是面向用户的便利特性，不是安全边界。
// 能绕过 excludedCommands 不属于安全漏洞，真正的安全控制是会提示用户的 sandbox
// 权限系统。
function containsExcludedCommand(command: string): boolean {
  // 检查动态配置里的禁用命令和禁用子串（仅对 ant 生效）。
  if (process.env.USER_TYPE === 'ant') {
    const disabledCommands = getFeatureValue_CACHED_MAY_BE_STALE<{
      commands: string[]
      substrings: string[]
    }>('tengu_sandbox_disabled_commands', { commands: [], substrings: [] })

    // 检查命令是否包含任何被禁用的子串。
    for (const substring of disabledCommands.substrings) {
      if (command.includes(substring)) {
        return true
      }
    }

    // 检查命令是否以任何被禁用的命令开头。
    try {
      const commandParts = splitCommand_DEPRECATED(command)
      for (const part of commandParts) {
        const baseCommand = part.trim().split(' ')[0]
        if (baseCommand && disabledCommands.commands.includes(baseCommand)) {
          return true
        }
      }
    } catch {
      // 如果命令无法解析（例如 bash 语法损坏），
      // 就把它视为“未被排除”，交给后续其他校验逻辑处理。
      // 这样可以避免在渲染 tool use 消息时崩溃。
    }
  }

  // 检查 settings 中由用户配置的 excluded commands。
  const settings = getSettings_DEPRECATED()
  const userExcludedCommands = settings.sandbox?.excludedCommands ?? []

  if (userExcludedCommands.length === 0) {
    return false
  }

  // 将复合命令（例如 "docker ps && curl evil.com"）拆成独立子命令，
  // 再逐个对照 excluded pattern 检查。这样可以防止某个复合命令仅因为
  // 第一个子命令命中排除模式，就整体逃逸出 sandbox。
  let subcommands: string[]
  try {
    subcommands = splitCommand_DEPRECATED(command)
  } catch {
    subcommands = [command]
  }

  for (const subcommand of subcommands) {
    const trimmed = subcommand.trim()
    // 这里也会尝试在去掉 env var 前缀和 wrapper command 后再做匹配，
    // 这样 `FOO=bar bazel ...` 和 `timeout 30 bazel ...` 也能命中 `bazel:*`。
    // 这不是安全边界（见顶部 NOTE）；上面的 && 拆分已经允许
    // `export FOO=bar && bazel ...` 命中。BINARY_HIJACK_VARS 在这里只保留为启发式条件。
    //
    // 我们会反复应用这两种 strip 操作，直到不再产生新候选（达到不动点），
    // 与 filterRulesByContentsMatchingInput 的处理方式保持一致。
    // 这样可以处理诸如 `timeout 300 FOO=bar bazel run` 这类交错模式，
    // 否则单次组合处理会失败。
    const candidates = [trimmed]
    const seen = new Set(candidates)
    let startIdx = 0
    while (startIdx < candidates.length) {
      const endIdx = candidates.length
      for (let i = startIdx; i < endIdx; i++) {
        const cmd = candidates[i]!
        const envStripped = stripAllLeadingEnvVars(cmd, BINARY_HIJACK_VARS)
        if (!seen.has(envStripped)) {
          candidates.push(envStripped)
          seen.add(envStripped)
        }
        const wrapperStripped = stripSafeWrappers(cmd)
        if (!seen.has(wrapperStripped)) {
          candidates.push(wrapperStripped)
          seen.add(wrapperStripped)
        }
      }
      startIdx = endIdx
    }

    for (const pattern of userExcludedCommands) {
      const rule = bashPermissionRule(pattern)
      for (const cand of candidates) {
        switch (rule.type) {
          case 'prefix':
            if (cand === rule.prefix || cand.startsWith(rule.prefix + ' ')) {
              return true
            }
            break
          case 'exact':
            if (cand === rule.command) {
              return true
            }
            break
          case 'wildcard':
            if (matchWildcardPattern(rule.pattern, cand)) {
              return true
            }
            break
        }
      }
    }
  }

  return false
}

export function shouldUseSandbox(input: Partial<SandboxInput>): boolean {
  if (!SandboxManager.isSandboxingEnabled()) {
    return false
  }

  // 如果显式要求覆盖，并且策略允许非沙箱命令，则不要启用 sandbox。
  if (
    input.dangerouslyDisableSandbox &&
    SandboxManager.areUnsandboxedCommandsAllowed()
  ) {
    return false
  }

  if (!input.command) {
    return false
  }

  // 如果命令命中了用户配置的 excluded commands，则不要启用 sandbox。
  if (containsExcludedCommand(input.command)) {
    return false
  }

  return true
}
