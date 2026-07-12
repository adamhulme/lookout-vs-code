#!/usr/bin/env node
/* global process */

import { runFakeProvider } from './fakeProviderCore.mjs';

runFakeProvider('codex', process.argv.slice(2));
