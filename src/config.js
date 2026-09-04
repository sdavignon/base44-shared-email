import path from "node:path";

export const PACKAGE_VERSION = "0.3.0";
export const MANIFEST_NAME = ".base44-shared-email.json";

const DOMAIN_PATTERN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function parseArgs(argv) {
  const [command = "help", ...rest] = argv;
  const flags = {};
  for (let index = 0; index < rest.length; index += 1) {
    const value = rest[index];
    if (!value.startsWith("--")) throw new Error("Unexpected argument: " + value);
    const key = value.slice(2);
    if (["force", "dry-run", "yes", "include-data-model", "json", "mcp"].includes(key)) {
      flags[key] = true;
      continue;
    }
    const next = rest[index + 1];
    if (!next || next.startsWith("--")) throw new Error("Missing value for --" + key);
    flags[key] = next;
    index += 1;
  }
  return { command, flags };
}

export function buildConfig(flags = {}, cwd = process.cwd()) {
  const domain = String(flags.domain || "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/$/, "");
  if (!DOMAIN_PATTERN.test(domain)) throw new Error("--domain must be a valid hostname, for example example.com");
  const brandName = String(flags.brand || "").trim();
  if (!brandName) throw new Error("--brand is required");
  const defaultMailbox = String(flags.mailbox || "hello@" + domain).trim().toLowerCase();
  if (!EMAIL_PATTERN.test(defaultMailbox) || !defaultMailbox.endsWith("@" + domain)) {
    throw new Error("--mailbox must be an address on " + domain);
  }
  const inboundDomain = String(flags["inbound-domain"] || "inbound." + domain).trim().toLowerCase();
  if (!DOMAIN_PATTERN.test(inboundDomain)) throw new Error("--inbound-domain must be a valid hostname");
  const route = String(flags.route || "/admin/email").trim();
  if (!route.startsWith("/") || /\s/.test(route)) throw new Error("--route must start with / and contain no spaces");
  const target = path.resolve(cwd, String(flags.target || "."));
  return {
    packageVersion: PACKAGE_VERSION,
    brandName,
    domain,
    defaultMailbox,
    inboundDomain,
    route,
    target,
    clientImport: String(flags["client-import"] || "@/api/base44Client"),
    authImport: String(flags["auth-import"] || "@/lib/AuthContext"),
    mcp: Boolean(flags.mcp)
  };
}

export function helpText() {
  return `base44-shared-email by 1976.cloud

Usage:
  base44-shared-email install --target . --brand "Example" --domain example.com
  base44-shared-email diff --target . --brand "Example" --domain example.com
  base44-shared-email doctor --target .
  base44-shared-email uninstall --target . [--include-data-model] [--yes]

Install options:
  --mailbox EMAIL          Defaults to hello@DOMAIN
  --inbound-domain DOMAIN  Defaults to inbound.DOMAIN
  --route PATH             Defaults to /admin/email
  --client-import PATH     Defaults to @/api/base44Client
  --auth-import PATH       Defaults to @/lib/AuthContext
  --mcp                    Add an OAuth App MCP email-support agent
  --dry-run                Preview without writing
  --force                  Replace package-owned files, preserving backups
  --json                   Emit machine-readable output
`;
}
