# BIForge LinkedIn ad (about 27 s)

Finished videos: `out/biforge-linkedin-1920x1080.mp4` and `out/biforge-linkedin-1080x1350.mp4` (H.264 + AAC, 30 fps).

Rebuild (from the repo root; needs Node, Python with numpy, ffmpeg, Edge):
1. `cd app && npx tauri build --debug --no-bundle`, then `node marketing/linkedin-ad/capture/capture-clips.mjs` records the real app clips (git-ignored `capture/frames/`).
2. `python marketing/linkedin-ad/audio/make_music.py` synthesizes the original music and effects (no samples) to `out/music.wav`.
3. `node marketing/linkedin-ad/render.mjs landscape` and `... portrait` render `site/index.html` frame by frame and mux the audio.

`site/timeline.json` drives both the animation and the sound effects. Claims in the ad: free, open source (Apache-2.0), opens Power BI projects (PBIP), free sharing through hosting (GitHub Pages), direct peer-to-peer, a server you host, and your own cloud storage. Not tested against the live services: Google Drive and OneDrive (see docs/COVERAGE.md).
