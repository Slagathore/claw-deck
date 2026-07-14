import { ipcMain, app, dialog } from "electron";
import * as crypto from "crypto";
import { ensureSourceTree, sourceRoot, isPathWithin } from "./paths";
import {
  promotedStatus,
  discardPromotion,
  clearLastRollback,
} from "./promoted";
import { repoStatus, setOrigin } from "./github";
import {
  createSnapshot,
  restoreSnapshot,
  listSnapshots,
  findSnapshotById,
  type Snapshot,
} from "./snapshot";
import { type PatchSet, validatePatchSet, extractPatchSetFromText } from "./patcher";
import { assessRisk } from "./risk";
import { runPipeline } from "./pipeline";
import {
  generateProposal,
  localOllamaBackend,
  openaiCompatBackend,
  type ReflectBackend,
  buildFacts,
} from "./reflector";
import { auditDirectory } from "../lib/scanner";

interface ReflectSettings {
  backend?: "local" | "remote" | "openclaw";
  ollamaUrl?: string;
  ollamaModel?: string;
  remoteUrl?: string;
  remoteKey?: string;
  remoteModel?: string;
  goal?: string;
}

const lastSnapshots = new Map<string, Snapshot>();

function backendFor(s: ReflectSettings): ReflectBackend {
  switch (s.backend) {
    case "remote":
      return openaiCompatBackend({
        url: s.remoteUrl || "https://api.openai.com/v1",
        apiKey: s.remoteKey,
        model: s.remoteModel || "gpt-4o-mini",
      });
    case "openclaw":
      // OpenClaw exposes an OpenAI-compatible endpoint when running locally; treat it as such.
      return openaiCompatBackend({
        url: s.remoteUrl || "http://localhost:7531/v1",
        apiKey: s.remoteKey,
        model: s.remoteModel || "openclaw-default",
      });

    case "local":
    default:
      return localOllamaBackend({
        baseUrl: s.ollamaUrl || "http://localhost:11434",
        model: s.ollamaModel || "llama3.2",
      });
  }
}

