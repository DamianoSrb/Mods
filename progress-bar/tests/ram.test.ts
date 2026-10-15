import { expect, test } from 'claude-code/testing'
import { fmtBytes, fmtRamPair, parseRam, ramProbes } from '../hooks/ram'
import { RAM_CARD_H, RAM_CARD_W, ramCardSvg } from '../hooks/ram-card'

const GiB = 1024 ** 3

test('probes per platform, in the order tried', () => {
  const win = ramProbes('win32')
  expect(win.map(p => p.format)).toEqual(['win32', 'wmic'])
  expect((win[0] as { argv: string[] }).argv[0]).toBe('powershell.exe')
  expect((win[1] as { argv: string[] }).argv).toEqual([
    'cmd.exe',
    '/c',
    'wmic OS get FreePhysicalMemory,TotalVisibleMemorySize /value',
  ])
  expect(ramProbes('darwin')).toEqual([{ kind: 'run', argv: ['sh', '-c', 'sysctl -n hw.memsize; vm_stat'], format: 'darwin' }])
  expect(ramProbes('linux')).toEqual([{ kind: 'file', path: '/proc/meminfo', format: 'linux' }])
  expect(ramProbes('freebsd')).toEqual([])
})

test('wmic /value: KB, either order, CR CR LF', () => {
  const out = '\r\r\n\r\r\nFreePhysicalMemory=6291456\r\r\nTotalVisibleMemorySize=16777216\r\r\n\r\r\n\r\r\n'
  expect(parseRam('wmic', out)).toEqual({ totalBytes: 16 * GiB, usedBytes: 10 * GiB })
  expect(parseRam('wmic', 'TotalVisibleMemorySize=16777216\nFreePhysicalMemory=0\n')).toEqual({
    totalBytes: 16 * GiB,
    usedBytes: 16 * GiB,
  })
  expect(parseRam('wmic', 'FreePhysicalMemory=6291456\r\n')).toBe(null)
  expect(parseRam('wmic', 'FreePhysicalMemory=200\r\nTotalVisibleMemorySize=100\r\n')).toBe(null)
  expect(parseRam('wmic', "'wmic' is not recognized as an internal or external command")).toBe(null)
  // The PowerShell format is not wmic's, and the reverse.
  expect(parseRam('wmic', '16777216 6291456')).toBe(null)
  expect(parseRam('win32', out)).toBe(null)
})

test('win32: KB total and free, CRLF and spaces', () => {
  const r = parseRam('win32', '\r\n  16777216   6291456  \r\n')
  expect(r).toEqual({ totalBytes: 16 * GiB, usedBytes: 10 * GiB })
  expect(parseRam('win32', 'garbage')).toBe(null)
  expect(parseRam('win32', '')).toBe(null)
  expect(parseRam('win32', '100 200')).toBe(null)
})

const VM_STAT = [
  '17179869184',
  'Mach Virtual Memory Statistics: (page size of 16384 bytes)',
  'Pages free:                               12000.',
  'Pages active:                            300000.',
  'Pages inactive:                          280000.',
  'Pages wired down:                        150000.',
  'Pages occupied by compressor:             50000.',
].join('\r\n')

test('darwin: (active + wired + compressor) × page size', () => {
  const r = parseRam('darwin', VM_STAT)
  expect(r).toEqual({ totalBytes: 17179869184, usedBytes: 500000 * 16384 })
  expect(parseRam('darwin', VM_STAT.replace(/Pages wired down.*\r\n/, ''))).toBe(null)
  expect(parseRam('darwin', VM_STAT.replace('17179869184\r\n', ''))).toBe(null)
})

test('linux: MemTotal − MemAvailable', () => {
  const mi = 'MemTotal:       32768000 kB\r\nMemFree:         1000000 kB\r\nMemAvailable:   12768000 kB\r\n'
  expect(parseRam('linux', mi)).toEqual({ totalBytes: 32768000 * 1024, usedBytes: 20000000 * 1024 })
  expect(parseRam('linux', 'MemTotal: 100 kB\n')).toBe(null)
})

test('fmtBytes and the pair', () => {
  expect(fmtBytes(15.2 * GiB)).toBe('15.2 GB')
  expect(fmtBytes(16 * GiB)).toBe('16 GB')
  expect(fmtBytes(812 * 1024 ** 2)).toBe('812 MB')
  expect(fmtBytes(512)).toBe('512 B')
  expect(fmtBytes(Number.NaN)).toBe('0 B')
  expect(fmtRamPair({ usedBytes: 9.8 * GiB, totalBytes: 16 * GiB })).toBe('9.8/16 GB')
  expect(fmtRamPair({ usedBytes: 2.5 * GiB, totalBytes: 7.6 * GiB })).toBe('2.5/7.6 GB')
})

test('card svg: size, ids, text, load color', () => {
  const svg = ramCardSvg({ usedBytes: 9.8 * GiB, totalBytes: 16 * GiB })
  expect(svg.startsWith('<svg')).toBe(true)
  expect(svg.endsWith('</svg>')).toBe(true)
  expect(svg).toContain(`width="${RAM_CARD_W}" height="${RAM_CARD_H}"`)
  expect(svg).toContain('>9.8/16 GB</text>')
  expect(svg).toContain('id="pbram-fill"')
  expect(svg).toContain('#F5B731')
  expect(ramCardSvg({ usedBytes: 1 * GiB, totalBytes: 16 * GiB })).toContain('#1D9E75')
  expect(ramCardSvg({ usedBytes: 15 * GiB, totalBytes: 16 * GiB })).toContain('#D0453F')
})

test('card svg: null reading', () => {
  const svg = ramCardSvg(null)
  expect(svg).toContain('RAM –')
  expect(svg).not.toContain('pbram-fill')
})

test('card svg: a failed probe reads RAM ? and says why in its label', () => {
  const svg = ramCardSvg(null, 120, 30, false, 'process.run refused: not available')
  expect(svg).toContain('>RAM ?</text>')
  expect(svg).toContain('aria-label="RAM ? (process.run refused: not available)"')
  expect(svg).not.toContain('RAM –')
})
