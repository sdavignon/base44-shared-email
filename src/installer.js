import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MANIFEST_NAME, PACKAGE_VERSION } from "./config.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const templateRoot = path.join(packageRoot, "templates");

const hash = (value) => createHash("sha256").update(value).digest("hex");
const slash = (value) => value.split(path.sep).join("/");
const regexpEscape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

async function readIfExists(file) {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function walk(directory, prefix = "") {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const relative = path.join(prefix, entry.name);
    if (entry.isDirectory()) files.push(...await walk(path.join(directory, entry.name), relative));
    else files.push(relative);
  }
  return files;
}

function replacements(config) {
  return new Map([
    ["__PACKAGE_VERSION__", PACKAGE_VERSION],
    ["__BRAND_JSON__", JSON.stringify(config.brandName)],
    ["__BRAND_JSON_ESCAPED__", JSON.stringify(config.brandName).slice(1, -1)],
    ["__DOMAIN_JSON__", JSON.stringify(config.domain)],
    ["__DOMAIN_REGEX__", regexpEscape(config.domain)],
    ["__DEFAULT_MAILBOX_JSON__", JSON.stringify(config.defaultMailbox)],
    ["__INBOUND_DOMAIN_JSON__", JSON.stringify(config.inboundDomain)],
    ["__ROUTE_JSON__", JSON.stringify(config.route)],
    ["__CLIENT_IMPORT_JSON__", JSON.stringify(config.clientImport)],
    ["__AUTH_IMPORT_JSON__", JSON.stringify(config.authImport)],
    ["__BRAND_TEXT__", config.brandName],
    ["__DOMAIN_TEXT__", config.domain],
    ["__DEFAULT_MAILBOX_TEXT__", config.defaultMailbox],
    ["__INBOUND_DOMAIN_TEXT__", config.inboundDomain],
    ["__ROUTE_TEXT__", config.route]
  ]);
}

function render(source, config) {
  let output = source;
  for (const [token, value] of replacements(config)) output = output.replaceAll(token, value);
  const unresolved = output.match(/__[A-Z0-9_]+__/g);
  if (unresolved) throw new Error("Unresolved template token: " + unresolved[0]);
  return output;
}

function outputPath(templatePath) {
  return slash(templatePath.endsWith(".tmpl") ? templatePath.slice(0, -5) : templatePath);
}

export async function readManifest(target) {
  const file = path.join(target, MANIFEST_NAME);
  try {
    return await readJson(file);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw new Error("Cannot read " + MANIFEST_NAME + ": " + error.message);
  }
}

async function assertBase44Project(target) {
  if (!existsSync(path.join(target, "base44", "config.jsonc"))) {
    throw new Error("Target is not an existing Base44 project: base44/config.jsonc was not found");
  }
  if (!existsSync(path.join(target, "package.json"))) {
    throw new Error("Target is not a JavaScript project: package.json was not found");
  }
}

async function renderedTemplates(config) {
  const templateFiles = await walk(templateRoot);
  const files = [];
  for (const templatePath of templateFiles) {
    const normalizedTemplatePath = slash(templatePath);
    const mcpOnly = normalizedTemplatePath.startsWith("base44/mcp/") ||
      normalizedTemplatePath.startsWith("base44/agents/shared_email_assistant") ||
      normalizedTemplatePath.startsWith("base44/functions/shared-email-assistant-api/") ||
      normalizedTemplatePath === "base44-shared-email.mcp.md.tmpl";
    if (mcpOnly && !config.mcp) continue;
    const source = await readFile(path.join(templateRoot, templatePath), "utf8");
    const content = render(source, config);
    const relativePath = outputPath(templatePath);
    files.push({
      relativePath,
      content,
      sha256: hash(content),
      dataModel: relativePath.startsWith("base44/entities/")
    });
  }
  return files;
}

