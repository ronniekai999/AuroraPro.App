# Playback fixture

`playback.ts` contains ten seconds of generated purple video and a sine tone.
It is test media only and is not included in the application APK.

Regenerate with FFmpeg:

```sh
ffmpeg -f lavfi -i color=c=purple:s=160x90:r=10 \
  -f lavfi -i sine=frequency=440:sample_rate=24000 -t 10 \
  -c:v libx264 -preset ultrafast -pix_fmt yuv420p -g 100 \
  -c:a aac -b:a 32k -f mpegts -y playback.ts
```
