#!/usr/bin/env node
// Entry point of the `harness-summit` binary.
import { cli } from './cli/main.js'

await cli(process.argv.slice(2))
