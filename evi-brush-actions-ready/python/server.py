
import os, random
from pathlib import Path
import gradio as gr
import torch
from diffusers import AutoPipelineForText2Image
from PIL import Image, ImageDraw

TITLE = "Sport Sneaker — Multi-View Composite by EVI Brush"
APP_ROOT = Path(__file__).parent
ASSETS = APP_ROOT / "app_assets"
OUT_DIR = APP_ROOT / "outputs"; OUT_DIR.mkdir(exist_ok=True, parents=True)

MODEL_LOCAL_DIR = APP_ROOT / "models" / "sd-turbo"
MODEL_ID = "stabilityai/sd-turbo"

def load_pipeline():
    dtype = torch.float16 if torch.cuda.is_available() else torch.float32
    try:
        if MODEL_LOCAL_DIR.exists():
            print(f"[model] Loading local: {MODEL_LOCAL_DIR}")
            pipe = AutoPipelineForText2Image.from_pretrained(MODEL_LOCAL_DIR.as_posix(), torch_dtype=dtype, local_files_only=True)
        else:
            print(f"[model] Local not found. Loading online: {MODEL_ID}")
            pipe = AutoPipelineForText2Image.from_pretrained(MODEL_ID, torch_dtype=dtype)
    except Exception as e:
        print("[model] Fallback online:", e)
        pipe = AutoPipelineForText2Image.from_pretrained(MODEL_ID, torch_dtype=dtype)
    if torch.cuda.is_available():
        pipe = pipe.to("cuda")
        try: pipe.enable_xformers_memory_efficient_attention()
        except Exception: pass
    return pipe

pipe = load_pipeline()

SPORT_PREFIX = "sport sneaker, running shoe, athletic footwear design, breathable mesh upper, synthetic overlays, lace-up"
BASE_VIEW_PROMPTS = {
    "top":   "top-down upper flat, footwear flat technical sketch, clean black line art on white",
    "left":  "left side profile, footwear flat technical sketch, clean black line art on white",
    "right": "right side profile, footwear flat technical sketch, clean black line art on white",
    "back":  "back heel view, footwear flat technical sketch, clean black line art on white",
    "sole":  "outsole bottom view, tread pattern, footwear flat technical sketch, clean black line art on white",
}
NEGATIVE_PROMPT = "photorealistic, 3d render, background scenery, colors, heavy shading, blur, messy lines, noise, clutter"
LABELS = {"top":"Top","left":"Left","right":"Right","back":"Back","sole":"Sole"}

def build_prompt(view_key, elements_text="", extra_directives=""):
    parts = [SPORT_PREFIX]
    if elements_text.strip(): parts.append(elements_text.strip())
    if extra_directives.strip(): parts.append(extra_directives.strip())
    parts.append(BASE_VIEW_PROMPTS[view_key])
    return ", ".join(parts)

def _device(): return "cuda" if torch.cuda.is_available() else "cpu"

def make_shared_latents(width, height, seed=None, dtype=None):
    import hashlib
    if seed is None: seed = random.randint(0, 2**31-1)
    g = torch.Generator(device=_device()).manual_seed(int(seed))
    ch = pipe.unet.config.in_channels
    h8, w8 = int(height)//8, int(width)//8
    if dtype is None: dtype = pipe.unet.dtype
    latents = torch.randn((1, ch, h8, w8), generator=g, device=_device(), dtype=dtype)
    return latents, seed

def t2i(prompt, latents=None, width=512, height=512, steps=6, guidance_scale=0.0):
    image = pipe(
        prompt=prompt,
        negative_prompt=NEGATIVE_PROMPT,
        width=width if latents is None else None,
        height=height if latents is None else None,
        num_inference_steps=int(steps),
        guidance_scale=float(guidance_scale),
        latents=latents
    ).images[0]
    return image

def compose(images, layout="auto", label=True, pad=12, bg=(255,255,255)):
    n = len(images)
    if n == 0: raise ValueError("No images to compose.")
    w, h = images[0][1].width, images[0][1].height
    if layout == "row":
        cols, rows = n, 1
    elif layout == "grid2x2":
        cols, rows = 2, 2
    else:
        if n <= 3: cols, rows = n, 1
        elif n == 4: cols, rows = 2, 2
        else: cols, rows = 3, 2
    total_w = cols*w + pad*(cols+1)
    total_h = rows*h + pad*(rows+1)
    canvas = Image.new("RGB", (total_w, total_h), bg)
    draw = ImageDraw.Draw(canvas)
    idx = 0
    for r in range(rows):
        for c in range(cols):
            if idx >= n: break
            key, img = images[idx]
            x = pad + c*(w+pad)
            y = pad + r*(h+pad)
            canvas.paste(img, (x, y))
            if label: draw.text((x+8, y+8), LABELS.get(key, key).title(), fill=(0,0,0))
            idx += 1
    return canvas

