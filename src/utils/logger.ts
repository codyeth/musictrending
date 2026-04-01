type LogLevel = 'info' | 'warn' | 'error' | 'debug'

const LOG_LEVEL = process.env.LOG_LEVEL ?? 'info'
const LEVEL_PRIORITY: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 }

function shouldLog(level: LogLevel): boolean {
  const minPriority = LEVEL_PRIORITY[LOG_LEVEL as LogLevel] ?? 1
  return LEVEL_PRIORITY[level] >= minPriority
}

function log(level: LogLevel, module: string, message: string) {
  if (!shouldLog(level)) return
  const timestamp = new Date().toISOString()
  const prefix = `[${timestamp}] [${level.toUpperCase()}] [${module}]`
  if (level === 'error') {
    console.error(`${prefix} ${message}`)
  } else {
    console.log(`${prefix} ${message}`)
  }
}

export const logger = {
  info:  (module: string, message: string) => log('info', module, message),
  warn:  (module: string, message: string) => log('warn', module, message),
  error: (module: string, message: string) => log('error', module, message),
  debug: (module: string, message: string) => log('debug', module, message),
}
