---
id: troubleshooting-sync
title: Troubleshooting Desktop Sync
doc_type: troubleshooting
tiers: [free, pro, enterprise]
---

# Troubleshooting Desktop Sync

## Sync is stuck or not starting

1. Check status.fernway.example for an ongoing incident.
2. Make sure the desktop app is version 4.2 or later; older versions stopped syncing in October 2026.
3. Sign out of the desktop app and sign back in.
4. If it is still stuck, quit the app and clear the local cache folder (macOS: ~/Library/Caches/Fernway, Windows: %LOCALAPPDATA%\Fernway\Cache), then restart. Clearing the cache does not delete any files in the workspace.

## A file will not upload

- Free workspaces have a 100 MB per-file limit; Pro and Enterprise allow up to 5 GB per file.
- File names cannot contain the characters < > : " | ? *.
- If the workspace storage is full, uploads pause until space is freed or more storage is added (Storage Pack on Free, or a Pro/Enterprise plan).

## Conflicted copies

When the same file is edited on two devices while one is offline, Fernway keeps both versions and names one "filename (conflicted copy, device name, date)". Nothing is lost. The customer should compare the two and delete the one they do not need.

## Selective sync

Customers can choose which folders sync to a device under Preferences > Selective sync. Unselected folders are removed from that device only and stay in the workspace.
