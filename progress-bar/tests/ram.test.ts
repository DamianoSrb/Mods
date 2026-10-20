import { expect, test } from 'claude-code/testing'
import { fmtBytes, fmtRamPair, parseRam, parseTypeperfAvailableMB, ramProbes } from '../hooks/ram'
import { RAM_CARD_H, RAM_CARD_W, ramAltText, ramCardSvg, rightZoneSvg } from '../hooks/ram-card'

const GiB = 1024 ** 3
const MiB = 1024 ** 2

test('probes per platform, in the order tried', () => {
  const win = ramProbes('win32')
  expect(win.map(p => p.format)).toEqual(['win32', 'typeperf', 'typeperf'])
  const ps = win[0] as { argv: string[]; timeoutMs: number }
  expect(ps.argv[0]).toBe('powershell.exe')
  expect(ps.timeoutMs).toBe(15000)
  // Direct argv, no shell: the English counter, then the Italian one.
  expect((win[1] as { argv: string[] }).argv).toEqual(['typeperf.exe', '\\Memory\\Available MBytes', '-sc', '1'])
  expect((win[2] as { argv: string[] }).argv).toEqual(['typeperf.exe', '\\Memoria\\MByte disponibili', '-sc', '1'])
  expect(JSON.stringify(win)).not.toContain('wmic')
  expect(ramProbes('darwin')).toEqual([
    { kind: 'run', argv: ['sh', '-c', 'sysctl -n hw.memsize; vm_stat'], format: 'darwin', timeoutMs: 4000 },
  ])
  expect(ramProbes('linux')).toEqual([{ kind: 'file', path: '/proc/meminfo', format: 'linux' }])
  expect(ramProbes('freebsd')).toEqual([])
})

// typeperf's output as captured on an Italian Windows 11, CRLF.
const TYPEPERF_IT = [
  '',
  '"(PDH-CSV 4.0)","\\\\NBK-SOMMAVILLA\\Memoria\\MByte disponibili"',
  '"10/16/2026 13:40:49.703","5735.000000"',
  'Uscita in corso. Attendere...                             ',
  'Esecuzione comando riuscita.',
  '',
  '',
].join('\r\n')
// The same on an English Windows.
const TYPEPERF_EN = [
  '',
  '"(PDH-CSV 4.0)","\\\\HOST\\Memory\\Available MBytes"',
  '"10/16/2026 13:40:49.703","4096.000000"',
  'Exiting, please wait...                                   ',
  'The command completed successfully.',
  '',
].join('\r\n')

test('typeperf: the last CSV line, last value, in MB; status lines ignored', () => {
  expect(parseTypeperfAvailableMB(TYPEPERF_IT)).toBe(5735)
  expect(parseTypeperfAvailableMB(TYPEPERF_EN)).toBe(4096)
  expect(parseTypeperfAvailableMB(TYPEPERF_EN.replace(/\r\n/g, '\n'))).toBe(4096)
  expect(
    parseTypeperfAvailableMB('"(PDH-CSV 4.0)","\\\\H\\Memoria\\MByte disponibili"\r\n"t","5735,5"\r\nComando completato.\r\n'),
  ).toBe(5735.5)
  // Header only, an empty sample, an error message: nothing.
  expect(
    parseTypeperfAvailableMB('"(PDH-CSV 4.0)","\\\\H\\Memory\\Available MBytes"\r\nThe command completed successfully.\r\n'),
  ).toBe(null)
  expect(parseTypeperfAvailableMB('"(PDH-CSV 4.0)","x"\r\n"10/16/2026 13:40:49.703"," "\r\n')).toBe(null)
  expect(parseTypeperfAvailableMB('\r\nUscita in corso. Attendere...\r\nErrore: nessun contatore valido.\r\n')).toBe(null)
  expect(parseTypeperfAvailableMB('')).toBe(null)
})

