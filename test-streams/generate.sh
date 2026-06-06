#!/usr/bin/env bash
# Regenerate the test-stream fixtures used to validate roku_diagnose_stream.
# Each fixture isolates one Roku-specific outcome, all verified on a real device
# (Roku Ultra 4850X, OS 15.2.4). Run from test-streams/.
#
# Result classes (proven on-device):
#   muxed-fmp4 / flac / vorbis -> video plays, media-player audio="none" (silent)
#   hevc-8k                    -> hard fail, errorCode -3 / category "mediaplayer"
#   demuxed-aac                -> CONTROL: plays WITH audio (audio="aac"); no false positive
set -euo pipefail
cd "$(dirname "$0")"

DUR=8
SIZE=1280x720
mk_dir() { rm -rf "$1"; mkdir -p "$1/v0"; }

# Shared muxed-fMP4 video+audio encoder (audio codec is the variable).
mux_fixture() { # name acodec acodec_flags codecs_attr
  local name="$1" acodec="$2" aflags="$3" codecs="$4"
  mk_dir "$name"
  ( cd "$name/v0"
    ffmpeg -y -hide_banner -loglevel error \
      -f lavfi -i "testsrc=size=$SIZE:rate=24:duration=$DUR" \
      -f lavfi -i "sine=frequency=440:duration=$DUR" \
      -c:v libx264 -profile:v high -level 3.1 -pix_fmt yuv420p -g 48 \
      -c:a "$acodec" $aflags \
      -f hls -hls_time 4 -hls_playlist_type vod -hls_segment_type fmp4 \
      -hls_fmp4_init_filename "init.mp4" -hls_segment_filename "seg_%03d.m4s" \
      stream.m3u8 )
  cat > "$name/master.m3u8" <<EOF
#EXTM3U
#EXT-X-VERSION:7
#EXT-X-STREAM-INF:BANDWIDTH=1500000,RESOLUTION=1280x720,CODECS="$codecs"
v0/stream.m3u8
EOF
}

# 1. Muxed fMP4 with supported AAC -> silent purely because of muxing.
mux_fixture muxed-fmp4-hls aac "-b:a 128k" "avc1.64001f,mp4a.40.2"
# 2. Unsupported FLAC audio (also muxed) -> silent.
mux_fixture flac-hls flac "" "avc1.64001f,fLaC"
# 3. Unsupported Vorbis audio (also muxed) -> silent.
mux_fixture vorbis-hls libvorbis "" "avc1.64001f,vorbis"

# 4. HEVC 7680x4320 Level 6.1 -> exceeds even an Ultra's decoder -> hard fail.
mk_dir hevc-8k-hls
( cd hevc-8k-hls/v0
  ffmpeg -y -hide_banner -loglevel error \
    -f lavfi -i "testsrc=size=7680x4320:rate=30:duration=4" \
    -f lavfi -i "sine=frequency=440:duration=4" \
    -c:v libx265 -preset ultrafast -pix_fmt yuv420p -x265-params "level-idc=6.1:no-info=1" -b:v 40M -g 60 \
    -c:a aac -b:a 128k -tag:v hvc1 \
    -f hls -hls_time 2 -hls_playlist_type vod -hls_segment_type fmp4 \
    -hls_fmp4_init_filename "init.mp4" -hls_segment_filename "seg_%03d.m4s" \
    stream.m3u8 )
cat > hevc-8k-hls/master.m3u8 <<'EOF'
#EXTM3U
#EXT-X-VERSION:7
#EXT-X-STREAM-INF:BANDWIDTH=40000000,RESOLUTION=7680x4320,CODECS="hvc1.1.6.L183.90,mp4a.40.2"
v0/stream.m3u8
EOF

# 5. CONTROL: demuxed AAC (separate EXT-X-MEDIA audio rendition) -> plays WITH audio.
rm -rf demuxed-aac-hls; mkdir -p demuxed-aac-hls/v0 demuxed-aac-hls/a0
( cd demuxed-aac-hls/v0
  ffmpeg -y -hide_banner -loglevel error -f lavfi -i "testsrc=size=$SIZE:rate=24:duration=$DUR" \
    -c:v libx264 -profile:v high -level 3.1 -pix_fmt yuv420p -g 48 -an \
    -f hls -hls_time 4 -hls_playlist_type vod -hls_segment_type fmp4 \
    -hls_fmp4_init_filename "init.mp4" -hls_segment_filename "seg_%03d.m4s" stream.m3u8 )
( cd demuxed-aac-hls/a0
  ffmpeg -y -hide_banner -loglevel error -f lavfi -i "sine=frequency=440:duration=$DUR" \
    -c:a aac -b:a 128k -vn \
    -f hls -hls_time 4 -hls_playlist_type vod -hls_segment_type fmp4 \
    -hls_fmp4_init_filename "init.mp4" -hls_segment_filename "seg_%03d.m4s" stream.m3u8 )
cat > demuxed-aac-hls/master.m3u8 <<'EOF'
#EXTM3U
#EXT-X-VERSION:7
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="English",DEFAULT=YES,AUTOSELECT=YES,URI="a0/stream.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=1500000,RESOLUTION=1280x720,CODECS="avc1.64001f,mp4a.40.2",AUDIO="aud"
v0/stream.m3u8
EOF

echo "All fixtures generated."
