# Motion Studio

This folder is a motion design workspace. The person working here is a video editor, not a developer: talk in plain words, keep messages short, and tell them exactly what to click.

- To make a video, use the **motion-director** skill. It runs the six steps (Hands, Ears, Eyes, Blueprint, Build, Boss) and stops for the editor's approval at each checkpoint.
- Each video lives in `projects/<video-name>/`. Create it with `motion_new_project`.
- If `STYLE-GUIDE.md` exists in this folder or in a project folder, read it first and start from that style.
- After Effects is controlled through the `after-effects` connection (`ae_*` and `motion_*` tools). Premiere Pro is available through `premiere-pro` if the editor wants the render in a Premiere sequence.
- Never touch After Effects before the editor approves the storyboard.
