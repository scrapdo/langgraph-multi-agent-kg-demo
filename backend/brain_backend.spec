# PyInstaller spec for the Brain backend binary.
#
# Build with:
#   cd backend
#   .venv-native/bin/pyinstaller brain_backend.spec --noconfirm
#
# Output: dist/brain_backend/  (a directory containing the brain_backend executable
# and its bundled Python runtime + libs). Electron ships this whole directory as
# an extraResource and spawns dist/brain_backend/brain_backend at launch.
#
# Why onedir over onefile:
#   * Much faster cold start (no temp-dir extraction on every launch).
#   * Lets macOS code-signing walk individual .dylibs/.so files cleanly.
#   * Easier to debug missing-module issues.

# ruff: noqa
from PyInstaller.utils.hooks import collect_data_files, collect_submodules, collect_all

block_cipher = None

# Langchain + langgraph use runtime entry points. PyInstaller's static analysis
# misses most of them — collect_submodules pulls the full tree.
hiddenimports = []
for pkg in (
    "langchain",
    "langchain_core",
    "langchain_openai",
    "langchain_anthropic",
    "langchain_google_genai",
    "langgraph",
    "langgraph.checkpoint.sqlite",
    "langgraph.checkpoint.sqlite.aio",
    "langgraph.checkpoint.memory",
    "openai",
    "anthropic",
    "tiktoken",
    "tiktoken_ext",
    "tiktoken_ext.openai_public",
    "pydantic",
    "pydantic_settings",
    "httpx",
    "httpcore",
    "fastapi",
    "uvicorn",
    "uvicorn.logging",
    "uvicorn.loops.auto",
    "uvicorn.loops.asyncio",
    "uvicorn.protocols",
    "uvicorn.protocols.http.auto",
    "uvicorn.protocols.http.h11_impl",
    "uvicorn.protocols.websockets.auto",
    "uvicorn.protocols.websockets.websockets_impl",
    "uvicorn.lifespan.on",
    "aiosqlite",
    "python_multipart",
    "tenacity",
    "zep_cloud",
):
    try:
        hiddenimports += collect_submodules(pkg)
    except Exception:
        # Optional packages that may not be installed for every build.
        hiddenimports.append(pkg)

# Non-Python data shipped inside packages (JSON schemas, tokenizer vocabularies,
# etc.). Without this, several SDKs raise FileNotFoundError at runtime.
datas = []
for pkg in (
    "langchain",
    "langchain_core",
    "langchain_openai",
    "langgraph",
    "tiktoken",
    "tiktoken_ext",
    "openai",
    "anthropic",
    "pydantic",
    "zep_cloud",
):
    try:
        datas += collect_data_files(pkg)
    except Exception:
        pass

# Our own app package — PyInstaller needs to see every submodule the API
# lazy-imports (agent nodes, tools, services).
app_datas, app_bins, app_hidden = collect_all("app")
datas += app_datas
hiddenimports += app_hidden

# Excludes: heavy optional deps that aren't needed for the voice-first native
# experience. Keeping them out trims hundreds of MB from the bundle.
excludes = [
    "playwright",           # ~300MB of bundled Chromium; install on-demand if needed
    "transformers",         # heavyweight, only needed for local HF inference
    "torch",
    "torchvision",
    "torchaudio",
    "huggingface_hub",
    "datasets",
    "accelerate",
    "optimum",
    "neo4j",                # optional; no-op driver kicks in when absent
    "psycopg",              # postgres path; sqlite checkpointer replaces it
    "psycopg2",
    "sqlalchemy",
    "alembic",
    "celery",               # in-process dispatcher replaces celery worker
    "kombu",
    "redis",                # celery broker; unused in native mode
    "billiard",
    "amqp",
    "vine",
    "PIL",
    "matplotlib",
    "numpy.testing",
    "pandas.tests",
    "tests",
]

a = Analysis(
    ["brain_backend.py"],
    pathex=[],
    binaries=[],
    datas=datas,
    hiddenimports=sorted(set(hiddenimports)),
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=excludes,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="brain_backend",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=True,              # Electron captures stdout; keep visible during dev
    disable_windowed_traceback=False,
    target_arch=None,
    codesign_identity=None,    # We sign the whole thing via electron-builder later
    entitlements_file=None,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name="brain_backend",
)
