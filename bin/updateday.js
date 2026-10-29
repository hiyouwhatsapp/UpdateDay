#!/usr/bin/env node
import { existsSync } from "node:fs";

const built = new URL("../dist/cli.js", import.meta.url);
await import(existsSync(built) ? built.href : new URL("../src/cli.ts", import.meta.url).href);
