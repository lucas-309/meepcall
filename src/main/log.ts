const useColor = process.stdout.isTTY === true

const C = {
  reset: '\x1b[0m',
  cyan: '\x1b[36m',
  magenta: '\x1b[35m',
  yellow: '\x1b[33m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  gray: '\x1b[90m',
  blue: '\x1b[34m'
}

function tag(color: string, label: string): string {
  return useColor ? `${color}${label}${C.reset}` : label
}

function timestamp(): string {
  const d = new Date()
  const t = d.toTimeString().split(' ')[0]
  return useColor ? `${C.gray}${t}${C.reset}` : t
}

export const log = {
  recall: (...args: unknown[]): void =>
    console.log(timestamp(), tag(C.cyan, '[recall]'), ...args),
  ai: (...args: unknown[]): void =>
    console.log(timestamp(), tag(C.magenta, '[ai]'), ...args),
  server: (...args: unknown[]): void =>
    console.log(timestamp(), tag(C.yellow, '[server]'), ...args),
  ipc: (...args: unknown[]): void =>
    console.log(timestamp(), tag(C.gray, '[ipc]'), ...args),
  ok: (tagName: string, ...args: unknown[]): void =>
    console.log(timestamp(), tag(C.green, `[${tagName}]`), ...args),
  warn: (tagName: string, ...args: unknown[]): void =>
    console.warn(timestamp(), tag(C.yellow, `[${tagName}]`), ...args),
  err: (tagName: string, ...args: unknown[]): void =>
    console.error(timestamp(), tag(C.red, `[${tagName}]`), ...args)
}
