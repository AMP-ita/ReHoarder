import { describe, it, expect } from 'vitest'
import {
  isGuidName,
  parseRegQuery,
  replaceEngineAssociation,
  validateRegistrationName
} from './engine-registration-rename'

describe('parseRegQuery', () => {
  it('reads name and path from reg query output', () => {
    const out =
      '\r\nHKEY_CURRENT_USER\\Software\\Epic Games\\Unreal Engine\\Builds\r\n' +
      '    {97C1723C-4C07-141A-C4BC-ECA50B1E34D8}    REG_SZ    O:/_Unreal/SourceBuilds/UE_5.7_AssetDowngrader\r\n' +
      '    My Build    REG_SZ    D:\\Builds\\UE 5.4\r\n'
    expect(parseRegQuery(out)).toEqual([
      {
        name: '{97C1723C-4C07-141A-C4BC-ECA50B1E34D8}',
        path: 'O:/_Unreal/SourceBuilds/UE_5.7_AssetDowngrader'
      },
      { name: 'My Build', path: 'D:\\Builds\\UE 5.4' }
    ])
  })
})

describe('isGuidName', () => {
  it('matches braced and bare GUIDs only', () => {
    expect(isGuidName('{97C1723C-4C07-141A-C4BC-ECA50B1E34D8}')).toBe(true)
    expect(isGuidName('97c1723c-4c07-141a-c4bc-eca50b1e34d8')).toBe(true)
    expect(isGuidName('AssetDowngrader')).toBe(false)
  })
})

describe('validateRegistrationName', () => {
  const existing = ['{97C1723C-4C07-141A-C4BC-ECA50B1E34D8}', 'Other']
  const cur = existing[0]
  it('accepts a readable name', () => {
    expect(validateRegistrationName('AssetDowngrader', existing, cur)).toBeNull()
    expect(validateRegistrationName('UE 5.7 Source', existing, cur)).toBeNull()
  })
  it('rejects empty, GUID, release-like and duplicate names', () => {
    expect(validateRegistrationName('', existing, cur)).not.toBeNull()
    expect(validateRegistrationName('{97C1723C-4C07-141A-C4BC-ECA50B1E34D9}', existing, cur)).not.toBeNull()
    expect(validateRegistrationName('5.7', existing, cur)).not.toBeNull()
    expect(validateRegistrationName('other', existing, cur)).not.toBeNull()
    expect(validateRegistrationName('bad\\name', existing, cur)).not.toBeNull()
  })
})

describe('replaceEngineAssociation', () => {
  const guid = '{97C1723C-4C07-141A-C4BC-ECA50B1E34D8}'
  it('changes only the matching value and keeps the rest verbatim', () => {
    const text = `{\n\t"FileVersion": 3,\n\t"EngineAssociation": "${guid}",\n\t"Category": ""\n}\n`
    expect(replaceEngineAssociation(text, guid, 'AssetDowngrader')).toBe(
      text.replace(guid, 'AssetDowngrader')
    )
  })
  it('returns null when the association is something else', () => {
    expect(replaceEngineAssociation('{"EngineAssociation": "5.7"}', guid, 'X')).toBeNull()
  })
})
