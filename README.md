# EyalSec for VS Code

When EyalSec reports that untrusted data reached a SQL query or a shell command, the next thing you want is the line of code. This extension puts your EyalSec events in a side panel next to that code: each event shows where the data came in, the operation it reached and the value it carried, and one click on the source, the sink or any frame of the call path opens the file at that line.

EyalSec follows untrusted data (requests, files, environment variables and more) through your running program and reports when it reaches a risky operation. This extension reads those events through the [EyalSec API](https://eyalsec.com/docs/api); it never changes anything on your account.

## What you need

- VS Code 1.85 or newer, or an editor that installs VS Code extensions from [Open VSX](https://open-vsx.org).
- An EyalSec account and an API key. Create the key on your dashboard under **Settings > API access**. A **read-only key** is all this extension needs, and it is the one we recommend: see [API keys](https://eyalsec.com/docs/api-keys).

No account yet? [Book a live demo](https://eyalsec.com/contact) and we will set one up with you. Pricing is at [eyalsec.com/pricing](https://eyalsec.com/pricing).

## Install

Download `vscode-eyalsec-0.1.0.vsix` from the [latest release](https://github.com/EyalSec/vscode-eyalsec/releases/latest) and install it:

```bash
code --install-extension vscode-eyalsec-0.1.0.vsix
```

Or, in VS Code, open the Extensions view, choose **...** > **Install from VSIX...** and pick the file.

## Set it up

1. Click the EyalSec shield in the activity bar.
2. Click **Set API key** and paste your key. The extension checks it once against your account and says which account it reached.

The key is kept in VS Code's secret storage (your operating system's keychain on the desktop), never in a settings file. It is stored per EyalSec address, so pointing the extension at another address asks for that address's key instead of sending it this one. **EyalSec: Remove API Key** in the Command Palette deletes it.

## What you see

```
EyalSec: Events
└─ es-python
   ├─ os system            critical · web-01 · 3×
   │  ├─ Source            socket  handler.py:9
   │  ├─ Sink              os system  handler.py:12
   │  ├─ Value             ping -c 1 8.8.8.8; id
   │  ├─ Impact            command injection (critical)
   │  ├─ Command line      es-python app.py --port 8080
   │  └─ Call path         2 frames, innermost last
   │     ├─ <module>       main.py:18
   │     └─ ping_host      handler.py:12
   └─ Load more events
```

- **One list per product** on your account (es-python, es-chromium and the others you have), with the same filters as the events page: severity, live or suppressed, and most-severe-first or newest-first.
- **Each event** opens to its **Source** (where the data came in), its **Sink** (the operation it reached), the **Value** that reached it, the value when it came in, its **Impact**, the **Command line** that produced it, and its **Call path**.
- **Click a location to open it.** The source and sink lines come from the code listings an event carries when the machine is set to [send source code](https://eyalsec.com/docs/event-context#source-code); without them, the sink falls back to the innermost frame of the call path.
- **Right-click** an event or a row to copy its value, path or trace. The **Open Events Page in Browser** button in the view title bar opens the same list on your dashboard.

### How a file is matched

The machine that reported an event usually has your code somewhere else: `/srv/app`, a container, a CI runner. The extension looks for the file in this order and opens the first that exists:

1. your `eyalsec.pathMappings`, for example `{ "/srv/app": "${workspaceFolder}" }`;
2. the path exactly as reported, when it exists on this computer;
3. the longest ending of the path that exists under a workspace folder (`/srv/app/pkg/mod.py` is tried as `srv/app/pkg/mod.py`, then `app/pkg/mod.py`, then `pkg/mod.py`);
4. the bare file name, only when exactly one file in the workspace has it.

A location that matches nothing is marked **(not in this workspace)**; clicking it offers to copy the path or open the mapping setting.

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `eyalsec.url` | `https://eyalsec.com` | Your EyalSec address. Change it only if your account lives on another domain. User settings only, so a workspace cannot redirect your key. |
| `eyalsec.sort` | `severity` | `severity` (most severe first) or `newest`. |
| `eyalsec.severity` | `[]` | Show only these severities. Empty shows all. |
| `eyalsec.bucket` | `live` | `live`, `suppressed` or `all`, the same as the **Show** control on the events page. |
| `eyalsec.pageSize` | `100` | Events to load per product at a time. |
| `eyalsec.pathMappings` | `{}` | Remote path prefix to local folder. `${workspaceFolder}` and `${workspaceFolder:name}` are expanded. |

## Safety notes

- **Event text is untrusted.** A value, a trace or a command line came from a monitored program and its inputs, which can include text an attacker wrote. The extension shows all of it as plain text, never as Markdown or links, and never runs any of it.
- **Use a read-only key.** Every call this extension makes is a read, so a read-only key loses nothing.
- **The key goes only to your EyalSec address, over HTTPS.** Plain `http://` is refused except to `localhost`.
- The API's [rate limits](https://eyalsec.com/docs/api#rate-limits) apply. One load reads at most 10 pages, and **Load more events** continues from there.

## Development

```bash
git clone https://github.com/EyalSec/vscode-eyalsec && cd vscode-eyalsec
npm ci
npm run lint
npm test                                  # unit tests, against a fake API
xvfb-run -a npm run test:integration      # starts VS Code with the extension (drop xvfb-run on macOS and Windows)
npm run package                           # builds the .vsix
```

Development needs Node.js 20 or newer. To try one read-only pass against your own account, through the same client the extension uses:

```bash
EYALSEC_API_KEY=es2_your_read_only_key npm run live-check -- /path/to/your/code
```

It prints the events the panel would show and which `file:line` references resolve under that folder.

## Help

Questions and bug reports are welcome in [issues](https://github.com/EyalSec/vscode-eyalsec/issues), or write to support@eyalsec.com. Please send security reports to security@eyalsec.com rather than a public issue.

## License

MIT. See [LICENSE](LICENSE). The license covers this extension; your EyalSec account is governed by the [EyalSec terms](https://eyalsec.com/legal/terms).
