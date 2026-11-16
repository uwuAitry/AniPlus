/**
 * Offline checks for dsh-AniPlus. Run with:
 *   ELECTRON_RUN_AS_NODE=1 <dsh-node> verify.mjs
 * or plain `node verify.mjs` when a Node >= 22 is on PATH.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))
const failures = []
const notes = []

function check(condition, message) {
  if (!condition) failures.push(message)
}

function read(path) {
  return readFileSync(join(root, path), 'utf8')
}

function readJson(path) {
  return JSON.parse(read(path))
}

/* ------------------------------------------------------------------ syntax -- */

function syntaxCheck(file) {
  const executable = process.env.ELECTRON_RUN_AS_NODE === '1' ? process.execPath : process.execPath
  execFileSync(executable, ['--check', join(root, file)], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: 'pipe',
  })
}
syntaxCheck('index.js')
syntaxCheck('client.js')

/* ---------------------------------------------------------------- manifest -- */

const pkg = readJson('package.json')
check(pkg.name === 'dsh-aniplus', 'package name must be dsh-aniplus')
check(pkg.version === '0.2.0', 'package version must be 0.2.0')
check(pkg.type === 'module', 'package must be type: module')
check(pkg.private !== true, 'package must be publishable to npm')
check(pkg.license === 'MIT', 'package license must be MIT')
check(pkg.exports?.['.'] === './index.js', 'exports["."] must point at index.js')
check(pkg.exports?.['./client'] === './client.js', 'exports["./client"] must point at client.js')
check(pkg.dsh?.bundle?.patch === './cordis.patch.yml', 'dsh.bundle.patch must point at cordis.patch.yml')
check(pkg.dsh?.client?.platform === 'web', 'dsh.client.platform must be web')
check(pkg.dsh?.client?.immediately === true, 'dsh.client.immediately must be true for a global motion layer')
check(Array.isArray(pkg.dsh?.client?.inject) && pkg.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-settings'), 'dsh.client.inject must include ui-settings')
check(Array.isArray(pkg.files) && pkg.files.includes('client.js') && pkg.files.includes('icon.svg'), 'files must include runtime files and icon')

const patch = read('cordis.patch.yml')
check(/- insert:/.test(patch), 'cordis.patch.yml must contain an insert list')
check(/id:\s*dsh-aniplus/.test(patch), 'patch must insert id dsh-aniplus')
check(/name:\s*'dsh-aniplus'/.test(patch), 'patch must mount name dsh-aniplus')

const host = read('index.js')
check(/export function apply\(\)/.test(host), 'Host half must export apply()')

const client = read('client.js')
check(client.includes("window.__ModuleLoader__.load({"), 'client half must self-register through __ModuleLoader__.load')
check(/id:\s*'dsh-aniplus'/.test(client), 'client registration id must be dsh-aniplus')
check(/exports\.inject\s*=\s*\['theme'\]/.test(client), 'client exports.inject must be [theme]')
check(/exports\.apply\s*=\s*apply/.test(client), 'client must export apply')

/* ------------------------------------------------------------------- locale -- */

for (const locale of ['en', 'zh']) {
  const json = readJson(`locale/${locale}.json`)
  check(typeof json.meta?.title === 'string' && json.meta.title.length > 0, `${locale}.json needs meta.title`)
  check(typeof json.meta?.description === 'string' && json.meta.description.length > 0, `${locale}.json needs meta.description`)
}

/* -------------------------------------------------------------------- icon -- */

const icon = read('icon.svg')
check(icon.trimStart().startsWith('<svg'), 'icon.svg must start with <svg')
check(/width="36"/.test(icon) && /height="36"/.test(icon) && /viewBox="0 0 36 36"/.test(icon), 'icon must use the 36x36 contract')
check(!/<(script|style|text|image|foreignObject)\b/i.test(icon), 'icon must not contain scripts, styles, text, image or foreignObject')
check(statSync(join(root, 'icon.svg')).size <= 256 * 1024, 'icon must stay under 256 KiB')

/* --------------------------------------------------------------------- CSS -- */

const startMarker = '/* == ANIP_CSS_START == */'
const endMarker = '/* == ANIP_CSS_END == */'
const start = client.indexOf(startMarker)
const end = client.indexOf(endMarker)
check(start !== -1 && end > start, 'client.js must carry the ANIP_CSS markers')
const css = start === -1 || end === -1 ? '' : client.slice(start + startMarker.length, end)

check(css.length > 5000, 'motion CSS looks unexpectedly short')
check((css.match(/{/g) ?? []).length === (css.match(/}/g) ?? []).length, 'CSS braces must balance')

const motionStart = css.indexOf('/* 02 — menus')
const settingsStart = css.indexOf('/* 10 — settings page')
check(motionStart !== -1 && settingsStart > motionStart, 'CSS must keep motion and settings sections separated')
const motionCss = css.slice(motionStart, settingsStart)
const settingsCss = css.slice(settingsStart)

check(/@media \(prefers-reduced-motion: no-preference\)/.test(motionCss), 'motion CSS must live under prefers-reduced-motion: no-preference')
check(!/@keyframes/.test(settingsCss), 'settings CSS must not define keyframes')
check(!/animation:/.test(settingsCss), 'settings CSS must not add animations')

const animationNames = [...motionCss.matchAll(/animation:\s*([a-z0-9-]+)/g)].map(match => match[1])
check(animationNames.length > 0, 'motion CSS should contain animations')
check(animationNames.every(name => name.startsWith('anip-')), 'every animation name must be plugin-local (anip-*)')

const keyframes = [...motionCss.matchAll(/@keyframes\s+([a-z0-9-]+)/g)].map(match => match[1])
check(keyframes.length > 0, 'motion CSS should define keyframes')
check(keyframes.every(name => name.startsWith('anip-')), 'every keyframe name must be plugin-local (anip-*)')
check(['anip-ghost-menu-out', 'anip-ghost-dialog-out', 'anip-ghost-tip-out', 'anip-ghost-fade-out'].every(name => keyframes.includes(name)), 'retract ghost keyframes must be present')

for (const forbidden of ['!important', 'transition: all', 'will-change', 'Element.prototype', 'document.body.append(']) {
  check(!client.includes(forbidden), `client.js must not contain "${forbidden}"`)
}
check((client.match(/new MutationObserver/g) ?? []).length === 1, 'exit ghosts must use exactly one bounded MutationObserver')
check(!/--ds-transition-duration-(slow|fast)\s*:/.test(client), 'must not override host duration tokens')
check(!/animation:\s*(dsh-|modalEnter|tooltip-in|wide-in|rail-in|running-)/.test(css), 'must not reference host keyframe names')

const cssWithoutStrings = css.replace(/"[^"]*"|'[^']*'/g, '')
const classSelectors = [...cssWithoutStrings.matchAll(/\.([A-Za-z_][\w-]*)/g)].map(match => match[1])
const foreignClasses = [...new Set(classSelectors.filter(name => !name.startsWith('anip-')))]
check(foreignClasses.length === 0, `CSS must not select host class names: ${foreignClasses.join(', ')}`)

const reducedMotion = /@media \(prefers-reduced-motion: reduce\)/.test(settingsCss)
const settingsTransitions = (settingsCss.match(/transition:/g) ?? []).length
check(settingsTransitions === 0 || reducedMotion, 'settings transitions need a reduced-motion off switch')

/* ------------------------------------------------------- selector honesty -- */

const installRoot = process.env.DSH_INSTALL_DIR || 'D:\\Program Files\\DSH NEXT\\resources\\app.asar'
const packageRoot = join(installRoot, 'node_modules', '@deepseek-ai')

function walk(dir, extensions, visit) {
  if (!existsSync(dir)) return
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules') walk(path, extensions, visit)
    } else if (extensions.some(extension => entry.name.endsWith(extension))) {
      if (statSync(path).size > 4 * 1024 * 1024) continue
      visit(path, readFileSync(path, 'utf8'))
    }
  }
}

