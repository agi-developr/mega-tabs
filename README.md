# Mega Tabs

Switch between sets of tabs by project, with notes and a canvas beside them. Everything stays on your computer.

## The problem

Three projects, one browser window. Every time you change what you are working on you close tabs, hunt for the right ones, and lose your place. Profiles split too much (logins, history, extensions) and bookmarks do not keep a page the way you left it.

## What it does

- **Spaces and mega tabs.** A space is a project. A mega tab is one line of work inside it. One click shows that mega tab's tabs and parks the rest.
- **Nothing reloads.** Switching moves tabs between windows instead of closing them. Pages, videos and logins keep going.
- **A calm side panel.** Spaces and mega tabs in one list. <kbd>Alt</kbd>+<kbd>W</kbd> (<kbd>Option</kbd>+<kbd>W</kbd> on a Mac) opens and closes it; <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>Up</kbd>/<kbd>Down</kbd> switch, <kbd>Alt</kbd>+<kbd>Q</kbd> jumps back to the last one.
- **Notes beside your tabs.** Read and edit Markdown notes per space in the Board. They are plain `.md` files.
- **A canvas to think on.** Cards, arrows and a pen, saved as an open [JSON Canvas](https://jsoncanvas.org/) file next to your notes.
- **Notes your AI tools can edit.** Point Claude Code, Cursor or any editor at the same folder. A change from outside shows up in the Board within a couple of seconds, and nothing you are typing is overwritten.
- Search, rename, delete with undo, light and dark themes, a Spaces home page with covers, an optional switcher at the screen edge, export, import and automatic backup. English and German.

## Install

You need Chrome (or another Chromium browser) 116 or newer on a desktop.

1. Download or clone this repository.
2. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked** and choose the `extension/` folder.
3. Click the toolbar icon, or press <kbd>Alt</kbd>+<kbd>W</kbd>. The panel opens with a few example spaces you can rename or delete.

Notes and Canvas work straight away: the Board asks you to pick a folder once and keeps its files there.

### Optional helper

A small helper program lets Chrome read and write a fixed `~/Spaces/<space>/` folder, and watch it, so edits from other tools show up live. Without it everything else still works.

```sh
node install-host.js --id <the id Chrome shows for Mega Tabs at chrome://extensions>
```

It writes two files: a Chrome native-messaging manifest and a two-line launcher. On macOS they go to the usual Chrome folders; elsewhere pass `--manifest-dir <dir>`. Remove them with `node install-host.js --uninstall`. The helper has no network code, touches only `.md` and `.canvas` files inside `~/Spaces`, and starts only for the one extension id you gave it. Needs a current Node.js (the tests run on 22).

## Privacy

- No account, no cloud, no analytics, no ads. The extension makes no network requests of its own.
- Your tab list lives in Chrome's extension storage on your device. Notes and canvases are files in a folder you choose.
- It reads the address and title of your open tabs, because it cannot park and restore them otherwise. It does not read page content, passwords or cookies.

The full text is in [PRIVACY.md](./PRIVACY.md).

## Good to know

- Parked tabs live in minimized windows, so they may show in your Dock or taskbar. They stay loaded: they keep using memory, and sound from them keeps playing unless you mute them.
- Pinned tabs belong to every mega tab and stay put. Incognito windows are not handled.

## Tests

```sh
node --test test/*.test.js                     # fast tests with fake Chrome APIs
CHROME=/path/to/chrome node --test --test-concurrency=1 test/*.chromium.test.js   # real-browser tests, one file at a time
```

The browser tests start a real Chromium with the extension in a fresh profile; use Chrome for Testing or Chromium. Without `CHROME` they skip.

## About this repository

Mega Tabs is built on [Helium Workspaces](https://github.com/Jerry0205dotde/helium-workspaces) by Jerry0205dotde, which supplies the tab-moving engine. That project is GPL-3.0-or-later and so is this one. See [NOTICE](./NOTICE).

`kwin/`, `install.sh` and most of `docs/` are the upstream Helium Workspaces files for a KDE Plasma setup. They expect upstream's pinned extension id, which this copy does not have, so they do not work as shipped; they are kept so the history and licence of that code stay whole.

The bundled libraries (marked, DOMPurify, OverType, React Flow and React) keep their own licences in `extension/vendor/LICENSE-*`.

## License

[GPL-3.0-or-later](./LICENSE). You may use, change and share Mega Tabs as long as anything you pass on based on it is also under the GPL and comes with its source code.
