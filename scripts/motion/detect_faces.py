#!/usr/bin/env python3
"""Find faces in a video and turn them into storyboard no-go zones.

Samples a frame every --every seconds, finds the largest face with OpenCV's
built-in detectors, groups samples where the face stays roughly in place, and
writes zones (fractions of the frame, padded) that on-screen text must avoid.

Basic by design: good for talking-head footage. Editors can adjust the zones in
storyboard.json afterwards.

Usage: detect_faces.py VIDEO --out faces.json [--every 0.5] [--padding 0.35]
"""
import argparse
import json
import os
import sys


def cascade_path(name):
    import cv2  # noqa: WPS433

    roots = []
    data = getattr(cv2, "data", None)
    if data is not None and getattr(data, "haarcascades", None):
        roots.append(data.haarcascades)
    roots.append(os.path.join(os.path.dirname(cv2.__file__), "data"))
    for root in roots:
        path = os.path.join(root, name)
        if os.path.exists(path):
            return path
    return None


def build_zones(samples, every, padding, max_move, duration):
    """Group consecutive samples whose largest face stays put; one padded zone per group."""
    zones = []
    current = None
    for s in samples:
        face = s["faces"][0] if s["faces"] else None
        if face is None:
            if current:
                zones.append(current)
                current = None
            continue
        cx, cy = face["x"] + face["w"] / 2, face["y"] + face["h"] / 2
        if current and abs(cx - current["_cx"]) < max_move and abs(cy - current["_cy"]) < max_move:
            current["_boxes"].append(face)
            current["end"] = s["t"] + every
        else:
            if current:
                zones.append(current)
            current = {"start": s["t"], "end": s["t"] + every, "_cx": cx, "_cy": cy, "_boxes": [face]}
    if current:
        zones.append(current)

    out_zones = []
    for z in zones:
        if len(z["_boxes"]) < 2:
            continue  # a single hit is more likely a false positive
        x0 = min(b["x"] for b in z["_boxes"])
        y0 = min(b["y"] for b in z["_boxes"])
        x1 = max(b["x"] + b["w"] for b in z["_boxes"])
        y1 = max(b["y"] + b["h"] for b in z["_boxes"])
        pw, ph = (x1 - x0) * padding, (y1 - y0) * padding
        x0, y0 = max(0.0, x0 - pw), max(0.0, y0 - ph)
        x1, y1 = min(1.0, x1 + pw), min(1.0, y1 + ph * 1.5)
        out_zones.append({
            "label": "face",
            "start": round(max(0.0, z["start"] - every / 2), 3),
            "end": round(min(duration or z["end"], z["end"]), 3),
            "x": round(x0, 4), "y": round(y0, 4), "w": round(x1 - x0, 4), "h": round(y1 - y0, 4),
        })
    return out_zones


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("video")
    parser.add_argument("--out", required=True)
    parser.add_argument("--every", type=float, default=0.5)
    parser.add_argument("--padding", type=float, default=0.35, help="Padding around each face, as a fraction of the face size")
    parser.add_argument("--max-move", type=float, default=0.08, help="Face movement (fraction of frame) that starts a new zone")
    args = parser.parse_args()

    try:
        import cv2  # noqa: WPS433
    except ImportError:
        print(json.dumps({"ok": False, "error": "OpenCV is not installed. Install with: pip install 'opencv-python-headless>=4.8,<5'"}))
        sys.exit(3)

    frontal = cascade_path("haarcascade_frontalface_default.xml")
    profile = cascade_path("haarcascade_profileface.xml")
    if not frontal:
        print(json.dumps({"ok": False, "error": "This OpenCV has no face model files (OpenCV 5 dropped them). Install OpenCV 4: pip install 'opencv-python-headless>=4.8,<5'"}))
        sys.exit(4)
    detectors = [cv2.CascadeClassifier(frontal)]
    if profile:
        detectors.append(cv2.CascadeClassifier(profile))

    cap = cv2.VideoCapture(args.video)
    if not cap.isOpened():
        print(json.dumps({"ok": False, "error": "Could not open video: " + args.video}))
        sys.exit(2)
    fps = cap.get(cv2.CAP_PROP_FPS) or 30
    frames = cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0
    width = cap.get(cv2.CAP_PROP_FRAME_WIDTH)
    height = cap.get(cv2.CAP_PROP_FRAME_HEIGHT)
    duration = frames / fps if frames and fps else 0

    samples = []
    t = 0.0
    while duration == 0 or t <= duration:
        cap.set(cv2.CAP_PROP_POS_MSEC, t * 1000)
        ok, frame = cap.read()
        if not ok:
            break
        h, w = frame.shape[:2]
        scale = 640.0 / w if w > 640 else 1.0
        small = cv2.resize(frame, (int(w * scale), int(h * scale))) if scale != 1.0 else frame
        gray = cv2.equalizeHist(cv2.cvtColor(small, cv2.COLOR_BGR2GRAY))
        min_size = max(24, int(min(gray.shape[:2]) * 0.08))
        found = []
        for det in detectors:
            for (x, y, fw, fh) in det.detectMultiScale(gray, scaleFactor=1.1, minNeighbors=6, minSize=(min_size, min_size)):
                found.append({
                    "x": round(x / gray.shape[1], 4),
                    "y": round(y / gray.shape[0], 4),
                    "w": round(fw / gray.shape[1], 4),
                    "h": round(fh / gray.shape[0], 4),
                })
        found.sort(key=lambda f: f["w"] * f["h"], reverse=True)
        samples.append({"t": round(t, 3), "faces": found[:3]})
        t += args.every
    cap.release()
    if duration == 0 and samples:
        duration = samples[-1]["t"]

    out_zones = build_zones(samples, args.every, args.padding, args.max_move, duration)

    result = {
        "ok": True,
        "video": args.video,
        "width": width,
        "height": height,
        "fps": fps,
        "duration": round(duration, 3),
        "sampleEvery": args.every,
        "samplesWithFace": sum(1 for s in samples if s["faces"]),
        "samples": samples,
        "zones": out_zones,
    }
    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump(result, fh)
    print(json.dumps({k: result[k] for k in ("ok", "duration", "samplesWithFace", "zones")}))


if __name__ == "__main__":
    main()