const hostAttributes = new Set()
const hostSources = []
if (existsSync(packageRoot)) {
  for (const pkgName of readdirSync(packageRoot)) {
    if (!/^dsh-(client|web)/.test(pkgName)) continue
    const sourceRoot = join(packageRoot, pkgName, 'src')
    walk(sourceRoot, ['.ts', '.tsx', '.css', '.js', '.mjs'], (path, text) => {
      hostSources.push({ path, text })
      for (const match of text.matchAll(/data-[a-z0-9]+(?:-[a-z0-9]+)*/g)) hostAttributes.add(match[0])
    })
  }
} else {
  notes.push(`host package root not found at ${packageRoot}; attribute checks skipped`)
}

if (hostAttributes.size > 0) {
  const usedAttributes = new Set([...css.matchAll(/\[(data-[a-z0-9]+(?:-[a-z0-9]+)*)/g)].map(match => match[1]))
  for (const attribute of usedAttributes) {
    if (attribute.startsWith('data-anip')) continue
    check(hostAttributes.has(attribute), `CSS references unknown host attribute [${attribute}]`)
  }
  notes.push(`checked ${usedAttributes.size} data-* selector attributes against ${hostAttributes.size} host attributes`)

  const slotNames = new Set([...css.matchAll(/\[data-slot="([^"]+)"/g)].map(match => match[1]))
  for (const slot of slotNames) {
    const found = hostSources.some(source => source.text.includes(`'${slot}'`) || source.text.includes(`"${slot}"`))
    check(found, `CSS references unknown slot ${slot}`)
  }
  notes.push(`checked ${slotNames.size} data-slot selectors against host sources`)
}

/* -------------------------------------------------------------- behaviour -- */

check(client.includes("const SETTINGS_KEY = PLUGIN_ID + ':settings'"), 'settings key must stay dsh-aniplus:settings')
check(client.includes("const STYLE_ID = PLUGIN_ID + '/motion.css'"), 'style tag id must stay dsh-aniplus/motion.css')
check(client.includes("id: 'aniplus'"), 'settings section id must be aniplus')
check(client.includes("'--ds-ease-in-out'"), 'theme layer must override --ds-ease-in-out')
check(/light:\s*'cubic-bezier\(0\.22, 1, 0\.36, 1\)'/.test(client), 'theme layer must supply the standard easing for light mode')
check(/dark:\s*'cubic-bezier\(0\.22, 1, 0\.36, 1\)'/.test(client), 'theme layer must supply the standard easing for dark mode')
check(client.includes("INTENSITIES = ['subtle', 'standard', 'expressive']"), 'settings must expose three intensity levels')
check(client.includes("'data-anip-ready'"), 'client must gate initial entrance replay with data-anip-ready')
check(css.includes('[style*="--dsh-model-anchor"]'), 'model selector needs a bottom-origin menu override')
check(client.includes("getPropertyValue('--dsh-model-anchor')"), 'model selector ghost exit must read its anchor property')
check(client.includes("PRESS_SELECTOR = 'button'"), 'press feedback must cover every button')
check(client.includes('function animatePress('), 'button press bounce must be implemented')
check(client.includes("getPropertyValue('--anip-ease-miuix-sink')"), 'press bounce must source the Miuix sink curve')
check(client.includes("getPropertyValue('--anip-press-sink-duration')"), 'press bounce must source the press duration token')
check(css.includes('button:focus-visible'), 'buttons need a keyboard focus ring')

/* -------------------------------------------------------------------- report -- */

for (const note of notes) console.log(`note: ${note}`)
if (failures.length > 0) {
  console.error(`FAIL (${failures.length})`)
  for (const failure of failures) console.error(` - ${failure}`)
  process.exit(1)
}
console.log('PASS: dsh-AniPlus checks passed')