test('typeperf: used = the known total minus available; no total, no reading', () => {
  expect(parseRam('typeperf', TYPEPERF_EN, 16 * GiB)).toEqual({ totalBytes: 16 * GiB, usedBytes: 16 * GiB - 4096 * MiB })
  expect(parseRam('typeperf', TYPEPERF_IT, 28 * GiB)).toEqual({ totalBytes: 28 * GiB, usedBytes: 28 * GiB - 5735 * MiB })
  expect(parseRam('typeperf', TYPEPERF_EN)).toBe(null)
  expect(parseRam('typeperf', TYPEPERF_EN, null)).toBe(null)
  // More available than the total: unreadable.
  expect(parseRam('typeperf', TYPEPERF_EN, 2 * GiB)).toBe(null)
  // The PowerShell format is not typeperf's, and the reverse.
  expect(parseRam('typeperf', '16777216 6291456', 16 * GiB)).toBe(null)
  expect(parseRam('win32', TYPEPERF_EN)).toBe(null)
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

test('card svg: a failed probe reads RAM ? and its label stays short', () => {
  const svg = ramCardSvg(null, 120, 30, false, 'timeout')
  expect(svg).toContain('>RAM ?</text>')
  expect(svg).toContain('aria-label="RAM ?"')
  expect(svg).not.toContain('RAM –')
  expect(svg).not.toContain('timeout')
})

// The reason chain the VS Code band once showed as text.
const CHAIN =
  'process.run refused: progress-bar: $.process.run(powershell.exe) aborted: still running after 4000ms (powershell.exe); cmd.exe exit 1: "wmic" non è riconosciuto'

test('alt text: short, never a failure reason', () => {
  const r = { usedBytes: 21.6 * GiB, totalBytes: 28 * GiB }
  expect(ramAltText(r)).toBe('RAM 21.6/28 GB')
  expect(ramAltText(r, null)).toBe('RAM 21.6/28 GB')
  expect(ramAltText(null, 'timeout')).toBe('RAM ?')
  expect(ramAltText(null, CHAIN)).toBe('RAM ?')
  expect(ramAltText(null)).toBe('RAM')
  for (const alt of [ramAltText(r, CHAIN), ramAltText(null, CHAIN)]) {
    expect(alt).not.toContain('process.run')
    expect(alt).not.toContain('wmic')
    expect(alt.length).toBeLessThanOrEqual(20)
  }
})

test('right zone: one <svg>, the card inlined in a translated group', () => {
  const r = { usedBytes: 21.6 * GiB, totalBytes: 28 * GiB }
  const cases: [typeof r | null, string | null][] = [
    [r, null],
    [null, 'timeout'],
    [null, CHAIN],
    [null, null],
  ]
  for (const [reading, err] of cases) {
    const svg = rightZoneSvg(reading, err, 180, 66)
    expect(svg.match(/<svg/g)?.length).toBe(1)
    expect(svg.match(/<\/svg>/g)?.length).toBe(1)
    // Fluid: designed at 180 × 66 (a viewBox), no width/height on the root.
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 180 66" preserveAspectRatio="xMinYMin meet"')).toBe(true)
    expect(svg.match(/^<svg[^>]*>/)?.[0]).not.toMatch(/\s(width|height)=/)
    expect(svg.endsWith('</g></svg>')).toBe(true)
    // Both styles at the root, before any drawing.
    expect(svg.match(/<style>/g)?.length).toBe(2)
    expect(svg.indexOf('.pbz-l{')).toBeLessThan(svg.indexOf('<line'))
    expect(svg.indexOf('.k{fill:#ecebe8}')).toBeLessThan(svg.indexOf('<line'))
    // Each id once.
    const ids = [...svg.matchAll(/ id="([^"]+)"/g)].map(m => m[1])
    expect(new Set(ids).size).toBe(ids.length)
    expect(svg).not.toContain('process.run')
    expect(svg).not.toContain('wmic')
  }
  // Card: 160 wide (the cap), centered right of the divider: 8 + (172 − 160) / 2.
  const svg = rightZoneSvg(r, null, 180, 66)
  expect(svg).toContain('<g id="pbz-card" transform="translate(14,0)">')
  expect(svg).toContain('<rect id="pbram-card" class="k" x="0" y="0" width="160" height="30" rx="6"/>')
  expect(svg).toContain('>21.6/28 GB</text>')
  expect(svg).toContain('aria-label="RAM 21.6/28 GB"')
  expect(rightZoneSvg(null, 'timeout', 180, 66)).toContain('>RAM ?</text>')
  // The card's elements are the standalone card's, unchanged.
  const card = ramCardSvg(r, 160, 30)
  const inner = card.slice(card.indexOf('</style>') + '</style>'.length, -'</svg>'.length)
  expect(svg).toContain(`<g id="pbz-card" transform="translate(14,0)">${inner}</g>`)
})
