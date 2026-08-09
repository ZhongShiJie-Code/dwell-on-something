# Dwell + Cloudflare Tunnel

1. Create a dedicated Cloudflare Tunnel and DNS hostname, for example `dwell.example.com`.
2. Configure the hostname as a Cloudflare Access application with an identity policy.
3. Copy `config.yml.example` to a local `config.yml`, replace the placeholders, and run:

```bash
cloudflared tunnel --config ./config.yml run
```

Run the Dwell backend on `127.0.0.1:8787` with `DWELL_AUTH_TOKEN` set. The Android app should receive the HTTPS hostname through its connection screen; neither the Tunnel credentials nor the Dwell token belongs in GitHub or the APK.

The Dwell task API keeps control actions disabled until `DWELL_DESKTOP_TASKS_BRIDGE` points to the audited Mac-side bridge. The bridge only accepts known task IDs and `run|pause|resume`; declared host scripts are still checked by the host allowlist. A Tunnel must not be used to bypass that local control boundary.
