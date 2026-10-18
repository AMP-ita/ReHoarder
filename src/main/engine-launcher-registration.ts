import { spawn } from 'node:child_process'
import { promises as fsp } from 'node:fs'
import * as path from 'node:path'

/**
 * Registers an on-disk engine in the Epic Games Launcher's install list
 * (`LauncherInstalled.dat`). Unreal's Version Selector and the `.uproject`
 * association enumerate engines from that file, so an engine whose entry went
 * missing (copied folder, wiped launcher data) stops showing up there even
 * though its files and registry keys are fine. Nothing is downloaded: only the
 * one JSON entry is written back.
 */

export interface RegisterWithLauncherResult {
  ok: boolean
  error?: string
  /** `AppName` written to the list, e.g. `UE_5.7`. */
  appName?: string
  /** True when an entry for this engine was already there and was left or updated in place. */
  alreadyListed?: boolean
  /** True when the Epic Games Launcher is running: it rewrites the file from its own state. */
  launcherRunning?: boolean
  /** True when the catalog item id of this version is not known (entry written with an empty id). */
  unknownItemId?: boolean
  /** Absolute path of the `.dat` that was written. */
  datPath?: string
}

interface LauncherInstallation {
  InstallLocation: string
  NamespaceId: string
  ItemId: string
  ArtifactId: string
  AppVersion: string
  AppName: string
}

interface LauncherInstalledFile {
  InstallationList: LauncherInstallation[]
  [key: string]: unknown
}

/** Catalog item ids of the Epic engine builds, taken from launcher installs. */
const KNOWN_ITEM_IDS: Record<string, string> = {
  '4.27': '3ddb1bad6e004b99a7192c1a29f2318a',
  '5.5': '1b3c549b6a724e90ad94d9c1f410bc96',
  '5.6': '73923380f4d944d5bcb6d77a0640d26d',
  '5.7': '7299c1cd206b4bb58658a98199b66860',
  '5.8': '18b3b415bc434c5b974f50488360ca31'
}

export function launcherInstalledDatPath(): string {
  const programData = process.env.ProgramData ?? 'C:\\ProgramData'
  return path.join(programData, 'Epic', 'UnrealEngineLauncher', 'LauncherInstalled.dat')
}

export interface EngineBuildInfo {
  major: number
  minor: number
  patch: number
  changelist: number
  branchName: string
}

export async function readEngineBuildInfo(engineRoot: string): Promise<EngineBuildInfo | null> {
  try {
    const raw = await fsp.readFile(
      path.join(engineRoot, 'Engine', 'Build', 'Build.version'),
      'utf-8'
    )
    const v = JSON.parse(raw) as Record<string, unknown>
    const num = (x: unknown): number => (typeof x === 'number' ? x : 0)
    return {
      major: num(v.MajorVersion),
      minor: num(v.MinorVersion),
      patch: num(v.PatchVersion),
      changelist: num(v.Changelist),
      branchName: typeof v.BranchName === 'string' ? v.BranchName : ''
    }
  } catch {
    return null
  }
}

/** `5.7.4-51494982+++UE5+Release-5.7-Windows`, the launcher's `AppVersion` shape. */
export function buildAppVersion(info: EngineBuildInfo): string {
  return `${info.major}.${info.minor}.${info.patch}-${info.changelist}+${info.branchName}-Windows`
}

/**
 * Pure merge step: returns the new file text with `entry` added, or the
 * existing entry updated when one with the same `AppName` is already listed.
 * `existingText` is null when the file does not exist yet. Formatting follows
 * the launcher's own (tab indentation).
 */
export function upsertInstallation(
  existingText: string | null,
  entry: LauncherInstallation
): { text: string; alreadyListed: boolean } {
  let file: LauncherInstalledFile = { InstallationList: [] }
  if (existingText !== null && existingText.trim() !== '') {
    const parsed = JSON.parse(existingText) as LauncherInstalledFile
    if (!parsed || !Array.isArray(parsed.InstallationList)) {
      throw new Error('LauncherInstalled.dat has no InstallationList array')
    }
    file = parsed
  }
  const idx = file.InstallationList.findIndex((i) => i.AppName === entry.AppName)
  let alreadyListed = false
  if (idx >= 0) {
    alreadyListed = true
    const old = file.InstallationList[idx]
    // Keep a real item id the launcher already knows over a guessed one.
    file.InstallationList[idx] = { ...entry, ItemId: old.ItemId || entry.ItemId }
  } else {
    file.InstallationList.push(entry)
  }
  return { text: JSON.stringify(file, null, '\t'), alreadyListed }
}

function isLauncherRunning(): Promise<boolean> {
  return new Promise((resolve) => {
    let out = ''
    const child = spawn('tasklist.exe', ['/FI', 'IMAGENAME eq EpicGamesLauncher.exe', '/NH'], {
      windowsHide: true
    })
    child.stdout?.on('data', (c) => (out += c.toString()))
    child.on('close', () => resolve(/EpicGamesLauncher\.exe/i.test(out)))
    child.on('error', () => resolve(false))
  })
}

export async function registerEngineWithLauncher(
  engineRoot: string
): Promise<RegisterWithLauncherResult> {
  if (process.platform !== 'win32') {
    return { ok: false, error: 'The Epic Games Launcher install list only exists on Windows.' }
  }
  const info = await readEngineBuildInfo(engineRoot)
  if (!info) {
    return { ok: false, error: 'Could not read Engine/Build/Build.version in that folder.' }
  }
  const short = `${info.major}.${info.minor}`
  const appName = `UE_${short}`
  const itemId = KNOWN_ITEM_IDS[short] ?? ''
  const datPath = launcherInstalledDatPath()

  let existing: string | null = null
  try {
    existing = await fsp.readFile(datPath, 'utf-8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      return { ok: false, error: `Could not read ${datPath}: ${(err as Error).message}` }
    }
  }

  let merged: { text: string; alreadyListed: boolean }
  try {
    merged = upsertInstallation(existing, {
      InstallLocation: path.resolve(engineRoot),
      NamespaceId: 'ue',
      ItemId: itemId,
      ArtifactId: appName,
      AppVersion: buildAppVersion(info),
      AppName: appName
    })
  } catch (err) {
    return { ok: false, error: `${datPath} is not valid: ${(err as Error).message}` }
  }

  try {
    await fsp.mkdir(path.dirname(datPath), { recursive: true })
    // One backup of the file as the launcher left it, never overwritten.
    if (existing !== null) {
      await fsp.writeFile(datPath + '.rehoarder.bak', existing, { flag: 'wx' }).catch(() => {})
    }
    const tmp = datPath + '.rehoarder.tmp'
    await fsp.writeFile(tmp, merged.text, 'utf-8')
    await fsp.rename(tmp, datPath)
  } catch (err) {
    return { ok: false, error: `Could not write ${datPath}: ${(err as Error).message}` }
  }

  return {
    ok: true,
    appName,
    alreadyListed: merged.alreadyListed,
    launcherRunning: await isLauncherRunning(),
    unknownItemId: itemId === '',
    datPath
  }
}
