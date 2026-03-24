import json, os, random, re
from typing import Any, Dict, Optional
import httpx
from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

QWEN_BASE_URL = os.getenv("QWEN_BASE_URL", "http://127.0.0.1:8080")
MODEL_NAME = os.getenv("MODEL_NAME", "Qwen3-14B")
app = FastAPI(title="Ambient Flow Engine")
STRUDEL_SYNTHS = ["sine", "triangle", "sawtooth", "square"]
STRUDEL_SAMPLES = ["wind", "space", "jazz", "metal", "insect", "crow", "casio", "numbers", "east"]
STRUDEL_EFFECTS = ["lowpass", "room", "phaser", "delay", "drift", "shimmer"]
TEXTURE_FAMILIES = ["mist", "glass", "velvet", "grain", "choir", "metallic"]
VOICE_SHAPES = ["sine", "triangle", "saw", "square", "hybrid"]
SCALES = ["lydian", "ionian", "mixolydian", "dorian", "aeolian"]
ROOTS = ["C", "D", "E", "F", "G", "A", "B"]

class SceneRequest(BaseModel):
    prompt: Optional[str] = None
    mode: str = "focus"
    seed: Optional[int] = None
    previous_scene: Optional[Dict[str, Any]] = None

def clamp(x: float, lo: float, hi: float) -> float: return max(lo, min(hi, x))

def maybe_float(value: Any, default: float) -> float:
    try: return float(value)
    except (TypeError, ValueError): return default

def choice(rng: random.Random, values): return values[int(rng.random() * len(values)) % len(values)]

def build_prompt_fallback(mode: str, rng: random.Random, bias: str = "") -> str:
    synths = rng.sample(STRUDEL_SYNTHS, k=2)
    samples = rng.sample(STRUDEL_SAMPLES, k=3)
    effects = rng.sample(STRUDEL_EFFECTS, k=2)
    mode_hint = {
        "focus": "steady, lucid, low-fatigue",
        "relax": "warm, floating, immersive",
        "sleep": "slow, dim, weightless",
    }.get(mode, "continuous, atmospheric")
    bias_text = bias.strip()
    if bias_text: bias_text = f" with a light bias toward {bias_text}"
    return (
        f"{mode_hint} ambient texture{bias_text}; use {synths[0]} and {synths[1]}-like harmonics, "
        f"evoke {samples[0]}/{samples[1]}/{samples[2]} color, add sparse {effects[0]} and {effects[1]}, "
        f"fully beatless, no drums, long-form evolving pad"
    )

