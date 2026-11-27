---
name: ecp-control
description: Reproduce a UI bug or reach a screen on a running Roku app by sending remote keys and checking what is on screen and in focus. Use when the user asks to navigate the app, open a screen, type into a field, check what is focused, or confirm a video is playing.
---

# Reproduce a bug on screen

Work in small steps: observe, act, wait, verify. Never check the screen right after a key press without a pause.

## Steps

1. Observe: `roku_screenshot` (the image) and `roku_get_focused_node` (what has focus).
2. Act: `roku_keypress` for one key, `roku_keypress_sequence` for several, `roku_type_text` after a text field has focus.
3. Wait: `roku_sleep` 500 to 2000 ms so rendering, animations and network settle.
4. Verify: `roku_find_node` (by `nodeId`, or `attr` + `value`) or `roku_get_focused_node`. For video, `roku_query_media_player`: `state` is `play`, `pause`, `buffer`, `stop` or `none`, with `position`, `duration` and `error`.
5. Take one more `roku_screenshot` only when the visual state matters.

### In code mode (`roku_run`)

The whole loop is one call. Return only what you need to decide the next step.

```js
await roku.input.keys({ keys: ['Home', 'Down', 'Down', 'Select'], delayMs: 300 });
await roku.device.sleep({ durationMs: 1500 });
const focused = await roku.ui.focused();
const play = await roku.ui.find({ attr: 'text', value: 'Play' });
return { focused, playFound: play.length > 0, player: await roku.device.mediaPlayer() };
```

Call `roku_screenshot` separately when you need the image.

### From a shell (`rokuctl`)

```sh
rokuctl input.keys Home Down Select --delay-ms 300
rokuctl device.sleep 1500
rokuctl ui.focused
```

## When it goes wrong

| Symptom | Cause | Fix |
|---|---|---|
| "No dev channel is running (the device answered 404 to query/app-ui)" | The UI tree needs a sideloaded dev channel | Deploy it (`deploy-debug` skill) |
| 403 "Limited mode" on a Cloud Device | RCE snapshot in Limited ECP mode | Tell the user to switch the snapshot to Permissive (`rce-cloud-emulator` skill); keys still work |
| The find returns nothing right after a key | The UI had not settled | Sleep longer, then find again |
| Typed text went nowhere | The field did not have focus | Select the field first, then type |
| "Could not resolve the Roku device hostname" or "No Roku device found" | No host, no Cloud Device, SSDP found nothing | Ask the user for the device; do not invent an IP (`install` skill) |
