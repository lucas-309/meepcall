import { EventEmitter } from 'node:events'
import type { SdkLogEntry } from '@shared/types'

const emitter = new EventEmitter()

function emit(entry: SdkLogEntry): void {
  emitter.emit('log', entry)
}

export const sdkLogger = {
  logApiCall(method: string, params: Record<string, unknown> = {}): void {
    emit({ type: 'api-call', method, params, timestamp: new Date().toISOString() })
  },
  logEvent(eventType: string, data: Record<string, unknown> = {}): void {
    emit({ type: 'event', eventType, data, timestamp: new Date().toISOString() })
  },
  logError(errorType: string, message: string): void {
    emit({ type: 'error', errorType, message, timestamp: new Date().toISOString() })
  },
  log(message: string, level: 'info' | 'warn' = 'info'): void {
    emit({ type: level, message, timestamp: new Date().toISOString() })
  },
  onLog(cb: (entry: SdkLogEntry) => void): () => void {
    emitter.on('log', cb)
    return () => emitter.off('log', cb)
  }
}