def build_demo():
    ALL_VIEWS = ["top","left","right","back","sole"]

    def gen_right(elements, extra, width, height, steps, guidance, state):
        latents, used_seed = make_shared_latents(width, height, seed=None, dtype=pipe.unet.dtype)
        prompt = build_prompt("right", elements_text=elements, extra_directives=extra)
        img = t2i(prompt, latents=latents, width=width, height=height, steps=steps, guidance_scale=guidance)
        path = OUT_DIR / "shoe_RIGHT_preview.png"
        img.save(path)
        state = {"elements": elements, "extra": extra, "width": int(width), "height": int(height),
                 "steps": int(steps), "guidance": float(guidance), "seed": used_seed, "latents": latents}
        return img, str(path), f"Right view ready. seed={used_seed}", state

    def gen_others(state, views, layout):
        if state is None or "latents" not in state: return None, "請先產生右視圖預覽。"
        sel = [v.lower() for v in views]; sel = [v for v in sel if v != "right"]
        if not sel: return None, "請至少勾選一個『右視圖以外』的視圖。"
        latents = state["latents"]; width, height = state["width"], state["height"]
        steps, guidance = state["steps"], state["guidance"]
        elements, extra = state["elements"], state["extra"]
        out_pairs = []
        for v in sel:
            prompt = build_prompt(v, elements_text=elements, extra_directives=extra)
            img = t2i(prompt, latents=latents, width=width, height=height, steps=steps, guidance_scale=guidance)
            out_pairs.append((v, img))
        right_prompt = build_prompt("right", elements_text=elements, extra_directives=extra)
        right_img = t2i(right_prompt, latents=latents, width=width, height=height, steps=steps, guidance_scale=guidance)
        comp = compose([("right", right_img)] + out_pairs, layout=layout, label=True, bg=(255,255,255))
        out_path = OUT_DIR / "shoe_COMPOSITE.png"
        comp.save(out_path)
        return comp, str(out_path)

    with gr.Blocks(title=TITLE) as demo:
        gr.Markdown(f'''
        <div style="display:flex;align-items:center;gap:12px;">
          <img src="file={ASSETS.as_posix()}/logo.png" style="height:60px;">
          <h1 style="margin:0;">{TITLE}</h1>
        </div>
        ''')
        state = gr.State()
        with gr.Row():
            with gr.Column(scale=1):
                elements = gr.Textbox(label="請輸入所需的鞋款元素（空白則隨機）", value="mesh toe, 5 eyelets, cupsole")
                extra = gr.Textbox(label="Design directives（可空白；會與『鞋款元素』合併）", value="")
                width = gr.Slider(384, 768, value=512, step=64, label="Width")
                height = gr.Slider(384, 768, value=512, step=64, label="Height")
                steps = gr.Slider(2, 12, value=6, step=1, label="Steps (Turbo: 4–8)")
                guidance = gr.Slider(0.0, 2.0, value=0.0, step=0.1, label="Guidance Scale (Turbo=0.0)")
                gen_btn = gr.Button("① 生成『右視圖』預覽")
            with gr.Column(scale=1):
                right_img = gr.Image(type="pil", label="Right View Preview")
                right_path = gr.Textbox(label="Right preview path")
                msg = gr.Markdown()

        gr.Markdown("---")
        with gr.Row():
            with gr.Column(scale=1):
                views = gr.CheckboxGroup(choices=[v.title() for v in ALL_VIEWS], value=["Top","Back","Left","Sole"], label="② 勾選要追加的視圖（右視圖已預先生成）")
                layout = gr.Radio(choices=["auto","row","grid2x2"], value="auto", label="版面")
                confirm_btn = gr.Button("③ 確認設計，生成合成圖")
            with gr.Column(scale=1):
                comp_img = gr.Image(type="pil", label="Composite (Right + Others)")
                comp_path = gr.Textbox(label="Composite path")

        gen_btn.click(gen_right, [elements, extra, width, height, steps, guidance, state], [right_img, right_path, msg, state])
        confirm_btn.click(gen_others, [state, views, layout], [comp_img, comp_path])
    return demo

if __name__ == "__main__":
    demo = build_demo()
    demo.launch(server_name="127.0.0.1", server_port=7860, share=False, inbrowser=False)
