// Unit tests for the platform rules that need no process inspection: one group key per project directory
// on Windows (XPLAT-AUDIT D11), the exit signals each platform has (D21), and the Windows rename retry
// (D5-D7).
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { renameRetry } from '../../src/core/fsx.js'
import { defaultGroupKey, normalizeRootPath, projectRootOf, samePath } from '../../src/core/project.js'
import { exitSignals, restrictRoot } from '../../src/server/server.js'
import { errno, tmpDir } from '../helpers/env.js'

describe('project root normalization', () => {
    it('on win32 one drive-letter case and one separator give one group key', () => {
        const keys = ['C:\\demo\\app', 'c:\\demo\\app', 'C:/demo/app', 'c:/demo\\app'].map((p) =>
            defaultGroupKey(normalizeRootPath(p, 'win32')),
        )
        expect(new Set(keys).size).toBe(1)
        expect(normalizeRootPath('C:/demo/app', 'win32')).toBe('c:\\demo\\app')
        expect(normalizeRootPath('\\\\server\\share\\x', 'win32')).toBe('\\\\server\\share\\x')
        // Other platforms keep the path as it is (Linux paths are case-sensitive).
        expect(normalizeRootPath('/Demo/App', 'linux')).toBe('/Demo/App')
    })

    it('resolves symlinks, so two ways into one directory give one root', () => {
        const dir = tmpDir('root')
        const real = path.join(dir, 'real')
        fs.mkdirSync(real)
        const link = path.join(dir, 'link')
        fs.symlinkSync(real, link, 'junction')
        expect(projectRootOf(link)).toBe(projectRootOf(real))
        expect(projectRootOf(real)).toBe(normalizeRootPath(fs.realpathSync.native(real)))
    })
})

describe('exit signals', () => {
    it('registers SIGHUP only where it exists', () => {
        expect(exitSignals('linux')).toEqual(['SIGTERM', 'SIGHUP', 'SIGINT'])
        expect(exitSignals('darwin')).toEqual(['SIGTERM', 'SIGHUP', 'SIGINT'])
        expect(exitSignals('win32')).toEqual(['SIGTERM', 'SIGINT'])
    })
})

describe('rename retry', () => {
    afterEach(() => {
        vi.restoreAllMocks()
    })

    it('retries a rename that another program blocks for a moment, and never reports a failed one as done', async () => {
        const dir = tmpDir('rename')
        const [from, to] = [path.join(dir, 'a'), path.join(dir, 'b')]
        fs.writeFileSync(from, 'x')
        const real = fsp.rename
        const spy = vi.spyOn(fsp, 'rename')
        spy.mockRejectedValueOnce(errno('EBUSY')).mockRejectedValueOnce(errno('EPERM'))
        spy.mockImplementation(real)
        await renameRetry(from, to)
        expect(fs.readFileSync(to, 'utf8')).toBe('x')
        spy.mockReset()
        spy.mockRejectedValue(errno('EACCES'))
        await expect(renameRetry(to, from)).rejects.toMatchObject({ code: 'EACCES' })
        expect(spy).toHaveBeenCalledTimes(7)
        spy.mockReset()
        spy.mockRejectedValue(errno('ENOENT'))
        await expect(renameRetry(to, from)).rejects.toMatchObject({ code: 'ENOENT' })
        expect(spy).toHaveBeenCalledTimes(1)
    })
})

describe('modes and path comparison (team review R2)', () => {
    it.skipIf(process.platform === 'win32')(
        'a server start sets a root that an older version created 0755 to 0700',
        async () => {
            // Windows keeps only the write bit, so there is no mode to set (restrictRoot returns at once).
            const root = tmpDir('oldroot')
            fs.chmodSync(root, 0o755)
            await restrictRoot(root)
            expect(fs.statSync(root).mode & 0o777).toBe(0o700)
            await restrictRoot(path.join(root, 'not-yet'))
        },
    )

    it('samePath on Windows ignores letter case in the whole path and the separator form', () => {
        expect(
            samePath(
                'C:\\Users\\Ann\\.harness-summit\\.wake\\claude-S.signal',
                'c:/users/ann/.HARNESS-summit/.wake/claude-S.signal',
                'win32',
            ),
        ).toBe(true)
        expect(samePath('C:\\a\\b.signal', 'C:\\a\\c.signal', 'win32')).toBe(false)
        expect(samePath('/a/B.signal', '/a/b.signal', 'linux')).toBe(false)
        expect(samePath('/a/x/../b.signal', '/a/b.signal', 'linux')).toBe(true)
    })
})
