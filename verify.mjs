/**
 * Verification for the usage-panel bundle: syntax, the module contract the DSH
 * client loader needs, and the peak-clock schedule math.
 *
 * Schedules under test (both Asia/Shanghai = UTC+8, so local Tokyo times are +1h):
 *   GLM      weekdays 14:00-18:00  -> 15:00-19:00 Asia/Tokyo
 *   DeepSeek weekdays 09:00-12:00 / 14:00-18:00 -> 10:00-13:00 / 15:00-19:00
 * The assertions build expected instants with the local Date constructor, so
 * they describe the viewer-local band; the host timezone is Asia/Tokyo.
 */
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const bundle = path.join(here, 'bundle/client.js')
const problems = []
const check = (label, ok) => { if (!ok) problems.push(label) }

try {
  execFileSync(process.execPath, ['--check', bundle], { stdio: 'pipe' })
} catch (error) {
  problems.push('node --check failed: ' + String(error.stderr ?? error.message).slice(0, 300))
}

const text = readFileSync(bundle, 'utf8')
for (const marker of ['.sup-peak-chip', '.sup-peak-band', '.sup-peak-now', '.sup-peak-axis', '.sup-peak-range', 'PeakClock', 'PEAK_RULES', 'peakEndsIn', 'peakStartsIn', 'peakRangeAt', 'ResetCreditsInfo', 'CodexResetRow']) {
  check('bundle contains ' + marker, text.includes(marker))
}

const reactStub = {
  createElement: () => ({}),
  memo: (fn) => fn,
  useState: () => [0, () => {}],
  useEffect: () => {},
  useCallback: (fn) => fn,
  useRef: () => ({ current: null }),
}
const requireStub = (name) => (name === 'react' ? reactStub : {})

let mod = null
try {
  globalThis.window = { __ModuleLoader__: { load: (definition) => { mod = definition.factory(requireStub) } } }
  await import('file://' + bundle + '?v=' + Date.now())
} catch (error) {
  problems.push('module factory threw: ' + String(error?.message ?? error).slice(0, 400))
}

check('exports apply()', typeof mod?.apply === 'function')
check('exports inject[]', Array.isArray(mod?.inject))

const peak = mod?.__peak
check('exports the peak test seam', peak !== undefined)
if (peak !== undefined) {
  const at = (y, m, d, hh, mm) => new Date(y, m - 1, d, hh, mm, 0, 0).getTime()
  const glm = peak.rules.glm
  const deepseek = peak.rules.deepseek

  const afternoon = peak.periodAt(glm, at(2026, 11, 4, 16, 0))
  check('GLM Wed 16:00 is peak', afternoon.peak === true)
  check('GLM peak ends 19:00 local', afternoon.boundaryMs === at(2026, 11, 4, 19, 0))

  const noon = peak.periodAt(glm, at(2026, 11, 4, 12, 0))
  check('GLM Wed 12:00 is off-peak', noon.peak === false)
  check('GLM next peak is 15:00 local', noon.boundaryMs === at(2026, 11, 4, 15, 0))

  const evening = peak.periodAt(glm, at(2026, 11, 4, 20, 0))
  check('GLM Wed 20:00 is off-peak', evening.peak === false)
  check('GLM next peak is Thursday 15:00', evening.boundaryMs === at(2026, 11, 5, 15, 0))

  const weekend = peak.periodAt(glm, at(2026, 11, 7, 16, 0))
  check('GLM Saturday is off-peak', weekend.peak === false)
  check('GLM next peak is Monday 15:00', weekend.boundaryMs === at(2026, 11, 9, 15, 0))

  const wedBands = peak.bands(glm, at(2026, 11, 4, 16, 0)).bands
  check('GLM Wednesday has one band', wedBands.length === 1)
  check('GLM band is 15:00-19:00 local',
    wedBands[0]?.start === at(2026, 11, 4, 15, 0) && wedBands[0]?.end === at(2026, 11, 4, 19, 0))

  const dsBands = peak.bands(deepseek, at(2026, 11, 4, 16, 0)).bands
  check('DeepSeek Wednesday has two bands', dsBands.length === 2)
  check('DeepSeek first band is 10:00-13:00 local',
    dsBands[0]?.start === at(2026, 11, 4, 10, 0) && dsBands[0]?.end === at(2026, 11, 4, 13, 0))
  check('DeepSeek second band is 15:00-19:00 local',
    dsBands[1]?.start === at(2026, 11, 4, 15, 0) && dsBands[1]?.end === at(2026, 11, 4, 19, 0))

  check('window start is inclusive', peak.windowAt(glm, at(2026, 11, 4, 15, 0)) !== null)
  check('window end is exclusive', peak.windowAt(glm, at(2026, 11, 4, 19, 0)) === null)

  // 計画に使う「ピーク窓の開始・終了」（ローカル瞬時値）
  const peakRange = peak.rangeAt(glm, at(2026, 11, 4, 16, 0))
  check('GLM 16:00 range is the current window', peakRange.peak === true)
  check('GLM current range is 15:00-19:00',
    peakRange.from === at(2026, 11, 4, 15, 0) && peakRange.to === at(2026, 11, 4, 19, 0))

  const noonRange = peak.rangeAt(glm, at(2026, 11, 4, 12, 0))
  check('GLM 12:00 range is the next window', noonRange.peak === false)
  check('GLM next range is 15:00-19:00 today',
    noonRange.from === at(2026, 11, 4, 15, 0) && noonRange.to === at(2026, 11, 4, 19, 0))

  const eveRange = peak.rangeAt(glm, at(2026, 11, 4, 20, 0))
  check('GLM 20:00 next range is Thu 15:00-19:00',
    eveRange.from === at(2026, 11, 5, 15, 0) && eveRange.to === at(2026, 11, 5, 19, 0))

  const dsMorn = peak.rangeAt(deepseek, at(2026, 11, 4, 10, 0))
  check('DeepSeek 10:00 current range is 10:00-13:00',
    dsMorn.peak === true && dsMorn.from === at(2026, 11, 4, 10, 0) && dsMorn.to === at(2026, 11, 4, 13, 0))

  const dsGap = peak.rangeAt(deepseek, at(2026, 11, 4, 13, 30))
  check('DeepSeek 13:30 next range is 15:00-19:00',
    dsGap.peak === false && dsGap.from === at(2026, 11, 4, 15, 0) && dsGap.to === at(2026, 11, 4, 19, 0))

  const satRange = peak.rangeAt(glm, at(2026, 11, 7, 16, 0))
  check('GLM Saturday next range is Mon 15:00-19:00',
    satRange.from === at(2026, 11, 9, 15, 0) && satRange.to === at(2026, 11, 9, 19, 0))
}

