import chalk from 'chalk'
import figures from 'figures'
import React, { useEffect } from 'react'
import {
  getAdditionalDirectoriesForClaudeMd,
  setAdditionalDirectoriesForClaudeMd,
} from '../../bootstrap/state.js'
import type { LocalJSXCommandContext } from '../../commands.js'
import { MessageResponse } from '../../components/MessageResponse.js'
import { AddWorkspaceDirectory } from '../../components/permissions/rules/AddWorkspaceDirectory.js'
import { Box, Text } from '../../ink.js'
import type { LocalJSXCommandOnDone } from '../../types/command.js'
import {
  applyPermissionUpdate,
  persistPermissionUpdate,
} from '../../utils/permissions/PermissionUpdate.js'
import type { PermissionUpdateDestination } from '../../utils/permissions/PermissionUpdateSchema.js'
import { SandboxManager } from '../../utils/sandbox/sandbox-adapter.js'
import {
  addDirHelpMessage,
  validateDirectoryForWorkspace,
} from './validation.js'

function AddDirError({
  message,
  args,
  onDone,
}: {
  message: string
  args: string
  onDone: () => void
}): React.ReactNode {
  useEffect(() => {
    const timer = setTimeout(onDone, 0)
    return () => clearTimeout(timer)
  }, [onDone])

  return (
    <Box flexDirection="column">
      <Text dimColor>
        {figures.pointer} /add-dir {args}
      </Text>
      <MessageResponse>
        <Text>{message}</Text>
      </MessageResponse>
    </Box>
  )
}

function parseArgs(args: string | undefined): { path: string; remember: boolean } {
  const raw = (args ?? '').trim()
  const remember = /\s--remember\b/.test(raw)
  const path = raw.replace(/\s--remember\b/, '').trim()
  return { path, remember }
}

export async function call(
  onDone: LocalJSXCommandOnDone,
  context: LocalJSXCommandContext,
  args?: string,
): Promise<React.ReactNode> {
  const { path: directoryPath, remember: rememberFlag } = parseArgs(args)
  const appState = context.getAppState()
  const isNonInteractive = context.options.isNonInteractiveSession

  const handleAddDirectory = async (path: string, remember = false) => {
    const destination: PermissionUpdateDestination = remember
      ? 'localSettings'
      : 'session'
    const permissionUpdate = {
      type: 'addDirectories' as const,
      directories: [path],
      destination,
    }

    const latestAppState = context.getAppState()
    const updatedContext = applyPermissionUpdate(
      latestAppState.toolPermissionContext,
      permissionUpdate,
    )
    context.setAppState((prev) => ({
      ...prev,
      toolPermissionContext: updatedContext,
    }))

    const currentDirs = getAdditionalDirectoriesForClaudeMd()
    if (!currentDirs.includes(path)) {
      setAdditionalDirectoriesForClaudeMd([...currentDirs, path])
    }
    SandboxManager.refreshConfig()

    let message: string
    if (remember) {
      try {
        persistPermissionUpdate(permissionUpdate)
        message = `Added ${chalk.bold(path)} as a working directory and saved to local settings`
      } catch (error) {
        message = `Added ${chalk.bold(path)} as a working directory. Failed to save to local settings: ${error instanceof Error ? error.message : 'Unknown error'}`
      }
    } else {
      message = `Added ${chalk.bold(path)} as a working directory for this session`
    }
    const messageWithHint = `${message} ${chalk.dim('· /permissions to manage')}`
    onDone(messageWithHint)
  }

  if (isNonInteractive && directoryPath) {
    const result = await validateDirectoryForWorkspace(
      directoryPath,
      appState.toolPermissionContext,
    )
    if (result.resultType !== 'success') {
      const message = addDirHelpMessage(result)
      onDone(message)
      return null
    }
    await handleAddDirectory(result.absolutePath, rememberFlag)
    return null
  }

  if (!directoryPath) {
    return (
      <AddWorkspaceDirectory
        permissionContext={appState.toolPermissionContext}
        onAddDirectory={handleAddDirectory}
        onCancel={() => {
          onDone('Did not add a working directory.')
        }}
      />
    )
  }

  const result = await validateDirectoryForWorkspace(
    directoryPath,
    appState.toolPermissionContext,
  )
  if (result.resultType !== 'success') {
    const message = addDirHelpMessage(result)
    return (
      <AddDirError
        message={message}
        args={args ?? ''}
        onDone={() => onDone(message)}
      />
    )
  }

  return (
    <AddWorkspaceDirectory
      directoryPath={result.absolutePath}
      permissionContext={appState.toolPermissionContext}
      onAddDirectory={handleAddDirectory}
      onCancel={() => {
        onDone(
          `Did not add ${chalk.bold(result.absolutePath)} as a working directory.`,
        )
      }}
    />
  )
}
