import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
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
  assert.match(gateway, /createSharedEmailSendConfirmation/);
  assert.match(gateway, /consumeSharedEmailSendConfirmation/);
  assert.match(gateway, /confirmation_token/);
  const confirmation = await readFile(path.join(root, "base44", "shared", "sharedEmailConfirmation.js"), "utf8");
  assert.match(confirmation, /CONFIRMATION_TTL_MS = 5 \* 60 \* 1000/);
  assert.match(confirmation, /payload_digest/);
  assert.match(confirmation, /SharedEmailSendConfirmation\.delete/);
  assert.equal(manifest.installedFiles.filter((item) => item.dataModel).length, 9);
  const guide = await readFile(path.join(root, "base44-shared-email.mcp.md"), "utf8");
  assert.match(guide, /1976\.cloud/);
  assert.match(guide, /Streamable HTTP/);
});

test("protects maintenance functions and verifies signed webhooks", async () => {
  const root = await project();
  await install(config(root));

  for (const functionName of ["shared-email-poll-status", "shared-email-reconcile"]) {
    const source = await readFile(path.join(root, "base44", "functions", functionName, "entry.ts"), "utf8");
    assert.match(source, /base44\.auth\.me\(\)/);
    assert.match(source, /user\.role !== "admin"/);
    assert.ok(source.indexOf("base44.auth.me()") < source.indexOf("base44.asServiceRole"));
  }

  for (const functionName of ["shared-email-sendgrid-inbound", "shared-email-sendgrid-events"]) {
    const source = await readFile(path.join(root, "base44", "functions", functionName, "entry.ts"), "utf8");
    assert.match(source, /await verifySendGridWebhook\(request, "SENDGRID_(?:INBOUND|EVENT)_WEBHOOK_PUBLIC_KEY"\)/);
    assert.doesNotMatch(source, /searchParams\.get\("token"\)|x-shared-email-secret|SHARED_EMAIL_WEBHOOK_SECRET/);
  }

  const verifier = await readFile(path.join(root, "base44", "shared", "sharedEmailWebhook.js"), "utf8");
  assert.match(verifier, /publicKeyEnvironmentName/);
  assert.match(verifier, /request\.clone\(\)\.arrayBuffer\(\)/);
  assert.match(verifier, /crypto\.subtle\.verify/);

  const guide = await readFile(path.join(root, "base44-shared-email.install.md"), "utf8");
  assert.match(guide, /SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY/);
  assert.match(guide, /SENDGRID_INBOUND_WEBHOOK_PUBLIC_KEY/);
  assert.doesNotMatch(guide, /\?token=|SHARED_EMAIL_WEBHOOK_SECRET/);
});

test("SendGrid signature verifier accepts only the exact signed payload", async () => {
  const source = await readFile(path.resolve("templates/base44/shared/sharedEmailWebhook.js.tmpl"), "utf8");
  const moduleUrl = "data:text/javascript;base64," + Buffer.from(source).toString("base64");
  const { verifySendGridSignature } = await import(moduleUrl);
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const verificationKey = publicKey.export({ type: "spki", format: "pem" });
  const timestamp = "1788451200";
  const body = Buffer.from('[{"event":"delivered","email":"person@example.com"}]');
  const signature = sign("sha256", Buffer.concat([Buffer.from(timestamp), body]), privateKey).toString("base64");

  assert.equal(await verifySendGridSignature(verificationKey, body, signature, timestamp), true);
  assert.equal(await verifySendGridSignature(verificationKey, Buffer.from(body + " "), signature, timestamp), false);
  assert.equal(await verifySendGridSignature(verificationKey, body, signature, timestamp + "1"), false);
});

test("send confirmation token is payload-bound, short-lived and single-use", async () => {
  const source = await readFile(path.resolve("templates/base44/shared/sharedEmailConfirmation.js.tmpl"), "utf8");
  const moduleUrl = "data:text/javascript;base64," + Buffer.from(source).toString("base64");
  const { createSharedEmailSendConfirmation, consumeSharedEmailSendConfirmation } = await import(moduleUrl);
  const rows = [];
  const confirmations = {
    create: async (data) => { const row = { id: String(rows.length + 1), ...data }; rows.push(row); return row; },
    filter: async ({ token_hash }) => rows.filter((row) => row.token_hash === token_hash),
    delete: async (id) => { const index = rows.findIndex((row) => row.id === id); if (index < 0) throw new Error("not found"); rows.splice(index, 1); },
  };
  const base44 = { asServiceRole: { entities: { SharedEmailSendConfirmation: confirmations } } };
  const user = { id: "user-1" };
  const preview = { aliasId: "alias-1", to: ["person@example.com"], cc: [], bcc: [], subject: "Hello", text: "Exact body", html: "" };
  const confirmation = await createSharedEmailSendConfirmation(base44, user, preview);

  assert.equal(rows.length, 1);
  assert.ok(Date.parse(confirmation.expiresAt) - Date.now() <= 5 * 60 * 1000);
  await assert.rejects(
    () => consumeSharedEmailSendConfirmation(base44, user, { ...preview, text: "Changed body" }, confirmation.token),
    /changed after confirmation/,
  );
  assert.equal(rows.length, 1);
  await consumeSharedEmailSendConfirmation(base44, user, preview, confirmation.token);
  assert.equal(rows.length, 0);
  await assert.rejects(
    () => consumeSharedEmailSendConfirmation(base44, user, preview, confirmation.token),
    /invalid or has already been used/,
  );

  const expired = await createSharedEmailSendConfirmation(base44, user, preview);
  rows[0].expires_at = new Date(Date.now() - 1).toISOString();
  await assert.rejects(
    () => consumeSharedEmailSendConfirmation(base44, user, preview, expired.token),
    /has expired/,
  );
  assert.equal(rows.length, 0);
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