export async function install(config, options = {}) {
  await assertBase44Project(config.target);
  const previous = await readManifest(config.target);
  const previousFiles = new Map((previous?.installedFiles || []).map((item) => [item.path, item]));
  const files = await renderedTemplates(config);
  const plan = [];
  const conflicts = [];

  for (const file of files) {
    const destination = path.join(config.target, file.relativePath);
    const current = await readIfExists(destination);
    if (current === null) {
      plan.push({ action: "create", path: file.relativePath });
      continue;
    }
    if (hash(current) === file.sha256) {
      plan.push({ action: "unchanged", path: file.relativePath });
      continue;
    }
    const previousFile = previousFiles.get(file.relativePath);
    const packageOwnedAndUnmodified = previousFile && hash(current) === previousFile.sha256;
    if (packageOwnedAndUnmodified) plan.push({ action: "update", path: file.relativePath });
    else if (options.force) plan.push({ action: "replace", path: file.relativePath });
    else conflicts.push(file.relativePath);
  }

  if (conflicts.length) {
    throw new Error(
      "Installation stopped to protect existing files:\n- " + conflicts.join("\n- ") +
      "\nRe-run with --force to back up and replace them."
    );
  }
  if (options.dryRun) return { changed: false, dryRun: true, plan, config };

  const backupRoot = path.join(config.target, ".base44-shared-email-backup", new Date().toISOString().replace(/[:.]/g, "-"));
  const backupPaths = [];
  for (const file of files) {
    const step = plan.find((item) => item.path === file.relativePath);
    if (step.action === "unchanged") continue;
    const destination = path.join(config.target, file.relativePath);
    if (step.action === "replace") {
      const backup = path.join(backupRoot, file.relativePath);
      await mkdir(path.dirname(backup), { recursive: true });
      await writeFile(backup, await readFile(destination));
      backupPaths.push(slash(path.relative(config.target, backup)));
    }
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, file.content, "utf8");
  }

  const manifest = {
    package: "base44-shared-email",
    version: PACKAGE_VERSION,
    installedAt: new Date().toISOString(),
    generatedBy: "1976.cloud",
    config: {
      brandName: config.brandName,
      domain: config.domain,
      defaultMailbox: config.defaultMailbox,
      inboundDomain: config.inboundDomain,
      route: config.route,
      clientImport: config.clientImport,
      authImport: config.authImport,
      mcp: config.mcp
    },
    installedFiles: files.map((file) => ({
      path: file.relativePath,
      sha256: file.sha256,
      dataModel: file.dataModel
    }))
  };
  await writeFile(path.join(config.target, MANIFEST_NAME), JSON.stringify(manifest, null, 2) + "\n", "utf8");
  return { changed: plan.some((item) => item.action !== "unchanged"), dryRun: false, plan, backupPaths, manifest };
}

async function sourceFiles(target) {
  const root = path.join(target, "src");
  if (!existsSync(root)) return [];
  return (await walk(root)).filter((file) => /\.[jt]sx?$/.test(file));
}

export async function doctor(target) {
  const resolved = path.resolve(target);
  const errors = [];
  const warnings = [];
  if (!existsSync(path.join(resolved, "base44", "config.jsonc"))) errors.push("base44/config.jsonc is missing");
  if (!existsSync(path.join(resolved, "package.json"))) errors.push("package.json is missing");
  const manifest = await readManifest(resolved);
  if (!manifest) {
    errors.push(MANIFEST_NAME + " is missing; run install first");
    return { ok: false, target: resolved, errors, warnings, manifest: null };
  }
  if (manifest.version !== PACKAGE_VERSION) warnings.push("Installed version is " + manifest.version + "; package version is " + PACKAGE_VERSION);
  for (const item of manifest.installedFiles || []) {
    const content = await readIfExists(path.join(resolved, item.path));
    if (content === null) errors.push("Missing installed file: " + item.path);
    else if (hash(content) !== item.sha256) warnings.push("Locally modified installed file: " + item.path);
  }

  let routeFound = false;
  let componentFound = false;
  for (const relative of await sourceFiles(resolved)) {
    const content = await readFile(path.join(resolved, "src", relative), "utf8");
    if (content.includes(manifest.config.route)) routeFound = true;
    if (content.includes("SharedEmailPage") || content.includes("SharedEmailAdmin")) componentFound = true;
  }
  if (!componentFound) errors.push("SharedEmailPage is not referenced by the application");
  if (!routeFound) warnings.push("No application route references " + manifest.config.route);

  const packageJson = existsSync(path.join(resolved, "package.json"))
    ? await readJson(path.join(resolved, "package.json"))
    : {};
  const dependencies = { ...packageJson.dependencies, ...packageJson.devDependencies };
  if (!dependencies.react) errors.push("The generated admin UI requires React");
  if (!dependencies["@base44/sdk"]) warnings.push("@base44/sdk is not declared in package.json");
  return { ok: errors.length === 0, target: resolved, errors, warnings, manifest };
}

export async function uninstall(target, options = {}) {
  const resolved = path.resolve(target);
  const manifest = await readManifest(resolved);
  if (!manifest) throw new Error(MANIFEST_NAME + " was not found");
  if (!options.yes) throw new Error("Uninstall requires --yes");
  const kept = [];
  const removed = [];
  const modified = [];
  for (const item of manifest.installedFiles || []) {
    if (item.dataModel && !options.includeDataModel) {
      kept.push(item);
      continue;
    }
    const destination = path.join(resolved, item.path);
    const content = await readIfExists(destination);
    if (content === null) continue;
    if (hash(content) !== item.sha256) {
      modified.push(item.path);
      continue;
    }
    await rm(destination);
    removed.push(item.path);
  }
  if (kept.length || modified.length) {
    const next = {
      ...manifest,
      uninstalledAt: new Date().toISOString(),
      installedFiles: [...kept, ...modified.map((itemPath) => manifest.installedFiles.find((item) => item.path === itemPath))]
    };
    await writeFile(path.join(resolved, MANIFEST_NAME), JSON.stringify(next, null, 2) + "\n", "utf8");
  } else {
    await rm(path.join(resolved, MANIFEST_NAME));
  }
  return { removed, preservedDataModel: kept.map((item) => item.path), modified };
}
