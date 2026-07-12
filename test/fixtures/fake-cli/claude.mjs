#!/usr/bin/env node
/* global process */

import { runFakeProvider } from './fakeProviderCore.mjs';

runFakeProvider('claude', process.argv.slice(2));
