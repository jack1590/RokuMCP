---
name: runtime-ui-editing
description: Edit a running Roku SceneGraph UI at runtime through the RTA On-Device Component (port 9000) using roku_edit_node, roku_get_value, roku_set_node_visible, roku_move_node, roku_focus_node, roku_create_node, roku_remove_node, roku_observe_field. Use when the user asks to change a title, hide a node, or mutate a field without redeploying.
---

# Runtime UI editing (RTA)

RTA is the On-Device Component on TCP 9000. It is not the debug console.

## Requirements

1. Dev channel running: `roku_query_active_app` shows `ui-location` = `dev`.
2. RTA present. Any of: `roku_query_sg_nodes type=roots` lists `RTA_OnDeviceComponent`; nodes in `roku_query_app_ui` carry `uiElementId="RTA_<digits>"`; device log shows `[RTA][INFO] OnDeviceComponent init`.
3. If RTA is missing, tell the user to either bundle the RTA OnDeviceComponent, or set `"injectRdbOnDeviceComponent": true` in `launch.json` and add `' vscode_rdb_on_device_component_entry` after `screen.show()` in `main()`.

## Rule

Use `uiElementId` (`RTA_<digits>`). Never use `name`: it is not addressable and the call returns OK with no visible change.

## Workflow: "change the title to X"

1. `roku_query_app_ui`, find the element with the visible text. Copy its `uiElementId`.
2. `roku_get_value nodeId="RTA_<n>" field="<field>"`: record current value.
3. `roku_edit_node nodeId="RTA_<n>" fields={...}`.
4. `roku_get_value` again. OK status alone is not proof.

## Why "OK but nothing changed"

- Used `name` instead of `uiElementId`.
- Parent is `LayoutGroup`, `RowList`, or `MarkupGrid`: its next layout pass overwrites `translation`/`width`/`height`. Change the parent or detach the child.
- An observer rewrites the field each tick: mutate the bound model node.
- Row was recycled: re-query for a fresh id.
- Wrong field for the subtype: `roku_get_value` returns `found: false`.
- RowList children: change the underlying `ContentNode`, not the child.
