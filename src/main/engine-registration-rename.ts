import { spawn } from 'node:child_process'
import { promises as fsp } from 'node:fs'
import * as path from 'node:path'
import { scanProjects } from './projects-local'

/**
 * Gives a source build registered under `HKCU\Software\Epic Games\Unreal
 * Engine\Builds` a readable name in place of its GUID. Unreal resolves an
 * `EngineAssociation` by plain lookup of the value name, so any string that is
 * not a GUID (and not an `X.Y` launcher release) works, and a shared repo then
 * carries the same value on every machine that registers the build under it.
 * Projects pointing at the old GUID are retargeted before the old value goes.
 */

const BUILDS_KEY = 'HKCU\\Software\\Epic Games\\Unreal Engine\\Builds'
const GUID_RE = /^\{?[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}\}?$/i

export interface BuildRegistration {
  name: string
  path: string
}

export interface RenameAffectedProject {
  name: string
  uprojectPath: string
}

export interface RenamePreviewResult {
  ok: boolean
  error?: string
  oldName?: string
  projects?: RenameAffectedProject[]
}

export interface RenameRegistrationResult {
  ok: boolean
  error?: string
  oldName?: string
  updatedProjects?: number
  failures?: Array<{ uprojectPath: string; error: string }>
}

function runReg(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    const child = spawn('reg.exe', args, { windowsHide: true })
    child.stdout?.on('data', (c) => (stdout += c.toString()))
    child.stderr?.on('data', (c) => (stderr += c.toString()))
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }))
    child.on('error', (err) => resolve({ code: -1, stdout, stderr: err.message }))
  })
}

/** Parses `reg query` output: `    <name>    REG_SZ    <data>` per value. */
export function parseRegQuery(output: string): BuildRegistration[] {
  const out: BuildRegistration[] = []
  for (const line of output.split(/\r?\n/)) {
    const m = /^\s+(.+?)\s+REG_SZ\s+(.*?)\s*$/.exec(line)
    if (m) out.push({ name: m[1], path: m[2] })
  }
  return out
}

export async function listBuildRegistrations(): Promise<BuildRegistration[]> {
  if (process.platform !== 'win32') return []
  const r = await runReg(['query', BUILDS_KEY])
  return r.code === 0 ? parseRegQuery(r.stdout) : []
}

