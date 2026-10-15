// System RAM in use: the probe to run per platform and the parser of its
// output. Pure: register.tsx runs the probe ($.process.run / $.fs.read) and
// hands the text here. No `$` here.

export type RamInfo = { usedBytes: number; totalBytes: number }
export type RamProbe = { kind: 'run'; argv: string[] } | { kind: 'file'; path: string }

/** How often register.tsx re-reads the RAM figures. */
export const RAM_POLL_MS = 5000

const WIN_SCRIPT =
  '$o=Get-CimInstance Win32_OperatingSystem; "$($o.TotalVisibleMemorySize) $($o.FreePhysicalMemory)"'

/** What to run or read on `platform` ('win32' | 'darwin' | 'linux'); null elsewhere. */
export function ramProbe(platform: string): RamProbe | null {
  switch (platform) {
    case 'win32':
      return { kind: 'run', argv: ['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', WIN_SCRIPT] }
    case 'darwin':
      return { kind: 'run', argv: ['sh', '-c', 'sysctl -n hw.memsize; vm_stat'] }
    case 'linux':
      return { kind: 'file', path: '/proc/meminfo' }
    default:
      return null
  }
}

const lines = (s: string): string[] =>
  s
    .split(/\r?\n|\r/)
    .map(l => l.trim())
    .filter(Boolean)

const info = (total: number, used: number): RamInfo | null =>
  Number.isFinite(total) && Number.isFinite(used) && total > 0
    ? { totalBytes: total, usedBytes: Math.min(total, Math.max(0, used)) }
    : null

function parseWin(out: string): RamInfo | null {
  // "<TotalVisibleMemorySize KB> <FreePhysicalMemory KB>"
  for (const l of lines(out)) {
    const m = /^(\d+)\s+(\d+)$/.exec(l)
    if (!m) continue
    const total = Number(m[1]) * 1024
    const free = Number(m[2]) * 1024
    if (free > total) return null
    return info(total, total - free)
  }
  return null
}

function parseMac(out: string): RamInfo | null {
  const ls = lines(out)
  const memLine = ls.find(l => /^\d+$/.test(l))
  const pageM = /page size of (\d+) bytes/i.exec(out)
  if (!memLine || !pageM) return null
  const pages = (label: string): number | null => {
    const re = new RegExp(`^Pages ${label}:\\s*(\\d+)\\.?$`, 'i')
    for (const l of ls) {
      const m = re.exec(l)
      if (m) return Number(m[1])
    }
    return null
  }
  const active = pages('active')
  const wired = pages('wired down')
  const compressed = pages('occupied by compressor')
  if (active === null || wired === null || compressed === null) return null
  return info(Number(memLine), (active + wired + compressed) * Number(pageM[1]))
}

function parseLinux(out: string): RamInfo | null {
  const kb = (key: string): number | null => {
    const m = new RegExp(`^${key}:\\s*(\\d+)\\s*kB$`, 'im').exec(out.replace(/\r/g, ''))
    return m ? Number(m[1]) * 1024 : null
  }
  const total = kb('MemTotal')
  const avail = kb('MemAvailable')
  if (total === null || avail === null || avail > total) return null
  return info(total, total - avail)
}

/** The probe's output (stdout, or the file's text) as used/total bytes; null when unreadable. */
export function parseRam(platform: string, output: string): RamInfo | null {
  if (typeof output !== 'string' || !output.trim()) return null
  switch (platform) {
    case 'win32':
      return parseWin(output)
    case 'darwin':
      return parseMac(output)
    case 'linux':
      return parseLinux(output)
    default:
      return null
  }
}

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const

function unitOf(n: number): number {
  let i = 0
  while (i < UNITS.length - 1 && n >= 1024 ** (i + 1)) i++
  return i
}

const dec1 = (v: number): string => v.toFixed(1).replace(/\.0$/, '')

/** Base 1024: 15.2 GB, 16 GB, 812 MB, 512 B. GB and up keep one decimal (dropped when .0). */
export function fmtBytes(n: number): string {
  const v = Number.isFinite(n) ? Math.max(0, n) : 0
  const i = unitOf(v)
  const x = v / 1024 ** i
  return `${i >= 3 ? dec1(x) : String(Math.round(x))} ${UNITS[i]}`
}

/** "9.8/16 GB": used and total in the total's unit; the total rounded past 10. */
export function fmtRamPair(r: RamInfo): string {
  const i = unitOf(r.totalBytes)
  const t = r.totalBytes / 1024 ** i
  const u = r.usedBytes / 1024 ** i
  const total = t >= 10 ? String(Math.round(t)) : dec1(t)
  const used = i >= 3 ? dec1(u) : String(Math.round(u))
  return `${used}/${total} ${UNITS[i]}`
}

/** used/total in [0, 1]. */
export const ramRatio = (r: RamInfo): number =>
  r.totalBytes > 0 ? Math.min(1, Math.max(0, r.usedBytes / r.totalBytes)) : 0

/** Load color: green under 60%, amber under 85%, red past. */
export const ramColor = (ratio: number): string => (ratio < 0.6 ? '#1D9E75' : ratio < 0.85 ? '#F5B731' : '#D0453F')
