#!/usr/bin/env node

import { runCli } from "../src/cli.js";

runCli(process.argv.slice(2)).catch((error) => {
  console.error("base44-shared-email: " + (error instanceof Error ? error.message : String(error)));
  process.exitCode = 1;
});
