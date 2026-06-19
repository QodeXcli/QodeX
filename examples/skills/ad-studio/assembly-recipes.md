# Assembly Recipes — turning sequences into a finished ad (ffmpeg)

Prefer the `media_transform` tool where it covers the op; drop to a raw `shell`/`code_run`
ffmpeg command for the filter-heavy ones (music, transitions, reframe). Always `media_probe`
first so you know codecs/resolution/fps before joining.

> The concat demuxer (used by `media_transform concat`) was verified: two 2s clips →
> a 4s output, lossless, via a list file + `-c copy`. It needs all clips to share
> codec/resolution/fps — the typical same-preset Higgsfield case. If they differ,
> normalize first (below) or pass `reencode:true`.

## 1. Join sequences → master cut  (the tool)
```
media_transform  operation=concat  inputs=[shot-01.mp4, shot-02.mp4, shot-03.mp4]  output=master.mp4  overwrite=true
# mismatched sources → add reencode=true
```

## 2. Normalize mismatched clips before concat
Re-encode every clip to ONE spec (resolution / fps / pixel format / codec), then concat:
```bash
# normalize each shot to 1080x1920 (9:16), 30fps, H.264 yuv420p
for f in shot-*.mp4; do
  ffmpeg -y -i "$f" -vf "scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2,setsar=1" \
    -r 30 -c:v libx264 -pix_fmt yuv420p -an "norm-$f"
done
# then media_transform concat the norm-*.mp4 files (now identical specs → -c copy works)
```

## 3. Add a music track (and duck/loop to video length)
```bash
# replace/lay music over the cut, trim music to video length, fade out last 1s
ffmpeg -y -i master.mp4 -i music.mp3 \
  -filter_complex "[1:a]afade=t=out:st=END-1:d=1[a]" \
  -map 0:v -map "[a]" -c:v copy -c:a aac -shortest withmusic.mp4
# (replace END with the video duration from media_probe)
```
If shots already have VO, mix instead of replace:
```bash
ffmpeg -y -i master.mp4 -i music.mp3 \
  -filter_complex "[0:a][1:a]amix=inputs=2:duration=first:weights=1 0.3[a]" \
  -map 0:v -map "[a]" -c:v copy -c:a aac out.mp4
```

## 4. Reframe to another aspect ratio (make platform variants)
```bash
# 16:9 source -> 9:16 (blurred-fill background, subject centered) — common for Reels/TikTok
ffmpeg -y -i master_16x9.mp4 -filter_complex \
 "[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=20[bg]; \
  [0:v]scale=1080:-1[fg]; [bg][fg]overlay=(W-w)/2:(H-h)/2" \
 -c:a copy master_9x16.mp4
```

## 5. Crossfade transition between two shots (xfade)
```bash
# 0.5s crossfade; 'offset' = (duration of clip A) - 0.5
ffmpeg -y -i a.mp4 -i b.mp4 -filter_complex \
 "[0][1]xfade=transition=fade:duration=0.5:offset=2.5,format=yuv420p" out.mp4
```
Use sparingly — hard cuts on the beat usually out-perform fades on social.

## 6. Cover / thumbnail frame
```
media_transform  operation=extract_frame  input=master.mp4  start=00:00:01  output=cover.jpg
```

## 7. Loudness normalize (broadcast-ish, consistent volume)
```bash
ffmpeg -y -i withmusic.mp4 -af loudnorm=I=-14:TP=-1.5:LRA=11 -c:v copy final.mp4
# -14 LUFS ~ social platform target
```

## Pipeline order (typical)
probe → (normalize if needed) → concat → music/VO → loudnorm → reframe per platform →
extract cover. Long encodes: run the heavy ffmpeg step via `background_job_start` so it
doesn't block the session.
