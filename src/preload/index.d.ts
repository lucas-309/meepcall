import type { RecallApi, SdkLoggerBridge } from '../shared/types'

declare global {
  interface Window {
    api: RecallApi
    sdkLoggerBridge: SdkLoggerBridge
  }
}

export {}
