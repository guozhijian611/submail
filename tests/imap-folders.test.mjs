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
    import { belongsToTarget, discoverImapSyncTargets, remoteMessageState, selectImapPreparationBatch } from "./apps/api/src/mail.ts";
    import { accountRepo, attachmentRepo, mailboxCursorRepo, messageRepo } from "./apps/api/src/repositories.ts";
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
    const sizedMessages = Array.from({ length: 10 }, (_, index) => ({ seq: index + 1, uid: index + 1, size: 1024 * 1024, flags: new Set() }));
    const oldestBudgeted = selectImapPreparationBatch(sizedMessages, "oldest", 3 * 1024 * 1024);
    const newestBudgeted = selectImapPreparationBatch(sizedMessages, "newest", 3 * 1024 * 1024);
    const account = await accountRepo.create({
      email: "sync@example.com", displayName: "Sync", notes: "", aliases: [], username: "sync@example.com",
      password: "secret", incomingProtocol: "imap", authMode: "password", imapHost: "imap.example.com",
      imapPort: 993, imapSecure: true, smtpHost: "smtp.example.com", smtpPort: 465, smtpSecure: true
    });
    const oldGeneration = await messageRepo.upsert({
      accountId: account.id, folder: "INBOX", uid: 42, subject: "old generation", flags: [],
      remoteMailbox: "INBOX", remoteUidValidity: "old", isStarred: false
    });
    await attachmentRepo.replaceForMessage(oldGeneration.id, [{
      filename: "old.txt", contentType: "text/plain", size: 3, content: Buffer.from("old")
    }]);
    await messageRepo.updateState(oldGeneration.id, { isStarred: true });
    const sameGeneration = await messageRepo.upsert({
      accountId: account.id, folder: "INBOX", uid: 42, subject: "same generation", flags: [],
      remoteMailbox: "INBOX", remoteUidValidity: "old", isStarred: false
    });
    let rolledBack = false;
    try {
      await db.transaction(async () => {
        await messageRepo.removeStaleRemoteIdentity(account.id, "INBOX", "INBOX", "new", { adoptLegacyIdentity: false });
        const staged = await messageRepo.upsert({
          accountId: account.id, folder: "INBOX", uid: 42, subject: "must roll back", flags: [],
          remoteMailbox: "INBOX", remoteUidValidity: "new", isStarred: false
        });
        await attachmentRepo.replaceForMessage(staged.id, []);
        throw new Error("force rollback");
      });
    } catch {
      rolledBack = true;
    }
    const afterRollback = await messageRepo.get(oldGeneration.id);
    const rollbackAttachments = await attachmentRepo.listForMessage(oldGeneration.id);
    let newGeneration;
    await db.transaction(async () => {
      await messageRepo.removeStaleRemoteIdentity(account.id, "INBOX", "INBOX", "new", { adoptLegacyIdentity: false });
      newGeneration = await messageRepo.upsert({
        accountId: account.id, folder: "INBOX", uid: 42, subject: "new generation", flags: [],
        remoteMailbox: "INBOX", remoteUidValidity: "new", isStarred: false
      });
      await attachmentRepo.replaceForMessage(newGeneration.id, []);
    });
    const newGenerationAttachments = await attachmentRepo.listForMessage(newGeneration.id);
    const oldGenerationUids = await messageRepo.remoteUids(account.id, "INBOX", "INBOX", "old");
    const newGenerationUids = await messageRepo.remoteUids(account.id, "INBOX", "INBOX", "new");
    const oldArchive = await messageRepo.upsert({
      accountId: account.id, folder: "Archive", uid: 9, subject: "old archive path", flags: [],
      remoteMailbox: "Archive", remoteUidValidity: "same", isArchived: true
    });
    await messageRepo.reconcileRemoteMailbox(account.id, "Archive", "[Gmail]/All Mail", [{
      uid: 9, flags: [], isRead: false, isStarred: false, isArchived: true, isDeleted: false
    }], { uidValidity: "same", adoptLegacyIdentity: false });
    const archivePathMismatchRemoved = !await messageRepo.get(oldArchive.id);
    const staleSent = await messageRepo.upsert({
      accountId: account.id, folder: "Sent", uid: 7, messageId: "<shared@example.com>", subject: "stale sent", flags: [],
      remoteMailbox: "Sent", remoteUidValidity: "old", isRead: true
    });
    const localSent = await messageRepo.upsert({
      accountId: account.id, folder: "Sent", messageId: "<shared@example.com>", subject: "local sent", flags: [], isRead: true
    });
    let mergedSent;
    await db.transaction(async () => {
      await messageRepo.removeStaleRemoteIdentity(account.id, "Sent", "Sent", "new", { adoptLegacyIdentity: false });
      mergedSent = await messageRepo.upsert({
        accountId: account.id, folder: "Sent", uid: 7, messageId: "<shared@example.com>", subject: "remote sent", flags: [],
        remoteMailbox: "Sent", remoteUidValidity: "new", isRead: true
      });
    });
    const staleSentAfterMerge = await messageRepo.get(staleSent.id);
    const sentUidRows = await db.prepare("SELECT id FROM messages WHERE account_id = ? AND folder = 'Sent' AND uid = 7").all(account.id);
    const unknownInvalidGeneration = await messageRepo.upsert({
      accountId: account.id, folder: "Trash", uid: 13, subject: "legacy unknown old generation", flags: [], isDeleted: true
    });
    await messageRepo.removeStaleRemoteIdentity(account.id, "Trash", "Trash", "new", { adoptLegacyIdentity: false });
    const unknownInvalidRemoved = !await messageRepo.get(unknownInvalidGeneration.id);
    const unknownValidGeneration = await messageRepo.upsert({
      accountId: account.id, folder: "Drafts", uid: 14, subject: "legacy same generation", flags: []
    });
    await messageRepo.removeStaleRemoteIdentity(account.id, "Drafts", "Drafts", "same", { adoptLegacyIdentity: true });
    await messageRepo.reconcileRemoteMailbox(account.id, "Drafts", "Drafts", [{
      uid: 14, flags: [], isRead: false, isStarred: false, isArchived: false, isDeleted: false
    }], { uidValidity: "same", adoptLegacyIdentity: true });
    const adoptedLegacyIdentity = await messageRepo.get(unknownValidGeneration.id);
    await mailboxCursorRepo.set(account.id, "INBOX", {
      cursorUid: 42, uidValidity: "new", backfillBeforeUid: 1, backfillComplete: true, lastReconcileAt: "2026-07-11T00:00:00.000Z"
    });
    const cursorSnapshot = await mailboxCursorRepo.get(account.id, "INBOX");
    const cursorMatches = await mailboxCursorRepo.matchesSnapshot(account.id, "INBOX", cursorSnapshot);
    await mailboxCursorRepo.set(account.id, "INBOX", {
      cursorUid: 43, uidValidity: "new", backfillBeforeUid: 1, backfillComplete: true, lastReconcileAt: "2026-07-11T00:00:01.000Z"
    });
    const staleCursorRejected = !await mailboxCursorRepo.matchesSnapshot(account.id, "INBOX", cursorSnapshot);
    const accountSnapshot = await accountRepo.get(account.id);
    const identityMatches = await accountRepo.incomingIdentityMatches(accountSnapshot);
    await db.prepare("UPDATE accounts SET username = ? WHERE id = ?").run("changed@example.com", account.id);
    const changedIdentityRejected = !await accountRepo.incomingIdentityMatches(accountSnapshot);
    const result = {
      folders: specialTargets.map((target) => target.localFolder),
      gmailArchive,
      inboxAcceptedAsArchive: belongsToTarget(inboxMessage, gmailArchive),
      archivedAccepted: belongsToTarget(archivedMessage, gmailArchive),
      archivedState: remoteMessageState(archivedMessage, gmailArchive),
      preparationBudget: {
        oldest: oldestBudgeted.map((message) => message.uid),
        newest: newestBudgeted.map((message) => message.uid)
      },
      stateIsolation: {
        sameGenerationStarred: sameGeneration.is_starred,
        rolledBack,
        rollbackGeneration: afterRollback.remote_uid_validity,
        rollbackSubject: afterRollback.subject,
        rollbackAttachments: rollbackAttachments.map((attachment) => attachment.filename),
        newGenerationStarred: newGeneration.is_starred,
        newGenerationOverrides: JSON.parse(newGeneration.local_state_overrides),
        newGenerationAttachmentCount: newGenerationAttachments.length,
        oldGenerationUids: [...oldGenerationUids],
        newGenerationUids: [...newGenerationUids],
        archivePathMismatchRemoved,
        sentMergedIntoLocal: mergedSent.id === localSent.id,
        staleSentRemoved: !staleSentAfterMerge,
        sentUidRowCount: sentUidRows.length,
        unknownInvalidRemoved,
        adoptedLegacyMailbox: adoptedLegacyIdentity.remote_mailbox,
        adoptedLegacyUidValidity: adoptedLegacyIdentity.remote_uid_validity,
        cursorMatches,
        staleCursorRejected,
        identityMatches,
        changedIdentityRejected
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
  assert.deepEqual(result.preparationBudget.oldest, [1, 2, 3]);
  assert.deepEqual(result.preparationBudget.newest, [8, 9, 10]);
  assert.equal(result.stateIsolation.sameGenerationStarred, 1);
  assert.equal(result.stateIsolation.rolledBack, true);
  assert.equal(result.stateIsolation.rollbackGeneration, "old");
  assert.equal(result.stateIsolation.rollbackSubject, "same generation");
  assert.deepEqual(result.stateIsolation.rollbackAttachments, ["old.txt"]);
  assert.equal(result.stateIsolation.newGenerationStarred, 0);
  assert.deepEqual(result.stateIsolation.newGenerationOverrides, {});
  assert.equal(result.stateIsolation.newGenerationAttachmentCount, 0);
  assert.deepEqual(result.stateIsolation.oldGenerationUids, []);
  assert.deepEqual(result.stateIsolation.newGenerationUids, [42]);
  assert.equal(result.stateIsolation.archivePathMismatchRemoved, true);
  assert.equal(result.stateIsolation.sentMergedIntoLocal, true);
  assert.equal(result.stateIsolation.staleSentRemoved, true);
  assert.equal(result.stateIsolation.sentUidRowCount, 1);
  assert.equal(result.stateIsolation.unknownInvalidRemoved, true);
  assert.equal(result.stateIsolation.adoptedLegacyMailbox, "Drafts");
  assert.equal(result.stateIsolation.adoptedLegacyUidValidity, "same");
  assert.equal(result.stateIsolation.cursorMatches, true);
  assert.equal(result.stateIsolation.staleCursorRejected, true);
  assert.equal(result.stateIsolation.identityMatches, true);
  assert.equal(result.stateIsolation.changedIdentityRejected, true);
});
