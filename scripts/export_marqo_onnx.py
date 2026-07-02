# Export Marqo/nsfw-image-detection-384 (ViT-tiny, Apache-2.0) to ONNX for use
# with onnxruntime-node inside the Electron detector.
#
# One-time dev-machine step:
#   pip install torch timm onnx
#   python scripts/export_marqo_onnx.py
#
# Outputs:
#   assets/models/marqo-nsfw-384.onnx
#   assets/models/marqo-nsfw-384.json   (input size, mean/std, label order)

import json
import os

import timm
import torch

OUT_DIR = os.path.join(os.path.dirname(__file__), "..", "assets", "models")
ONNX_PATH = os.path.join(OUT_DIR, "marqo-nsfw-384.onnx")
META_PATH = os.path.join(OUT_DIR, "marqo-nsfw-384.json")


def main():
    os.makedirs(OUT_DIR, exist_ok=True)

    model = timm.create_model("hf_hub:Marqo/nsfw-image-detection-384", pretrained=True)
    model.eval()

    data_cfg = timm.data.resolve_data_config({}, model=model)
    labels = list(model.pretrained_cfg.get("label_names") or [])
    size = data_cfg["input_size"][-1]
    print("input_size:", data_cfg["input_size"])
    print("mean:", data_cfg["mean"], "std:", data_cfg["std"])
    print("labels:", labels)
    assert labels, "model must expose label_names so JS knows the class order"

    dummy = torch.randn(1, 3, size, size)
    torch.onnx.export(
        model,
        dummy,
        ONNX_PATH,
        input_names=["input"],
        output_names=["logits"],
        opset_version=17,
        dynamic_axes={"input": {0: "batch"}, "logits": {0: "batch"}},
    )

    with open(META_PATH, "w") as f:
        json.dump(
            {
                "source": "Marqo/nsfw-image-detection-384",
                "license": "Apache-2.0",
                "size": size,
                "mean": list(data_cfg["mean"]),
                "std": list(data_cfg["std"]),
                "labels": labels,
            },
            f,
            indent=2,
        )

    mb = os.path.getsize(ONNX_PATH) / 1e6
    print(f"exported {ONNX_PATH} ({mb:.1f} MB)")

    # sanity check: same tensor through torch and onnx must agree
    import onnxruntime as ort  # noqa: E402

    sess = ort.InferenceSession(ONNX_PATH, providers=["CPUExecutionProvider"])
    with torch.no_grad():
        t = model(dummy).softmax(dim=-1).numpy()
    o = sess.run(None, {"input": dummy.numpy()})[0]
    import numpy as np  # noqa: E402

    o = np.exp(o) / np.exp(o).sum(axis=-1, keepdims=True)
    diff = float(abs(t - o).max())
    print("torch-vs-onnx max softmax diff:", diff)
    assert diff < 1e-3, "ONNX export does not match torch output"
    print("OK")


if __name__ == "__main__":
    main()