// ── 使用量リセット権（Codex / Claude）の純関数 ─────────────────────────────
let fetchers = null
try {
  fetchers = await import('file://' + path.join(here, 'src/fetchers.mjs') + '?v=' + Date.now())
} catch (error) {
  problems.push('src/fetchers.mjs import threw: ' + String(error?.message ?? error).slice(0, 300))
}
check('fetchers exports codexResetCredits', typeof fetchers?.codexResetCredits === 'function')
check('fetchers exports pickUsableCredits', typeof fetchers?.pickUsableCredits === 'function')
check('fetchers exports claudeResetCredits', typeof fetchers?.claudeResetCredits === 'function')
if (fetchers !== null) {
  const creditsInfo = fetchers.codexResetCredits({ rate_limit_reset_credits: { available_count: 2, applicable_available_count: 1 } })
  check('codex reset credits read available/applicable', creditsInfo?.available === 2 && creditsInfo?.applicable === 1)
  check('codex reset credits absent -> null', fetchers.codexResetCredits({}) === null)

  const usable = fetchers.pickUsableCredits({ credits: [
    { id: 'a', status: 'available', expires_at: '2026-12-01T00:00:00Z' },
    { id: 'b', status: 'redeemed', expires_at: '2026-11-20T00:00:00Z' },
    { id: 'c', status: 'available', expires_at: '2026-11-20T00:00:00Z' },
  ] })
  check('codex reset credits keep only available ones', usable.length === 2 && usable.every((c) => c.id !== 'b'))
  check('codex reset credits are sorted by expiry', usable[0]?.id === 'c' && usable[1]?.id === 'a')

  const now = Date.parse('2026-11-07T00:00:00Z')
  const noGrant = fetchers.claudeResetCredits({ eligible: false, ineligible_reason: 'no_grant', grants: [] }, now)
  check('claude reset credits: no_grant is 0 and not eligible', noGrant?.available === 0 && noGrant?.eligible === false && noGrant?.reason === 'no_grant')
  const grants = fetchers.claudeResetCredits({
    eligible: true,
    grants: [
      { id: 'g1', resets_left: 2, ends_at: '2026-12-01T00:00:00Z', usable_now: true },
      { id: 'g2', resets_left: 1, ends_at: '2026-10-01T00:00:00Z', usable_now: true },
      { id: 'g3', resets_left: 5, ends_at: '2026-12-01T00:00:00Z', paused: true },
    ],
  }, now)
  check('claude reset credits sum live grants', grants?.available === 2)
  check('claude reset credits expose the earliest expiry', typeof grants?.expiresAt === 'string' && grants.expiresAt.length > 0)
  check('claude reset credits absent -> null', fetchers.claudeResetCredits(null) === null)
}

if (problems.length > 0) {
  console.error('FAIL')
  for (const problem of problems) console.error('  - ' + problem)
  process.exit(1)
}
console.log('PASS: panel bundle parses, exposes apply/inject, and the peak clock reports GLM/DeepSeek bands correctly')
