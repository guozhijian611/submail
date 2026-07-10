import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const projectRoot = path.resolve(import.meta.dirname, "..");

test("IMAP special folders and Gmail archive labels map to local views", async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "submail-imap-folders-"));
  t.after(() => fs.rm(tempDir, { recursive: true, force: true }));
  const program = `
    import { belongsToTarget, discoverImapSyncTargets, remoteMessageState } from "./apps/api/src/mail.ts";
    import { accountRepo, messageRepo } from "./apps/api/src/repositories.ts";
    import { db } from "./apps/api/src/db.ts";
    const slash = String.fromCharCode(92);
    const mailbox = (path, specialUse, flags = new Set()) => ({ path, delimiter: "/", flags, specialUse });
    const specialTargets = discoverImapSyncTargets([
      mailbox("Sent Items", slash + "Sent"),
      mailbox("Drafts", slash + "Drafts"),
      mailbox("Deleted", slash + "Trash"),
      mailbox("Archive", slash + "Archive"),
      mailbox("Ignored", slash + "Sent", new Set([slash + "Noselect"]))
    ], false);
    const gmailTargets = discoverImapSyncTargets([
      mailbox("[Gmail]/Sent Mail", slash + "Sent"),
      mailbox("Archive"),
      mailbox("[Gmail]/All Mail", slash + "All")
    ], true);
    const gmailArchive = gmailTargets.find((target) => target.localFolder === "Archive");
    const inboxMessage = { seq: 1, uid: 10, flags: new Set(), labels: new Set([slash + "Inbox", slash + "All"]) };
    const archivedMessage = { seq: 2, uid: 11, flags: new Set([slash + "Seen", slash + "Flagged"]), labels: new Set([slash + "All"]) };
    const account = await accountRepo.create({
      email: "sync@example.com", displayName: "Sync", notes: "", aliases: [], username: "sync@example.com",
      password: "secret", incomingProtocol: "imap", authMode: "password", imapHost: "imap.example.com",
      imapPort: 993, imapSecure: true, smtpHost: "smtp.example.com", smtpPort: 465, smtpSecure: true
    });
    const oldGeneration = await messageRepo.upsert({
      accountId: account.id, folder: "INBOX", uid: 42, subject: "old generation", flags: [],
      remoteMailbox: "INBOX", remoteUidValidity: "old", isStarred: false
    });
    await messageRepo.updateState(oldGeneration.id, { isStarred: true });
    const sameGeneration = await messageRepo.upsert({
      accountId: account.id, folder: "INBOX", uid: 42, subject: "same generation", flags: [],
      remoteMailbox: "INBOX", remoteUidValidity: "old", isStarred: false
    });
    let rolledBack = false;
    try {
      await db.transaction(async () => {
        await messageRepo.upsert({
          accountId: account.id, folder: "INBOX", uid: 42, subject: "must roll back", flags: [],
          remoteMailbox: "INBOX", remoteUidValidity: "new", isStarred: false
        });
        throw new Error("force rollback");
      });
    } catch {
      rolledBack = true;
    }
    const afterRollback = await messageRepo.get(oldGeneration.id);
    const newGeneration = await messageRepo.upsert({
      accountId: account.id, folder: "INBOX", uid: 42, subject: "new generation", flags: [],
      remoteMailbox: "INBOX", remoteUidValidity: "new", isStarred: false
    });
    const oldGenerationUids = await messageRepo.remoteUids(account.id, "INBOX", "INBOX", "old");
    const newGenerationUids = await messageRepo.remoteUids(account.id, "INBOX", "INBOX", "new");
    const result = {
      folders: specialTargets.map((target) => target.localFolder),
      gmailArchive,
      inboxAcceptedAsArchive: belongsToTarget(inboxMessage, gmailArchive),
      archivedAccepted: belongsToTarget(archivedMessage, gmailArchive),
      archivedState: remoteMessageState(archivedMessage, gmailArchive),
      stateIsolation: {
        sameGenerationStarred: sameGeneration.is_starred,
        rolledBack,
        rollbackGeneration: afterRollback.remote_uid_validity,
        rollbackSubject: afterRollback.subject,
        newGenerationStarred: newGeneration.is_starred,
        newGenerationOverrides: JSON.parse(newGeneration.local_state_overrides),
        oldGenerationUids: [...oldGenerationUids],
        newGenerationUids: [...newGenerationUids]
      }
    };
    console.log("__RESULT__" + JSON.stringify(result));
    await db.close();
  `;
  const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", program], {
    cwd: projectRoot,
    env: {
      ...process.env,
      NODE_ENV: "test",
      SUBMAIL_DB_PATH: path.join(tempDir, "submail.sqlite"),
      SUBMAIL_STORAGE_DIR: path.join(tempDir, "storage"),
      SUBMAIL_SECRET: "test-secret-abcdefghijklmnopqrstuvwxyz-0123456789",
      SUBMAIL_DEMO_MODE: "false"
    },
    encoding: "utf8"
  });
  assert.equal(child.status, 0, `${child.stdout}\n${child.stderr}`);
  const resultLine = child.stdout.split("\n").find((line) => line.startsWith("__RESULT__"));
  assert(resultLine, child.stdout);
  const result = JSON.parse(resultLine.slice("__RESULT__".length));
  assert.deepEqual(result.folders, ["INBOX", "Sent", "Drafts", "Trash", "Archive"]);
  assert.equal(result.gmailArchive.localFolder, "Archive");
  assert.equal(result.gmailArchive.mailboxPath, "[Gmail]/All Mail");
  assert.equal(result.gmailArchive.gmailArchive, true);
  assert.equal(result.inboxAcceptedAsArchive, false);
  assert.equal(result.archivedAccepted, true);
  assert.equal(result.archivedState.isRead, true);
  assert.equal(result.archivedState.isStarred, true);
  assert.equal(result.archivedState.isArchived, true);
  assert.equal(result.archivedState.isDeleted, false);
  assert.equal(result.stateIsolation.sameGenerationStarred, 1);
  assert.equal(result.stateIsolation.rolledBack, true);
  assert.equal(result.stateIsolation.rollbackGeneration, "old");
  assert.equal(result.stateIsolation.rollbackSubject, "same generation");
  assert.equal(result.stateIsolation.newGenerationStarred, 0);
  assert.deepEqual(result.stateIsolation.newGenerationOverrides, {});
  assert.deepEqual(result.stateIsolation.oldGenerationUids, []);
  assert.deepEqual(result.stateIsolation.newGenerationUids, [42]);
});