export function registerSelfUpgradeHandlers() {
  ipcMain.handle("selfUpgrade:status", async () => {
    const ensured = await ensureSourceTree();
    const repo = await repoStatus(ensured.path);
    const snaps = await listSnapshots();
    return {
      sourceRoot: ensured.path,
      ready: ensured.ready,
      reason: ensured.reason,
      reseeded: ensured.reseeded ?? false,
      archivedTo: ensured.archivedTo,
      supersededVersion: ensured.supersededVersion,
      repo,
      snapshots: snaps,
      electronExe: process.execPath,
      version: app.getVersion(),
      packaged: app.isPackaged,
      promoted: promotedStatus(app.getVersion()),
    };
  });

  // What the app is actually running right now, and what it will run next launch.
  ipcMain.handle("selfUpgrade:promotedStatus", async () =>
    promotedStatus(app.getVersion()),
  );

  // Undo a promotion: next launch boots the pristine build that shipped in the asar.
  ipcMain.handle("selfUpgrade:revertPromotion", async () => {
    const dropped = discardPromotion(
      "user reverted the promoted self-upgrade from the Self-Upgrade tab",
      "manual-revert",
    );
    if (!dropped) return { ok: false, reason: "no promoted upgrade is active" };
    return {
      ok: true,
      reverted: dropped.id,
      note: "Restart Claw Deck to go back to the build that shipped with the installer.",
    };
  });

  ipcMain.handle("selfUpgrade:dismissRollbackNotice", async () => {
    clearLastRollback();
    return { ok: true };
  });

  ipcMain.handle("selfUpgrade:relaunch", async () => {
    app.relaunch();
    app.quit();
    return { ok: true };
  });

  ipcMain.handle("selfUpgrade:facts", async () => {
    const ensured = await ensureSourceTree();
    if (!ensured.ready) return { ok: false, reason: ensured.reason };
    const facts = await buildFacts(ensured.path);
    return { ok: true, facts: facts.slice(0, 100) };
  });

  ipcMain.handle("selfUpgrade:baselineAudit", async () => {
    const ensured = await ensureSourceTree();
    if (!ensured.ready) return { ok: false, reason: ensured.reason };
    const r = await auditDirectory(ensured.path);
    return { ok: true, summary: r.summary, fileCount: r.fileCount };
  });

  ipcMain.handle("selfUpgrade:reflect", async (_e, s: ReflectSettings) => {
    const ensured = await ensureSourceTree();
    if (!ensured.ready) return { ok: false, reason: ensured.reason };
    const backend = backendFor(s);
    try {
      const proposal = await generateProposal(
        backend,
        ensured.path,
        s.goal || "propose a small, safe improvement",
      );
      if (!proposal)
        return { ok: false, reason: "model returned no parseable patch set" };
      const v = validatePatchSet(proposal, ensured.path);
      if (!v.ok)
        return { ok: false, reason: `invalid patch: ${v.reason}`, proposal };
      const risk = assessRisk(proposal);
      return { ok: true, proposal, risk, backend: backend.name };
    } catch (e: any) {
      return { ok: false, reason: e.message };
    }
  });

  ipcMain.handle("selfUpgrade:parseManualPatch", async (_e, text: string) => {
    const proposal = extractPatchSetFromText(text);
    if (!proposal)
      return { ok: false, reason: "could not parse JSON patch set" };
    const ensured = await ensureSourceTree();
    if (!ensured.ready) return { ok: false, reason: ensured.reason };
    const v = validatePatchSet(proposal, ensured.path);
    if (!v.ok) return { ok: false, reason: v.reason, proposal };
    return { ok: true, proposal, risk: assessRisk(proposal) };
  });

  ipcMain.handle(
    "selfUpgrade:run",
    async (
      _e,
      opts: {
        patch: PatchSet;
        sandboxHighRisk?: boolean;
        probeChecks?: ("boot" | "db" | "tray" | "ollama" | "render" | "scan")[];
        launchProbe?: boolean;
      },
    ) => {
      const ensured = await ensureSourceTree();
      if (!ensured.ready) return { ok: false, reason: ensured.reason };
      const runId = `run-${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`;
      const result = await runPipeline({
        runId,
        sourceRoot: ensured.path,
        patch: opts.patch,
        sandboxHighRisk: opts.sandboxHighRisk !== false,
        // Packaged: the boot probe of the built bundle is mandatory, so the
        // electron exe is always needed. Dev: only when the user asked for it.
        electronExe:
          app.isPackaged || opts.launchProbe ? process.execPath : undefined,
        probeChecks: opts.probeChecks,
        packaged: app.isPackaged,
        appRoot: app.getAppPath(),
        appVersion: app.getVersion(),
      });
      if (result.snapshot)
        lastSnapshots.set(result.snapshot.id, result.snapshot);
      return result;
    },
  );

  ipcMain.handle(
    "selfUpgrade:rollback",
    async (_e, opts: { snapshotId: string }) => {
      // Prefer the in-memory snapshot from this session; fall back to the durable
      // on-disk index so rollback still works after an app restart.
      const snap =
        lastSnapshots.get(opts.snapshotId) ??
        (await findSnapshotById(opts.snapshotId, "self"));
      if (!snap)
        return {
          ok: false,
          reason:
            "snapshot not found (no in-session record and no entry in the on-disk index)",
        };
      // Containment: restoring a snapshot means `git reset --hard` (or a tree
      // wipe) at snap.root. The self-upgrade UI may only ever do that to Claw
      // Deck's own source tree — never to one of the user's other repos that the
      // council/executor snapshotted.
      const root = sourceRoot();
      if (!isPathWithin(root, snap.root)) {
        const reason = `refusing to restore snapshot ${snap.id}: it is rooted at ${snap.root}, outside the Claw Deck source tree (${root})`;
        console.error(`[selfUpgrade] ${reason}`);
        return { ok: false, reason };
      }
      try {
        await restoreSnapshot(snap);
        return { ok: true };
      } catch (e: any) {
        return { ok: false, reason: e.message };
      }
    },
  );

  ipcMain.handle(
    "selfUpgrade:snapshot",
    async (_e, opts: { label?: string }) => {
      const ensured = await ensureSourceTree();
      if (!ensured.ready) return { ok: false, reason: ensured.reason };
      try {
        const snap = await createSnapshot(
          ensured.path,
          opts?.label || "manual snapshot",
          "self",
        );
        lastSnapshots.set(snap.id, snap);
        return { ok: true, snapshot: snap };
      } catch (e: any) {
        return { ok: false, reason: e.message };
      }
    },
  );

  ipcMain.handle("selfUpgrade:setOrigin", async (_e, opts: { url: string }) => {
    const ensured = await ensureSourceTree();
    if (!ensured.ready) return { ok: false, reason: ensured.reason };
    if (!opts?.url) {
      const r = await dialog.showMessageBox({
        type: "info",
        message: "No GitHub origin set",
        detail:
          'Create a private repo named "claw-deck" on github.com and paste its SSH/HTTPS URL into Settings → Self-Upgrade.',
        buttons: ["OK"],
      });
      return {
        ok: false,
        reason: "user prompt acknowledged",
        acknowledged: r.response === 0,
      };
    }
    return setOrigin(ensured.path, opts.url);
  });

  ipcMain.handle("selfUpgrade:openSourceRoot", async () => {
    const ensured = await ensureSourceTree();
    const { shell } = await import("electron");
    await shell.openPath(ensured.path);
    return { ok: true, path: ensured.path };
  });
}

export { sourceRoot };
