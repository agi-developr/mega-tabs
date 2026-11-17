# Privacy Policy: Mega Tabs

Effective: see the date of the last commit that changed this file. Publisher: the maintainers of this repository. Contact: open an issue in this repository.

## In short

- No data leaves your device. Mega Tabs makes no network requests of its own.
- No account, no cloud, no analytics, no ads, no tracking, no sale or sharing of data.
- Everything it keeps is on your computer, and you can delete it.

## What Mega Tabs stores, and where

| Data | Why | Where it lives |
| --- | --- | --- |
| Names of your spaces and mega tabs, their order, and settings | To show and switch them | Chrome's extension storage on your device |
| The tabs in each mega tab: web address, title, pinned state, tab group name and colour | To park tabs when you switch away and bring them back, and to rebuild after a browser restart | Chrome's extension storage on your device |
| Notes (`.md`) and canvases (`.canvas`) | The Board feature | Plain files in the folder you choose, on your disk |
| Optional automatic backup of your workspaces | So a crash or reinstall does not lose them | A file Chrome saves to your Downloads folder, only if you turn the backup on |
| An unsaved note draft | So a reload does not lose what you were typing | The browser tab's session storage, removed when the note is saved or the tab closes |

Mega Tabs reads the address and title of your open tabs because it cannot park and restore tabs without them. It does not read page content, passwords, form data or cookies.

## What leaves your device

Nothing, unless you click something:

- A link in a note, or the optional tip link, opens a web page in a browser tab when you click it. That is your browser visiting that page, not Mega Tabs sending data.
- "Open in Cursor" hands a file path to your own Cursor app on your machine. It is skipped if you do not have it.
- Images that point to the web inside a note are not loaded, so a note cannot make your browser call out.

## The optional file helper

Some setups use a small helper program that Chrome starts to read and write your note and canvas files. It talks to the extension only through Chrome, accepts only this extension's ID, touches only `.md` and `.canvas` files in your notes folder, refuses paths that leave that folder, and contains no network code (its tests check this). If you do not install it, nothing changes about what is said above.

## Third-party code

Mega Tabs bundles these open-source libraries inside the package: marked, DOMPurify, OverType and React Flow with React. They run locally and make no requests. The extension loads and runs no code from the internet.

## Your choices

- Delete a space or mega tab inside the extension.
- Delete your notes and canvases: they are ordinary files in your folder.
- Remove the extension: Chrome deletes its stored workspaces and backup. Files in your notes folder and any backup file in Downloads stay until you delete them.

## Children

Mega Tabs collects no personal information from anyone, including children.

## Changes

If this policy changes, the new text goes at this URL with a new effective date, and the release notes say so.

## Source

The code is open source under GPL-3.0 in this repository, so every statement above can be checked.