def keyword_scene(prompt: Optional[str], mode: str, seed: Optional[int], previous_scene=None) -> Dict[str, Any]:
    text = (prompt or "").lower()
    actual_seed = seed if seed is not None else random.SystemRandom().randint(1, 2**31 - 1)
    rng = random.Random(actual_seed)
    prev = previous_scene or {}

    brightness = maybe_float(prev.get("brightness"), 0.48)
    density = maybe_float(prev.get("density"), 0.38)
    movement = maybe_float(prev.get("movement"), 0.24)
    warmth = maybe_float(prev.get("warmth"), 0.58)
    air = maybe_float(prev.get("air"), 0.30)
    shimmer = maybe_float(prev.get("shimmer"), 0.18)
    noisiness = maybe_float(prev.get("noisiness"), 0.14)
    reverb = maybe_float(prev.get("reverb"), 0.45)
    stereo_width = maybe_float(prev.get("stereo_width"), 0.62)
    sub_amount = maybe_float(prev.get("sub_amount"), 0.22)
    detune = maybe_float(prev.get("detune"), 0.10)
    drift = maybe_float(prev.get("drift"), 0.18)

    root = prev.get("root") or choice(rng, ROOTS[:-1])
    scale = prev.get("scale") or "lydian"
    texture_family = prev.get("texture_family") or choice(rng, TEXTURE_FAMILIES)
    voice_shape = prev.get("voice_shape") or "hybrid"

    if any(k in text for k in ["dark", "fog", "drone", "night", "shadow"]):
        brightness -= 0.16
        warmth += 0.05
        shimmer -= 0.06
        air += 0.02
        scale = "aeolian"
        texture_family = "velvet"
    if any(k in text for k in ["glass", "glassy", "crystal", "celestial"]):
        brightness += 0.18
        shimmer += 0.12
        air += 0.08
        warmth -= 0.03
        texture_family = "glass"
        voice_shape = "triangle"
    if any(k in text for k in ["metal", "metallic", "steel", "chrome"]):
        shimmer += 0.15
        warmth -= 0.08
        texture_family = "metallic"
        voice_shape = "saw"
    if any(k in text for k in ["warm", "soft", "velvet", "analog"]):
        warmth += 0.12
        brightness -= 0.04
        reverb += 0.04
        texture_family = "velvet"
    if any(k in text for k in ["grain", "dust", "weathered", "lofi"]):
        noisiness += 0.12
        air += 0.05
        brightness -= 0.03
        texture_family = "grain"
    if any(k in text for k in ["choir", "voice", "choral", "human"]):
        air += 0.09
        warmth += 0.05
        texture_family = "choir"
        voice_shape = "sine"
    if "underwater" in text:
        brightness -= 0.08
        air += 0.12
        movement -= 0.03
        reverb += 0.05
    if any(k in text for k in ["focus", "study", "work", "flow"]):
        density -= 0.03
        shimmer -= 0.03
        movement += 0.02
    if any(k in text for k in ["sleep", "dream", "nighttime"]):
        movement -= 0.10
        density -= 0.06
        shimmer -= 0.08
        air += 0.04
        reverb += 0.04
    if any(k in text for k in ["wide", "cinematic", "spacious"]):
        stereo_width += 0.12
        reverb += 0.08
    if any(k in text for k in ["minimal", "plain", "simple"]):
        density -= 0.08
        noisiness -= 0.05
        shimmer -= 0.04

    if mode == "focus":
        focus_mod_hz = 14.5
        focus_mod_depth = 0.011
        chord_change_min_s, chord_change_max_s = 26, 54
        evolve_every_min_s, evolve_every_max_s = 55, 95
        morph_s = 18
        master_gain = 0.30
    elif mode == "sleep":
        focus_mod_hz = 7.5
        focus_mod_depth = 0.003
        chord_change_min_s, chord_change_max_s = 42, 88
        evolve_every_min_s, evolve_every_max_s = 80, 140
        morph_s = 28
        master_gain = 0.28
        density -= 0.03
        movement -= 0.03
    else:
        focus_mod_hz = 10.0
        focus_mod_depth = 0.006
        chord_change_min_s, chord_change_max_s = 30, 68
        evolve_every_min_s, evolve_every_max_s = 60, 110
        morph_s = 22
        master_gain = 0.32

    brightness = clamp(brightness + (rng.random() - 0.5) * 0.08, 0.08, 0.95)
    density = clamp(density + (rng.random() - 0.5) * 0.08, 0.08, 0.90)
    movement = clamp(movement + (rng.random() - 0.5) * 0.06, 0.02, 0.85)
    warmth = clamp(warmth + (rng.random() - 0.5) * 0.06, 0.05, 0.95)
    air = clamp(air + (rng.random() - 0.5) * 0.06, 0.0, 0.95)
    shimmer = clamp(shimmer + (rng.random() - 0.5) * 0.05, 0.0, 0.90)
    noisiness = clamp(noisiness + (rng.random() - 0.5) * 0.04, 0.0, 0.60)
    reverb = clamp(reverb + (rng.random() - 0.5) * 0.05, 0.05, 0.95)
    stereo_width = clamp(stereo_width + (rng.random() - 0.5) * 0.06, 0.10, 1.00)
    sub_amount = clamp(sub_amount + (rng.random() - 0.5) * 0.04, 0.0, 0.55)
    detune = clamp(detune + (rng.random() - 0.5) * 0.04, 0.0, 0.45)
    drift = clamp(drift + (rng.random() - 0.5) * 0.05, 0.0, 0.80)

    generated_prompt = prompt or build_prompt_fallback(mode, rng)

    return {
        "generated_prompt": generated_prompt,
        "style_text": generated_prompt,
        "mode": mode,
        "seed": actual_seed,
        "root": root,
        "scale": scale,
        "texture_family": texture_family,
        "voice_shape": voice_shape,
        "brightness": brightness,
        "density": density,
        "movement": movement,
        "warmth": warmth,
        "air": air,
        "shimmer": shimmer,
        "noisiness": noisiness,
        "reverb": reverb,
        "stereo_width": stereo_width,
        "sub_amount": sub_amount,
        "detune": detune,
        "drift": drift,
        "master_gain": master_gain,
        "focus_mod_hz": clamp(focus_mod_hz, 5.0, 18.0),
        "focus_mod_depth": clamp(focus_mod_depth, 0.0, 0.03),
        "chord_change_min_s": chord_change_min_s,
        "chord_change_max_s": chord_change_max_s,
        "evolve_every_min_s": evolve_every_min_s,
        "evolve_every_max_s": evolve_every_max_s,
        "morph_s": morph_s,
        "strudel_palette": {
            "synths": rng.sample(STRUDEL_SYNTHS, k=2),
            "samples": rng.sample(STRUDEL_SAMPLES, k=3),
            "effects": rng.sample(STRUDEL_EFFECTS, k=2),
        },
    }

