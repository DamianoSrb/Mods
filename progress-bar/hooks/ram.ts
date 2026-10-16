// System RAM in use: the probe to run per platform and the parser of its
// output. Pure: register.tsx runs the probe ($.process.run / $.fs.read) and
// hands the text here. No `$` here.

export type RamInfo = { usedBytes: number; totalBytes: number }
/**
 * Which parser reads a probe's output. 'typeperf' gives only the available
 * memory: it needs the total of an earlier reading.
 */
export type RamFormat = 'win32' | 'typeperf' | 'darwin' | 'linux'
export type RamProbe =
  | { kind: 'run'; argv: string[]; format: RamFormat; timeoutMs: number }
  | { kind: 'file'; path: string; format: RamFormat }

/** How often register.tsx re-reads the RAM figures. */
export const RAM_POLL_MS = 10000
/** A failed poll stays silent while the last good reading is younger than this. */
export const RAM_GRACE_MS = 60000

const WIN_SCRIPT =
  '$o=Get-CimInstance Win32_OperatingSystem; "$($o.TotalVisibleMemorySize) $($o.FreePhysicalMemory)"'

// typeperf's counter path is localized: English first, then Italian.
const TYPEPERF_COUNTERS = ['\\Memory\\Available MBytes', '\\Memoria\\MByte disponibili']

/**
 * What to run or read on `platform` ('win32' | 'darwin' | 'linux'), in the
 * order to try them: register.tsx moves on to the next when one rejects,
 * exits non-zero or does not parse. Empty elsewhere.
 */
export function ramProbes(platform: string): RamProbe[] {
  switch (platform) {
    case 'win32':
      return [
        {
          kind: 'run',
          argv: ['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', WIN_SCRIPT],
          format: 'win32',
          // A cold PowerShell start can take several seconds.
          timeoutMs: 15000,
        },
        ...TYPEPERF_COUNTERS.map(
          (counter): RamProbe => ({
            kind: 'run',
            argv: ['typeperf.exe', counter, '-sc', '1'],
            format: 'typeperf',
            timeoutMs: 10000,
          }),
        ),
      ]
    case 'darwin':
      return [{ kind: 'run', argv: ['sh', '-c', 'sysctl -n hw.memsize; vm_stat'], format: 'darwin', timeoutMs: 4000 }]
    case 'linux':
      return [{ kind: 'file', path: '/proc/meminfo', format: 'linux' }]
    default:
      return []
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

/**
 * typeperf's CSV (`-sc 1`): a header line, then `"<timestamp>","<value>"`,
 * among blank and localized status lines. The last CSV line's last quoted
 * value is the available memory in MB; null when it is not a number (no
 * sample, header only, an error message).
 */
export function parseTypeperfAvailableMB(out: string): number | null {
  if (typeof out !== 'string') return null
  const csv = lines(out).filter(l => l.startsWith('"'))
  const last = csv[csv.length - 1]
  if (!last) return null
  const values = [...last.matchAll(/"([^"]*)"/g)].map(m => m[1] ?? '')
  const v = (values[values.length - 1] ?? '').trim().replace(/^(\d+),(\d+)$/, '$1.$2')
  return /^\d+(\.\d+)?$/.test(v) ? Number(v) : null
}

function parseTypeperf(out: string, totalBytes: number | null): RamInfo | null {
  const mb = parseTypeperfAvailableMB(out)
  if (mb === null || totalBytes === null || !(totalBytes > 0)) return null
  const avail = mb * 1024 * 1024
  if (avail > totalBytes) return null
  return info(totalBytes, totalBytes - avail)
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

/**
 * The probe's output (stdout, or the file's text) as used/total bytes; null
 * when unreadable. `format` is the probe's (a platform name, or 'typeperf',
 * which reads only the available memory and takes the total as
 * `knownTotalBytes`, from an earlier reading: null without one).
 */
export function parseRam(format: string, output: string, knownTotalBytes: number | null = null): RamInfo | null {
  if (typeof output !== 'string' || !output.trim()) return null
  switch (format) {
    case 'win32':
      return parseWin(output)
    case 'typeperf':
      return parseTypeperf(output, knownTotalBytes)
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
