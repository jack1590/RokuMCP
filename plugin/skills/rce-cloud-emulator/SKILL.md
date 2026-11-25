---
name: rce-cloud-emulator
description: Start, use, and stop a Roku Cloud Emulator (RCE) Cloud Device with roku-mcp, keeping billed Run time short. Use when the user asks to test on RCE, a cloud Roku, or a Cloud Device, or names a Cloud Device id or name.
---

# Roku Cloud Emulator (RCE)

RCE runs Roku devices in the cloud. A Cloud Device is permanent; each boot of it is a Run.

**Billing.** A Run costs $0.20 per hour, billed per minute from the start request. RCE never stops an idle Run; only the maximum runtime cap ends it. Start a Run only when the user asked for one, keep `maxRuntimeMinutes` as low as the task allows (the default is 60), and always end with `roku_rce_stop`, also after a failure.

## Configuration

- `ROKU_RCE_TOKEN` (required): the RCE personal access token. It never appears in tool output. Never ask the user to paste it into chat; it belongs in the environment or the `.env` file.
- `ROKU_RCE_DEVICE` (optional): the default Cloud Device id or exact name. When it is set, device tools target it unless you pass `host`.
- `ROKU_RCE_PASSWORD` (optional): the Cloud Device developer password, needed by `roku_deploy`, `roku_delete_dev_channel` and `roku_screenshot`.

## Workflow

1. `roku_rce_list_devices`: find the Cloud Device and check that `run` is null. If it already has a Run that this server did not start, ask the user before touching it.
2. `roku_rce_status rceDevice=<id>`: pick a Snapshot if the user named one.
3. `roku_rce_start rceDevice=<id> [snapshotId=<id>] maxRuntimeMinutes=<n>`: waits until the device takes input (about 35 to 50 seconds).
4. Work with the usual tools and `rceDevice=<id>`:
   - `roku_console_capture_start`, then `roku_deploy rootDir=<dir>`, then `roku_console_wait pattern="<marker>"`.
   - `roku_query_active_app`, `roku_keypress`, `roku_screenshot`.
5. `roku_rce_stop rceDevice=<id>`, then `roku_rce_status` to confirm `status: "shutdown"`.

## Limits on a Cloud Device

- In the default "Limited" ECP mode, `roku_query_app_ui`, `roku_query_sg_nodes`, `roku_find_node`, `roku_get_focused_node` and `roku_query_media_player` fail with a 403. The fix is on the device: Settings > System > Advanced system settings > Control by mobile apps > Network access > Permissive, then save a new Snapshot and start from it. Tell the user; do not retry in a loop.
- The runtime UI editing tools try an RCE bridge to port 9000. This path is unverified. A closed-port error means the channel has no RTA, or RCE does not bridge port 9000.
- `roku_perfetto_enable`, `roku_perfetto_start`, `roku_discover` and `roku_diagnose_stream` with `captureLive` are not supported on RCE.
- No tool creates or deletes Cloud Devices.
