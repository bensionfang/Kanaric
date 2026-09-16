import json
import os
import struct
import subprocess
import sys
import tempfile
import time
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
PYTOOLS = ROOT / "pytools.py"
EXTENSION_ID = "abcdefghijklmnopabcdefghijklmnop"


def frame(payload):
    raw = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    return struct.pack("<I", len(raw)) + raw


def read_frame(raw):
    size = struct.unpack("<I", raw[:4])[0]
    return json.loads(raw[4:4 + size].decode("utf-8"))


def run_host(payload, discovery_path, argv=None, extension_env=EXTENSION_ID):
    env = os.environ.copy()
    env["KANARIC_DISCOVERY_FILE"] = str(discovery_path)
    if extension_env is None:
        env.pop("KANARIC_EXTENSION_ID", None)
    else:
        env["KANARIC_EXTENSION_ID"] = extension_env
    return subprocess.run(
        [sys.executable, str(PYTOOLS), *(argv or ["native-messaging"])],
        input=payload,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=env,
        check=False,
        timeout=10,
    )


with tempfile.TemporaryDirectory() as temp_dir:
    discovery = Path(temp_dir) / "discovery.json"
    discovery.write_text(json.dumps({
        "baseUrl": "http://127.0.0.1:5720",
        "token": "synthetic-native-host-token",
        "expiresAt": int(time.time() * 1000) + 60_000,
        "pid": os.getpid(),
    }), encoding="utf-8")

    result = run_host(frame({
        "type": "discover",
        "protocol": "kanaric-youtube-v1",
        "origin": f"chrome-extension://{EXTENSION_ID}/",
    }), discovery)
    response = read_frame(result.stdout)
    assert response["ok"] is True
    assert response["baseUrl"] == "http://127.0.0.1:5720"
    assert response["expiresAt"] > int(time.time() * 1000)

    chrome_origin = f"chrome-extension://{EXTENSION_ID}/"
    chrome_result = run_host(
        frame({
            "type": "discover",
            "protocol": "kanaric-youtube-v1",
            "origin": chrome_origin,
        }),
        discovery,
        [chrome_origin, "--parent-window=1234"],
        extension_env=None,
    )
    assert chrome_result.returncode == 0, chrome_result.stderr.decode()
    response = read_frame(chrome_result.stdout)
    assert response["ok"] is True

    chrome_mismatch = run_host(
        frame({
            "type": "discover",
            "protocol": "kanaric-youtube-v1",
            "origin": "chrome-extension://pppppppppppppppppppppppppppppppp/",
        }),
        discovery,
        [chrome_origin, "--parent-window=1234"],
        extension_env=None,
    )
    assert read_frame(chrome_mismatch.stdout) == {"ok": False, "error": "invalid-origin"}

    for request in (
        {"type": "unknown", "protocol": "kanaric-youtube-v1"},
        {"type": "discover", "protocol": "wrong"},
        {
            "type": "discover",
            "protocol": "kanaric-youtube-v1",
            "origin": "chrome-extension://pppppppppppppppppppppppppppppppp/",
        },
    ):
        response = read_frame(run_host(frame(request), discovery).stdout)
        assert response["ok"] is False

    oversized = struct.pack("<I", 16 * 1024 + 1) + b"{}"
    response = read_frame(run_host(oversized, discovery).stdout)
    assert response["ok"] is False

    missing = Path(temp_dir) / "missing.json"
    response = read_frame(run_host(frame({
        "type": "discover",
        "protocol": "kanaric-youtube-v1",
    }), missing).stdout)
    assert response == {"ok": False, "error": "app-not-running"}

print("test_native_messaging_host: OK")
