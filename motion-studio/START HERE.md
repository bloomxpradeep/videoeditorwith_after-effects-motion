# Motion Studio: start here

Motion Studio lets Claude build motion design videos in After Effects with you. You bring the footage and your taste; Claude transcribes, storyboards, builds the scenes as normal editable After Effects layers, checks its own work, and renders. You stay the creative director: Claude stops and asks you at every step.

## Every time you make a video

1. **Open After Effects.** Then choose **Window > Extensions > MCP Bridge (CEP)**. The panel should say **Connected**. (Leave it open; After Effects remembers it.)
2. **Open the Claude app**, go to the **Code** tab, and open this **Motion Studio** folder.
3. Type: **Let's make a motion design video**
4. Claude asks for a name and creates a folder for the video under `projects/`. Put your **raw video** in its `footage` folder and any **references or logo** in `references`, then tell Claude **Done**.
5. Answer Claude's questions. It works in six steps and waits for you after each one:

| Step | What happens | What you do |
| --- | --- | --- |
| 1. Connect | Claude checks it can reach After Effects and saves a project. | Nothing, unless it asks you to open the panel. |
| 2. Transcribe | Claude transcribes the video word by word on this Mac (nothing is uploaded) and lists names it might have misspelled. | Fix the spellings. |
| 3. References | Claude studies your references and proposes colours, fonts and rules. | Share images, videos, YouTube links, your brand. Approve the look. |
| 4. Storyboard | Claude writes a storyboard and checks it against your rules. Open `storyboard/storyboard.html` (double-click it), press **Play full storyboard**. | Give feedback on feeling: "too fast", "pixels too big", "more 3D". Approve when it's right. |
| 5. Build | Claude builds the video in After Effects scene by scene, checking each one. | Watch it happen. Say what feels wrong and why. |
| 6. Review and render | Claude reviews every scene against your rules, fixes what it finds, and renders to `renders/`. | Final notes, then you're done. |

At the end, Claude saves what worked (palette, fonts, rules, transitions) to `STYLE-GUIDE.md`, so the next video starts from your style.

## Good rules to give Claude

Write them in plain English when Claude asks. Some ideas:

- Text appears only when it's said, letter by letter.
- Text never covers the face; it sits beside it.
- One hero word per scene; everything else smaller.
- Max 2 fonts: one sans, one italic serif for emphasis.
- Every scene holds for at least half a second after its animation finishes.
- Keep the bottom 20% clear for captions.
- Colours only from my palette: #..., #..., #...
- Nothing static: everything always has some gentle movement.

## If something isn't working

- **"I couldn't reach After Effects"**: make sure After Effects is open and the **MCP Bridge (CEP)** panel says **Connected**, then tell Claude to try again. If a dialog is open in After Effects, close it.
- **The MCP Bridge panel is missing** from Window > Extensions: quit After Effects, run the installer again (below), and reopen After Effects.
- **Claude says a tool is missing** (Whisper, ffmpeg, OpenCV): run the installer again.
- **Fonts look wrong**: the font must be installed on this Mac. Tell Claude which font you want.

## Updating

Open Terminal and run the same install command you used the first time. It updates everything and keeps your projects and style guide.

## What's in this folder

| Item | What it is |
| --- | --- |
| `projects/` | One folder per video. |
| `STYLE-GUIDE.md` | Your house style, once Claude has saved one. |
| `.mcp.json` | The After Effects and Premiere connections (set up by the installer, don't edit). |
| `.claude/` | The Motion Director skill and settings (set up by the installer). |
| `motion-director-skill.zip` | The same skill, if you'd rather add it in Claude under Customize > Skills. |
