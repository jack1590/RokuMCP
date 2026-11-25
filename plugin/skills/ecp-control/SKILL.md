---
name: ecp-control
description: Drive a Roku with simulated remote input and inspect the running app via ECP (keypress, type text, SceneGraph tree, focused node, media player state). Use to navigate menus, type into fields, find nodes, or assert video playback state.
---

# ECP control and observation

## Loop

Observe → act → wait → verify. Always pause between presses.

```
roku_screenshot                       # observe
roku_get_focused_node                 # what has focus
roku_keypress / roku_keypress_sequence / roku_type_text   # act
roku_sleep durationMs=500..2000       # settle
roku_find_node | roku_query_app_ui    # verify
```

- Text fields: focus with `roku_keypress` first, then `roku_type_text`.
- Video assertions: `roku_query_media_player` is the source of truth. `state` is one of `play`, `pause`, `buffer`, `stop`, `none`. Read `position`, `duration`, `error`.
- Never assert without a preceding `roku_sleep`.

## Test generation

- Match the target project's test framework. Read sibling tests first.
- Every step is navigate → wait → assert.
- Prefer `uiElementId` (`RTA_<digits>`) over text matches for selectors when RTA is present (see `runtime-ui-editing`).
