# Test streams for `roku_diagnose_stream`

Deliberately Roku-incompatible (and one control) HLS streams used to exercise and
tune the stream diagnoser. They play in a browser (hls.js / Shaka / VLC) but
behave badly on Roku. **Every fixture below was verified on a real device**
(Roku Ultra 4850X, OS 15.2.4) — the "device truth" column is what the hardware
actually did, captured via the bundled StreamProbe harness (`errorInfo` on the
debug console) plus the ECP media-player query (`audio=`/`state=`).

Regenerate all fixtures: `./generate.sh` (needs `ffmpeg` with libx265/libvorbis).

> Note: only the `.m3u8` playlists and `generate.sh` are committed. The binary
> media segments (`.m4s`/`.mp4`) are gitignored — run `./generate.sh` to
> (re)create them before serving streams to a device. The regression test
> (`npm test`) only reads the playlists, so it works without the segments.

| Fixture | What's "wrong" | Device truth | Diagnoser verdict |
|---|---|---|---|
| `muxed-fmp4-hls` | AAC muxed with video in one fMP4 rendition (no audio group) | plays, **`audio="none"`** | `muxed-fmp4-no-audio` (high) |
| `flac-hls` | FLAC audio, muxed fMP4 | plays, `audio="none"` | `muxed-fmp4-no-audio` (high) + `audio-codec-silent` |
| `vorbis-hls` | Vorbis audio, muxed fMP4 | plays, `audio="none"` | `muxed-fmp4-no-audio` (high) + `audio-codec-silent` |
| `hevc-8k-hls` | HEVC 7680x4320 @ Level 6.1 | **hard fail, `errorCode -3`** | `hevc-exceeds-decoder` (high) |
| `demuxed-aac-hls` | nothing — **control** | plays **with** audio (`audio="aac"`) | No issues (no false positive) |
| `opus-hls` | Opus audio, muxed fMP4 | plays, silent | `muxed-fmp4-no-audio` + `audio-codec-silent` |
| `h264-4k-hls` | 4K H.264 High@5.1 | hard fail (reader error) | `avc-exceeds-decoder` (high) |

## The two headline findings these fixtures proved

### 1. Muxed audio in fMP4/CMAF HLS = silent on Roku (even with AAC)

`muxed-fmp4-hls` uses fully-supported **AAC**, yet the device reports
`audio="none"` and plays silently. The only difference from `demuxed-aac-hls`
(which plays *with* sound) is that the control puts audio in a separate
`#EXT-X-MEDIA:TYPE=AUDIO` rendition. So the root cause is the **muxing**, not the
codec. Muxed MPEG-TS HLS is fine; muxed fMP4/CMAF is not.

Fix: split audio into its own rendition —
`ffmpeg ... -var_stream_map "v:0,agroup:aud a:0,agroup:aud,default:yes"`.

### 2. Over-limit video decoders hard-fail with `errorCode -3` (not always -5)

`hevc-8k-hls` (8K / HEVC L6.1) exceeds even the Ultra's decoder. The device went
`buffering -> error -> finished` with:

```
errorCode = -3
errorInfo = {"category":"mediaplayer","dbgmsg":"bad:extra:err_clip_idx:0","drmerrcode":0,"errcode":0}
```

Roku does **not** always emit `errorCode -5` for undecodable media — a generic
`-3` / `category:"mediaplayer"` is common. The diagnoser now treats that as a
media error and corroborates the manifest-derived decoder-limit finding.

## Why no `long-segments` / `broken-frag` fixtures

Both were built and device-tested. On this Ultra, 20s VOD segments and
single-GOP / mid-GOP fMP4 cuts **played fine with audio**. They are not reliable
"fails on Roku" cases on modern hardware, so they were dropped rather than ship
misleading fixtures. The segment-length check survives in the diagnoser as a
low-confidence advisory (a hint, not a hard fail), which is the honest treatment.

## How the device captures were taken

The bundled StreamProbe harness (`src/assets/streamprobe`) plays a deep-linked
stream and prints `[StreamProbe] state changed ...` / `errorInfo = ...` to the
BrightScript debug console (port 8085). Capture flow:

```bash
# 1. deploy the harness (or use roku_deploy)
# 2. deep-link a stream:
curl -d '' "http://<roku-ip>:8060/launch/dev?input_url=<url-encoded>&input_format=hls"
# 3. read the console:
nc <roku-ip> 8085
# 4. (for the silent cases) confirm the dropped audio track:
curl "http://<roku-ip>:8060/query/media-player"   # look at <format audio="...">
```

## Serving locally

```bash
# from the test-streams directory
python3 -m http.server 8080 --bind 0.0.0.0
# point the tool at:  http://<your-lan-ip>:8080/<fixture>/master.m3u8
```

## Diagnosing

```
roku_diagnose_stream url="http://<ip>:8080/muxed-fmp4-hls/master.m3u8"
```

Pass a `url` (not just pasted `content`) so the diagnoser fetches one child media
playlist to confirm the container — the TS-vs-fMP4 distinction is what makes the
muxed-audio finding high-confidence.
