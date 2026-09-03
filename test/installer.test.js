import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { buildConfig } from "../src/config.js";
import { doctor, install, readManifest, uninstall } from "../src/installer.js";

const testRoot = path.resolve(".test-tmp");

async function project() {
  await mkdir(testRoot, { recursive: true });
  const root = await mkdtemp(path.join(testRoot, "site-"));
  await mkdir(path.join(root, "base44"), { recursive: true });
  await writeFile(path.join(root, "base44", "config.jsonc"), '{ "name": "fixture" }\n');
  await writeFile(path.join(root, "package.json"), JSON.stringify({ dependencies: { react: "latest", "@base44/sdk": "latest" } }, null, 2));
  return root;
}

const config = (target) => buildConfig({ target, brand: "Acme & Co", domain: "example.com" });
const mcpConfig = (target) => buildConfig({ target, brand: 'Acme "Support"', domain: "example.com", mcp: true });

test.after(async () => {
  await rm(testRoot, { recursive: true, force: true });
});

test("installs a namespaced, branded Base44 email feature", async () => {
  const root = await project();
  const result = await install(config(root));
  assert.equal(result.changed, true);
  assert.ok(result.plan.length >= 20);
  const manifest = await readManifest(root);
  assert.equal(manifest.generatedBy, "1976.cloud");
  assert.equal(manifest.config.defaultMailbox, "hello@example.com");
  assert.equal(manifest.installedFiles.filter((item) => item.dataModel).length, 8);
  const source = await readFile(path.join(root, "base44", "shared", "sharedEmailConfig.ts"), "utf8");
  assert.match(source, /Acme & Co/);
  assert.match(source, /1976\.cloud/);
  assert.doesNotMatch(source, /__[A-Z0-9_]+__/);
  const guide = await readFile(path.join(root, "base44-shared-email.install.md"), "utf8");
  assert.match(guide, /https:\/\/1976\.cloud/);
  assert.match(guide, /inbound\.example\.com/);
  assert.equal(manifest.config.mcp, false);
  assert.equal(manifest.installedFiles.some((item) => item.path === "base44/mcp/config.json"), false);
  for (const item of manifest.installedFiles.filter((file) => file.path.endsWith(".jsonc"))) {
    const content = await readFile(path.join(root, item.path), "utf8");
    assert.doesNotThrow(() => JSON.parse(content), item.path + " should contain valid JSONC-compatible JSON");
  }
});

test("optionally installs OAuth App MCP email support", async () => {
  const root = await project();
  await install(mcpConfig(root));
  const manifest = await readManifest(root);
  assert.equal(manifest.config.mcp, true);
  assert.ok(manifest.installedFiles.some((item) => item.path === "base44/mcp/config.json"));
  assert.ok(manifest.installedFiles.some((item) => item.path === "base44/agents/shared_email_assistant.jsonc"));
  assert.ok(manifest.installedFiles.some((item) => item.path === "base44/functions/shared-email-assistant-api/entry.ts"));
  const appMcp = JSON.parse(await readFile(path.join(root, "base44", "mcp", "config.json"), "utf8"));
  assert.equal(appMcp.auth, "oauth");
  const agent = JSON.parse(await readFile(path.join(root, "base44", "agents", "shared_email_assistant.jsonc"), "utf8"));
  assert.equal(agent.name, "shared_email_assistant");
  assert.match(agent.description, /Acme "Support"/);
  assert.deepEqual(agent.tool_configs.map((tool) => tool.function_name), ["shared-email-assistant-api"]);
  const gateway = await readFile(path.join(root, "base44", "functions", "shared-email-assistant-api", "entry.ts"), "utf8");
  assert.match(gateway, /confirm_send/);
  assert.match(gateway, /explicit confirmation/i);
  const guide = await readFile(path.join(root, "base44-shared-email.mcp.md"), "utf8");
  assert.match(guide, /1976\.cloud/);
  assert.match(guide, /Streamable HTTP/);
});

test("a second install is idempotent", async () => {
  const root = await project();
  await install(config(root));
  const result = await install(config(root));
  assert.equal(result.changed, false);
  assert.ok(result.plan.every((item) => item.action === "unchanged"));
});

test("dry run reports changes without writing", async () => {
  const root = await project();
  const result = await install(config(root), { dryRun: true });
  assert.equal(result.dryRun, true);
  assert.equal(await readManifest(root), null);
});

test("protects local edits and backs them up only with force", async () => {
  const root = await project();
  await install(config(root));
  const ui = path.join(root, "src", "features", "shared-email", "SharedEmailAdmin.jsx");
  await writeFile(ui, "// local customization\n");
  await assert.rejects(() => install(config(root)), /protect existing files/);
  const forced = await install(config(root), { force: true });
  assert.ok(forced.backupPaths.some((item) => item.endsWith("SharedEmailAdmin.jsx")));
});

test("doctor validates files and warns until the app route is wired", async () => {
  const root = await project();
  await install(config(root));
  const result = await doctor(root);
  assert.equal(result.ok, true);
  assert.ok(result.warnings.some((item) => item.includes("/admin/email")));
  await writeFile(path.join(root, "src", "App.jsx"), 'import { SharedEmailPage } from "./features/shared-email";\nexport default () => <Route path="/admin/email" element={<SharedEmailPage />} />;\n');
  const wired = await doctor(root);
  assert.equal(wired.ok, true);
  assert.equal(wired.warnings.some((item) => item.includes("/admin/email")), false);
});

test("uninstall preserves data-model files by default", async () => {
  const root = await project();
  await install(config(root));
  const result = await uninstall(root, { yes: true });
  assert.equal(result.preservedDataModel.length, 8);
  assert.ok(result.removed.length > 0);
  const manifest = await readManifest(root);
  assert.equal(manifest.installedFiles.length, 8);
});

test("validates domain and mailbox configuration", () => {
  assert.throws(() => buildConfig({ brand: "Acme", domain: "not a domain" }), /valid hostname/);
  assert.throws(() => buildConfig({ brand: "Acme", domain: "example.com", mailbox: "hello@elsewhere.com" }), /address on example\.com/);
});
