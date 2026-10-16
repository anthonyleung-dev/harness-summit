// A config file install created, where the user then adds their own key (SPEC §8): uninstall removes only our
// key and keeps the file with the user's content, whether or not an install ran again in between; with no user
// content left, the file goes and the home is as before install. No backup of a file install created is left.
import fs from 'node:fs'
import path from 'node:path'
import { parse as parseToml } from 'smol-toml'
import { describe, expect, it } from 'vitest'

import { HARNESSES } from '../../src/core/schemas.js'
import { BACKUP_SUFFIX } from '../../src/install/actions.js'
import { setJsonKey } from '../../src/install/edits.js'
import { runInstall, runUninstall } from '../../src/install/install.js'
import type { Launch } from '../../src/install/render.js'
import { snapshot, tmpDir } from '../helpers/env.js'
import { claudeExec, fakeOpencode, OLD_LAUNCH, TEST_LAUNCH } from '../helpers/install.js'

const OMP = '.omp/agent/mcp.json'
const CODEX = '.codex/config.toml'
const OPENCODE = '.config/opencode/opencode.json'
const MINE = { command: 'mine' }

// Purpose: an empty home and install / uninstall of every harness there, with the fake opencode.
function emptyHome() {
    const home = tmpDir('home')
    const opts = { harnesses: [...HARNESSES], home, dryRun: false }
    const file = (rel: string) => path.join(home, rel)
    return {
        home,
        file,
        install: (launch: Launch) => runInstall({ ...opts, exec: claudeExec(fakeOpencode), launch }),
        uninstall: () => runUninstall({ ...opts, exec: claudeExec(), launch: TEST_LAUNCH }),
    }
}

// Purpose: the user adds their own key to each config file install created.
function addUserKeys(file: (rel: string) => string): void {
    const json = (rel: string, keyPath: string[], value: unknown) =>
        fs.writeFileSync(file(rel), setJsonKey(fs.readFileSync(file(rel), 'utf8'), keyPath, value, rel))
    json(OMP, ['mcpServers', 'mine'], MINE)
    json(OPENCODE, ['model', 'mine'], 'glm')
    fs.appendFileSync(file(CODEX), '\n[mcp_servers.mine]\ncommand = "mine"\n')
}

// Purpose: each file holds exactly the user's key, and no backup is left anywhere in the home.
function onlyUserKeys(home: string, file: (rel: string) => string): void {
    const read = (rel: string) => fs.readFileSync(file(rel), 'utf8')
    expect(JSON.parse(read(OMP))).toEqual({ mcpServers: { mine: MINE } })
    expect(JSON.parse(read(OPENCODE))).toEqual({ model: { mine: 'glm' } })
    expect(parseToml(read(CODEX))).toEqual({ mcp_servers: { mine: MINE } })
    expect(Object.keys(snapshot(home).files).filter((f) => f.endsWith(BACKUP_SUFFIX))).toEqual([])
}

describe('a user key in a config file install created', () => {
    it('install A, user key, install B, uninstall: the file stays with only the user key', async () => {
        const { home, file, install, uninstall } = emptyHome()
        await install(OLD_LAUNCH)
        addUserKeys(file)
        await install(TEST_LAUNCH)
        await uninstall()
        onlyUserKeys(home, file)
    })

    it('one install, user key, uninstall: the file stays with only the user key', async () => {
        const { home, file, install, uninstall } = emptyHome()
        await install(TEST_LAUNCH)
        addUserKeys(file)
        await uninstall()
        onlyUserKeys(home, file)
    })

    it('without a user key: the files go and the home is as before install', async () => {
        const { home, install, uninstall } = emptyHome()
        const original = snapshot(home)
        await install(OLD_LAUNCH)
        await install(TEST_LAUNCH)
        await uninstall()
        expect(snapshot(home)).toEqual(original)
    })
})
