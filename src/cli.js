import path from "node:path";
import { buildConfig, helpText, MANIFEST_NAME, PACKAGE_VERSION, parseArgs } from "./config.js";
import { doctor, install, readManifest, uninstall } from "./installer.js";

function print(value, json) {
  if (json) console.log(JSON.stringify(value, null, 2));
  else console.log(value);
}

function installationSummary(result) {
  const counts = result.plan.reduce((accumulator, item) => {
    accumulator[item.action] = (accumulator[item.action] || 0) + 1;
    return accumulator;
  }, {});
  const heading = result.dryRun ? "Installation preview" : "Shared email module installed";
  return [
    heading,
    ...Object.entries(counts).map(([key, count]) => "  " + key + ": " + count),
    ...(result.backupPaths?.length ? ["  backups: " + result.backupPaths.length] : []),
    "",
    "Next: open base44-shared-email.install.md in the target project and wire the generated page into its protected admin route."
  ].join("\n");
}

function configFlagsFromManifest(manifest) {
  if (!manifest?.config) return {};
  return {
    brand: manifest.config.brandName,
    domain: manifest.config.domain,
    mailbox: manifest.config.defaultMailbox,
    "inbound-domain": manifest.config.inboundDomain,
    route: manifest.config.route,
    "client-import": manifest.config.clientImport,
    "auth-import": manifest.config.authImport,
    mcp: Boolean(manifest.config.mcp)
  };
}

export async function runCli(argv) {
  const { command, flags } = parseArgs(argv);
  if (["help", "--help", "-h"].includes(command)) {
    console.log(helpText());
    return;
  }
  if (["version", "--version", "-v"].includes(command)) {
    console.log(PACKAGE_VERSION);
    return;
  }
  const target = path.resolve(process.cwd(), String(flags.target || "."));
  if (command === "doctor") {
    const result = await doctor(target);
    if (flags.json) print(result, true);
    else {
      console.log(result.ok ? "Shared email installation is healthy." : "Shared email installation needs attention.");
      result.errors.forEach((item) => console.log("  ERROR: " + item));
      result.warnings.forEach((item) => console.log("  WARN: " + item));
    }
    if (!result.ok) process.exitCode = 1;
    return result;
  }
  if (command === "uninstall") {
    const result = await uninstall(target, {
      yes: Boolean(flags.yes),
      includeDataModel: Boolean(flags["include-data-model"])
    });
    print(flags.json ? result : [
      "Shared email code removed.",
      "  removed: " + result.removed.length,
      "  preserved data-model files: " + result.preservedDataModel.length,
      "  preserved modified files: " + result.modified.length
    ].join("\n"), Boolean(flags.json));
    return result;
  }
  if (["install", "upgrade", "diff"].includes(command)) {
    const manifest = command === "upgrade" ? await readManifest(target) : null;
    if (command === "upgrade" && !manifest) throw new Error(MANIFEST_NAME + " is missing; use install first");
    const config = buildConfig({ ...configFlagsFromManifest(manifest), ...flags }, process.cwd());
    const result = await install(config, {
      dryRun: command === "diff" || Boolean(flags["dry-run"]),
      force: Boolean(flags.force)
    });
    print(flags.json ? result : installationSummary(result), Boolean(flags.json));
    return result;
  }
  throw new Error("Unknown command: " + command + "\n\n" + helpText());
}
