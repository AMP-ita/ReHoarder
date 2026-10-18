import { describe, it, expect } from 'vitest'
import { buildAppVersion, upsertInstallation } from './engine-launcher-registration'

const entry = {
  InstallLocation: 'C:\\Program Files\\Epic Games\\UE_5.7',
  NamespaceId: 'ue',
  ItemId: '7299c1cd206b4bb58658a98199b66860',
  ArtifactId: 'UE_5.7',
  AppVersion: '5.7.4-51494982+++UE5+Release-5.7-Windows',
  AppName: 'UE_5.7'
}

describe('buildAppVersion', () => {
  it('matches the launcher shape', () => {
    expect(
      buildAppVersion({
        major: 5,
        minor: 7,
        patch: 4,
        changelist: 51494982,
        branchName: '++UE5+Release-5.7'
      })
    ).toBe('5.7.4-51494982+++UE5+Release-5.7-Windows')
  })
})

describe('upsertInstallation', () => {
  it('creates the file content when there is none', () => {
    const r = upsertInstallation(null, entry)
    expect(r.alreadyListed).toBe(false)
    expect(JSON.parse(r.text).InstallationList).toEqual([entry])
  })

  it('appends and keeps unrelated entries and keys', () => {
    const other = { ...entry, AppName: 'Sample_1', ArtifactId: 'Sample_1' }
    const text = JSON.stringify({ InstallationList: [other], Extra: 1 })
    const r = upsertInstallation(text, entry)
    const parsed = JSON.parse(r.text)
    expect(parsed.InstallationList).toEqual([other, entry])
    expect(parsed.Extra).toBe(1)
  })

  it('updates the entry of the same AppName and keeps its real item id', () => {
    const old = { ...entry, InstallLocation: 'D:\\Old\\UE_5.7', ItemId: 'realid' }
    const r = upsertInstallation(JSON.stringify({ InstallationList: [old] }), {
      ...entry,
      ItemId: ''
    })
    expect(r.alreadyListed).toBe(true)
    const list = JSON.parse(r.text).InstallationList
    expect(list).toHaveLength(1)
    expect(list[0].InstallLocation).toBe(entry.InstallLocation)
    expect(list[0].ItemId).toBe('realid')
  })

  it('rejects a file without an InstallationList', () => {
    expect(() => upsertInstallation('{"x":1}', entry)).toThrow()
  })
})