const normPath = (p: string): string =>
  path.resolve(p.replace(/\//g, '\\')).toLowerCase()

export function isGuidName(name: string): boolean {
  return GUID_RE.test(name)
}

/** Registration whose data points at `engineRoot`, or null. */
export async function findBuildRegistration(
  engineRoot: string
): Promise<BuildRegistration | null> {
  const target = normPath(engineRoot)
  const all = await listBuildRegistrations()
  return all.find((r) => normPath(r.path) === target) ?? null
}

/** Pure check of a candidate name against the names already in the key. */
export function validateRegistrationName(
  name: string,
  existingNames: string[],
  currentName: string
): string | null {
  if (!name) return 'Enter a name.'
  if (name.length > 64) return 'Use at most 64 characters.'
  if (!/^[A-Za-z0-9][A-Za-z0-9._ -]*$/.test(name)) {
    return 'Use letters, digits, dot, underscore, space or hyphen, starting with a letter or digit.'
  }
  if (name !== name.trim()) return 'Remove the leading or trailing spaces.'
  if (isGuidName(name)) return 'A GUID is not a readable name.'
  if (/^\d+(\.\d+)?$/.test(name)) {
    return 'Names like 5.7 are reserved for engines installed by the Epic Games Launcher.'
  }
  const lower = name.toLowerCase()
  if (existingNames.some((n) => n !== currentName && n.toLowerCase() === lower)) {
    return 'Another registered build already uses this name.'
  }
  return null
}

async function projectsUsing(
  projectPaths: string[],
  oldName: string
): Promise<RenameAffectedProject[]> {
  const all = await scanProjects(projectPaths)
  const want = oldName.toLowerCase()
  return all
    .filter((p) => p.engineAssociation.toLowerCase() === want)
    .map((p) => ({ name: p.name, uprojectPath: p.uprojectPath }))
}

export async function previewRegistrationRename(
  engineRoot: string,
  newName: string,
  projectPaths: string[]
): Promise<RenamePreviewResult> {
  const current = await findBuildRegistration(engineRoot)
  if (!current) return { ok: false, error: 'This engine is not registered under HKCU Builds.' }
  const names = (await listBuildRegistrations()).map((r) => r.name)
  const bad = validateRegistrationName(newName.trim(), names, current.name)
  if (bad) return { ok: false, error: bad }
  return {
    ok: true,
    oldName: current.name,
    projects: await projectsUsing(projectPaths, current.name)
  }
}

/** Swap only the `EngineAssociation` value, leaving the rest of the file byte for byte. */
export function replaceEngineAssociation(
  text: string,
  oldName: string,
  newName: string
): string | null {
  let replaced = false
  const next = text.replace(
    /("EngineAssociation"\s*:\s*")([^"]*)(")/,
    (whole, pre: string, value: string, post: string) => {
      if (value.toLowerCase() !== oldName.toLowerCase()) return whole
      replaced = true
      return pre + newName + post
    }
  )
  return replaced ? next : null
}

export async function renameBuildRegistration(
  engineRoot: string,
  newNameRaw: string,
  projectPaths: string[]
): Promise<RenameRegistrationResult> {
  if (process.platform !== 'win32') {
    return { ok: false, error: 'Build registrations live in the Windows registry.' }
  }
  const newName = newNameRaw.trim()
  const current = await findBuildRegistration(engineRoot)
  if (!current) return { ok: false, error: 'This engine is not registered under HKCU Builds.' }
  const names = (await listBuildRegistrations()).map((r) => r.name)
  const bad = validateRegistrationName(newName, names, current.name)
  if (bad) return { ok: false, error: bad }
  if (newName === current.name) return { ok: false, error: 'That is already its name.' }

  const projects = await projectsUsing(projectPaths, current.name)

  // New value first, so there is never a moment when the engine has no name.
  const add = await runReg(['add', BUILDS_KEY, '/v', newName, '/t', 'REG_SZ', '/d', current.path, '/f'])
  if (add.code !== 0) {
    return { ok: false, error: `reg.exe add failed: ${add.stderr.trim() || add.code}` }
  }

  let updated = 0
  const failures: Array<{ uprojectPath: string; error: string }> = []
  for (const p of projects) {
    try {
      const text = await fsp.readFile(p.uprojectPath, 'utf-8')
      const next = replaceEngineAssociation(text, current.name, newName)
      if (next === null) continue
      await fsp.copyFile(p.uprojectPath, p.uprojectPath + '.bak').catch(() => {})
      const tmp = p.uprojectPath + '.tmp'
      await fsp.writeFile(tmp, next, 'utf-8')
      await fsp.rename(tmp, p.uprojectPath)
      updated++
    } catch (err) {
      failures.push({
        uprojectPath: p.uprojectPath,
        error: err instanceof Error ? err.message : String(err)
      })
    }
  }

  // A project that could not be retargeted still points at the old name, so
  // the old value stays until every project moved.
  if (failures.length > 0) {
    return {
      ok: true,
      oldName: current.name,
      updatedProjects: updated,
      failures,
      error: 'Some projects could not be updated, so the old registration was kept.'
    }
  }
  const del = await runReg(['delete', BUILDS_KEY, '/v', current.name, '/f'])
  if (del.code !== 0) {
    return {
      ok: true,
      oldName: current.name,
      updatedProjects: updated,
      error: `Renamed, but the old value could not be removed: ${del.stderr.trim() || del.code}`
    }
  }
  return { ok: true, oldName: current.name, updatedProjects: updated }
}
