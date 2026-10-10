// Unit tests for the DTOs at the edges: the OpenCode session.get answer (DEMO D3, REVIEW m12), the
// whoami output union (REVIEW m15) and the CLI argument DTO (REVIEW m16).
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { logsToFile, parseCliArgs, parseHarnessList } from '../../src/cli/args.js'
import { resolveCwd } from '../../src/core/project.js'
import { WhoamiOutput } from '../../src/server/tools.js'
import { opencodeMeta, recordingExec, tmpDir } from '../helpers/env.js'

describe('OpenCode session directory', () => {
    it('reads data.location.directory from `opencode api session.get`', async () => {
        const dir = tmpDir('ocdir')
        const exec = recordingExec({
            code: 0,
            stdout: JSON.stringify({ data: { id: 'ses_a', location: { directory: dir } } }),
            stderr: '',
        })
        expect(await resolveCwd('opencode', opencodeMeta('ses_a'), exec)).toEqual({
            cwd: dir,
            cwdSource: 'opencode-session',
        })
        expect(exec.calls[0]?.req.args).toEqual(['api', 'session.get', '--param', 'sessionID=ses_a'])
    })

    it('falls back to process.cwd on a top-level directory field or bad JSON', async () => {
        const dir = tmpDir('ocdir')
        for (const stdout of [JSON.stringify({ directory: dir }), 'not json']) {
            const exec = recordingExec({ code: 0, stdout, stderr: '' })
            expect((await resolveCwd('opencode', opencodeMeta('ses_a'), exec)).cwdSource).toBe('process.cwd')
        }
    })
})

describe('whoami output', () => {
    it('requires the identity fields exactly when joined', () => {
        const id = {
            uuid: '11111111-1111-4111-8111-111111111111',
            name: null,
            groupKey: 'g',
            folder: '/f',
            harness: 'pi',
        }
        expect(WhoamiOutput.safeParse({ joined: true, hostKey: 'pi-1', ...id }).success).toBe(true)
        expect(WhoamiOutput.safeParse({ joined: false, hostKey: 'pi-1' }).success).toBe(true)
        expect(WhoamiOutput.safeParse({ joined: true, hostKey: 'pi-1' }).success).toBe(false)
        expect(WhoamiOutput.safeParse({ joined: false, hostKey: 'pi-1', uuid: id.uuid }).success).toBe(false)
    })
})

describe('CLI arguments', () => {
    it('parses into the DTO and turns parse errors into SUMMIT_BAD_INPUT', () => {
        expect(parseCliArgs(['install', '--harness', 'pi,omp', '--dry-run', '--home', '/h'])).toMatchObject({
            cmd: 'install',
            harness: 'pi,omp',
            dryRun: true,
            // `--home` is resolved: `/h` on POSIX, `<drive>:\\h` on Windows.
            home: path.resolve('/h'),
        })
        expect(() => parseCliArgs(['--nope'])).toThrow(expect.objectContaining({ code: 'SUMMIT_BAD_INPUT' }))
        expect(() => parseHarnessList('pi,vim')).toThrow(expect.objectContaining({ code: 'SUMMIT_BAD_INPUT' }))
    })

    it('logs to the summit root only for commands that own it', () => {
        const yes = ['mcp', 'hook', 'notice', 'install', 'uninstall']
        for (const cmd of yes) expect(logsToFile(parseCliArgs([cmd]))).toBe(true)
        for (const argv of [[], ['--help'], ['doctor'], ['gen-plugin'], ['install', '--dry-run'], ['mcp', '-h']]) {
            expect(logsToFile(parseCliArgs(argv)), argv.join(' ')).toBe(false)
        }
    })
})
