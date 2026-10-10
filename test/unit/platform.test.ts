// Unit tests for the platform rules that need no process inspection: one group key per project directory
// on Windows (XPLAT-AUDIT D11), the exit signals each platform has (D21), and the Windows rename retry
// (D5-D7).
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { renameRetry } from '../../src/core/fsx.js'
import { defaultGroupKey, normalizeRootPath, projectRootOf } from '../../src/core/project.js'
import { exitSignals } from '../../src/server/server.js'
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
