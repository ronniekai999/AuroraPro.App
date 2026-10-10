# Playback fixture

`playback.ts` contains ten seconds of generated purple video and a sine tone.
It is test media only and is not included in the application APK.

`playback-high.ts` is a second generated rendition (320×180). The controls tests
serve these as a two-rendition HLS master with repeated discontinuities to keep
playback running while checking the five-second overlay timeout and quality
changes. The source duration and returned anchor are deliberately different
from the local playlist duration.

Regenerate with FFmpeg:

```sh
ffmpeg -f lavfi -i color=c=purple:s=160x90:r=10 \
  -f lavfi -i sine=frequency=440:sample_rate=24000 -t 10 \
  -c:v libx264 -preset ultrafast -pix_fmt yuv420p -g 100 \
  -c:a aac -b:a 32k -f mpegts -y playback.ts
```

Regenerate the higher rendition:

```sh
ffmpeg -f lavfi -i 'color=c=#713bbb:s=320x180:r=24:d=10' \
  -f lavfi -i 'sine=frequency=660:sample_rate=48000:duration=10' \
  -c:v libx264 -profile:v baseline -level 3.0 -pix_fmt yuv420p \
  -preset ultrafast -g 48 -keyint_min 48 -sc_threshold 0 \
  -c:a aac -b:a 64k -shortest -f mpegts -y playback-high.ts
```

`playback-two-audio.mp4` contains English and Spanish-labelled sine tracks in
that file order, plus English and Spanish `mov_text` captions. The fallback test
selects Spanish audio/captions in real Media3 playback, triggers an extractor
error, and checks the outgoing source audio index, served tone rendition,
decoded AAC track and selected HLS caption language. Muxed HLS does not expose
an audio LANGUAGE attribute, so the test does not infer one from Media3's format.
It then restores Automatic audio, checking that the replacement plays English
while retaining Spanish captions, the source position, and Pause.
`playback-spanish.ts` and `playback-english.ts` are generated compatibility renditions.

```sh
ffmpeg -f lavfi -i 'testsrc2=size=160x90:rate=24' \
  -f lavfi -i 'sine=frequency=440:sample_rate=48000' \
  -f lavfi -i 'sine=frequency=880:sample_rate=48000' \
  -map 0:v -map 1:a -map 2:a -t 90 -c:v libx264 -threads 1 \
  -preset ultrafast -profile:v baseline -pix_fmt yuv420p -c:a aac -b:a 32k \
  -metadata:s:a:0 language=eng -metadata:s:a:1 language=spa \
  -movflags +faststart -y playback-two-audio.mp4

printf '1\n00:00:00,000 --> 00:01:30,000\nEnglish fixture captions\n' > english.srt
printf '1\n00:00:00,000 --> 00:01:30,000\nSpanish fixture captions\n' > spanish.srt
ffmpeg -i playback-two-audio.mp4 -i english.srt -i spanish.srt \
  -map 0 -map 1:0 -map 2:0 -c:v copy -c:a copy -c:s mov_text \
  -metadata:s:s:0 language=eng -metadata:s:s:1 language=spa \
  -disposition:s:0 default -disposition:s:1 0 -movflags +faststart \
  -y playback-with-captions.mp4
mv playback-with-captions.mp4 playback-two-audio.mp4

ffmpeg -f lavfi -i 'testsrc2=size=160x90:rate=24' \
  -f lavfi -i 'sine=frequency=880:sample_rate=48000' \
  -map 0:v -map 1:a -t 10 -c:v libx264 -threads 1 -preset ultrafast \
  -profile:v baseline -pix_fmt yuv420p -c:a aac -b:a 32k \
  -metadata:s:a:0 language=spa -f mpegts -y playback-spanish.ts

ffmpeg -f lavfi -i 'testsrc2=size=160x90:rate=24' \
  -f lavfi -i 'sine=frequency=440:sample_rate=48000' \
  -map 0:v -map 1:a -t 10 -c:v libx264 -threads 1 -preset ultrafast \
  -profile:v baseline -pix_fmt yuv420p -c:a aac -b:a 32k \
  -metadata:s:a:0 language=eng -f mpegts -y playback-english.ts
```
