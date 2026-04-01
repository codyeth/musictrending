type LogLevel = 'info' | 'warn' | 'error' | 'debug'

function log(level: LogLevel, module: string, message: string) {
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
