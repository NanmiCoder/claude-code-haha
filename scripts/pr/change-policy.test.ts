import { describe, expect, test } from 'bun:test'
import { evaluateChangePolicy } from './change-policy'

describe('evaluateChangePolicy', () => {
  test('blocks CLI core changes without an override label', () => {
    const result = evaluateChangePolicy([
      'src/commands/help.ts',
      'src/utils/config.ts',
    ])

    expect(result.blocked).toBe(true)
    expect(result.areas).toContain('cli-core')
    expect(result.areaLabels).toContain('area:cli-core')
    expect(result.cliCoreFiles).toEqual(['src/commands/help.ts', 'src/utils/config.ts'])
  })

  test('allows CLI core changes with a maintainer override label', () => {
    const result = evaluateChangePolicy(
      ['src/tools/WebSearchTool/backend.ts'],
      ['allow-cli-core-change'],
    )

    expect(result.blocked).toBe(false)
    expect(result.areas).toEqual(['cli-core'])
    expect(result.checks.server).toBe(true)
  })

  test('keeps docs-only changes on the docs lane', () => {
    const result = evaluateChangePolicy([
      'docs/index.md',
      'README.md',
    ])

    expect(result.blocked).toBe(false)
    expect(result.areas).toEqual(['docs'])
    expect(result.checks.docs).toBe(true)
    expect(result.checks.server).toBe(false)
  })

  test('routes server changes to server checks', () => {
    const result = evaluateChangePolicy([
      'src/server/ws/handler.ts',
    ])

    expect(result.areas).toEqual(['server'])
    expect(result.checks.server).toBe(true)
  })

  test('routes adapter changes to adapter checks', () => {
    const result = evaluateChangePolicy(['adapters/telegram/index.ts'])

    expect(result.areas).toEqual(['adapters'])
    expect(result.checks.adapters).toBe(true)
  })

  test('does not route removed desktop app artifacts to checks', () => {
    const result = evaluateChangePolicy([
      'desktop/src/pages/Settings.tsx',
      'desktop/src-tauri/tauri.conf.json',
      '.github/workflows/release-desktop.yml',
      '.github/workflows/build-desktop-dev.yml',
      'scripts/release.ts',
    ])

    expect(result.areas).toEqual([])
    expect(result.checks.server).toBe(false)
  })
})