def extract_json_object(text: str) -> Dict[str, Any]:
    text = text.strip()
    try:
        data = json.loads(text)
        if isinstance(data, dict): return data
    except json.JSONDecodeError: pass

    match = re.search(r"\{.*\}", text, re.DOTALL)
    if not match: raise ValueError("No JSON object found in model output")

    data = json.loads(match.group(0))
    if not isinstance(data, dict): raise ValueError("Model did not return a JSON object")
    return data

async def generate_meta_prompt_with_qwen(user_bias: Optional[str], mode: str, seed: Optional[int], previous_scene) -> str:
    rng = random.Random(seed if seed is not None else random.SystemRandom().randint(1, 2**31 - 1))
    fallback_prompt = build_prompt_fallback(mode, rng, bias=user_bias or "")
    system_prompt = f"""
You write one concise prompt for a Qwen-driven ambient generator.
Return ONE strict JSON object only: {{"generated_prompt": "..."}}

Rules:
- output one sentence only
- no markdown
- no prose outside JSON
- beatless, no drums, no vocals, no hard transients
- optimize for long-form listening
- use some vocabulary from these lists when helpful
- synth vocabulary: {', '.join(STRUDEL_SYNTHS)}
- sample color vocabulary: {', '.join(STRUDEL_SAMPLES)}
- effect vocabulary: {', '.join(STRUDEL_EFFECTS)}
"""

    payload = {
        "model": MODEL_NAME,
        "messages": [
            {"role": "system", "content": system_prompt},
            {
                "role": "user",
                "content": json.dumps({ "mode": mode, "user_bias": user_bias or "", "fallback_prompt": fallback_prompt, "previous_scene": previous_scene or {} }),
            },
        ],
        "temperature": 0.75,
        "max_tokens": 180,
        "response_format": {"type": "json_object"},
        "stream": False,
    }

    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.post(f"{QWEN_BASE_URL}/v1/chat/completions", json=payload)
            resp.raise_for_status()
            data = resp.json()
        content = data["choices"][0]["message"]["content"]
        obj = extract_json_object(content)
        prompt = str(obj.get("generated_prompt", "")).strip()
        return prompt or fallback_prompt
    except Exception:
        return fallback_prompt

