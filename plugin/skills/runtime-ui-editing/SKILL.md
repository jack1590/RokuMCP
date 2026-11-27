---
name: runtime-ui-editing
description: Change a running Roku SceneGraph UI without redeploying (change a label, hide or move a node, focus it, add or remove one) and read a field or wait for it to change, through the RTA On-Device Component. Use when the user asks to tweak the UI live, try a layout change, or wait until a field (such as video state) reaches a value.
---

# Change the UI live

RTA is an On-Device Component the channel must include. It listens on TCP 9000 and is not the debug console.

## Steps

1. Check that a dev channel runs: `roku_query_active_app` shows `ui-location` = `dev`.
2. Check that RTA is present: `roku_query_sg_nodes type=roots` lists `RTA_OnDeviceComponent`, or nodes in `roku_query_app_ui` carry `uiElementId="RTA_<digits>"`.
3. Find the node: `roku_query_app_ui`, locate the visible text, copy that element's `uiElementId`. Never use `name`: it is not addressable and the call returns OK with no change.
4. Read the current value: `roku_get_value nodeId="RTA_<n>" field="<field>"`.
5. Change it: `roku_edit_node nodeId="RTA_<n>" fields={...}` (or `roku_set_node_visible`, `roku_move_node`, `roku_focus_node`, `roku_create_node`, `roku_remove_node`).
6. Read it again with `roku_get_value`. An OK reply alone is not proof.
7. To wait for a change (e.g. video starts): `roku_observe_field nodeId=... field=... match=...`.

### In code mode (`roku_run`)

```js
const [title] = await roku.ui.find({ attr: 'text', value: "America's Newsroom" });
const id = title.uiElementId;
const before = await roku.rta.get({ nodeId: id, field: 'text' });
await roku.rta.edit({ nodeId: id, fields: { text: 'Hello' } });
const after = await roku.rta.get({ nodeId: id, field: 'text' });
return { id, before: before.value, after: after.value };
```

## When it goes wrong

| Symptom | Cause | Fix |
|---|---|---|
| OK, but nothing changed | Used `name` instead of `uiElementId` | Re-read the tree and use `RTA_<digits>` |
| OK, then the value snaps back | Parent `LayoutGroup`, `RowList` or `MarkupGrid` relays out, or an observer rewrites the field | Change the parent, or the bound `ContentNode` |
| `found: false` | Wrong field name for that subtype | Check the field on the node in `roku_query_app_ui` |
| Connection refused, "RTA socket closed" | The channel has no RTA | Tell the user: bundle the RTA OnDeviceComponent, or set `"injectRdbOnDeviceComponent": true` in `launch.json` and add `' vscode_rdb_on_device_component_entry` after `screen.show()` in `main()` |
| "Port 9000 did not answer through the Roku Cloud Emulator bridge" | Cloud Device: no RTA, or RCE does not bridge 9000 (unverified) | Use a LAN device for live editing |
| Id stopped working | A row was recycled | Query the tree again for a fresh id |
