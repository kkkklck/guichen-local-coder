# Optional Windows tunnel integration

`windows/tunnel` contains this project's startup and diagnostic scripts, not the OpenAI Tunnel executable. The scripts derive from a working personal deployment; the public edition uses relative project paths and separate credential/log names. These portable changes passed mock tests but have not been verified on a fresh machine with a real account.

Complete the README's local setup and build first. This integration currently fixes the MCP port at 3000, the Admin port at 3001, and the Tunnel health port at 8080, all listening on 127.0.0.1. If another application owns a port, the scripts refuse a duplicate launch instead of terminating an unknown process.

Obtain the Windows client and runtime credentials appropriate for your account from the [official OpenAI Secure MCP Tunnel documentation](https://platform.openai.com/docs/guides/secure-mcp-tunnel). Place your independently verified `tunnel-client.exe` in `windows/tunnel`. Git ignores that executable. This repository does not provide a third-party mirror or personal Tunnel ID.

Configure from an interactive PowerShell session:

```powershell
& .\windows\tunnel\run-local-coder-tunnel.ps1 -Configure
```

The script asks for a Tunnel ID and a Runtime API Key through hidden input. The key is stored in the current user's Windows Credential Manager under `GuichenLocalCoder:RuntimeAPIKey`. The Tunnel ID is stored in local `tunnel-settings.json`, which must not be committed. The script then starts supervision; the local MCP server must already be running.

Check actual status:

```powershell
& .\windows\tunnel\get-local-coder-status.ps1
```

A running process is not proof of connectivity: connected status requires observed successful control-plane polling. For 429 responses, the client's backoff is retained. Authentication failures are not handled by a restart loop. Late or changing system proxy settings trigger a fresh Windows route check; recovery only replaces a verified, idle, disconnected transport launched by this integration.

Logs are written to `%LOCALAPPDATA%\GuichenLocalCoder\logs`. Raw tokens, keys, and request payloads are not persisted by the supervisor. Credential and log names are separate from the historical personal installation.

For startup after user login, create current-user Startup shortcuts for these scripts using Windows PowerShell's `-NoProfile -WindowStyle Hidden -File` options and quoted absolute script paths:

- `windows/tunnel/start-local-coder-autostart.ps1`
- `windows/tunnel/start-tunnel-autostart.ps1`

This means startup after login, not before login. The approval UI requires an interactive user session; do not run approval mode as a non-interactive Session 0 service. Preparing this repository does not install startup entries or launch a second production service.

`npm run test:tunnel` needs no real account. The optional `node windows/tunnel/tests/test-proxy-routing.mjs` requires an installed client and uses a local fake control plane and dummy credentials; it does not verify public account connectivity.