async def generate_scene_with_qwen(user_prompt: Optional[str], mode: str, seed: Optional[int], previous_scene) -> Dict[str, Any]:
    generated_prompt = await generate_meta_prompt_with_qwen(user_prompt, mode, seed, previous_scene)
    fallback = keyword_scene(generated_prompt, mode, seed, previous_scene)

    system_prompt = """
You are a compiler for an infinite ambient audio engine.
Return ONE strict JSON object only. No markdown. No prose.

Goal:
Convert the generated prompt into a compact evolving scene spec for continuous,
beatless, atmospheric audio for focus, relaxation, or sleep.

Rules:
- no drums
- no explicit rhythm
- no vocals
- no sudden transients
- optimize for long-form listening
- output only valid JSON
- keep all numeric values within stated ranges

Required schema:
{
  "generated_prompt": "string",
  "style_text": "string",
  "mode": "focus|relax|sleep",
  "seed": 123,
  "root": "C|D|E|F|G|A|B",
  "scale": "lydian|ionian|mixolydian|dorian|aeolian",
  "texture_family": "mist|glass|velvet|grain|choir|metallic",
  "voice_shape": "sine|triangle|saw|square|hybrid",
  "brightness": 0.0,
  "density": 0.0,
  "movement": 0.0,
  "warmth": 0.0,
  "air": 0.0,
  "shimmer": 0.0,
  "noisiness": 0.0,
  "reverb": 0.0,
  "stereo_width": 0.0,
  "sub_amount": 0.0,
  "detune": 0.0,
  "drift": 0.0,
  "master_gain": 0.32,
  "focus_mod_hz": 14.0,
  "focus_mod_depth": 0.012,
  "chord_change_min_s": 30,
  "chord_change_max_s": 60,
  "evolve_every_min_s": 60,
  "evolve_every_max_s": 110,
  "morph_s": 20
}

Ranges:
brightness,density,movement,warmth,air,shimmer,noisiness,reverb,stereo_width,sub_amount,detune,drift in [0.0, 1.0]
master_gain in [0.18, 0.55]
focus_mod_hz in [5.0, 18.0]
focus_mod_depth in [0.0, 0.03]
chord_change_min_s in [20, 90]
chord_change_max_s in [30, 140]
evolve_every_min_s in [30, 180]
evolve_every_max_s in [45, 240]
morph_s in [6, 60]
"""

    payload = {
        "model": MODEL_NAME,
        "messages": [
            {"role": "system", "content": system_prompt},
            {
                "role": "user",
                "content": json.dumps(
                    {
                        "generated_prompt": generated_prompt,
                        "mode": mode,
                        "seed": seed if seed is not None else fallback["seed"],
                        "previous_scene": previous_scene or {},
                        "fallback_reference": fallback,
                        "allowed_texture_families": TEXTURE_FAMILIES,
                        "allowed_voice_shapes": VOICE_SHAPES,
                    }
                ),
            },
        ],
        "temperature": 0.45,
        "max_tokens": 600,
        "response_format": {"type": "json_object"},
        "stream": False,
    }

    try:
        async with httpx.AsyncClient(timeout=45.0) as client:
            resp = await client.post(f"{QWEN_BASE_URL}/v1/chat/completions", json=payload)
            resp.raise_for_status()
            data = resp.json()
        content = data["choices"][0]["message"]["content"]
        scene = extract_json_object(content)
    except Exception:
        return fallback

    merged = {**fallback, **scene}
    merged["generated_prompt"] = str(merged.get("generated_prompt") or generated_prompt).strip() or generated_prompt
    merged["style_text"] = str(merged.get("style_text") or merged["generated_prompt"]).strip()
    merged["mode"] = mode
    merged["seed"] = int(maybe_float(merged.get("seed"), fallback["seed"]))
    merged["root"] = merged.get("root") if merged.get("root") in ROOTS else fallback["root"]
    merged["scale"] = merged.get("scale") if merged.get("scale") in SCALES else fallback["scale"]
    merged["texture_family"] = merged.get("texture_family") if merged.get("texture_family") in TEXTURE_FAMILIES else fallback["texture_family"]
    merged["voice_shape"] = merged.get("voice_shape") if merged.get("voice_shape") in VOICE_SHAPES else fallback["voice_shape"]

    for key in [ "brightness", "density", "movement", "warmth", "air", "shimmer", "noisiness", "reverb", "stereo_width", "sub_amount", "detune", "drift" ]:
        merged[key] = clamp(maybe_float(merged.get(key), fallback[key]), 0.0, 1.0)

    merged["master_gain"] = clamp(maybe_float(merged.get("master_gain"), fallback["master_gain"]), 0.18, 0.55)
    merged["focus_mod_hz"] = clamp(maybe_float(merged.get("focus_mod_hz"), fallback["focus_mod_hz"]), 5.0, 18.0)
    merged["focus_mod_depth"] = clamp(maybe_float(merged.get("focus_mod_depth"), fallback["focus_mod_depth"]), 0.0, 0.03)
    merged["chord_change_min_s"] = int(clamp(maybe_float(merged.get("chord_change_min_s"), fallback["chord_change_min_s"]), 20, 90))
    merged["chord_change_max_s"] = int(clamp(maybe_float(merged.get("chord_change_max_s"), fallback["chord_change_max_s"]), 30, 140))
    merged["evolve_every_min_s"] = int(clamp(maybe_float(merged.get("evolve_every_min_s"), fallback["evolve_every_min_s"]), 30, 180))
    merged["evolve_every_max_s"] = int(clamp(maybe_float(merged.get("evolve_every_max_s"), fallback["evolve_every_max_s"]), 45, 240))
    merged["morph_s"] = int(clamp(maybe_float(merged.get("morph_s"), fallback["morph_s"]), 6, 60))

    if merged["chord_change_max_s"] < merged["chord_change_min_s"]:
        merged["chord_change_max_s"] = merged["chord_change_min_s"] + 8
    if merged["evolve_every_max_s"] < merged["evolve_every_min_s"]:
        merged["evolve_every_max_s"] = merged["evolve_every_min_s"] + 10

    merged["strudel_palette"] = fallback["strudel_palette"]
    return merged

@app.get("/")
async def root(): return FileResponse("static/index.html")

analysis_latest: Dict[str, Any] = {}
@app.get("/api/analysis/latest")
async def latest_analysis():
    return analysis_latest or {"ok": True, "analysis": None}

@app.websocket("/ws/analysis")
async def analysis_ws(ws: WebSocket):
    await ws.accept()
    try:
        while True:
            payload = await ws.receive_text()
            try:
                data = json.loads(payload)
            except json.JSONDecodeError:
                continue
            analysis_latest.clear()
            analysis_latest.update(data)
    except WebSocketDisconnect:
        return

@app.get("/api/health")
async def health(): return {"ok": True, "qwen_base_url": QWEN_BASE_URL, "model_name": MODEL_NAME}

@app.post("/api/scene")
async def create_scene(req: SceneRequest):
    scene = await generate_scene_with_qwen(
        user_prompt=(req.prompt or "").strip() or None,
        mode=req.mode,
        seed=req.seed,
        previous_scene=req.previous_scene,
    )
    return {"prompt": scene["generated_prompt"], "scene": scene}

@app.get("/favicon.ico")
async def favicon(): raise HTTPException(status_code=204)

@app.get("/v1/models")
async def compat_models(): return {"object": "list", "data": [{"id": MODEL_NAME, "object": "model", "owned_by": "local"}]}

app.mount("/static", StaticFiles(directory="static"), name="static")