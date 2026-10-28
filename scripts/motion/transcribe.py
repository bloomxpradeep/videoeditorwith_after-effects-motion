#!/usr/bin/env python3
"""Word-level transcription for the Motion Director workflow.

Runs locally with faster-whisper (installed by the Motion Director installer).
Falls back to openai-whisper if that is what is installed. Writes Whisper-style
JSON (segments with per-word start/end/probability) to --out; the MCP server
turns that into words.json, an .srt and plain text.

Usage: transcribe.py MEDIA --out raw.json [--model small] [--language en] [--prompt "Names, Brands"]
"""
import argparse
import json
import sys
import time


def log(message):
    sys.stderr.write(message + "\n")
    sys.stderr.flush()


def with_faster_whisper(args):
    from faster_whisper import WhisperModel  # noqa: WPS433 (optional dependency)

    log(f"Loading faster-whisper model '{args.model}' (first run downloads it)...")
    model = WhisperModel(args.model, device="auto", compute_type="int8")
    segments, info = model.transcribe(
        args.media,
        word_timestamps=True,
        language=args.language or None,
        initial_prompt=args.prompt or None,
        beam_size=5,
        vad_filter=False,
    )
    out = {
        "engine": "faster-whisper",
        "model": args.model,
        "language": info.language,
        "duration": info.duration,
        "segments": [],
    }
    for seg in segments:
        out["segments"].append({
            "start": seg.start,
            "end": seg.end,
            "text": seg.text.strip(),
            "words": [
                {"word": w.word.strip(), "start": w.start, "end": w.end, "probability": w.probability}
                for w in (seg.words or [])
            ],
        })
        log(f"  {seg.end:7.1f}s / {info.duration:.1f}s")
    return out


def with_openai_whisper(args):
    import whisper  # noqa: WPS433 (optional dependency)

    log(f"Loading openai-whisper model '{args.model}'...")
    model = whisper.load_model(args.model)
    result = model.transcribe(
        args.media,
        word_timestamps=True,
        language=args.language or None,
        initial_prompt=args.prompt or None,
    )
    segments = []
    for seg in result.get("segments", []):
        segments.append({
            "start": seg["start"],
            "end": seg["end"],
            "text": seg["text"].strip(),
            "words": [
                {"word": w["word"].strip(), "start": w["start"], "end": w["end"], "probability": w.get("probability")}
                for w in seg.get("words", [])
            ],
        })
    duration = segments[-1]["end"] if segments else 0
    return {"engine": "openai-whisper", "model": args.model, "language": result.get("language"), "duration": duration, "segments": segments}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("media")
    parser.add_argument("--out", required=True)
    parser.add_argument("--model", default="small")
    parser.add_argument("--language", default=None)
    parser.add_argument("--prompt", default=None, help="Names and brand words to help spelling")
    args = parser.parse_args()

    started = time.time()
    engines = [("faster-whisper", with_faster_whisper), ("openai-whisper", with_openai_whisper)]
    result = None
    missing = []
    for name, fn in engines:
        try:
            result = fn(args)
            break
        except ImportError:
            missing.append(name)
    if result is None:
        print(json.dumps({"ok": False, "error": "No Whisper engine installed (tried " + ", ".join(missing) + "). Install with: pip install faster-whisper"}))
        sys.exit(3)

    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump(result, fh, ensure_ascii=False)
    words = sum(len(s["words"]) for s in result["segments"])
    print(json.dumps({
        "ok": True,
        "engine": result["engine"],
        "language": result.get("language"),
        "duration": result.get("duration"),
        "segments": len(result["segments"]),
        "words": words,
        "seconds": round(time.time() - started, 1),
    }))


if __name__ == "__main__":
    main()
