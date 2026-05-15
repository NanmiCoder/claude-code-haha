/**
 * 命令语义配置，用于在不同上下文中解释退出码。
 *
 * 很多命令会用退出码表达“成功/失败”之外的语义信息。
 * 例如 grep 在没有匹配结果时会返回 1，但这并不代表真正的错误。
 */

import { splitCommand_DEPRECATED } from '../../utils/bash/commands.js'

export type CommandSemantic = (
  exitCode: number,
  stdout: string,
  stderr: string,
) => {
  isError: boolean
  message?: string
}

/**
 * 默认语义：只有 0 算成功，其他都视为错误。
 */
const DEFAULT_SEMANTIC: CommandSemantic = (exitCode, _stdout, _stderr) => ({
  isError: exitCode !== 0,
  message:
    exitCode !== 0 ? `Command failed with exit code ${exitCode}` : undefined,
})

/**
 * 针对特定命令的语义定义。
 */
const COMMAND_SEMANTICS: Map<string, CommandSemantic> = new Map([
  // grep：0=找到匹配，1=未找到匹配，2+=错误。
  [
    'grep',
    (exitCode, _stdout, _stderr) => ({
      isError: exitCode >= 2,
      message: exitCode === 1 ? 'No matches found' : undefined,
    }),
  ],

  // ripgrep 与 grep 使用相同语义。
  [
    'rg',
    (exitCode, _stdout, _stderr) => ({
      isError: exitCode >= 2,
      message: exitCode === 1 ? 'No matches found' : undefined,
    }),
  ],

  // find：0=成功，1=部分成功（某些目录不可访问），2+=错误。
  [
    'find',
    (exitCode, _stdout, _stderr) => ({
      isError: exitCode >= 2,
      message:
        exitCode === 1 ? 'Some directories were inaccessible' : undefined,
    }),
  ],

  // diff：0=无差异，1=发现差异，2+=错误。
  [
    'diff',
    (exitCode, _stdout, _stderr) => ({
      isError: exitCode >= 2,
      message: exitCode === 1 ? 'Files differ' : undefined,
    }),
  ],

  // test/[：0=条件为真，1=条件为假，2+=错误。
  [
    'test',
    (exitCode, _stdout, _stderr) => ({
      isError: exitCode >= 2,
      message: exitCode === 1 ? 'Condition is false' : undefined,
    }),
  ],

  // [ 是 test 的别名。
  [
    '[',
    (exitCode, _stdout, _stderr) => ({
      isError: exitCode >= 2,
      message: exitCode === 1 ? 'Condition is false' : undefined,
    }),
  ],

  // wc、head、tail、cat 等命令通常只会在真实错误下失败，
  // 因此这里直接使用默认语义。
])

/**
 * 获取某条命令对应的语义解释器。
 */
function getCommandSemantic(command: string): CommandSemantic {
  // 提取基础命令（第一个词，并处理管道场景）。
  const baseCommand = heuristicallyExtractBaseCommand(command)
  const semantic = COMMAND_SEMANTICS.get(baseCommand)
  return semantic !== undefined ? semantic : DEFAULT_SEMANTIC
}

/**
 * 从单条命令字符串中只提取命令名（第一个词）。
 */
function extractBaseCommand(command: string): string {
  return command.trim().split(/\s+/)[0] || ''
}

/**
 * 从复杂命令行中提取主要命令。
 * 这个过程可能会猜得很离谱，因此绝不能把它当作安全判断依据。
 */
function heuristicallyExtractBaseCommand(command: string): string {
  const segments = splitCommand_DEPRECATED(command)

  // 取最后一个命令，因为它通常决定最终退出码。
  const lastCommand = segments[segments.length - 1] || command

  return extractBaseCommand(lastCommand)
}

/**
 * 根据语义规则解释命令执行结果。
 */
export function interpretCommandResult(
  command: string,
  exitCode: number,
  stdout: string,
  stderr: string,
): {
  isError: boolean
  message?: string
} {
  const semantic = getCommandSemantic(command)
  const result = semantic(exitCode, stdout, stderr)

  return {
    isError: result.isError,
    message: result.message,
  }
}
