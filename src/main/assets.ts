import { app } from 'electron'
import { join } from 'node:path'

export function resolveBinPath(name: string): string {
  if (app.isPackaged) return join(process.resourcesPath, 'bin', name)
  return join(app.getAppPath(), 'build', 'bin', name)
}

export function resolveModelPath(name: string): string {
  if (app.isPackaged) return join(process.resourcesPath, 'models', name)
  return join(app.getAppPath(), 'build', 'models', name)
}
